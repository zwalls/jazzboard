import {
  artifactIndexSchema,
  attemptEventSchema,
  attemptRecordSchema,
  attemptRegistrySchema,
  publicAttemptManifestSchema,
  type ArtifactIndex,
  type AttemptEvent,
  type AttemptRecord,
  type AttemptRegistry,
  type PublicAttemptManifest,
} from "./attempt-schemas";
import {
  computeArtifactMerkleRoot,
  computeAuthorEvidenceRoot,
  computeEventHash,
  computeRegistryRoot,
  createPublicAttemptManifest,
  isAllowedAttemptTransition,
} from "./attempt-ledger";
import { hashCanonicalJson, sha256Digest } from "./provenance-crypto";
import { findSecretLeakage } from "./provenance-redaction";

export type VerificationResult = { ok: true } | { ok: false; errors: string[] };

function result(errors: string[]): VerificationResult {
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

export function verifyEventChain(events: readonly AttemptEvent[], expectedAttemptId?: string): VerificationResult {
  const errors: string[] = [];
  if (events.length === 0) errors.push("Event chain is empty.");

  events.forEach((event, index) => {
    const parsed = (() => {
      const candidate = attemptEventSchema.safeParse(event);
      if (!candidate.success) {
        errors.push(`Event ${index} fails schema validation.`);
        return null;
      }
      return candidate.data;
    })();
    if (!parsed) return;
    if (parsed.sequence !== index) errors.push(`Event ${index} has sequence ${parsed.sequence}.`);
    if (expectedAttemptId !== undefined && parsed.attemptId !== expectedAttemptId) errors.push(`Event ${index} belongs to another attempt.`);
    if (index === 0) {
      if (parsed.previousEventHash !== null) errors.push("Initial event has a previous hash.");
      if (parsed.from !== null || parsed.to !== "allocated") errors.push("Initial event is not null -> allocated.");
    } else {
      const previous = events[index - 1];
      if (parsed.previousEventHash !== previous.eventHash) errors.push(`Event ${index} previous hash does not match event ${index - 1}.`);
      if (parsed.from !== previous.to) errors.push(`Event ${index} does not continue the previous lifecycle state.`);
      if (!isAllowedAttemptTransition(parsed.from, parsed.to)) errors.push(`Event ${index} contains invalid transition ${parsed.from} -> ${parsed.to}.`);
      if (Date.parse(parsed.at) < Date.parse(previous.at)) errors.push(`Event ${index} timestamp precedes event ${index - 1}.`);
    }
    if (computeEventHash(parsed) !== parsed.eventHash) errors.push(`Event ${index} hash is invalid.`);
  });

  return result(errors);
}

export function verifyArtifactIndex(indexInput: ArtifactIndex): VerificationResult {
  const parsed = artifactIndexSchema.safeParse(indexInput);
  if (!parsed.success) return { ok: false, errors: ["Artifact index fails schema validation."] };
  const expected = computeArtifactMerkleRoot(parsed.data);
  return result(expected === parsed.data.merkleRoot ? [] : ["Artifact Merkle root is invalid."]);
}

export function verifyArtifactPayload(indexInput: ArtifactIndex, path: string, payload: string | Uint8Array): VerificationResult {
  const index = artifactIndexSchema.safeParse(indexInput);
  if (!index.success) return { ok: false, errors: ["Artifact index fails schema validation."] };
  const entry = index.data.entries.find((candidate) => candidate.path === path);
  if (!entry) return { ok: false, errors: [`Artifact ${path} is absent from the index.`] };
  const byteLength = typeof payload === "string" ? Buffer.byteLength(payload, "utf8") : payload.byteLength;
  const errors: string[] = [];
  if (entry.bytes !== byteLength) errors.push(`Artifact ${path} byte size is invalid.`);
  if (entry.sha256 !== sha256Digest(payload)) errors.push(`Artifact ${path} digest is invalid.`);
  return result(errors);
}

export function verifyAttemptRecord(attemptInput: AttemptRecord): VerificationResult {
  const parsed = attemptRecordSchema.safeParse(attemptInput);
  if (!parsed.success) return { ok: false, errors: ["Attempt record fails schema validation."] };
  const attempt = parsed.data;
  const errors: string[] = [];
  const chain = verifyEventChain(attempt.events, attempt.attemptId);
  if (!chain.ok) errors.push(...chain.errors);
  if (attempt.events.at(-1)?.to !== attempt.state) errors.push("Attempt state does not match the final event.");

  const expectedOutcome = attempt.events.some((event) => event.to === "author_completed") ? "completed"
    : attempt.events.some((event) => event.to === "author_failed") ? "failed"
      : attempt.events.some((event) => event.to === "timeout") ? "timeout"
        : attempt.events.some((event) => event.to === "infra_failure") ? "infra_failure"
          : attempt.events.some((event) => event.to === "policy_violation") ? "policy_violation" : null;
  if (attempt.authorOutcome !== expectedOutcome) errors.push("Author outcome does not match the lifecycle event chain.");

  if (attempt.artifactIndex !== null) {
    const artifacts = verifyArtifactIndex(attempt.artifactIndex);
    if (!artifacts.ok) errors.push(...artifacts.errors);
  }
  if (attempt.state === "sealed") {
    const finalPayload = attempt.events.at(-1)?.payload;
    if (attempt.artifactIndex !== null && (
      finalPayload?.artifactMerkleRoot !== attempt.artifactIndex.merkleRoot
      || finalPayload?.artifactCount !== attempt.artifactIndex.entries.length
    )) errors.push("Sealing event does not match the artifact index.");
    try {
      if (computeAuthorEvidenceRoot(attempt) !== attempt.authorEvidenceRoot) errors.push("Author evidence root is invalid.");
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Author evidence root cannot be computed.");
    }
  }
  return result(errors);
}

export function verifyAttemptRegistry(registryInput: AttemptRegistry): VerificationResult {
  const parsed = attemptRegistrySchema.safeParse(registryInput);
  if (!parsed.success) return { ok: false, errors: ["Attempt registry fails schema validation."] };
  const registry = parsed.data;
  const errors: string[] = [];
  if (hashCanonicalJson(registry.runSpec) !== registry.runSpecDigest) errors.push("Run specification digest is invalid.");
  if (computeRegistryRoot(registry) !== registry.registryRoot) errors.push("Registry root is invalid.");
  registry.attempts.forEach((attempt, index) => {
    const verification = verifyAttemptRecord(attempt);
    if (!verification.ok) errors.push(...verification.errors.map((message) => `Attempt ${index}: ${message}`));
  });
  return result(errors);
}

export function verifyPublicAttemptManifest(manifestInput: PublicAttemptManifest, knownSecrets: readonly string[] = []): VerificationResult {
  const parsed = publicAttemptManifestSchema.safeParse(manifestInput);
  const errors: string[] = [];
  if (!parsed.success) errors.push("Public manifest fails schema validation.");
  const leaks = findSecretLeakage(manifestInput, knownSecrets);
  if (leaks.length > 0) errors.push(`Public manifest contains secret material: ${leaks.join(", ")}`);
  return result(errors);
}

export function verifyPublicManifestAgainstAttempt(manifestInput: PublicAttemptManifest, attemptInput: AttemptRecord, knownSecrets: readonly string[] = []): VerificationResult {
  const publicVerification = verifyPublicAttemptManifest(manifestInput, knownSecrets);
  const attemptVerification = verifyAttemptRecord(attemptInput);
  const errors = [
    ...(publicVerification.ok ? [] : publicVerification.errors),
    ...(attemptVerification.ok ? [] : attemptVerification.errors),
  ];
  if (errors.length === 0) {
    try {
      if (hashCanonicalJson(manifestInput) !== hashCanonicalJson(createPublicAttemptManifest(attemptInput))) errors.push("Public manifest does not match the sealed attempt.");
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Public manifest comparison failed.");
    }
  }
  return result(errors);
}
