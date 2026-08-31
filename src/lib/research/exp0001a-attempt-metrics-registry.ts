import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import {
  attemptMetricsArtifactSchema,
  attemptMetricsFrozenBindingsSchema,
  extractExp0001aAttemptMetrics,
  verifyExp0001aAttemptMetricsArtifact,
  type AttemptMetricsExtractionInput,
} from "./attempt-metrics";
import { canonicalJson, hashCanonicalJson, SHA256_DIGEST_PATTERN } from "./provenance-crypto";

const digestSchema = z.string().regex(SHA256_DIGEST_PATTERN);
const stableIdSchema = z.string().trim().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const timestampSchema = z.string().datetime({ offset: true });

export const EXP0001A_ATTEMPT_METRICS_REGISTRY_SOURCE_PATH =
  "src/lib/research/exp0001a-attempt-metrics-registry.ts" as const;
export const EXP0001A_ATTEMPT_METRICS_REGISTRY_VERSION =
  "exp-0001a-attempt-metrics-registry/v1" as const;

const registrySourceBindingSchema = z.object({
  sourcePath: z.literal(EXP0001A_ATTEMPT_METRICS_REGISTRY_SOURCE_PATH),
  sourceDigest: digestSchema,
  version: z.literal(EXP0001A_ATTEMPT_METRICS_REGISTRY_VERSION),
}).strict();

const expectedAttemptSchema = z.object({
  attemptId: stableIdSchema,
  pairId: stableIdSchema,
  taskId: stableIdSchema,
  taskDigest: digestSchema,
  treatment: z.enum(["A0", "A1"]),
  attemptBundleDigest: digestSchema,
  artifactRoot: digestSchema,
  authorEvidenceRoot: digestSchema.nullable(),
  rawEvidenceRoot: digestSchema,
  evaluatorAssessmentEnvelopeDigest: digestSchema.nullable(),
}).strict();

const registryBindingContentSchema = z.object({
  schemaVersion: z.literal(1),
  protocolId: z.literal("EXP-0001A"),
  authorizationReceiptDigest: digestSchema,
  expectedAttempts: z.array(expectedAttemptSchema).length(48),
  scoringSpecDigest: digestSchema,
  extractor: attemptMetricsFrozenBindingsSchema.shape.extractor,
  scorer: attemptMetricsFrozenBindingsSchema.shape.scorer,
  evaluatorAuthority: attemptMetricsFrozenBindingsSchema.shape.evaluatorAuthority,
  registry: registrySourceBindingSchema,
}).strict().superRefine((binding, context) => {
  const attemptIds = new Set<string>();
  for (const [index, attempt] of binding.expectedAttempts.entries()) {
    if (attemptIds.has(attempt.attemptId)) {
      context.addIssue({ code: "custom", path: ["expectedAttempts", index, "attemptId"], message: "Duplicate attempt ID." });
    }
    attemptIds.add(attempt.attemptId);
  }
  const pairTreatments = new Set(binding.expectedAttempts.map((attempt) => `${attempt.pairId}:${attempt.treatment}`));
  if (pairTreatments.size !== 48) {
    context.addIssue({ code: "custom", path: ["expectedAttempts"], message: "Each pair/treatment slot must occur exactly once." });
  }
  const byPair = new Map<string, { taskId: string; digest: string; treatments: Set<string> }>();
  for (const attempt of binding.expectedAttempts) {
    const pair = byPair.get(attempt.pairId) ?? {
      taskId: attempt.taskId,
      digest: attempt.taskDigest,
      treatments: new Set<string>(),
    };
    if (pair.taskId !== attempt.taskId || pair.digest !== attempt.taskDigest) {
      context.addIssue({ code: "custom", path: ["expectedAttempts"], message: `Pair ${attempt.pairId} changes task identity.` });
    }
    pair.treatments.add(attempt.treatment);
    byPair.set(attempt.pairId, pair);
  }
  if (byPair.size !== 24 || [...byPair.values()].some((pair) => (
    pair.treatments.size !== 2 || !pair.treatments.has("A0") || !pair.treatments.has("A1")
  ))) {
    context.addIssue({
      code: "custom",
      path: ["expectedAttempts"],
      message: "EXP-0001A requires exactly 24 pairs with one A0 and one A1 attempt apiece.",
    });
  }
  const taskPairs = new Map<string, Set<string>>();
  const taskDigests = new Map<string, string>();
  for (const [pairId, pair] of byPair) {
    const priorDigest = taskDigests.get(pair.taskId);
    if (priorDigest !== undefined && priorDigest !== pair.digest) {
      context.addIssue({
        code: "custom",
        path: ["expectedAttempts"],
        message: `Task ${pair.taskId} changes its frozen digest between randomized pairs.`,
      });
    }
    taskDigests.set(pair.taskId, pair.digest);
    const pairs = taskPairs.get(pair.taskId) ?? new Set<string>();
    pairs.add(pairId);
    taskPairs.set(pair.taskId, pairs);
  }
  if (taskPairs.size !== 12 || [...taskPairs.values()].some((pairs) => pairs.size !== 2)) {
    context.addIssue({
      code: "custom",
      path: ["expectedAttempts"],
      message: "EXP-0001A requires exactly 12 tasks represented by two independently randomized pairs each.",
    });
  }
});

