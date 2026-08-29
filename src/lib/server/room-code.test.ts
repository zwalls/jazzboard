// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import {
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  isCurrentRoomCode,
} from "@/lib/domain/room-code";

import {
  allocateLocalRoomCode,
  generateRoomCode,
  ROOM_CODE_ALLOCATION_MAX_ATTEMPTS,
} from "./room-code";

describe("secure room-code allocation", () => {
  it("generates only current-format candidates from the shared alphabet", () => {
    for (let index = 0; index < 256; index += 1) {
      const code = generateRoomCode();
      expect(code).toHaveLength(ROOM_CODE_LENGTH);
      expect(isCurrentRoomCode(code)).toBe(true);
      expect([...code].every((character) => ROOM_CODE_ALPHABET.includes(character))).toBe(true);
    }
  });

  it("retries a process-local collision without replacing the existing mapping", () => {
    const candidates = ["AAAAAA", "BBBBBB"];
    const createCandidate = vi.fn(() => candidates.shift() ?? "CCCCCC");

    expect(
      allocateLocalRoomCode((code) => code === "AAAAAA", createCandidate),
    ).toBe("BBBBBB");
    expect(createCandidate).toHaveBeenCalledTimes(2);
  });

  it("bounds process-local allocation when every candidate collides", () => {
    const createCandidate = vi.fn(() => "AAAAAA");

    expect(() => allocateLocalRoomCode(() => true, createCandidate)).toThrow(
      "Unable to allocate a unique room code.",
    );
    expect(createCandidate).toHaveBeenCalledTimes(ROOM_CODE_ALLOCATION_MAX_ATTEMPTS);
  });
});
