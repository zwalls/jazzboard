import {
  artifactEntrySchema,
  artifactIndexSchema,
  attemptEventSchema,
  attemptRecordSchema,
  attemptRegistrySchema,
  publicAttemptManifestSchema,
  runSpecSchema,
  scoreRunSchema,
  type ArtifactEntry,
  type ArtifactIndex,
  type AttemptAuthorOutcome,
  type AttemptEvent,
  type AttemptLifecycleState,
  type AttemptRecord,
  type AttemptRegistry,
  type PublicAttemptManifest,
  type RunSpec,
  type ScoreRun,
} from "./attempt-schemas";
import { hashCanonicalJson, merkleRoot, type JsonValue } from "./provenance-crypto";

const TRANSITIONS: Readonly<Record<AttemptLifecycleState, readonly AttemptLifecycleState[]>> = {
  allocated: ["provisioned", "infra_failure"],
  provisioned: ["started", "infra_failure"],
  started: ["author_completed", "author_failed", "timeout", "infra_failure", "policy_violation"],
  author_completed: ["sealed"],
  author_failed: ["sealed"],
  timeout: ["sealed"],
  infra_failure: ["sealed"],
  policy_violation: ["sealed"],
  sealed: [],
};

const OUTCOMES: Partial<Record<AttemptLifecycleState, AttemptAuthorOutcome>> = {
  author_completed: "completed",
  author_failed: "failed",
  timeout: "timeout",
  infra_failure: "infra_failure",
  policy_violation: "policy_violation",
};

export function isAllowedAttemptTransition(from: AttemptLifecycleState | null, to: AttemptLifecycleState): boolean {
  return from === null ? to === "allocated" : TRANSITIONS[from].includes(to);
}

type EventPayload = Record<string, JsonValue>;

function withoutEventHash(event: Omit<AttemptEvent, "eventHash"> | AttemptEvent) {
  return {
    schemaVersion: event.schemaVersion,
    attemptId: event.attemptId,
    sequence: event.sequence,
    at: event.at,
    kind: event.kind,
    from: event.from,
    to: event.to,
    payload: event.payload,
    previousEventHash: event.previousEventHash,
  };
}

export function computeEventHash(event: Omit<AttemptEvent, "eventHash"> | AttemptEvent): string {
  return hashCanonicalJson(withoutEventHash(event));
}

function createEvent(input: {
  attemptId: string;
  sequence: number;
  at: string;
  from: AttemptLifecycleState | null;
  to: AttemptLifecycleState;
  payload?: EventPayload;
  previousEventHash: string | null;
}): AttemptEvent {
  const unsigned = {
    schemaVersion: 1 as const,
    attemptId: input.attemptId,
    sequence: input.sequence,
    at: input.at,
    kind: "lifecycle_transition" as const,
    from: input.from,
    to: input.to,
    payload: input.payload ?? {},
    previousEventHash: input.previousEventHash,
  };
  return attemptEventSchema.parse({ ...unsigned, eventHash: computeEventHash(unsigned) });
}

function artifactLeaf(entry: ArtifactEntry): string {
  return hashCanonicalJson({ schemaVersion: 1, entry });
}

export function createArtifactIndex(attemptId: string, entries: readonly ArtifactEntry[]): ArtifactIndex {
  const sorted = entries.map((entry) => artifactEntrySchema.parse(entry)).sort((left, right) => left.path.localeCompare(right.path));
  return artifactIndexSchema.parse({
    schemaVersion: 1,
    attemptId,
    entries: sorted,
    merkleRoot: merkleRoot(sorted.map(artifactLeaf)),
  });
}

export function computeArtifactMerkleRoot(index: ArtifactIndex): string {
  return merkleRoot([...index.entries].sort((left, right) => left.path.localeCompare(right.path)).map(artifactLeaf));
}

export function computeAuthorEvidenceRoot(input: Pick<AttemptRecord, "attemptId" | "runId" | "taskCommitment" | "authorOutcome" | "events" | "artifactIndex">): string {
  const eventHeadHash = input.events.at(-1)?.eventHash;
  if (input.authorOutcome === null || input.artifactIndex === null || eventHeadHash === undefined) {
    throw new Error("Author evidence can be rooted only after outcome, events, and artifacts exist.");
  }
  return hashCanonicalJson({
    schemaVersion: 1,
    attemptId: input.attemptId,
    runId: input.runId,
    taskCommitment: input.taskCommitment,
    authorOutcome: input.authorOutcome,
    eventHeadHash,
    artifactMerkleRoot: input.artifactIndex.merkleRoot,
  });
}

