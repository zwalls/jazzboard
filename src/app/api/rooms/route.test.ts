// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

import { DomainError } from "@/lib/domain/errors";
import { DEFAULT_JSON_REQUEST_BYTES } from "@/lib/server/capacity";
import { currentMutationContext } from "@/lib/server/mutation-context";

const mocks = vi.hoisted(() => ({
  consumeJoinAttempt: vi.fn(),
  createRoom: vi.fn(),
  getOrCreateGuestSession: vi.fn(),
  joinRoom: vi.fn(),
}));

vi.mock("@/lib/server/join-attempt-limiter", () => ({
  consumeJoinAttempt: mocks.consumeJoinAttempt,
}));
vi.mock("@/lib/server/room-store", () => ({
  getRoomStore: () => ({ createRoom: mocks.createRoom, joinRoom: mocks.joinRoom }),
}));
vi.mock("@/lib/server/session", () => ({
  getOrCreateGuestSession: mocks.getOrCreateGuestSession,
}));

import { POST } from "./route";

function request(body: unknown, headers?: HeadersInit): Request {
  return new Request("https://jazzboard.example/api/rooms", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("room create and exact-code join route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getOrCreateGuestSession.mockReturnValue({
      participantId: "p_signed-session",
      setCookie: "jazzboard_guest=new-signed-cookie; Path=/; HttpOnly; SameSite=Lax",
    });
    mocks.consumeJoinAttempt.mockResolvedValue({
      allowed: true,
      limit: 8,
      remaining: 7,
      retryAfterSeconds: 0,
    });
    mocks.createRoom.mockResolvedValue({ id: "room_created", code: "ABC234" });
    mocks.joinRoom.mockResolvedValue({ id: "room_joined", code: "ABC234" });
  });

  it("normalizes and limits a validated join before exact lookup", async () => {
    const response = await POST(
      request({ action: "join", code: "abc-234", displayName: "Ada", role: "participant" }, {
        "x-real-ip": "203.0.113.9",
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.consumeJoinAttempt).toHaveBeenCalledWith(
      "p_signed-session",
      expect.any(Request),
      null,
    );
    expect(mocks.joinRoom).toHaveBeenCalledWith({
      participantId: "p_signed-session",
      code: "ABC234",
      displayName: "Ada",
      role: "participant",
    });
    expect(response.headers.get("set-cookie")).toContain("jazzboard_guest=new-signed-cookie");
  });

  it("rejects prefixes, invalid alphabets, Unicode lookalikes, and arrays before consuming an attempt", async () => {
    for (const code of ["ABC23", "ABC2345", "ABO234", "ABⅠ234", "ABC*34", ["ABC234", "DEF567"]]) {
      const response = await POST(
        request({ action: "join", code, displayName: "Ada", role: "participant" }),
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { code: "INVALID_REQUEST" },
      });
      expect(response.headers.get("set-cookie")).toContain("jazzboard_guest=new-signed-cookie");
    }
    expect(mocks.consumeJoinAttempt).not.toHaveBeenCalled();
    expect(mocks.joinRoom).not.toHaveBeenCalled();
  });

  it("returns the newly issued guest cookie with malformed JSON errors", async () => {
    const response = await POST(
      new Request("https://jazzboard.example/api/rooms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not-json",
      }),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("set-cookie")).toContain("jazzboard_guest=new-signed-cookie");
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
  });

  it("returns a structured retry response and the newly issued guest cookie when limited", async () => {
    mocks.consumeJoinAttempt.mockResolvedValue({
      allowed: false,
      limit: 8,
      remaining: 0,
      retryAfterSeconds: 37,
    });

    const response = await POST(
      request({ action: "join", code: "ABC234", displayName: "Ada", role: "spectator" }),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("37");
    expect(response.headers.get("set-cookie")).toContain("jazzboard_guest=new-signed-cookie");
    expect(await response.json()).toEqual({
      ok: false,
      error: {
        code: "JOIN_RATE_LIMITED",
        message: "Too many room-code attempts. Try again in 37 seconds.",
        details: { limit: 8, remaining: 0, retryAfterSeconds: 37 },
      },
    });
    expect(mocks.joinRoom).not.toHaveBeenCalled();
  });

  it("returns the newly issued guest cookie when an exact-code join fails", async () => {
    mocks.joinRoom.mockRejectedValue(
      new DomainError("ROOM_NOT_FOUND", "No Jazzboard exists with that code."),
    );

    const response = await POST(
      request({ action: "join", code: "ZZZ999", displayName: "Ada", role: "participant" }),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("set-cookie")).toContain("jazzboard_guest=new-signed-cookie");
    expect(await response.json()).toMatchObject({
      ok: false,
      error: {
        code: "ROOM_NOT_FOUND",
        message: "Jazzboard could not join with that code.",
      },
    });
  });

  it("keeps exact legacy four-digit rooms joinable", async () => {
    const response = await POST(
      request({ action: "join", code: "12-34", displayName: "Ada", role: "participant" }),
    );

    expect(response.status).toBe(200);
    expect(mocks.joinRoom).toHaveBeenCalledWith({
      participantId: "p_signed-session",
      code: "1234",
      displayName: "Ada",
      role: "participant",
    });
  });

  it("fails closed with a generic response when distributed join admission is unavailable", async () => {
    mocks.consumeJoinAttempt.mockRejectedValue(new Error("redis connection failed"));

    const response = await POST(
      request({ action: "join", code: "ABC234", displayName: "Ada", role: "participant" }),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("set-cookie")).toContain("jazzboard_guest=new-signed-cookie");
    expect(await response.json()).toEqual({
      ok: false,
      error: {
        code: "JOIN_UNAVAILABLE",
        message: "Jazzboard could not complete that join right now. Try again shortly.",
      },
    });
    expect(mocks.joinRoom).not.toHaveBeenCalled();
  });

  it("preserves unthrottled room creation", async () => {
    const response = await POST(request({ action: "create", displayName: "Ada", title: "Design" }));

    expect(response.status).toBe(200);
    expect(mocks.createRoom).toHaveBeenCalledWith({
      participantId: "p_signed-session",
      displayName: "Ada",
      title: "Design",
    });
    expect(mocks.consumeJoinAttempt).not.toHaveBeenCalled();
  });

  it("binds a caller idempotency key to the authenticated room-creation mutation", async () => {
    let observed = null as ReturnType<typeof currentMutationContext>;
    mocks.createRoom.mockImplementation(async () => {
      observed = currentMutationContext();
      return { id: "room_created", code: "ABC234" };
    });

    const response = await POST(request(
      { action: "create", displayName: "Ada", title: "Design" },
      { "idempotency-key": "create-room-route-0001" },
    ));

    expect(response.status).toBe(200);
    expect(observed).toMatchObject({
      operation: "room.create",
      actorKind: "human",
      idempotency: {
        namespace: "room.create",
        actorKind: "human",
      },
    });
  });

  it("deduplicates join-rate accounting by the keyed canonical request", async () => {
    const response = await POST(request(
      { action: "join", code: "abc-234", displayName: "Ada", role: "participant" },
      { "idempotency-key": "landing-join-route-0001" },
    ));

    expect(response.status).toBe(200);
    expect(mocks.consumeJoinAttempt).toHaveBeenCalledWith(
      "p_signed-session",
      expect.any(Request),
      {
        idempotencyKey: "landing-join-route-0001",
        requestDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    );
  });

  it("rejects oversized JSON before a room mutation runs", async () => {
    const response = await POST(request({
      action: "create",
      displayName: "Ada",
      title: "Design",
      padding: "x".repeat(DEFAULT_JSON_REQUEST_BYTES),
    }));

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "REQUEST_TOO_LARGE" },
    });
    expect(mocks.createRoom).not.toHaveBeenCalled();
    expect(mocks.joinRoom).not.toHaveBeenCalled();
  });

  it.each([{}, { action: "search", codePrefix: "00" }, { action: "CREATE" }])(
    "fails closed when action is missing or unknown",
    async (body) => {
      const response = await POST(request(body));

      expect(response.status).toBe(400);
      expect(response.headers.get("set-cookie")).toContain("jazzboard_guest=new-signed-cookie");
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { code: "INVALID_REQUEST" },
      });
      expect(mocks.createRoom).not.toHaveBeenCalled();
      expect(mocks.joinRoom).not.toHaveBeenCalled();
      expect(mocks.consumeJoinAttempt).not.toHaveBeenCalled();
    },
  );
});
