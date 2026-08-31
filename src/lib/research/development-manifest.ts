import { z } from "zod";

import developmentBundleJson from "../../../research/benchmarks/development-v1.json";
import { hashCanonicalJson, SHA256_DIGEST_PATTERN } from "./provenance-crypto";
import { findSecretLeakage } from "./provenance-redaction";

const sha256Schema = z.string().regex(SHA256_DIGEST_PATTERN);
const idSchema = z.string().min(1).max(200).regex(/^[a-z0-9][a-z0-9-]*$/);
const labelSchema = z.enum(["A0", "A1"]);

const developmentTaskSchema = z.object({
  id: idSchema,
  title: z.string().min(1),
  domain: z.enum(["architecture", "drawing"]),
  stratum: z.enum(["creation", "editing", "stress"]),
  operation: z.enum(["create", "edit", "diagnose"]),
  complexity: z.enum(["small", "medium", "large", "dense"]),
  brief: z.string().min(1),
  stressors: z.array(z.string().min(1)).min(1),
  antiGamingCases: z.array(z.string().min(1)).min(1),
  publicEvaluationDimensions: z.array(z.string().min(1)).min(1),
  acceptanceCriteria: z.array(z.object({
    id: idSchema,
    text: z.string().min(1),
  }).strict()).min(1),
  requiredCapabilities: z.array(z.string().min(1)).min(1),
  initialState: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("blank") }).strict(),
    z.object({ kind: z.literal("fixture"), fixtureId: idSchema }).strict(),
  ]),
  concurrentEventFixtureId: idSchema.optional(),
  publicTaskPacket: z.object({
    kind: z.enum(["architecture", "drawing"]),
    materials: z.array(z.object({
      id: idSchema,
      title: z.string().min(1),
      sourceKind: z.string().min(1),
      content: z.string().min(1),
    }).strict()).min(1),
  }).passthrough(),
}).strict();

export const developmentBundleSchema = z.object({
  schemaVersion: z.literal(1),
  benchmarkId: z.enum(["jazzboard-development-v1", "jazzboard-development-v2"]),
  split: z.literal("development"),
  description: z.string().min(1),
  answerPolicy: z.literal("public-prompts-only-no-reference-answers-or-judge-rubrics"),
  tasks: z.array(developmentTaskSchema).length(12),
}).strict();

const taskCommitmentSchema = z.object({
  taskId: idSchema,
  taskFamily: z.enum(["architecture", "drawing"]),
  stratum: z.enum(["creation", "editing", "stress"]),
  taskDigest: sha256Schema,
}).strict();

const attemptAssignmentSchema = z.object({
  attemptId: idSchema,
  opaqueLabel: labelSchema,
  orderIndex: z.union([z.literal(0), z.literal(1)]),
  treatmentDigest: sha256Schema,
  freshAuthorContext: z.literal(true),
  freshRoom: z.literal(true),
}).strict();

const pairContentSchema = z.object({
  pairId: idSchema,
  taskId: idSchema,
  taskFamily: z.enum(["architecture", "drawing"]),
  stratum: z.enum(["creation", "editing", "stress"]),
  taskDigest: sha256Schema,
  replicateIndex: z.union([z.literal(0), z.literal(1)]),
  timeBlock: z.number().int().min(0).max(23),
  order: z.tuple([labelSchema, labelSchema]),
  attempts: z.tuple([attemptAssignmentSchema, attemptAssignmentSchema]),
}).strict();

const pairAssignmentSchema = pairContentSchema.extend({
  pairDigest: sha256Schema,
}).strict();