function attemptRegistryProjection(registry: Omit<AttemptRegistry, "registryRoot"> | AttemptRegistry) {
  return {
    schemaVersion: 1,
    runSpecDigest: registry.runSpecDigest,
    attempts: registry.attempts.map((attempt) => ({
      attemptId: attempt.attemptId,
      pairId: attempt.pairId,
      condition: attempt.condition,
      replicateIndex: attempt.replicateIndex,
      orderIndex: attempt.orderIndex,
      timeBlock: attempt.timeBlock,
      parentAttemptId: attempt.parentAttemptId,
      state: attempt.state,
      authorOutcome: attempt.authorOutcome,
      eventHeadHash: attempt.events.at(-1)?.eventHash ?? null,
      authorEvidenceRoot: attempt.authorEvidenceRoot,
      scoringStatus: attempt.scoringStatus,
      scoreRuns: attempt.scoreRuns.map((run) => hashCanonicalJson(run)),
    })),
  };
}

export function computeRegistryRoot(registry: Omit<AttemptRegistry, "registryRoot"> | AttemptRegistry): string {
  return hashCanonicalJson(attemptRegistryProjection(registry));
}

function withRegistryRoot(registry: Omit<AttemptRegistry, "registryRoot">): AttemptRegistry {
  return attemptRegistrySchema.parse({ ...registry, registryRoot: computeRegistryRoot(registry) });
}

export function createAttemptRegistry(runSpecInput: RunSpec): AttemptRegistry {
  const runSpec = runSpecSchema.parse(runSpecInput);
  return withRegistryRoot({
    schemaVersion: 1,
    runSpec,
    runSpecDigest: hashCanonicalJson(runSpec),
    attempts: [],
  });
}

export function allocateAttempt(registryInput: AttemptRegistry, input: {
  attemptId: string;
  taskId: string;
  taskCommitment: string;
  pairId: string;
  condition: "baseline" | "candidate";
  replicateIndex: number;
  orderIndex: 0 | 1;
  timeBlock: number;
  at: string;
  parentAttemptId?: string;
  retryReason?: string;
}): AttemptRegistry {
  const registry = attemptRegistrySchema.parse(registryInput);
  if (registry.attempts.some((attempt) => attempt.attemptId === input.attemptId)) throw new Error(`Attempt ${input.attemptId} already exists; retries require a new attempt ID.`);

  const parentAttemptId = input.parentAttemptId ?? null;
  const retryReason = input.retryReason ?? null;
  if ((parentAttemptId === null) !== (retryReason === null)) throw new Error("Retries require both parentAttemptId and retryReason.");
  if (parentAttemptId !== null) {
    const parent = registry.attempts.find((attempt) => attempt.attemptId === parentAttemptId);
    if (!parent) throw new Error(`Retry parent ${parentAttemptId} is not retained in this registry.`);
    if (parent.state !== "sealed") throw new Error("A retry may be allocated only after its parent attempt is sealed.");
  }

  const event = createEvent({
    attemptId: input.attemptId,
    sequence: 0,
    at: input.at,
    from: null,
    to: "allocated",
    payload: parentAttemptId === null ? {} : { parentAttemptId, retryReason: retryReason as string },
    previousEventHash: null,
  });
  const attempt = attemptRecordSchema.parse({
    schemaVersion: 1,
    attemptId: input.attemptId,
    runId: registry.runSpec.runId,
    taskId: input.taskId,
    taskCommitment: input.taskCommitment,
    pairId: input.pairId,
    condition: input.condition,
    replicateIndex: input.replicateIndex,
    orderIndex: input.orderIndex,
    timeBlock: input.timeBlock,
    parentAttemptId,
    retryReason,
    state: "allocated",
    authorOutcome: null,
    events: [event],
    artifactIndex: null,
    authorEvidenceRoot: null,
    scoringStatus: "unscored",
    scoreRuns: [],
  });
  return withRegistryRoot({ ...registry, attempts: [...registry.attempts, attempt] });
}

function replaceAttempt(registry: AttemptRegistry, replacement: AttemptRecord): AttemptRegistry {
  return withRegistryRoot({
    ...registry,
    attempts: registry.attempts.map((attempt) => attempt.attemptId === replacement.attemptId ? replacement : attempt),
  });
}

export function transitionAttempt(registryInput: AttemptRegistry, attemptId: string, to: Exclude<AttemptLifecycleState, "allocated" | "sealed">, at: string, payload: EventPayload = {}): AttemptRegistry {
  const registry = attemptRegistrySchema.parse(registryInput);
  const attempt = registry.attempts.find((candidate) => candidate.attemptId === attemptId);
  if (!attempt) throw new Error(`Unknown attempt ${attemptId}.`);
  if (!isAllowedAttemptTransition(attempt.state, to)) throw new Error(`Invalid attempt transition ${attempt.state} -> ${to}.`);

  const event = createEvent({
    attemptId,
    sequence: attempt.events.length,
    at,
    from: attempt.state,
    to,
    payload,
    previousEventHash: attempt.events.at(-1)?.eventHash ?? null,
  });
  const replacement = attemptRecordSchema.parse({
    ...attempt,
    state: to,
    authorOutcome: OUTCOMES[to] ?? attempt.authorOutcome,
    events: [...attempt.events, event],
  });
  return replaceAttempt(registry, replacement);
}