export const exp0001aAttemptMetricsRegistryBindingSchema = registryBindingContentSchema.extend({
  bindingRoot: digestSchema,
}).strict();

export type Exp0001aAttemptMetricsRegistryBinding = z.infer<
  typeof exp0001aAttemptMetricsRegistryBindingSchema
>;

const metricsRegistryEventContentSchema = z.object({
  schemaVersion: z.literal(1),
  protocolId: z.literal("EXP-0001A"),
  kind: z.literal("attempt_metrics_retained"),
  sequence: z.number().int().min(0).max(47),
  previousEventDigest: digestSchema.nullable(),
  retainedAt: timestampSchema,
  bindingRoot: digestSchema,
  pairId: stableIdSchema,
  treatment: z.enum(["A0", "A1"]),
  metricsArtifact: attemptMetricsArtifactSchema,
}).strict();

export const exp0001aAttemptMetricsRegistryEventSchema = metricsRegistryEventContentSchema.extend({
  eventDigest: digestSchema,
}).strict();

export type Exp0001aAttemptMetricsRegistryEvent = z.infer<
  typeof exp0001aAttemptMetricsRegistryEventSchema
>;

const completionSealContentSchema = z.object({
  schemaVersion: z.literal(1),
  protocolId: z.literal("EXP-0001A"),
  kind: z.literal("attempt_metrics_registry_completion"),
  sealedAt: timestampSchema,
  bindingRoot: digestSchema,
  expectedAttemptCount: z.literal(48),
  retainedAttemptCount: z.literal(48),
  finalEventDigest: digestSchema,
  registryRoot: digestSchema,
}).strict();

export const exp0001aAttemptMetricsRegistryCompletionSealSchema = completionSealContentSchema.extend({
  sealDigest: digestSchema,
}).strict();

export type Exp0001aAttemptMetricsRegistryCompletionSeal = z.infer<
  typeof exp0001aAttemptMetricsRegistryCompletionSealSchema
>;

export type Exp0001aAttemptMetricsRegistrySummary = Readonly<{
  bindingRoot: string;
  registryRoot: string;
  expectedAttemptCount: 48;
  retainedAttemptCount: number;
  remainingAttemptIds: readonly string[];
  denominatorComplete: boolean;
  completionSealDigest: string | null;
}>;

export type Exp0001aAttemptMetricsRegistrySnapshot = Readonly<{
  events: readonly Exp0001aAttemptMetricsRegistryEvent[];
  completionSeal: Exp0001aAttemptMetricsRegistryCompletionSeal | null;
  summary: Exp0001aAttemptMetricsRegistrySummary;
}>;

export type Exp0001aAttemptMetricsRegistry = Readonly<{
  append(input: AttemptMetricsExtractionInput): Promise<Exp0001aAttemptMetricsRegistryEvent>;
  read(): Promise<Exp0001aAttemptMetricsRegistrySnapshot>;
  seal(): Promise<Exp0001aAttemptMetricsRegistryCompletionSeal>;
  requireComplete(expectedCompletionSealDigest: string): Promise<Exp0001aAttemptMetricsRegistrySnapshot>;
}>;

function withoutDigest<T extends Record<string, unknown>>(value: T, field: keyof T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== field));
}

