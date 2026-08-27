// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createGuestBootstrapToken, GUEST_BOOTSTRAP_HEADER } from "@/lib/guest-bootstrap";

import {
  getOrCreateGuestSession,
  parseGuestParticipantId,
  requireGuestParticipantId,
} from "./session";

const START = new Date("2026-08-25T12:00:00.000Z");

function cookieHeader(setCookie: string | null): string {
  if (!setCookie) throw new Error("Expected a newly issued guest cookie.");
  return setCookie.split(";", 1)[0];
}

describe("guest sessions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    vi.stubEnv("SESSION_SECRET", "test-session-secret-with-enough-entropy");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("issues a persistent signed participant cookie and reuses it", () => {
    const first = getOrCreateGuestSession(new Request("https://jazzboard.example/api/rooms"));

    expect(first.participantId).toMatch(/^p_[A-Za-z0-9_-]{24}$/);
    expect(first.setCookie).toContain("jazzboard_guest=");
    expect(first.setCookie).toContain("Path=/");
    expect(first.setCookie).toContain("HttpOnly");
    expect(first.setCookie).toContain("SameSite=Lax");
    expect(first.setCookie).toContain("Max-Age=31536000");

    const authenticatedRequest = new Request("https://jazzboard.example/api/rooms", {
      headers: { cookie: cookieHeader(first.setCookie) },
    });
    expect(parseGuestParticipantId(authenticatedRequest)).toBe(first.participantId);
    expect(getOrCreateGuestSession(authenticatedRequest)).toEqual({
      participantId: first.participantId,
      setCookie: null,
    });
  });

  it("derives the same signed guest identity for an ambiguous bootstrap retry", () => {
    const bootstrap = createGuestBootstrapToken(START.getTime(), (bytes) => {
      bytes.fill(0x42);
      return bytes;
    });
    const headers = {
      [GUEST_BOOTSTRAP_HEADER]: bootstrap,
      "idempotency-key": "landing-create-0001",
    };

    const first = getOrCreateGuestSession(
      new Request("https://jazzboard.example/api/rooms", { method: "POST", headers }),
    );
    const retry = getOrCreateGuestSession(
      new Request("https://jazzboard.example/api/rooms", { method: "POST", headers }),
    );

    expect(retry.participantId).toBe(first.participantId);
    expect(first.participantId).toMatch(/^p_[A-Za-z0-9_-]{24}$/);
    expect(
      parseGuestParticipantId(
        new Request("https://jazzboard.example/", { headers: { cookie: cookieHeader(retry.setCookie) } }),
      ),
    ).toBe(first.participantId);
  });

  it("binds the bootstrap identity to its logical idempotency key", () => {
    const bootstrap = createGuestBootstrapToken(START.getTime(), (bytes) => {
      bytes.fill(0x24);
      return bytes;
    });
    const session = (idempotencyKey: string) => getOrCreateGuestSession(
      new Request("https://jazzboard.example/api/rooms", {
        method: "POST",
        headers: {
          [GUEST_BOOTSTRAP_HEADER]: bootstrap,
          "idempotency-key": idempotencyKey,
        },
      }),
    );

    expect(session("landing-create-0001").participantId).not.toBe(
      session("landing-create-0002").participantId,
    );
  });

  it("keeps an established signed session authoritative over bootstrap headers", () => {
    const established = getOrCreateGuestSession(new Request("https://jazzboard.example/api/rooms"));
    const authenticated = getOrCreateGuestSession(
      new Request("https://jazzboard.example/api/rooms", {
        method: "POST",
        headers: {
          cookie: cookieHeader(established.setCookie),
          [GUEST_BOOTSTRAP_HEADER]: "malformed-and-must-be-ignored",
        },
      }),
    );

    expect(authenticated).toEqual({ participantId: established.participantId, setCookie: null });
  });

  it("rejects malformed or expired bootstrap proofs before issuing authorization", () => {
    const request = (bootstrap: string, idempotencyKey = "landing-create-0001") =>
      new Request("https://jazzboard.example/api/rooms", {
        method: "POST",
        headers: {
          [GUEST_BOOTSTRAP_HEADER]: bootstrap,
          "idempotency-key": idempotencyKey,
        },
      });

    expect(() => getOrCreateGuestSession(request("guessable"))).toThrowError(
      expect.objectContaining({ code: "INVALID_GUEST_BOOTSTRAP" }),
    );
    const expired = createGuestBootstrapToken(
      START.getTime() - 10 * 60 * 1_000 - 1,
      (bytes) => bytes,
    );
    expect(() => getOrCreateGuestSession(request(expired))).toThrowError(
      expect.objectContaining({ code: "INVALID_GUEST_BOOTSTRAP" }),
    );
    const fresh = createGuestBootstrapToken(START.getTime(), (bytes) => bytes);
    expect(() => getOrCreateGuestSession(request(fresh, "short"))).toThrowError(
      expect.objectContaining({ code: "INVALID_IDEMPOTENCY_KEY" }),
    );
  });

  it("rejects tampered and expired cookies", () => {
    const session = getOrCreateGuestSession(new Request("https://jazzboard.example/"));
    const cookie = cookieHeader(session.setCookie);
    const tampered = cookie.replace(session.participantId, "p_attacker");

    expect(
      parseGuestParticipantId(
        new Request("https://jazzboard.example/", { headers: { cookie: tampered } }),
      ),
    ).toBeNull();

    vi.setSystemTime(new Date(START.getTime() + 365 * 24 * 60 * 60 * 1_000 + 1));
    expect(
      parseGuestParticipantId(
        new Request("https://jazzboard.example/", { headers: { cookie } }),
      ),
    ).toBeNull();
  });

  it("treats malformed cookie encoding as unauthenticated", () => {
    const request = new Request("https://jazzboard.example/", {
      headers: { cookie: "jazzboard_guest=%E0%A4%A" },
    });

    expect(parseGuestParticipantId(request)).toBeNull();
    expect(() => requireGuestParticipantId(request)).toThrow("AUTH_REQUIRED");
  });

  it("requires a strong configured signing secret and marks production cookies Secure", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SESSION_SECRET", "too-short");
    expect(() =>
      getOrCreateGuestSession(new Request("https://jazzboard.example/")),
    ).toThrow("at least 32 characters");

    vi.stubEnv("SESSION_SECRET", "a-production-secret-that-is-at-least-32-characters");
    expect(getOrCreateGuestSession(new Request("https://jazzboard.example/")).setCookie).toContain(
      "; Secure",
    );
  });
});