const developmentExecutionManifestContentSchema = z.object({
  schemaVersion: z.literal(1),
  manifestId: z.enum([
    "exp-0001a-development-execution-v1",
    "exp-0001a-development-execution-v2",
  ]),
  protocolId: z.literal("EXP-0001A"),
  studyKind: z.literal("aa_calibration"),
  partition: z.literal("development"),
  seed: z.literal(20260830),
  randomizationAlgorithm: z.literal("xorshift32-fisher-yates-weave-v1"),
  benchmark: z.object({
    path: z.enum([
      "research/benchmarks/development-v1.json",
      "research/benchmarks/development-v2.json",
    ]),
    benchmarkId: z.enum(["jazzboard-development-v1", "jazzboard-development-v2"]),
    bundleDigest: sha256Schema,
  }).strict(),
  opaqueLabels: z.tuple([z.literal("A0"), z.literal("A1")]),
  treatments: z.object({
    A0: sha256Schema,
    A1: sha256Schema,
  }).strict(),
  replicateCount: z.literal(2),
  taskCount: z.literal(12),
  pairCount: z.literal(24),
  attemptCount: z.literal(48),
  tasks: z.array(taskCommitmentSchema).length(12),
  assignments: z.array(pairAssignmentSchema).length(24),
  sensitiveMaterialRedacted: z.literal(true),
}).strict();

export const developmentExecutionManifestSchema = developmentExecutionManifestContentSchema.extend({
  manifestDigest: sha256Schema,
}).strict().superRefine((manifest, context) => {
  const version = manifest.benchmark.benchmarkId === "jazzboard-development-v1" ? "v1" : "v2";
  if (manifest.manifestId !== `exp-0001a-development-execution-${version}`) {
    context.addIssue({
      code: "custom",
      path: ["manifestId"],
      message: "Execution manifest and benchmark versions must match.",
    });
  }
  if (manifest.benchmark.path !== `research/benchmarks/development-${version}.json`) {
    context.addIssue({
      code: "custom",
      path: ["benchmark", "path"],
      message: "Execution manifest path and benchmark versions must match.",
    });
  }
});

export type DevelopmentBundle = z.infer<typeof developmentBundleSchema>;
export type DevelopmentTask = z.infer<typeof developmentTaskSchema>;
export type DevelopmentExecutionManifest = z.infer<typeof developmentExecutionManifestSchema>;
export type DevelopmentPairAssignment = z.infer<typeof pairAssignmentSchema>;

export type DevelopmentManifestVerification =
  | { ok: true; manifest: DevelopmentExecutionManifest; bundle: DevelopmentBundle }
  | { ok: false; errors: string[] };

export const DEVELOPMENT_EXECUTION_SEED = 20260830 as const;
export const DEVELOPMENT_RANDOMIZATION_ALGORITHM = "xorshift32-fisher-yates-weave-v1" as const;

const BASELINE_RECEIPT_DIGEST = "sha256:32fddd038f6ec696f633bc5ee28ec587540282dbbd1e451e5d2debeb67069b23";
const BASELINE_BUILD_IDENTITY_DIGEST = "sha256:0342169d87c8c5b4aa770745222488fe934e83940a01e296872daa096e6465d4";
export const DEVELOPMENT_AA_TREATMENT_DIGEST = hashCanonicalJson({
  baselineReceiptDigest: BASELINE_RECEIPT_DIGEST,
  buildIdentityDigest: BASELINE_BUILD_IDENTITY_DIGEST,
  studyKind: "aa_calibration",
});