export function createExp0001aAttemptMetricsRegistryBinding(
  input: z.input<typeof registryBindingContentSchema>,
): Exp0001aAttemptMetricsRegistryBinding {
  const content = registryBindingContentSchema.parse(input);
  return exp0001aAttemptMetricsRegistryBindingSchema.parse({
    ...content,
    bindingRoot: hashCanonicalJson(content),
  });
}

export function verifyExp0001aAttemptMetricsRegistryBinding(
  input: unknown,
): Exp0001aAttemptMetricsRegistryBinding {
  const binding = exp0001aAttemptMetricsRegistryBindingSchema.parse(input);
  if (hashCanonicalJson(withoutDigest(binding, "bindingRoot")) !== binding.bindingRoot) {
    throw new Error("Attempt-metrics registry binding root does not verify.");
  }
  return binding;
}

export function computeExp0001aAttemptMetricsRegistryEventDigest(
  event: Exp0001aAttemptMetricsRegistryEvent,
): string {
  return hashCanonicalJson(metricsRegistryEventContentSchema.parse(withoutDigest(event, "eventDigest")));
}

export function computeExp0001aAttemptMetricsRegistryRoot(
  bindingRoot: string,
  events: readonly Exp0001aAttemptMetricsRegistryEvent[],
): string {
  digestSchema.parse(bindingRoot);
  return hashCanonicalJson({
    schemaVersion: 1,
    protocolId: "EXP-0001A",
    bindingRoot,
    eventDigests: events.map((event) => event.eventDigest),
  });
}

function verifyCompletionSeal(
  sealInput: unknown,
  binding: Exp0001aAttemptMetricsRegistryBinding,
  events: readonly Exp0001aAttemptMetricsRegistryEvent[],
): Exp0001aAttemptMetricsRegistryCompletionSeal {
  const seal = exp0001aAttemptMetricsRegistryCompletionSealSchema.parse(sealInput);
  if (hashCanonicalJson(withoutDigest(seal, "sealDigest")) !== seal.sealDigest) {
    throw new Error("Attempt-metrics completion seal digest does not verify.");
  }
  const registryRoot = computeExp0001aAttemptMetricsRegistryRoot(binding.bindingRoot, events);
  if (events.length !== 48 || seal.bindingRoot !== binding.bindingRoot
      || seal.finalEventDigest !== events[47]?.eventDigest || seal.registryRoot !== registryRoot
      || Date.parse(seal.sealedAt) < Date.parse(events[47].retainedAt)) {
    throw new Error("Attempt-metrics completion seal does not match the exact 48-entry registry.");
  }
  return seal;
}

function eventFileName(event: Exp0001aAttemptMetricsRegistryEvent): string {
  return `${event.sequence.toString().padStart(6, "0")}-${event.eventDigest.slice("sha256:".length, "sha256:".length + 16)}.json`;
}

