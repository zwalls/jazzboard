import { describe, expect, it } from "vitest";

import executionManifestJson from "../../../research/data/development-execution-manifest-v1.json";

import {
  EXP0001A_AUTHOR_SESSION_IDENTITIES,
  computeExp0001aAuthorIdentityManifestRoot,
  exp0001aAuthorIdentityCommitments,
  verifyExp0001aAuthorIdentityManifest,
} from "./exp0001a-author-identities";

describe("EXP-0001A author process identities", () => {
  it("pre-registers one unique opaque process identity for every frozen attempt", () => {
    const expectedIds = [...executionManifestJson.assignments]
      .sort((left, right) => left.timeBlock - right.timeBlock)
      .flatMap((pair) => [...pair.attempts]
        .sort((left, right) => left.orderIndex - right.orderIndex)
        .map((attempt) => attempt.attemptId));

    expect(EXP0001A_AUTHOR_SESSION_IDENTITIES.identities.map((entry) => entry.attemptId)).toEqual(expectedIds);
    expect(EXP0001A_AUTHOR_SESSION_IDENTITIES.identities).toHaveLength(48);
    expect(new Set(EXP0001A_AUTHOR_SESSION_IDENTITIES.identities.map((entry) => entry.identityCommitment)).size).toBe(48);
    expect(EXP0001A_AUTHOR_SESSION_IDENTITIES.manifestRoot)
      .toBe(computeExp0001aAuthorIdentityManifestRoot(EXP0001A_AUTHOR_SESSION_IDENTITIES));
    expect(exp0001aAuthorIdentityCommitments()).toEqual(Object.fromEntries(
      EXP0001A_AUTHOR_SESSION_IDENTITIES.identities.map((entry) => [entry.attemptId, entry.identityCommitment]),
    ));
  });

  it("rejects reordered, missing, duplicated, or self-issued identities", () => {
    for (const mutate of [
      (value: typeof EXP0001A_AUTHOR_SESSION_IDENTITIES) => ({ ...value, identities: value.identities.slice(1) }),
      (value: typeof EXP0001A_AUTHOR_SESSION_IDENTITIES) => ({ ...value, identities: [value.identities[1], value.identities[0], ...value.identities.slice(2)] }),
      (value: typeof EXP0001A_AUTHOR_SESSION_IDENTITIES) => ({ ...value, identities: value.identities.map((entry, index) => index === 1
        ? { ...entry, identityCommitment: value.identities[0].identityCommitment }
        : entry) }),
      (value: typeof EXP0001A_AUTHOR_SESSION_IDENTITIES) => ({ ...value, identities: value.identities.map((entry, index) => index === 0
        ? { ...entry, identityCommitment: "sha256:" + "a".repeat(64) }
        : entry) }),
    ]) {
      const tampered = mutate(structuredClone(EXP0001A_AUTHOR_SESSION_IDENTITIES));
      expect(() => verifyExp0001aAuthorIdentityManifest({
        ...tampered,
        manifestRoot: computeExp0001aAuthorIdentityManifestRoot(tampered as typeof EXP0001A_AUTHOR_SESSION_IDENTITIES),
      } as typeof EXP0001A_AUTHOR_SESSION_IDENTITIES)).toThrow(/identit|attempt order/i);
    }
  });

  it("does not overclaim authentication semantics", () => {
    expect(EXP0001A_AUTHOR_SESSION_IDENTITIES.semantics).toBe("opaque-process-instance-label-not-authentication");
    expect(JSON.stringify(EXP0001A_AUTHOR_SESSION_IDENTITIES)).not.toMatch(/token|password|cookie|roomCode|sessionId/i);
  });
});
