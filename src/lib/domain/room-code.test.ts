import { describe, expect, it } from "vitest";

import {
  formatRoomCode,
  isCurrentRoomCode,
  isLegacyRoomCode,
  isSupportedRoomCode,
  normalizeRoomCode,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
} from "./room-code";

describe("room codes", () => {
  it("defines a six-character unambiguous 32-symbol alphabet", () => {
    expect(ROOM_CODE_LENGTH).toBe(6);
    expect(ROOM_CODE_ALPHABET).toHaveLength(32);
    expect(new Set(ROOM_CODE_ALPHABET).size).toBe(32);
    expect(ROOM_CODE_ALPHABET).not.toMatch(/[01IO]/);
  });

  it("normalizes current codes without guessing Unicode or lookalike characters", () => {
    expect(normalizeRoomCode("abc-234")).toBe("ABC234");
    expect(normalizeRoomCode(" AB C2 34 ")).toBe("ABC234");
    expect(normalizeRoomCode("ABC234")).toBe("ABC234");
    expect(normalizeRoomCode("ABO234")).toBeNull();
    expect(normalizeRoomCode("ABⅠ234")).toBeNull();
    expect(normalizeRoomCode("ＡＢＣ234")).toBeNull();
  });

  it("keeps exact legacy four-digit rooms compatible", () => {
    expect(normalizeRoomCode("12-34")).toBe("1234");
    expect(isLegacyRoomCode("1234")).toBe(true);
    expect(isSupportedRoomCode("1234")).toBe(true);
    expect(isCurrentRoomCode("1234")).toBe(false);
  });

  it("rejects prefixes, suffixes, and unsupported lengths", () => {
    for (const value of ["ABC23", "ABC2345", "123", "12345", "ABC_234", "ABC/234", ""]) {
      expect(normalizeRoomCode(value)).toBeNull();
    }
  });

  it("groups only current codes for human display", () => {
    expect(formatRoomCode("ABC234")).toBe("ABC-234");
    expect(formatRoomCode("1234")).toBe("1234");
  });
});