async function statNoFollow(filePath: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function ensurePlainDirectory(directory: string): Promise<void> {
  const current = await statNoFollow(directory);
  if (!current) await mkdir(directory, { recursive: false, mode: 0o700 });
  const retained = await lstat(directory);
  if (!retained.isDirectory() || retained.isSymbolicLink()) {
    throw new Error("Attempt-metrics registry path must be a plain directory.");
  }
  if ((retained.mode & 0o077) !== 0 || (typeof process.getuid === "function" && retained.uid !== process.getuid())) {
    throw new Error("Attempt-metrics registry directory must be private and owned by the executing user.");
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readPlainFile(filePath: string): Promise<Buffer> {
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600
        || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
      throw new Error("Attempt-metrics registry entry must be a private, singly linked, owner-controlled plain file.");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function retainExclusive(filePath: string, value: unknown): Promise<void> {
  const handle = await open(
    filePath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(canonicalJson(value), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(filePath));
  const retained = await readPlainFile(filePath);
  if (retained.toString("utf8") !== canonicalJson(value)) {
    throw new Error("Attempt-metrics registry durable readback differs from the bytes written.");
  }
}

async function readJsonFile(filePath: string, label: string): Promise<unknown> {
  try {
    return JSON.parse((await readPlainFile(filePath)).toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} is not valid JSON.`);
    throw error;
  }
}

function validateEventChain(
  eventsInput: readonly Exp0001aAttemptMetricsRegistryEvent[],
  binding: Exp0001aAttemptMetricsRegistryBinding,
): Exp0001aAttemptMetricsRegistryEvent[] {
  const events = eventsInput.map((event) => exp0001aAttemptMetricsRegistryEventSchema.parse(event));
  const seenAttemptIds = new Set<string>();
  let previousEventDigest: string | null = null;
  let previousRetainedAtMs = -1;
  events.forEach((event, sequence) => {
    const expected = binding.expectedAttempts[sequence];
    if (!expected || event.sequence !== sequence || event.previousEventDigest !== previousEventDigest
        || event.bindingRoot !== binding.bindingRoot
        || computeExp0001aAttemptMetricsRegistryEventDigest(event) !== event.eventDigest) {
      throw new Error("Attempt-metrics registry event order, binding, or hash chain is invalid.");
    }
    const retainedAtMs = Date.parse(event.retainedAt);
    if (retainedAtMs < previousRetainedAtMs) {
      throw new Error("Attempt-metrics registry retention timestamps are not monotonic.");
    }
    previousRetainedAtMs = retainedAtMs;
    const artifact = verifyExp0001aAttemptMetricsArtifact(event.metricsArtifact);
    if (seenAttemptIds.has(artifact.attemptId)) throw new Error(`Duplicate attempt metrics: ${artifact.attemptId}.`);
    seenAttemptIds.add(artifact.attemptId);
    const evaluatorEnvelopeDigest = artifact.provenance.evaluatorAssessment.status === "observed"
      ? artifact.provenance.evaluatorAssessment.envelope.envelopeDigest : null;
    if (event.pairId !== expected.pairId || event.treatment !== expected.treatment || artifact.attemptId !== expected.attemptId
        || artifact.taskId !== expected.taskId || artifact.provenance.taskDigest !== expected.taskDigest
        || artifact.provenance.scoringSpecDigest !== binding.scoringSpecDigest
        || artifact.provenance.attemptBundleDigest !== expected.attemptBundleDigest
        || artifact.provenance.artifactRoot !== expected.artifactRoot
        || artifact.provenance.authorEvidenceRoot !== expected.authorEvidenceRoot
        || artifact.provenance.rawEvidence.rawEvidenceRoot !== expected.rawEvidenceRoot
        || evaluatorEnvelopeDigest !== expected.evaluatorAssessmentEnvelopeDigest
        || canonicalJson(artifact.provenance.extractor) !== canonicalJson(binding.extractor)
        || canonicalJson(artifact.provenance.scorer) !== canonicalJson(binding.scorer)
        || canonicalJson(artifact.provenance.evaluatorAuthority) !== canonicalJson(binding.evaluatorAuthority)) {
      throw new Error(`Attempt metrics at sequence ${sequence} drift from the frozen 48-entry registry binding.`);
    }
    previousEventDigest = event.eventDigest;
  });
  return events;
}

async function loadRegistry(input: {
  directory: string;
  binding: Exp0001aAttemptMetricsRegistryBinding;
  allowLock: boolean;
}): Promise<Exp0001aAttemptMetricsRegistrySnapshot> {
  await ensurePlainDirectory(input.directory);
  const entries = await readdir(input.directory);
  const allowed = (name: string) => /^\d{6}-[a-f0-9]{16}\.json$/.test(name)
    || name === "completion.json" || (input.allowLock && name === ".append.lock");
  const unexpected = entries.filter((name) => !allowed(name));
  if (unexpected.length > 0) {
    throw new Error(`Attempt-metrics registry contains unexpected entries: ${unexpected.sort().join(", ")}`);
  }
  if (!input.allowLock && entries.includes(".append.lock")) {
    throw new Error("Attempt-metrics registry is locked or requires crash recovery; refusing an uncertain read.");
  }
  const eventNames = entries.filter((name) => /^\d{6}-[a-f0-9]{16}\.json$/.test(name)).sort();
  const rawEvents: Exp0001aAttemptMetricsRegistryEvent[] = [];
  for (const name of eventNames) {
    const event = exp0001aAttemptMetricsRegistryEventSchema.parse(
      await readJsonFile(path.join(input.directory, name), `Attempt-metrics event ${name}`),
    );
    if (eventFileName(event) !== name) throw new Error("Attempt-metrics event filename does not match retained bytes.");
    rawEvents.push(event);
  }
  const events = validateEventChain(rawEvents, input.binding);
  const completionPath = path.join(input.directory, "completion.json");
  const completionPresent = entries.includes("completion.json");
  const completionSeal = completionPresent
    ? verifyCompletionSeal(await readJsonFile(completionPath, "Attempt-metrics completion seal"), input.binding, events)
    : null;
  const registryRoot = computeExp0001aAttemptMetricsRegistryRoot(input.binding.bindingRoot, events);
  return Object.freeze({
    events: Object.freeze(events),
    completionSeal,
    summary: Object.freeze({
      bindingRoot: input.binding.bindingRoot,
      registryRoot,
      expectedAttemptCount: 48 as const,
      retainedAttemptCount: events.length,
      remainingAttemptIds: Object.freeze(input.binding.expectedAttempts.slice(events.length).map((attempt) => attempt.attemptId)),
      denominatorComplete: events.length === 48 && completionSeal !== null,
      completionSealDigest: completionSeal?.sealDigest ?? null,
    }),
  });
}

export function createExp0001aAttemptMetricsRegistry(input: {
  directory: string;
  binding: Exp0001aAttemptMetricsRegistryBinding;
  authorizedBindingRoot: string;
  authorizationReceiptDigest: string;
  now?: () => string;
}): Exp0001aAttemptMetricsRegistry {
  if (!path.isAbsolute(input.directory)) throw new Error("Attempt-metrics registry directory must be absolute.");
  const binding = verifyExp0001aAttemptMetricsRegistryBinding(input.binding);
  digestSchema.parse(input.authorizedBindingRoot);
  digestSchema.parse(input.authorizationReceiptDigest);
  if (binding.bindingRoot !== input.authorizedBindingRoot) {
    throw new Error("Attempt-metrics registry binding is not the execution-authorized binding root.");
  }
  if (binding.authorizationReceiptDigest !== input.authorizationReceiptDigest) {
    throw new Error("Attempt-metrics registry binding is attached to another execution authorization receipt.");
  }
  const now = input.now ?? (() => new Date().toISOString());
  const lockPath = path.join(input.directory, ".append.lock");

  const read = async () => loadRegistry({ directory: input.directory, binding, allowLock: false });

  const withLock = async <T>(operation: () => Promise<T>): Promise<T> => {
    await ensurePlainDirectory(input.directory);
    let lockHandle;
    try {
      lockHandle = await open(
        lockPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error("Attempt-metrics registry is already locked; refusing concurrent or uncertain execution.");
      }
      throw error;
    }
    try {
      await lockHandle.writeFile(canonicalJson({ schemaVersion: 1, acquiredAt: now(), pid: process.pid }), "utf8");
      await lockHandle.sync();
      await syncDirectory(input.directory);
      return await operation();
    } finally {
      await lockHandle.close().catch(() => {});
      await unlink(lockPath).catch(() => {});
      await syncDirectory(input.directory).catch(() => {});
    }
  };

  return Object.freeze({
    async append(extractionInput) {
      const artifact = verifyExp0001aAttemptMetricsArtifact(
        extractExp0001aAttemptMetrics(extractionInput).scoreArtifact,
      );
      return withLock(async () => {
        const current = await loadRegistry({ directory: input.directory, binding, allowLock: true });
        if (current.completionSeal) throw new Error("Attempt-metrics registry is sealed and immutable.");
        if (current.events.some((event) => event.metricsArtifact.attemptId === artifact.attemptId)) {
          throw new Error(`Duplicate attempt metrics: ${artifact.attemptId}.`);
        }
        const expected = binding.expectedAttempts[current.events.length];
        if (!expected) throw new Error("Attempt-metrics registry already contains all 48 expected attempts.");
        const evaluatorEnvelopeDigest = artifact.provenance.evaluatorAssessment.status === "observed"
          ? artifact.provenance.evaluatorAssessment.envelope.envelopeDigest : null;
        if (artifact.attemptId !== expected.attemptId || artifact.taskId !== expected.taskId
            || artifact.provenance.taskDigest !== expected.taskDigest
            || artifact.provenance.scoringSpecDigest !== binding.scoringSpecDigest
            || artifact.provenance.attemptBundleDigest !== expected.attemptBundleDigest
            || artifact.provenance.artifactRoot !== expected.artifactRoot
            || artifact.provenance.authorEvidenceRoot !== expected.authorEvidenceRoot
            || artifact.provenance.rawEvidence.rawEvidenceRoot !== expected.rawEvidenceRoot
            || evaluatorEnvelopeDigest !== expected.evaluatorAssessmentEnvelopeDigest
            || canonicalJson(artifact.provenance.extractor) !== canonicalJson(binding.extractor)
            || canonicalJson(artifact.provenance.scorer) !== canonicalJson(binding.scorer)
            || canonicalJson(artifact.provenance.evaluatorAuthority) !== canonicalJson(binding.evaluatorAuthority)) {
          throw new Error(`Attempt metrics do not match frozen sequence ${current.events.length}.`);
        }
        const retainedAt = now();
        const previousRetainedAt = current.events.at(-1)?.retainedAt;
        if (previousRetainedAt && Date.parse(retainedAt) < Date.parse(previousRetainedAt)) {
          throw new Error("Attempt-metrics event timestamps regress before durable retention.");
        }
        const content = metricsRegistryEventContentSchema.parse({
          schemaVersion: 1,
          protocolId: "EXP-0001A",
          kind: "attempt_metrics_retained",
          sequence: current.events.length,
          previousEventDigest: current.events.at(-1)?.eventDigest ?? null,
          retainedAt,
          bindingRoot: binding.bindingRoot,
          pairId: expected.pairId,
          treatment: expected.treatment,
          metricsArtifact: artifact,
        });
        const event = exp0001aAttemptMetricsRegistryEventSchema.parse({
          ...content,
          eventDigest: hashCanonicalJson(content),
        });
        await retainExclusive(path.join(input.directory, eventFileName(event)), event);
        const readback = await loadRegistry({ directory: input.directory, binding, allowLock: true });
        const retained = readback.events.at(-1);
        if (!retained || retained.eventDigest !== event.eventDigest) {
          throw new Error("Attempt-metrics append readback does not contain the exact retained event.");
        }
        return retained;
      });
    },
    read,
    async seal() {
      return withLock(async () => {
        const current = await loadRegistry({ directory: input.directory, binding, allowLock: true });
        if (current.completionSeal) return current.completionSeal;
        if (current.events.length !== 48) {
          throw new Error(`Cannot seal attempt metrics with ${current.events.length}/48 retained attempts.`);
        }
        const sealedAt = now();
        if (Date.parse(sealedAt) < Date.parse(current.events[47].retainedAt)) {
          throw new Error("Attempt-metrics completion timestamp regresses before durable retention.");
        }
        const sealContent = completionSealContentSchema.parse({
          schemaVersion: 1,
          protocolId: "EXP-0001A",
          kind: "attempt_metrics_registry_completion",
          sealedAt,
          bindingRoot: binding.bindingRoot,
          expectedAttemptCount: 48,
          retainedAttemptCount: 48,
          finalEventDigest: current.events[47]?.eventDigest,
          registryRoot: current.summary.registryRoot,
        });
        const seal = exp0001aAttemptMetricsRegistryCompletionSealSchema.parse({
          ...sealContent,
          sealDigest: hashCanonicalJson(sealContent),
        });
        await retainExclusive(path.join(input.directory, "completion.json"), seal);
        const readback = await loadRegistry({ directory: input.directory, binding, allowLock: true });
        if (readback.completionSeal?.sealDigest !== seal.sealDigest) {
          throw new Error("Attempt-metrics completion-seal readback differs from the retained seal.");
        }
        return readback.completionSeal;
      });
    },
    async requireComplete(expectedCompletionSealDigest) {
      digestSchema.parse(expectedCompletionSealDigest);
      const snapshot = await read();
      if (!snapshot.summary.denominatorComplete || !snapshot.completionSeal) {
        throw new Error("Attempt-metrics denominator is incomplete or lacks its immutable completion seal.");
      }
      if (snapshot.completionSeal.sealDigest !== expectedCompletionSealDigest) {
        throw new Error("Attempt-metrics completion seal differs from the externally retained authorized digest.");
      }
      return snapshot;
    },
  });
}
