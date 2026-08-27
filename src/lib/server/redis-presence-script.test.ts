// @vitest-environment node

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import Redis from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  REDIS_PRESENCE_COMMIT_SCRIPT,
  redisPresenceScript,
  redisPresenceScriptSha,
} from "./redis-presence-script";

describe("atomic Redis presence script", () => {
  it("keeps the steady key surface to awareness, coordination, and one compact stream", () => {
    expect(REDIS_PRESENCE_COMMIT_SCRIPT).toContain('redis.call("MGET", KEYS[1], KEYS[2])');
    expect(REDIS_PRESENCE_COMMIT_SCRIPT).toContain('redis.pcall("MSET", KEYS[1]');
    expect(REDIS_PRESENCE_COMMIT_SCRIPT).toContain('"XADD", KEYS[3]');
    expect(REDIS_PRESENCE_COMMIT_SCRIPT).not.toContain("WATCH");
    expect(REDIS_PRESENCE_COMMIT_SCRIPT).not.toContain("KEYS[4]");
  });

  it("uses Upstash key locking only for the provider-specific script variant", () => {
    expect(redisPresenceScript(false).startsWith("#!lua")).toBe(false);
    expect(redisPresenceScript(true)).toMatch(/^#!lua flags=allow-key-locking\n/);
    expect(redisPresenceScriptSha(redisPresenceScript(true))).toMatch(/^[a-f0-9]{40}$/);
    expect(redisPresenceScriptSha(redisPresenceScript(false)))
      .not.toBe(redisPresenceScriptSha(redisPresenceScript(true)));
  });

  it("preserves empty arrays and required nullable fields across provider cjson variants", () => {
    expect(REDIS_PRESENCE_COMMIT_SCRIPT).toContain(
      `string.gsub(encoded, '"followingParticipantIds":{}', '"followingParticipantIds":[]')`,
    );
    expect(REDIS_PRESENCE_COMMIT_SCRIPT).toContain(
      `string.gsub(encoded, '"objectIds":{}', '"objectIds":[]')`,
    );
    expect(REDIS_PRESENCE_COMMIT_SCRIPT).toContain(
      `string.gsub(encoded, '"leases":%[%]', '"leases":{}')`,
    );
    expect(REDIS_PRESENCE_COMMIT_SCRIPT).toContain(
      `local null_marker = "JAZZBOARD_INTERNAL_NULL_7D65C042A48B4F75"`,
    );
    expect(REDIS_PRESENCE_COMMIT_SCRIPT).toContain(
      `'"' .. field .. '":null'`,
    );
  });
});

const redisServerAvailable = spawnSync("redis-server", ["--version"], {
  stdio: "ignore",
}).status === 0;
const runRedisLuaTests =
  redisServerAvailable && process.env.JAZZBOARD_RUN_REDIS_LUA_TESTS === "1";

describe.runIf(runRedisLuaTests)("atomic Redis presence Lua serialization", () => {
  let server: ChildProcess;
  let redis: Redis;
  let directory: string;

  beforeAll(async () => {
    directory = mkdtempSync(join("/tmp", "jbpresence-"));
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
    await redis.flushdb();
  });

  it("keeps the lease map object-shaped across empty and populated presence writes", async () => {
    const keys = ["awareness", "coordination", "events"];
    const awareness = {
      schemaVersion: 1,
      participants: {
        owner: {
          member: {
            participantId: "owner",
            displayName: "Owner",
            color: "blue",
            role: "participant",
            joinedAt: 1,
          },
          lastSeenAt: 1,
          connected: true,
          agentActive: false,
          human: { cursor: null, viewport: null, lastSeenAt: 1, activity: null },
          agent: { cursor: null, viewport: null, lastSeenAt: 1, activity: null },
        },
      },
      spotlight: null,
    };
    const coordination = {
      schemaVersion: 1,
      stateRevision: 1,
      roomRevision: 1,
      legacyRetired: true,
      leases: {},
    };
    await redis.mset(keys[0], JSON.stringify(awareness), keys[1], JSON.stringify(coordination));

    const commitPresence = async (now: number) => redis.eval(
      REDIS_PRESENCE_COMMIT_SCRIPT,
      3,
      ...keys,
      "room_alpha",
      "owner",
      "human",
      String(now),
      JSON.stringify({ cursor: null, viewport: null, activity: null }),
      "75000",
      "enforce",
      String(2 * 1024 * 1024),
      String(1.5 * 1024 * 1024),
      String(8 * 1024 * 1024),
      `presence-${now}`,
      `derived-${now}`,
    );

    const firstReply = await commitPresence(1_000) as unknown[];
    expect(firstReply[0]).toBe("ok");
    expect(JSON.parse(String(firstReply[1]))).toMatchObject({
      actor: { kind: "human" },
      payload: {
        presence: {
          cursor: null,
          viewport: null,
          activity: null,
          lastSeenAt: 1_000,
        },
      },
    });
    expect(JSON.parse((await redis.get(keys[0]))!)).toMatchObject({
      spotlight: null,
      participants: {
        owner: {
          human: { cursor: null, viewport: null, activity: null },
          agent: { cursor: null, viewport: null, activity: null },
        },
      },
    });
    const afterEmpty = JSON.parse((await redis.get(keys[1]))!) as typeof coordination;
    expect(Array.isArray(afterEmpty.leases)).toBe(false);
    expect(afterEmpty.leases).toEqual({});

    const lease = {
      leaseId: "lease-1",
      objectId: "node-1",
      actor: { participantId: "owner", displayName: "Owner", color: "blue", kind: "human" },
      operation: "move",
      objectRevision: 1,
      acquiredAt: 1_100,
      expiresAt: 6_000,
    };
    await redis.set(keys[1], JSON.stringify({ ...afterEmpty, leases: { "node-1": lease } }));
    expect((await commitPresence(2_000) as unknown[])[0]).toBe("ok");
    const afterLease = JSON.parse((await redis.get(keys[1]))!) as {
      leases: Record<string, typeof lease>;
    };
    expect(Array.isArray(afterLease.leases)).toBe(false);
    expect(afterLease.leases["node-1"]).toEqual(lease);
  });
});
