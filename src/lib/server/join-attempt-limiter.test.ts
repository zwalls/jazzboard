// @vitest-environment node

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import Redis from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRedisForRealtime: vi.fn(),
}));

vi.mock("./room-store", () => ({
  getRedisForRealtime: mocks.getRedisForRealtime,
}));

import {
  consumeJoinAttempt,
  JOIN_ATTEMPT_LIMIT,
  JOIN_ATTEMPT_WINDOW_SECONDS,
  JOIN_NETWORK_ATTEMPT_LIMIT,
} from "./join-attempt-limiter";

const START = new Date("2026-08-26T12:00:00.000Z");

function request(headers?: HeadersInit): Request {
  return new Request("https://jazzboard.example/api/rooms", { headers });
}

describe("join attempt limiter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(START);
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("SESSION_SECRET", "join-attempt-test-secret-with-enough-entropy");
    mocks.getRedisForRealtime.mockReturnValue(null);
    globalThis.__jazzboardLocalJoinAttemptWindowsV3 = undefined;
  });

  afterEach(() => {
    globalThis.__jazzboardLocalJoinAttemptWindowsV3 = undefined;
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("limits attempts independently by signed guest participant ID in local development", async () => {
    for (let attempt = 1; attempt <= JOIN_ATTEMPT_LIMIT; attempt += 1) {
      await expect(consumeJoinAttempt("p_alice", request())).resolves.toEqual({
        allowed: true,
        limit: JOIN_ATTEMPT_LIMIT,
        remaining: JOIN_ATTEMPT_LIMIT - attempt,
        retryAfterSeconds: 0,
      });
    }

    await expect(consumeJoinAttempt("p_alice", request())).resolves.toEqual({
      allowed: false,
      limit: JOIN_ATTEMPT_LIMIT,
      remaining: 0,
      retryAfterSeconds: JOIN_ATTEMPT_WINDOW_SECONDS,
    });
    await expect(consumeJoinAttempt("p_bob", request())).resolves.toMatchObject({
      allowed: true,
      remaining: JOIN_ATTEMPT_LIMIT - 1,
    });
  });

  it("opens a fresh local window after the retry interval", async () => {
    for (let attempt = 0; attempt <= JOIN_ATTEMPT_LIMIT; attempt += 1) {
      await consumeJoinAttempt("p_alice", request());
    }

    vi.advanceTimersByTime(JOIN_ATTEMPT_WINDOW_SECONDS * 1_000);

    await expect(consumeJoinAttempt("p_alice", request())).resolves.toEqual({
      allowed: true,
      limit: JOIN_ATTEMPT_LIMIT,
      remaining: JOIN_ATTEMPT_LIMIT - 1,
      retryAfterSeconds: 0,
    });
  });

  it("counts one logical keyed attempt only once across delivery retries", async () => {
    const identity = {
      idempotencyKey: "landing-join-0001",
      requestDigest: "a".repeat(64),
    };
    await expect(consumeJoinAttempt("p_alice", request(), identity)).resolves.toMatchObject({
      allowed: true,
      remaining: JOIN_ATTEMPT_LIMIT - 1,
    });
    await expect(consumeJoinAttempt("p_alice", request(), identity)).resolves.toMatchObject({
      allowed: true,
      remaining: JOIN_ATTEMPT_LIMIT - 1,
    });
    await expect(consumeJoinAttempt("p_alice", request(), {
      ...identity,
      requestDigest: "b".repeat(64),
    })).resolves.toMatchObject({
      allowed: true,
      remaining: JOIN_ATTEMPT_LIMIT - 2,
    });
  });

  it("keeps the final admitted keyed attempt retryable without storing rejected floods", async () => {
    for (let attempt = 1; attempt < JOIN_ATTEMPT_LIMIT; attempt += 1) {
      await consumeJoinAttempt("p_alice", request(), {
        idempotencyKey: `landing-join-${attempt.toString().padStart(4, "0")}`,
        requestDigest: attempt.toString(16).padStart(64, "0"),
      });
    }
    const finalIdentity = {
      idempotencyKey: "landing-join-final",
      requestDigest: "f".repeat(64),
    };
    await expect(consumeJoinAttempt("p_alice", request(), finalIdentity)).resolves.toMatchObject({
      allowed: true,
      remaining: 0,
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await expect(consumeJoinAttempt("p_alice", request())).resolves.toMatchObject({ allowed: false });
    }
    await expect(consumeJoinAttempt("p_alice", request(), finalIdentity)).resolves.toMatchObject({
      allowed: true,
      remaining: 0,
    });
    const windows = globalThis.__jazzboardLocalJoinAttemptWindowsV3;
    expect(windows?.size).toBe(1);
    expect([...windows!.values()][0]?.attempts.size).toBe(JOIN_ATTEMPT_LIMIT);
  });

  it("prevents guest-session rotation from bypassing the trusted Vercel network budget", async () => {
    vi.stubEnv("VERCEL", "1");
    const sameNetwork = request({ "x-real-ip": "203.0.113.9" });
    for (let attempt = 0; attempt < JOIN_NETWORK_ATTEMPT_LIMIT; attempt += 1) {
      await expect(consumeJoinAttempt(`p_rotated_${attempt}`, sameNetwork)).resolves.toMatchObject({
        allowed: true,
      });
    }
    await expect(consumeJoinAttempt("p_rotated_blocked", sameNetwork)).resolves.toEqual({
      allowed: false,
      limit: JOIN_ATTEMPT_LIMIT,
      remaining: 0,
      retryAfterSeconds: JOIN_ATTEMPT_WINDOW_SECONDS,
    });
    await expect(consumeJoinAttempt("p_other_network", request({
      "x-real-ip": "198.51.100.7",
    }))).resolves.toMatchObject({ allowed: true });
  });

  it("ignores spoofable forwarding headers and never creates a shared unknown-network bucket", async () => {
    vi.stubEnv("VERCEL", "1");
    for (let attempt = 0; attempt < JOIN_NETWORK_ATTEMPT_LIMIT + 2; attempt += 1) {
      await expect(consumeJoinAttempt(`p_${attempt}`, request({
        "x-forwarded-for": "203.0.113.9",
      }))).resolves.toMatchObject({ allowed: true });
    }
    expect(globalThis.__jazzboardLocalJoinAttemptWindowsV3?.size).toBe(
      JOIN_NETWORK_ATTEMPT_LIMIT + 2,
    );
  });

  it("uses one atomic Redis evaluation with only opaque bounded scopes", async () => {
    vi.stubEnv("VERCEL", "1");
    const redis = {
      eval: vi.fn().mockResolvedValue([
        JOIN_ATTEMPT_LIMIT,
        37,
        JOIN_NETWORK_ATTEMPT_LIMIT,
        29,
        0,
      ]),
    };
    mocks.getRedisForRealtime.mockReturnValue(redis);

    await expect(consumeJoinAttempt(
      "p_signed-session",
      request({ "x-real-ip": "203.0.113.9" }),
    )).resolves.toEqual({
      allowed: false,
      limit: JOIN_ATTEMPT_LIMIT,
      remaining: 0,
      retryAfterSeconds: 37,
    });
    expect(redis.eval).toHaveBeenCalledOnce();
    const args = redis.eval.mock.calls[0]!;
    expect(args[0]).toEqual(expect.stringContaining("if allowed then"));
    expect(args[1]).toBe(2);
    expect(args[2]).toMatch(/^jazzboard:join-attempts:v3:session:[a-f0-9]{64}$/);
    expect(args[3]).toMatch(/^jazzboard:join-attempts:v3:network:[a-f0-9]{64}$/);
    expect(JSON.stringify(args)).not.toContain("203.0.113.9");
    expect(JSON.stringify(args)).not.toContain("p_signed-session");
    expect(args.slice(-5)).toEqual([
      JOIN_ATTEMPT_WINDOW_SECONDS.toString(),
      expect.stringMatching(/^[a-f0-9]{64}$/),
      JOIN_ATTEMPT_LIMIT.toString(),
      JOIN_NETWORK_ATTEMPT_LIMIT.toString(),
      "1",
    ]);
  });
});

const redisServerAvailable = spawnSync("redis-server", ["--version"], {
  stdio: "ignore",
}).status === 0;
const runRedisLuaTests =
  redisServerAvailable && process.env.JAZZBOARD_RUN_REDIS_LUA_TESTS === "1";

describe.runIf(runRedisLuaTests)("join-attempt Redis Lua admission", () => {
  let server: ChildProcess;
  let redis: Redis;
  let directory: string;

  beforeAll(async () => {
    directory = mkdtempSync(join("/tmp", "jbjoin-"));
    const socket = join(directory, "redis.sock");
    server = spawn("redis-server", [
      "--port", "0",
      "--save", "",
      "--appendonly", "no",
      "--unixsocket", socket,
      "--unixsocketperm", "700",
    ], { stdio: "ignore" });
    const deadline = Date.now() + 5_000;
    while (!existsSync(socket) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!existsSync(socket)) throw new Error("Test Redis socket did not start.");
    redis = new Redis({ path: socket, maxRetriesPerRequest: 1 });
    await redis.ping();
  });

  afterAll(async () => {
    await redis?.quit().catch(() => undefined);
    server?.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (!server || server.exitCode !== null) return resolve();
      server.once("exit", () => resolve());
      setTimeout(resolve, 1_000);
    });
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  beforeEach(async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("SESSION_SECRET", "join-attempt-redis-secret-with-enough-entropy");
    mocks.getRedisForRealtime.mockReturnValue(redis);
    await redis.flushdb();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("atomically caps a trusted network across rotated sessions without storing rejections", async () => {
    const sameNetwork = request({ "x-real-ip": "203.0.113.9" });
    for (let attempt = 0; attempt < JOIN_NETWORK_ATTEMPT_LIMIT; attempt += 1) {
      await expect(consumeJoinAttempt(`p_rotated_${attempt}`, sameNetwork)).resolves.toMatchObject({
        allowed: true,
      });
    }

    for (let rejected = 0; rejected < 20; rejected += 1) {
      await expect(consumeJoinAttempt(`p_rejected_${rejected}`, sameNetwork)).resolves.toMatchObject({
        allowed: false,
      });
    }

    const keys = await redis.keys("jazzboard:join-attempts:v3:*");
    const networkKeys = keys.filter((key) => key.includes(":network:"));
    const rejectedSessionKeys = keys.filter((key) => key.includes(":session:"));
    expect(networkKeys).toHaveLength(1);
    expect(await redis.hlen(networkKeys[0]!)).toBe(JOIN_NETWORK_ATTEMPT_LIMIT);
    expect(rejectedSessionKeys).toHaveLength(JOIN_NETWORK_ATTEMPT_LIMIT);
    expect(JSON.stringify(keys)).not.toContain("203.0.113.9");
    expect(JSON.stringify(keys)).not.toContain("p_rotated");
  });
});