function xorshift32(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function shuffled<T>(values: readonly T[], random: () => number): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

function formatIssues(prefix: string, error: z.ZodError): string[] {
  return error.issues.map((issue) => `${prefix}${issue.path.length ? `/${issue.path.join("/")}` : ""}: ${issue.message}`);
}

function validateBundleInvariants(bundle: DevelopmentBundle): string[] {
  const errors: string[] = [];
  const ids = bundle.tasks.map((task) => task.id);
  if (new Set(ids).size !== ids.length) errors.push("TASK_IDS_NOT_UNIQUE");
  if (ids.some((id) => !id.startsWith("dev-") || /sealed/i.test(id))) errors.push("TASK_ID_NOT_DEVELOPMENT_ONLY");
  if (bundle.tasks.some((task) => task.publicTaskPacket.kind !== task.domain)) errors.push("TASK_PACKET_DOMAIN_MISMATCH");
  for (const domain of ["architecture", "drawing"] as const) {
    if (bundle.tasks.filter((task) => task.domain === domain).length !== 6) errors.push(`DOMAIN_COUNT:${domain}`);
    for (const stratum of ["creation", "editing", "stress"] as const) {
      if (bundle.tasks.filter((task) => task.domain === domain && task.stratum === stratum).length !== 2) {
        errors.push(`STRATUM_COUNT:${domain}:${stratum}`);
      }
    }
  }
  const sensitive = findSecretLeakage(bundle);
  if (sensitive.length > 0) errors.push(`SENSITIVE_BUNDLE:${sensitive.join(",")}`);
  return errors;
}

export function loadDevelopmentBundle(input: unknown = developmentBundleJson): DevelopmentBundle {
  const parsed = developmentBundleSchema.safeParse(input);
  if (!parsed.success) throw new Error(`Invalid development bundle: ${formatIssues("bundle", parsed.error).join(" ")}`);
  const errors = validateBundleInvariants(parsed.data);
  if (errors.length > 0) throw new Error(`Invalid development bundle: ${errors.join(" ")}`);
  return parsed.data;
}

function taskCommitments(bundle: DevelopmentBundle): DevelopmentExecutionManifest["tasks"] {
  return [...bundle.tasks]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((task) => ({
      taskId: task.id,
      taskFamily: task.domain,
      stratum: task.stratum,
      taskDigest: hashCanonicalJson(task),
    }));
}

function pairDigest(pair: unknown): string {
  return hashCanonicalJson(pair);
}

export function computeDevelopmentManifestDigest(manifest: DevelopmentExecutionManifest): string {
  return hashCanonicalJson(Object.fromEntries(
    Object.entries(manifest).filter(([key]) => key !== "manifestDigest"),
  ));
}

function weaveFamilies(
  byFamily: ReadonlyMap<DevelopmentTask["domain"], DevelopmentTask[]>,
  firstFamily: DevelopmentTask["domain"],
): DevelopmentTask[] {
  const familyOrder: readonly DevelopmentTask["domain"][] = firstFamily === "architecture"
    ? ["architecture", "drawing"]
    : ["drawing", "architecture"];
  const result: DevelopmentTask[] = [];
  for (let index = 0; index < 6; index += 1) {
    for (const family of familyOrder) result.push(byFamily.get(family)![index]);
  }
  return result;
}

export function createDevelopmentExecutionManifest(
  bundleInput: unknown = developmentBundleJson,
  seed: number = DEVELOPMENT_EXECUTION_SEED,
): DevelopmentExecutionManifest {
  if (seed !== DEVELOPMENT_EXECUTION_SEED) throw new Error(`EXP-0001A requires fixed seed ${DEVELOPMENT_EXECUTION_SEED}.`);
  const bundle = loadDevelopmentBundle(bundleInput);
  const version = bundle.benchmarkId === "jazzboard-development-v1" ? "v1" : "v2";
  const random = xorshift32(seed);
  const tasks = taskCommitments(bundle);
  const taskById = new Map(tasks.map((task) => [task.taskId, task]));
  const raw: Array<Omit<z.infer<typeof pairContentSchema>, "timeBlock" | "attempts">> = [];
  let nextFirstFamily: DevelopmentTask["domain"] = random() < 0.5 ? "architecture" : "drawing";

  for (const replicateIndex of [0, 1] as const) {
    const byFamily = new Map<DevelopmentTask["domain"], DevelopmentTask[]>([
      ["architecture", shuffled(bundle.tasks.filter((task) => task.domain === "architecture"), random)],
      ["drawing", shuffled(bundle.tasks.filter((task) => task.domain === "drawing"), random)],
    ]);
    const woven = weaveFamilies(byFamily, nextFirstFamily);
    nextFirstFamily = woven.at(-1)!.domain === "architecture" ? "drawing" : "architecture";
    const startsA0 = new Map<DevelopmentTask["domain"], boolean>([
      ["architecture", random() < 0.5],
      ["drawing", random() < 0.5],
    ]);
    const familyIndexes = new Map<DevelopmentTask["domain"], number>([["architecture", 0], ["drawing", 0]]);

    for (const task of woven) {
      const familyIndex = familyIndexes.get(task.domain)!;
      familyIndexes.set(task.domain, familyIndex + 1);
      const a0First = familyIndex % 2 === 0 ? startsA0.get(task.domain)! : !startsA0.get(task.domain)!;
      const order: ["A0" | "A1", "A0" | "A1"] = a0First ? ["A0", "A1"] : ["A1", "A0"];
      const taskEntry = taskById.get(task.id)!;
      const pairId = `pair-${task.id}-r${replicateIndex + 1}`;
      raw.push({
        pairId,
        taskId: task.id,
        taskFamily: task.domain,
        stratum: task.stratum,
        taskDigest: taskEntry.taskDigest,
        replicateIndex,
        order,
      });
    }
  }

  const assignments = raw.map((pair, timeBlock): DevelopmentPairAssignment => {
    const attempts: DevelopmentPairAssignment["attempts"] = pair.order.map((opaqueLabel, orderIndex) => ({
      attemptId: `attempt-${pair.taskId}-r${pair.replicateIndex + 1}-${opaqueLabel.toLowerCase()}`,
      opaqueLabel,
      orderIndex: orderIndex as 0 | 1,
      treatmentDigest: DEVELOPMENT_AA_TREATMENT_DIGEST,
      freshAuthorContext: true as const,
      freshRoom: true as const,
    })) as DevelopmentPairAssignment["attempts"];
    const content = pairContentSchema.parse({ ...pair, timeBlock, attempts });
    return { ...content, pairDigest: pairDigest(content) };
  });

  const content = developmentExecutionManifestContentSchema.parse({
    schemaVersion: 1,
    manifestId: `exp-0001a-development-execution-${version}`,
    protocolId: "EXP-0001A",
    studyKind: "aa_calibration",
    partition: "development",
    seed,
    randomizationAlgorithm: DEVELOPMENT_RANDOMIZATION_ALGORITHM,
    benchmark: {
      path: `research/benchmarks/development-${version}.json`,
      benchmarkId: bundle.benchmarkId,
      bundleDigest: hashCanonicalJson(bundle),
    },
    opaqueLabels: ["A0", "A1"],
    treatments: { A0: DEVELOPMENT_AA_TREATMENT_DIGEST, A1: DEVELOPMENT_AA_TREATMENT_DIGEST },
    replicateCount: 2,
    taskCount: 12,
    pairCount: 24,
    attemptCount: 48,
    tasks,
    assignments,
    sensitiveMaterialRedacted: true,
  });
  return developmentExecutionManifestSchema.parse({ ...content, manifestDigest: hashCanonicalJson(content) });
}

export function verifyDevelopmentExecutionManifest(
  manifestInput: unknown,
  bundleInput: unknown = developmentBundleJson,
): DevelopmentManifestVerification {
  const manifestResult = developmentExecutionManifestSchema.safeParse(manifestInput);
  const bundleResult = developmentBundleSchema.safeParse(bundleInput);
  const errors = [
    ...(manifestResult.success ? [] : formatIssues("manifest", manifestResult.error)),
    ...(bundleResult.success ? [] : formatIssues("bundle", bundleResult.error)),
  ];
  if (!manifestResult.success || !bundleResult.success) return { ok: false, errors };

  const manifest = manifestResult.data;
  let bundle: DevelopmentBundle;
  try {
    bundle = loadDevelopmentBundle(bundleResult.data);
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : "Invalid development bundle."] };
  }

  if (computeDevelopmentManifestDigest(manifest) !== manifest.manifestDigest) errors.push("MANIFEST_DIGEST_INVALID");
  if (manifest.treatments.A0 !== manifest.treatments.A1) errors.push("AA_TREATMENTS_DIFFER");
  if (manifest.treatments.A0 !== DEVELOPMENT_AA_TREATMENT_DIGEST) errors.push("AA_TREATMENT_NOT_FROZEN_BASELINE");
  if (manifest.benchmark.bundleDigest !== hashCanonicalJson(bundle)) errors.push("BUNDLE_DIGEST_INVALID");
  if (manifest.benchmark.benchmarkId !== bundle.benchmarkId) errors.push("BENCHMARK_ID_MISMATCH");

  const pairIds = new Set<string>();
  const attemptIds = new Set<string>();
  const taskReplicates = new Set<string>();
  const timeBlocks = new Set<number>();
  for (const pair of manifest.assignments) {
    if (pairIds.has(pair.pairId)) errors.push(`DUPLICATE_PAIR:${pair.pairId}`);
    pairIds.add(pair.pairId);
    if (timeBlocks.has(pair.timeBlock)) errors.push(`DUPLICATE_TIME_BLOCK:${pair.timeBlock}`);
    timeBlocks.add(pair.timeBlock);
    const taskReplicate = `${pair.taskId}:${pair.replicateIndex}`;
    if (taskReplicates.has(taskReplicate)) errors.push(`DUPLICATE_TASK_REPLICATE:${taskReplicate}`);
    taskReplicates.add(taskReplicate);
    const pairContent = Object.fromEntries(Object.entries(pair).filter(([key]) => key !== "pairDigest"));
    if (pairDigest(pairContent) !== pair.pairDigest) errors.push(`PAIR_DIGEST_INVALID:${pair.pairId}`);
    if (new Set(pair.order).size !== 2) errors.push(`PAIR_LABELS_INVALID:${pair.pairId}`);
    pair.attempts.forEach((attempt, orderIndex) => {
      if (attemptIds.has(attempt.attemptId)) errors.push(`DUPLICATE_ATTEMPT:${attempt.attemptId}`);
      attemptIds.add(attempt.attemptId);
      if (attempt.opaqueLabel !== pair.order[orderIndex] || attempt.orderIndex !== orderIndex) {
        errors.push(`ATTEMPT_ORDER_INVALID:${attempt.attemptId}`);
      }
      if (attempt.treatmentDigest !== manifest.treatments[attempt.opaqueLabel]) {
        errors.push(`ATTEMPT_TREATMENT_INVALID:${attempt.attemptId}`);
      }
    });
  }

  if (taskReplicates.size !== 24) errors.push("TASK_REPLICATE_COVERAGE_INVALID");
  if ([...timeBlocks].sort((a, b) => a - b).some((value, index) => value !== index)) errors.push("TIME_BLOCK_COVERAGE_INVALID");
  for (const family of ["architecture", "drawing"] as const) {
    for (const replicateIndex of [0, 1] as const) {
      const block = manifest.assignments.filter((pair) => pair.taskFamily === family && pair.replicateIndex === replicateIndex);
      const difference = Math.abs(
        block.filter((pair) => pair.order[0] === "A0").length
        - block.filter((pair) => pair.order[0] === "A1").length,
      );
      if (difference > block.length % 2) errors.push(`ORDER_IMBALANCE:${family}:${replicateIndex}`);
    }
  }
  const globalDifference = Math.abs(
    manifest.assignments.filter((pair) => pair.order[0] === "A0").length
    - manifest.assignments.filter((pair) => pair.order[0] === "A1").length,
  );
  if (globalDifference !== 0) errors.push("GLOBAL_ORDER_IMBALANCE");
  if (manifest.assignments.some((pair, index) => index > 0 && manifest.assignments[index - 1].taskFamily === pair.taskFamily)) {
    errors.push("TASK_FAMILIES_NOT_INTERLEAVED");
  }

  const expected = createDevelopmentExecutionManifest(bundle, manifest.seed);
  if (hashCanonicalJson(expected) !== hashCanonicalJson(manifest)) errors.push("MANIFEST_NOT_DETERMINISTIC_EXPECTATION");
  const sensitive = findSecretLeakage(manifest);
  if (sensitive.length > 0) errors.push(`SENSITIVE_MANIFEST:${sensitive.join(",")}`);
  if (/sealed/i.test(JSON.stringify({
    partition: manifest.partition,
    labels: manifest.opaqueLabels,
    taskIds: manifest.tasks.map((task) => task.taskId),
  }))) errors.push("SEALED_CONTENT_REFERENCE");

  return errors.length === 0 ? { ok: true, manifest, bundle } : { ok: false, errors: [...new Set(errors)].sort() };
}
