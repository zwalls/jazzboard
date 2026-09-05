import { describe, expect, it } from "vitest";
import { avatarFamilyFor, avatarTraitsFor, type AvatarFamily } from "./ripple-traits";

describe("name-based avatar family selection", () => {
  it("preserves the approved version-one assignments across boards", () => {
    const expected = { Sol: "puddle", Astra: "loop", Mira: "mochi", Kai: "ripple", Juniper: "loop" };
    for (const [name, family] of Object.entries(expected)) {
      expect(avatarFamilyFor(name)).toBe(family);
      expect(avatarTraitsFor(name).family).toBe(family);
      expect(avatarTraitsFor(name)).toEqual(avatarTraitsFor(name));
    }
  });

  it("distributes a large numbered-name population evenly without prefix clustering", () => {
    const counts: Record<AvatarFamily, number> = { puddle: 0, loop: 0, mochi: 0, ripple: 0 };
    for (let i = 1; i <= 10000; i++) counts[avatarFamilyFor(`Agent ${i}`)]++;
    for (const count of Object.values(counts)) {
      expect(count).toBeGreaterThan(2300);
      expect(count).toBeLessThan(2700);
    }
  });
});