export function sealAttempt(registryInput: AttemptRegistry, attemptId: string, at: string, artifactIndexInput: ArtifactIndex): AttemptRegistry {
  const registry = attemptRegistrySchema.parse(registryInput);
  const attempt = registry.attempts.find((candidate) => candidate.attemptId === attemptId);
  if (!attempt) throw new Error(`Unknown attempt ${attemptId}.`);
  if (!isAllowedAttemptTransition(attempt.state, "sealed") || attempt.authorOutcome === null) throw new Error(`Attempt ${attemptId} cannot be sealed from ${attempt.state}.`);
  const artifactIndex = artifactIndexSchema.parse(artifactIndexInput);
  if (artifactIndex.attemptId !== attemptId) throw new Error("Artifact index belongs to another attempt.");

  const event = createEvent({
    attemptId,
    sequence: attempt.events.length,
    at,
    from: attempt.state,
    to: "sealed",
    payload: { artifactMerkleRoot: artifactIndex.merkleRoot, artifactCount: artifactIndex.entries.length },
    previousEventHash: attempt.events.at(-1)?.eventHash ?? null,
  });
  const rootInput = { ...attempt, state: "sealed" as const, events: [...attempt.events, event], artifactIndex };
  const replacement = attemptRecordSchema.parse({ ...rootInput, authorEvidenceRoot: computeAuthorEvidenceRoot(rootInput) });
  return replaceAttempt(registry, replacement);
}

export function appendScoreRun(registryInput: AttemptRegistry, attemptId: string, scoreRunInput: ScoreRun): AttemptRegistry {
  const registry = attemptRegistrySchema.parse(registryInput);
  const attempt = registry.attempts.find((candidate) => candidate.attemptId === attemptId);
  if (!attempt) throw new Error(`Unknown attempt ${attemptId}.`);
  if (attempt.state !== "sealed") throw new Error("Scoring requires sealed author evidence.");
  const scoreRun = scoreRunSchema.parse(scoreRunInput);
  if (attempt.scoreRuns.some((run) => run.scoreRunId === scoreRun.scoreRunId)) throw new Error(`Score run ${scoreRun.scoreRunId} already exists.`);
  const scoreRuns = [...attempt.scoreRuns, scoreRun];
  const scoringStatus = scoreRuns.some((run) => run.status === "succeeded") ? "scored" : "scorer_failed";
  const replacement = attemptRecordSchema.parse({ ...attempt, scoreRuns, scoringStatus });
  return replaceAttempt(registry, replacement);
}

export function createPublicAttemptManifest(attemptInput: AttemptRecord): PublicAttemptManifest {
  const attempt = attemptRecordSchema.parse(attemptInput);
  if (attempt.state !== "sealed" || attempt.authorOutcome === null || attempt.artifactIndex === null || attempt.authorEvidenceRoot === null) {
    throw new Error("Only sealed attempts can be published.");
  }
  const eventHeadHash = attempt.events.at(-1)?.eventHash;
  if (!eventHeadHash) throw new Error("Sealed attempt has no event head.");
  return publicAttemptManifestSchema.parse({
    schemaVersion: 1,
    attemptId: attempt.attemptId,
    runId: attempt.runId,
    task: { id: attempt.taskId, commitment: attempt.taskCommitment },
    assignment: {
      pairId: attempt.pairId,
      condition: attempt.condition,
      replicateIndex: attempt.replicateIndex,
      orderIndex: attempt.orderIndex,
      timeBlock: attempt.timeBlock,
    },
    retry: attempt.parentAttemptId === null ? null : { parentAttemptId: attempt.parentAttemptId, reason: attempt.retryReason },
    state: "sealed",
    authorOutcome: attempt.authorOutcome,
    evidence: {
      authorEvidenceRoot: attempt.authorEvidenceRoot,
      eventHeadHash,
      artifactMerkleRoot: attempt.artifactIndex.merkleRoot,
      artifactCount: attempt.artifactIndex.entries.length,
    },
    scoring: {
      status: attempt.scoringStatus,
      successfulRuns: attempt.scoreRuns.filter((run) => run.status === "succeeded").length,
      failedRuns: attempt.scoreRuns.filter((run) => run.status === "failed").length,
    },
    sensitiveMaterialRedacted: true,
  });
}
