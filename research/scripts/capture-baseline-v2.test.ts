import { describe, expect, it } from "vitest";

// The production capture is executable ESM and intentionally has no ambient declaration file.
// @ts-expect-error committed ESM capture script intentionally has no typings
import { assertPrivateInventoryScope, buildInventoryScope, canonicalJson, collectCaptureIdentityValues, hashCanonicalJson, projectPublicInventoryScope, redactCaptureIdentities } from "./capture-baseline-v2.mjs";

describe("baseline-v2 production capture primitives", () => {
  const tools = [
    {
      name: "read_room_state",
      title: "Read room state",
      description: "Reads semantic state.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
    },
    {
      name: "create_shape",
      title: "Create shape",
      description: "Creates one semantic shape.",
      inputSchema: {
        type: "object",
        properties: { label: { type: "string" } },
        required: ["label"],
        additionalProperties: false,
      },
      annotations: { destructiveHint: false, readOnlyHint: false },
    },
  ];

  it("retains normalized descriptors privately and produces a compact public projection", () => {
    const scope = buildInventoryScope(tools);
    expect(assertPrivateInventoryScope(scope)).toBe(scope);
    expect(scope.descriptors.map((descriptor: { name: string }) => descriptor.name)).toEqual([
      "create_shape",
      "read_room_state",
    ]);
    expect(scope.contractDigest).toBe(hashCanonicalJson(scope.descriptors));
    for (const [index, descriptor] of scope.descriptors.entries()) {
      expect(scope.tools[index]).toEqual({
        name: descriptor.name,
        definitionDigest: hashCanonicalJson(descriptor),
      });
    }
    const publicScope = projectPublicInventoryScope(scope);
    expect(publicScope).not.toHaveProperty("descriptors");
    expect(publicScope.contractDigest).toBe(scope.contractDigest);
  });

  it("fails closed when a retained descriptor cannot reproduce its digest", () => {
    const scope = buildInventoryScope(tools);
    scope.descriptors[0].description = "tampered";
    expect(() => assertPrivateInventoryScope(scope)).toThrow(/contract digest is not reproducible/);
  });

  it("redacts room, code, participant, session, and embedded identity strings", () => {
    const input = {
      room: { roomId: "room_private-12345678", code: "RG3ZYE" },
      selfParticipantId: "participant-private",
      sessionToken: "cookie-private",
      nested: { href: "/room/room_private-12345678?code=RG3ZYE" },
    };
    const identities = collectCaptureIdentityValues(input);
    const redacted = redactCaptureIdentities(input, identities);
    const serialized = canonicalJson(redacted);
    expect(serialized).not.toContain("room_private");
    expect(serialized).not.toContain("RG3ZYE");
    expect(serialized).not.toContain("participant-private");
    expect(serialized).not.toContain("cookie-private");
    expect(serialized).toContain("[REDACTED]");
  });
});
