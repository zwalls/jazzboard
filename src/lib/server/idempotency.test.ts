import { describe, expect, it } from "vitest";

import {
  assertReceiptMatches,
  canonicalMutationJson,
  createMutationIdentity,
  createMutationReceipt,
  MAX_IDEMPOTENCY_RECEIPT_BYTES,
  mutationRequestDigest,
  parseIdempotencyKey,
  parseMutationReceipt,
  serializeMutationReceipt,
} from "./idempotency";

const identityInput = {
  participantId: "p_never-store-me",
  idempotencyKey: "mutation_12345678",
  namespace: "canvas.command",
  actorKind: "human" as const,
  method: "POST",
  resourceScope: "room_private",
  body: { command: { type: "create", content: "private content", id: "private_object" } },
};

describe("idempotency foundation", () => {
  it("accepts bounded opaque keys and rejects unsafe input", () => {
    expect(parseIdempotencyKey("12345678")).toBe("12345678");
    expect(parseIdempotencyKey(null)).toBeNull();
    expect(() => parseIdempotencyKey("short")).toThrowError(
      expect.objectContaining({ code: "INVALID_IDEMPOTENCY_KEY" }),
    );
    expect(() => parseIdempotencyKey("unsafe key with spaces")).toThrow();
  });

  it("canonicalizes object keys and binds digests to method, namespace, actor, resource, and body", () => {
    expect(canonicalMutationJson({ z: 1, a: { y: 2, x: 3 } })).toBe(
      '{"a":{"x":3,"y":2},"z":1}',
    );
    const first = mutationRequestDigest({
      method: "post",
      namespace: "canvas.command",
      actorKind: "human",
      resourceScope: "room_one",
      body: { z: 1, a: 2 },
    });
    const reordered = mutationRequestDigest({
      method: "POST",
      namespace: "canvas.command",
      actorKind: "human",
      resourceScope: "room_one",
      body: { a: 2, z: 1 },
    });
    expect(reordered).toBe(first);
    expect(mutationRequestDigest({
      method: "POST",
      namespace: "canvas.command",
      actorKind: "agent",
      resourceScope: "room_one",
      body: { a: 2, z: 1 },
    })).not.toBe(first);
    expect(mutationRequestDigest({
      method: "POST",
      namespace: "canvas.command",
      actorKind: "human",
      resourceScope: "room_two",
      body: { a: 2, z: 1 },
    })).not.toBe(first);
  });

  it("uses a participant-scoped opaque Redis key and retains no raw private input", () => {
    const identity = createMutationIdentity(identityInput);
    const encoded = JSON.stringify(identity);
    expect(identity.receiptKey).toMatch(/^jazzboard:mutation:v1:[a-f0-9]{64}$/);
    expect(encoded).not.toContain(identityInput.participantId);
    expect(encoded).not.toContain(identityInput.idempotencyKey);
    expect(encoded).not.toContain("private content");
    expect(encoded).not.toContain("private_object");
  });

  it("serializes a compact content-free receipt and hashes resource references", () => {
    const identity = createMutationIdentity(identityInput);
    const receipt = createMutationReceipt({
      identity,
      outcome: "applied",
      committedAt: 100,
      committedRoomRevision: 7,
      activityId: "activity_private",
      proposalId: "proposal_private",
      resourceId: "snapshot_private",
      changedObjectCount: 3,
      changedDiagramCount: 1,
    });
    const serialized = serializeMutationReceipt(receipt);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThan(MAX_IDEMPOTENCY_RECEIPT_BYTES);
    expect(serialized).not.toContain("activity_private");
    expect(serialized).not.toContain("proposal_private");
    expect(serialized).not.toContain("snapshot_private");
    expect(serialized).not.toContain("private content");
    expect(parseMutationReceipt(serialized)).toEqual(receipt);
    expect(parseMutationReceipt("{}" )).toBeNull();
    expect(parseMutationReceipt(serialized.slice(0, -1) + ',"privateContent":"secret"}')).toEqual(receipt);
  });

  it("distinguishes a replay from key reuse with a different request", () => {
    const identity = createMutationIdentity(identityInput);
    const receipt = createMutationReceipt({
      identity,
      outcome: "applied",
      committedAt: 100,
      committedRoomRevision: 7,
    });
    expect(() => assertReceiptMatches(receipt, identity)).not.toThrow();
    const changed = createMutationIdentity({ ...identityInput, body: { command: "different" } });
    expect(changed.receiptKey).toBe(identity.receiptKey);
    expect(() => assertReceiptMatches(receipt, changed)).toThrowError(
      expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }),
    );
  });
});
