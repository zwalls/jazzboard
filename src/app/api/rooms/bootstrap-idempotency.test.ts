// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createGuestBootstrapToken, GUEST_BOOTSTRAP_HEADER } from "@/lib/guest-bootstrap";
import { getRoomStore } from "@/lib/server/room-store";
import { parseGuestParticipantId } from "@/lib/server/session";

import { POST } from "./route";

type RoomPayload = {
  ok: true;
  participantId: string;
  room: {
    id: string;
    code: string;
    roomRevision: number;
    participants: Record<string, unknown>;
  };
};

function cookieHeader(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error("Expected a signed guest-session cookie.");
  return setCookie.split(";", 1)[0];
}

function bootstrapRequest(input: {
  body: unknown;
  bootstrap: string;
  idempotencyKey: string;
}): Request {
  return new Request("https://jazzboard.example/api/rooms", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [GUEST_BOOTSTRAP_HEADER]: input.bootstrap,
      "idempotency-key": input.idempotencyKey,
    },
    body: JSON.stringify(input.body),
  });
}

async function payload(response: Response): Promise<RoomPayload> {
  expect(response.status).toBe(200);
  return response.json() as Promise<RoomPayload>;
}

describe("room-route guest bootstrap idempotency", () => {
  beforeEach(() => {
    vi.stubEnv("REDIS_URL", "");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("SESSION_SECRET", "bootstrap-route-test-secret-with-32-chars");
    globalThis.__jazzboardRoomStore = undefined;
    globalThis.__jazzboardLocalState = undefined;
    globalThis.__jazzboardRedis = undefined;
    globalThis.__jazzboardLocalJoinAttemptWindows = undefined;
  });

  afterEach(() => {
    globalThis.__jazzboardRoomStore = undefined;
    globalThis.__jazzboardLocalState = undefined;
    globalThis.__jazzboardRedis = undefined;
    globalThis.__jazzboardLocalJoinAttemptWindows = undefined;
    vi.unstubAllEnvs();
  });

  it("returns the exact same room and signed participant after the first create response is lost", async () => {
    const bootstrap = createGuestBootstrapToken();
    const input = {
      body: { action: "create", displayName: "Maya", title: "Retry-safe room" },
      bootstrap,
      idempotencyKey: "landing-create-retry-0001",
    };

    const firstResponse = await POST(bootstrapRequest(input));
    const first = await payload(firstResponse);
    // Simulate a caller that never received either the body or Set-Cookie and
    // therefore repeats the request without a cookie.
    const retryResponse = await POST(bootstrapRequest(input));
    const retry = await payload(retryResponse);

    expect(retry).toEqual(first);
    expect(Object.keys(retry.room.participants)).toEqual([first.participantId]);
    expect(
      parseGuestParticipantId(
        new Request("https://jazzboard.example/room", {
          headers: { cookie: cookieHeader(retryResponse) },
        }),
      ),
    ).toBe(first.participantId);
    await expect(getRoomStore().getRoom(first.room.id)).resolves.toMatchObject({
      id: first.room.id,
      code: first.room.code,
      participants: { [first.participantId]: { displayName: "Maya" } },
    });
  });

  it("adds one membership when an exact-code join response is lost and retried without its cookie", async () => {
    const host = await payload(await POST(bootstrapRequest({
      body: { action: "create", displayName: "Host", title: "Join retry" },
      bootstrap: createGuestBootstrapToken(),
      idempotencyKey: "landing-host-create-0001",
    })));
    const joinInput = {
      body: {
        action: "join",
        code: host.room.code,
        displayName: "Guest",
        role: "participant",
      },
      bootstrap: createGuestBootstrapToken(),
      idempotencyKey: "landing-join-retry-0001",
    };

    const firstJoin = await payload(await POST(bootstrapRequest(joinInput)));
    const retryJoin = await payload(await POST(bootstrapRequest(joinInput)));

    expect(retryJoin.participantId).toBe(firstJoin.participantId);
    expect(retryJoin.room.id).toBe(host.room.id);
    expect(retryJoin.room.roomRevision).toBe(firstJoin.room.roomRevision);
    expect(Object.keys(retryJoin.room.participants)).toHaveLength(2);
    expect(retryJoin.room.participants).toHaveProperty(host.participantId);
    expect(retryJoin.room.participants).toHaveProperty(firstJoin.participantId);
  });

  it("fails closed without issuing a session when a bootstrap proof is invalid", async () => {
    const response = await POST(bootstrapRequest({
      body: { action: "create", displayName: "Maya", title: "Invalid bootstrap" },
      bootstrap: "guessable",
      idempotencyKey: "landing-create-invalid-0001",
    }));

    expect(response.status).toBe(400);
    expect(response.headers.get("set-cookie")).toBeNull();
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_GUEST_BOOTSTRAP" },
    });
  });
});
