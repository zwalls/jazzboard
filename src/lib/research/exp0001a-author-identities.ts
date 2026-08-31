import executionManifestJson from "../../../research/data/development-execution-manifest-v1.json";

import { verifyDevelopmentExecutionManifest } from "./development-manifest";
import { hashCanonicalJson, SHA256_DIGEST_PATTERN } from "./provenance-crypto";

/**
 * This is a public namespace commitment, not an authentication secret. Its
 * only purpose is to give every frozen author process a stable, coordinator-
 * issued identity that is distinct from every evaluator identity. It must
 * never be described as proving who operated a process.
 */
export const EXP0001A_AUTHOR_IDENTITY_NAMESPACE =
  "sha256:7e50926f42147dcbe0866bdc4935fcb24264dd5bc49ed44a6984830185fb7c25" as const;

export type Exp0001aAuthorSessionIdentity = Readonly<{
  attemptId: string;
  identityCommitment: string;
}>;

export type Exp0001aAuthorSessionIdentityManifest = Readonly<{
  schemaVersion: 1;
  manifestId: "exp-0001a-author-session-identities-v1";
  protocolId: "EXP-0001A";
  scheduleManifestDigest: string;
  identityNamespaceDigest: string;
  semantics: "opaque-process-instance-label-not-authentication";
  identities: readonly Exp0001aAuthorSessionIdentity[];
  manifestRoot: string;
}>;

function orderedAttemptIds(): string[] {
  const verification = verifyDevelopmentExecutionManifest(executionManifestJson);
  if (!verification.ok) {
    throw new Error(`Cannot compile author identities from an invalid execution manifest: ${verification.errors.join(", ")}`);
  }
  return [...verification.manifest.assignments]
    .sort((left, right) => left.timeBlock - right.timeBlock)
    .flatMap((pair) => [...pair.attempts]
      .sort((left, right) => left.orderIndex - right.orderIndex)
      .map((attempt) => attempt.attemptId));
}

function identityCommitment(attemptId: string): string {
  return hashCanonicalJson({
    schemaVersion: "exp-0001a-author-process-identity/v1",
    protocolId: "EXP-0001A",
    scheduleManifestDigest: executionManifestJson.manifestDigest,
    identityNamespaceDigest: EXP0001A_AUTHOR_IDENTITY_NAMESPACE,
    attemptId,
  });
}

function withoutRoot(manifest: Exp0001aAuthorSessionIdentityManifest) {
  const { manifestRoot: _ignored, ...content } = manifest;
  void _ignored;
  return content;
}

export function computeExp0001aAuthorIdentityManifestRoot(
  manifest: Exp0001aAuthorSessionIdentityManifest,
): string {
  return hashCanonicalJson(withoutRoot(manifest));
}

export function verifyExp0001aAuthorIdentityManifest(
  input: Exp0001aAuthorSessionIdentityManifest,
): Exp0001aAuthorSessionIdentityManifest {
  const expectedAttemptIds = orderedAttemptIds();
  if (input.schemaVersion !== 1
      || input.manifestId !== "exp-0001a-author-session-identities-v1"
      || input.protocolId !== "EXP-0001A"
      || input.scheduleManifestDigest !== executionManifestJson.manifestDigest
      || input.identityNamespaceDigest !== EXP0001A_AUTHOR_IDENTITY_NAMESPACE
      || input.semantics !== "opaque-process-instance-label-not-authentication") {
    throw new Error("Author identity manifest metadata drifted from EXP-0001A.");
  }
  if (input.identities.length !== expectedAttemptIds.length
      || input.identities.some((entry, index) => entry.attemptId !== expectedAttemptIds[index])) {
    throw new Error("Author identity manifest does not cover the exact frozen attempt order.");
  }
  const ids = input.identities.map((entry) => entry.attemptId);
  const commitments = input.identities.map((entry) => entry.identityCommitment);
  if (new Set(ids).size !== ids.length || new Set(commitments).size !== commitments.length) {
    throw new Error("Author process identities must be unique.");
  }
  input.identities.forEach((entry) => {
    if (!SHA256_DIGEST_PATTERN.test(entry.identityCommitment)
        || entry.identityCommitment !== identityCommitment(entry.attemptId)) {
      throw new Error(`Author process identity commitment drifted for ${entry.attemptId}.`);
    }
  });
  if (input.manifestRoot !== computeExp0001aAuthorIdentityManifestRoot(input)) {
    throw new Error("Author identity manifest root is invalid.");
  }
  return input;
}

const identityContent = {
  schemaVersion: 1 as const,
  manifestId: "exp-0001a-author-session-identities-v1" as const,
  protocolId: "EXP-0001A" as const,
  scheduleManifestDigest: executionManifestJson.manifestDigest,
  identityNamespaceDigest: EXP0001A_AUTHOR_IDENTITY_NAMESPACE,
  semantics: "opaque-process-instance-label-not-authentication" as const,
  identities: orderedAttemptIds().map((attemptId) => ({
    attemptId,
    identityCommitment: identityCommitment(attemptId),
  })),
};

export const EXP0001A_AUTHOR_SESSION_IDENTITIES = verifyExp0001aAuthorIdentityManifest({
  ...identityContent,
  manifestRoot: hashCanonicalJson(identityContent),
});

export function exp0001aAuthorIdentityCommitments(): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(
    EXP0001A_AUTHOR_SESSION_IDENTITIES.identities.map((entry) => [entry.attemptId, entry.identityCommitment]),
  ));
}
