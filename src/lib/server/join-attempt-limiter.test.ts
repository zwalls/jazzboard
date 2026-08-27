// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
} from "./join-attempt-limiter";

const START = new Date("2026-08-26T12:00:00.000Z");

describe("join attempt limiter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(START);
    mocks.getRedisForRealtime.mockReturnValue(null);
    globalThis.__jazzboardLocalJoinAttemptWindows = undefined;
  });

  afterEach(() => {
    globalThis.__jazzboardLocalJoinAttemptWindows = undefined;
    vi.useRealTimers();
  });

  it("limits attempts independently by signed guest participant ID in local development", async () => {
    for (let attempt = 1; attempt <= JOIN_ATTEMPT_LIMIT; attempt += 1) {
      await expect(consumeJoinAttempt("p_alice")).resolves.toEqual({
        allowed: true,
        limit: JOIN_ATTEMPT_LIMIT,
        remaining: JOIN_ATTEMPT_LIMIT - attempt,
        retryAfterSeconds: 0,
      });
    }

    await expect(consumeJoinAttempt("p_alice")).resolves.toEqual({
      allowed: false,
      limit: JOIN_ATTEMPT_LIMIT,
      remaining: 0,
      retryAfterSeconds: JOIN_ATTEMPT_WINDOW_SECONDS,
    });
    await expect(consumeJoinAttempt("p_bob")).resolves.toMatchObject({
      allowed: true,
      remaining: JOIN_ATTEMPT_LIMIT - 1,
    });
  });

  it("opens a fresh local window after the retry interval", async () => {
    for (let attempt = 0; attempt <= JOIN_ATTEMPT_LIMIT; attempt += 1) {
      await consumeJoinAttempt("p_alice");
    }

    vi.advanceTimersByTime(JOIN_ATTEMPT_WINDOW_SECONDS * 1_000);

    await expect(consumeJoinAttempt("p_alice")).resolves.toEqual({
      allowed: true,
      limit: JOIN_ATTEMPT_LIMIT,
      remaining: JOIN_ATTEMPT_LIMIT - 1,
      retryAfterSeconds: 0,
    });
  });

  it("counts one logical keyed attempt only once across delivery retries", async () => {
    await expect(consumeJoinAttempt("p_alice", {
      idempotencyKey: "landing-join-0001",
      requestDigest: "a".repeat(64),
    })).resolves.toMatchObject({
      allowed: true,
      remaining: JOIN_ATTEMPT_LIMIT - 1,
    });
    await expect(consumeJoinAttempt("p_alice", {
      idempotencyKey: "landing-join-0001",
      requestDigest: "a".repeat(64),
    })).resolves.toMatchObject({
      allowed: true,
      remaining: JOIN_ATTEMPT_LIMIT - 1,
    });
    await expect(consumeJoinAttempt("p_alice", {
      idempotencyKey: "landing-join-0001",
      requestDigest: "b".repeat(64),
    })).resolves.toMatchObject({
      allowed: true,
      remaining: JOIN_ATTEMPT_LIMIT - 2,
    });
  });

  it("does not turn the final allowed logical attempt into a rate-limit error on retry", async () => {
    for (let attempt = 1; attempt < JOIN_ATTEMPT_LIMIT; attempt += 1) {
      await consumeJoinAttempt("p_alice", {
        idempotencyKey: `landing-join-${attempt.toString().padStart(4, "0")}`,
        requestDigest: attempt.toString(16).padStart(64, "0"),
      });
    }
    const finalIdentity = {
      idempotencyKey: "landing-join-final",
      requestDigest: "f".repeat(64),
    };

    await expect(consumeJoinAttempt("p_alice", finalIdentity)).resolves.toMatchObject({
      allowed: true,
      remaining: 0,
    });
    await expect(consumeJoinAttempt("p_alice", finalIdentity)).resolves.toMatchObject({
      allowed: true,
      remaining: 0,
    });
    await expect(consumeJoinAttempt("p_alice", {
      idempotencyKey: "landing-join-too-many",
      requestDigest: "e".repeat(64),
    })).resolves.toMatchObject({ allowed: false });
    await expect(consumeJoinAttempt("p_alice", finalIdentity)).resolves.toMatchObject({
      allowed: true,
      remaining: 0,
    });
    await expect(consumeJoinAttempt("p_alice", {
      idempotencyKey: "landing-join-too-many",
      requestDigest: "e".repeat(64),
    })).resolves.toMatchObject({
      allowed: false,
      remaining: 0,
    });
  });

  it("uses an atomic distributed Redis window keyed only by participant ID", async () => {
    const redis = { eval: vi.fn().mockResolvedValue([JOIN_ATTEMPT_LIMIT + 1, 37, 0]) };
    mocks.getRedisForRealtime.mockReturnValue(redis);

    await expect(consumeJoinAttempt("p_signed-session")).resolves.toEqual({
      allowed: false,
      limit: JOIN_ATTEMPT_LIMIT,
      remaining: 0,
      retryAfterSeconds: 37,
    });
    expect(redis.eval).toHaveBeenCalledOnce();
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining('redis.call("HGET", KEYS[1], ARGV[2])'),
      1,
      expect.stringMatching(/^jazzboard:join-attempts:v2:[a-f0-9]{64}$/),
      JOIN_ATTEMPT_WINDOW_SECONDS.toString(),
      expect.stringMatching(/^[a-f0-9]{64}$/),
      JOIN_ATTEMPT_LIMIT.toString(),
    );
  });
});
