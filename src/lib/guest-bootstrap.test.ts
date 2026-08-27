import { describe, expect, it } from "vitest";

import {
  createGuestBootstrapToken,
  GUEST_BOOTSTRAP_FUTURE_SKEW_MS,
  GUEST_BOOTSTRAP_MAX_AGE_MS,
  parseGuestBootstrapToken,
} from "./guest-bootstrap";

const NOW = Date.parse("2026-08-27T12:00:00.000Z");

describe("guest bootstrap proof", () => {
  it("creates a canonical 256-bit token and parses it only inside its short window", () => {
    const token = createGuestBootstrapToken(NOW, (bytes) => {
      bytes.fill(0xab);
      return bytes;
    });

    expect(token).toBe(`gb1_${NOW.toString(36)}_${"ab".repeat(32)}`);
    expect(parseGuestBootstrapToken(token, NOW)).toEqual({ token, issuedAt: NOW });
    expect(parseGuestBootstrapToken(token, NOW + GUEST_BOOTSTRAP_MAX_AGE_MS)).not.toBeNull();
    expect(parseGuestBootstrapToken(token, NOW + GUEST_BOOTSTRAP_MAX_AGE_MS + 1)).toBeNull();
  });

  it("rejects malformed, truncated, and implausibly future proofs", () => {
    const token = createGuestBootstrapToken(NOW, (bytes) => {
      bytes.fill(0x12);
      return bytes;
    });

    expect(parseGuestBootstrapToken(token.slice(0, -1), NOW)).toBeNull();
    expect(parseGuestBootstrapToken(token.toUpperCase(), NOW)).toBeNull();
    expect(parseGuestBootstrapToken("not-a-bootstrap-proof", NOW)).toBeNull();
    expect(
      parseGuestBootstrapToken(
        createGuestBootstrapToken(NOW + GUEST_BOOTSTRAP_FUTURE_SKEW_MS + 1, (bytes) => bytes),
        NOW,
      ),
    ).toBeNull();
  });
});
