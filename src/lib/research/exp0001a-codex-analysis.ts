import { z } from "zod";

import {
  UNOBSERVABLE,
  exp0001aCodexAccountingLedgerSchema,
  summarizeExp0001aCodexAccounting,
  type Exp0001aCodexAccountingLedger,
  type Exp0001aCodexAccountingSummary,
  type Exp0001aCodexTaskAccounting,
} from "./exp0001a-codex-accounting";
import {
  summarizePairedBinary,
  summarizePairedPositiveRatio,
  type PairedBinarySummary,
  type PairedRatioSummary,
} from "./statistics";

export const EXP0001A_CODEX_ANALYSIS_VERSION = "exp-0001a-codex-analysis/v1" as const;
export const EXP0001A_CODEX_ANALYSIS_SETTINGS = Object.freeze({
  bootstrapDraws: 10_000,
  seed: 20_260_830,
} as const);

const stableIdSchema = z.string().trim().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const exp0001aCodexAnalysisAttemptSchema = z.object({
  assignmentId: stableIdSchema,
  attemptId: stableIdSchema,
  accountingId: stableIdSchema,
  pairId: stableIdSchema,
  taskId: stableIdSchema,
  taskFamily: z.enum(["architecture", "drawing"]),
  condition: z.enum(["A0", "A1"]),
  accepted: z.boolean(),
  artifactComplete: z.boolean(),
}).strict();

export type Exp0001aCodexAnalysisAttempt = z.infer<typeof exp0001aCodexAnalysisAttemptSchema>;

export const exp0001aCodexPairwisePreferenceSchema = z.object({
  pairId: stableIdSchema,
  taskId: stableIdSchema,
  taskFamily: z.enum(["architecture", "drawing"]),
  preferredCondition: z.enum(["A0", "A1", "tie", "unavailable"]),
}).strict();

export type Exp0001aCodexPairwisePreference = z.infer<typeof exp0001aCodexPairwisePreferenceSchema>;

const analysisAttemptsSchema = z.array(exp0001aCodexAnalysisAttemptSchema).length(48).superRefine((attempts, context) => {
  const assignments = new Set<string>();
  const attemptIds = new Set<string>();
  const accountingIds = new Set<string>();
  const pairs = new Map<string, Exp0001aCodexAnalysisAttempt[]>();
  const tasks = new Map<string, Exp0001aCodexAnalysisAttempt[]>();
  attempts.forEach((attempt, index) => {
    for (const [field, value, seen] of [
      ["assignmentId", attempt.assignmentId, assignments],
      ["attemptId", attempt.attemptId, attemptIds],
      ["accountingId", attempt.accountingId, accountingIds],
    ] as const) {
      if (seen.has(value)) context.addIssue({ code: "custom", path: [index, field], message: `${field} must be unique.` });
      seen.add(value);
    }
    pairs.set(attempt.pairId, [...(pairs.get(attempt.pairId) ?? []), attempt]);
    tasks.set(attempt.taskId, [...(tasks.get(attempt.taskId) ?? []), attempt]);
  });
  for (const [pairId, pair] of pairs) {
    const conditions = new Set(pair.map((attempt) => attempt.condition));
    if (pair.length !== 2 || conditions.size !== 2
        || pair[0]?.taskId !== pair[1]?.taskId
        || pair[0]?.taskFamily !== pair[1]?.taskFamily) {
      context.addIssue({ code: "custom", message: `Pair ${pairId} must contain exactly one A0 and one A1 attempt for the same task.` });
    }
  }
  if (pairs.size !== 24 || tasks.size !== 12) {
    context.addIssue({
      code: "custom",
      message: "EXP-0001A requires exactly 24 pairs clustered in 12 tasks.",
    });
  }
  for (const [taskId, taskAttempts] of tasks) {
    const taskPairs = new Set(taskAttempts.map((attempt) => attempt.pairId));
    const families = new Set(taskAttempts.map((attempt) => attempt.taskFamily));
    if (taskAttempts.length !== 4 || taskPairs.size !== 2 || families.size !== 1) {
      context.addIssue({
        code: "custom",
        message: `Task ${taskId} must retain exactly two complete A0/A1 replicate pairs in one family.`,
      });
    }
  }
});

const pairwisePreferencesSchema = z.array(exp0001aCodexPairwisePreferenceSchema).length(24).superRefine((preferences, context) => {
  const pairIds = new Set<string>();
  preferences.forEach((preference, index) => {
    if (pairIds.has(preference.pairId)) {
      context.addIssue({ code: "custom", path: [index, "pairId"], message: "Pairwise preference pair IDs must be unique." });
    }
    pairIds.add(preference.pairId);
  });
});

type ResourceKey = "wallTimeMs" | "webMcpCalls" | "revisions" | "inspections";

export type Exp0001aCodexResourceRatio = Readonly<{
  comparablePairCount: number;
  unobservablePairCount: number;
  omittedZeroPairCount: number;
  summary: PairedRatioSummary | null;
}>;

export type Exp0001aCodexTaskClusterSignFlipInference = Readonly<{
  inferenceRole: "primary_investigation_decision";
  method: "exact_two_sided_complete_task_vector_sign_flip";
  taskCount: 12;
  replicatesPerTask: 2;
  permutationCount: 4096;
  observedSignedSum: number | null;
  observedMeanPerPair: number | null;
  exactTwoSidedPValue: number | null;
  evaluation: "evaluable" | "not_evaluable";
  nonEvaluableReason: string | null;
}>;

export type Exp0001aCodexPairwiseVisualSummary = Readonly<{
  pairCount: 24;
  A0Wins: number;
  A1Wins: number;
  ties: number;
  unavailable: number;
  nonTieCount: number;
  A1WinRateAmongNonTies: number | null;
  exactTwoSidedSignPValue: number | null;
  exactTwoSidedSignPValueRole: "descriptive_only_naive_non_tie_pair_level_sign_test";
}>;

export type Exp0001aCodexAnalysisReport = Readonly<{
  schemaVersion: typeof EXP0001A_CODEX_ANALYSIS_VERSION;
  protocolId: "EXP-0001A";
  analysisSettings: typeof EXP0001A_CODEX_ANALYSIS_SETTINGS;
  pairCount: number;
  attemptCount: number;
  acceptance: PairedBinarySummary;
  artifactCompleteness: PairedBinarySummary;
  clusterAwareInference: Readonly<{
    acceptance: Exp0001aCodexTaskClusterSignFlipInference;
    pairwiseVisualPreference: Exp0001aCodexTaskClusterSignFlipInference;
  }>;
  pairwiseVisual: Exp0001aCodexPairwiseVisualSummary;
  resources: Record<ResourceKey, Exp0001aCodexResourceRatio>;
  webMcpFailures: Readonly<{
    A0: number | null;
    A1: number | null;
    total: number | null;
    observedTaskCount: number;
    unobservableTaskCount: number;
  }>;
  accounting: Exp0001aCodexAccountingSummary;
}>;

function taskValue(task: Exp0001aCodexTaskAccounting, metric: ResourceKey): number | null {
  switch (metric) {
    case "wallTimeMs": return task.wallTimeMs;
    case "webMcpCalls": return task.webMcp.callCount === UNOBSERVABLE ? null : task.webMcp.callCount.value;
    case "revisions": return task.canvas.revisionCount === UNOBSERVABLE ? null : task.canvas.revisionCount.value;
    case "inspections": return task.canvas.inspectionCount === UNOBSERVABLE ? null : task.canvas.inspectionCount.value;
  }
}

function pairMap(attempts: readonly Exp0001aCodexAnalysisAttempt[]) {
  const pairs = new Map<string, { A0: Exp0001aCodexAnalysisAttempt; A1: Exp0001aCodexAnalysisAttempt }>();
  for (const attempt of attempts) {
    const current = pairs.get(attempt.pairId) ?? {} as Partial<{ A0: Exp0001aCodexAnalysisAttempt; A1: Exp0001aCodexAnalysisAttempt }>;
    current[attempt.condition] = attempt;
    pairs.set(attempt.pairId, current as { A0: Exp0001aCodexAnalysisAttempt; A1: Exp0001aCodexAnalysisAttempt });
  }
  return pairs;
}

function exactTaskClusterSignFlip(
  observations: readonly Readonly<{ taskId: string; signedValue: -1 | 0 | 1 | null }>[]
): Exp0001aCodexTaskClusterSignFlipInference {
  const byTask = new Map<string, Array<-1 | 0 | 1 | null>>();
  for (const observation of observations) {
    byTask.set(observation.taskId, [...(byTask.get(observation.taskId) ?? []), observation.signedValue]);
  }
  if (byTask.size !== 12) throw new Error("EXP0001A_CLUSTER_INFERENCE_REQUIRES_12_TASKS");
  const incomplete = [...byTask.entries()].find(([, values]) => values.length !== 2);
  const unobservable = [...byTask.entries()].find(([, values]) => values.some((value) => value === null));
  if (incomplete !== undefined || unobservable !== undefined) {
    return Object.freeze({
      inferenceRole: "primary_investigation_decision",
      method: "exact_two_sided_complete_task_vector_sign_flip",
      taskCount: 12,
      replicatesPerTask: 2,
      permutationCount: 4096,
      observedSignedSum: null,
      observedMeanPerPair: null,
      exactTwoSidedPValue: null,
      evaluation: "not_evaluable",
      nonEvaluableReason: incomplete !== undefined
        ? `Task ${incomplete[0]} does not retain its complete two-replicate vector.`
        : `Task ${unobservable![0]} contains an unavailable visual comparison.`,
    });
  }
  const taskSums = [...byTask.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([, values]) => (values[0] as number) + (values[1] as number));
  const observedSignedSum = taskSums.reduce((sum, value) => sum + value, 0);
  let atLeastAsExtreme = 0;
  for (let assignment = 0; assignment < 4096; assignment += 1) {
    const randomizedSum = taskSums.reduce((sum, value, index) => (
      sum + (((assignment >>> index) & 1) === 1 ? value : -value)
    ), 0);
    if (Math.abs(randomizedSum) >= Math.abs(observedSignedSum)) atLeastAsExtreme += 1;
  }
  return Object.freeze({
    inferenceRole: "primary_investigation_decision",
    method: "exact_two_sided_complete_task_vector_sign_flip",
    taskCount: 12,
    replicatesPerTask: 2,
    permutationCount: 4096,
    observedSignedSum,
    observedMeanPerPair: observedSignedSum / 24,
    exactTwoSidedPValue: atLeastAsExtreme / 4096,
    evaluation: "evaluable",
    nonEvaluableReason: null,
  });
}

function binomialCoefficient(n: number, kInput: number): number {
  const k = Math.min(kInput, n - kInput);
  let result = 1;
  for (let index = 1; index <= k; index += 1) result = (result * (n - k + index)) / index;
  return result;
}

function exactTwoSidedSignPValue(wins: number, losses: number): number | null {
  const nonTies = wins + losses;
  if (nonTies === 0) return null;
  const lowerTail = Math.min(wins, losses);
  let probability = 0;
  for (let index = 0; index <= lowerTail; index += 1) {
    probability += binomialCoefficient(nonTies, index) * (0.5 ** nonTies);
  }
  return Math.min(1, 2 * probability);
}

function pairwiseVisualSummary(
  preferences: readonly Exp0001aCodexPairwisePreference[],
): Exp0001aCodexPairwiseVisualSummary {
  const counts = preferences.reduce((summary, preference) => {
    summary[preference.preferredCondition] += 1;
    return summary;
  }, { A0: 0, A1: 0, tie: 0, unavailable: 0 });
  const nonTieCount = counts.A0 + counts.A1;
  return Object.freeze({
    pairCount: 24,
    A0Wins: counts.A0,
    A1Wins: counts.A1,
    ties: counts.tie,
    unavailable: counts.unavailable,
    nonTieCount,
    A1WinRateAmongNonTies: nonTieCount === 0 ? null : counts.A1 / nonTieCount,
    exactTwoSidedSignPValue: exactTwoSidedSignPValue(counts.A1, counts.A0),
    exactTwoSidedSignPValueRole: "descriptive_only_naive_non_tie_pair_level_sign_test",
  });
}

function binarySummary(
  pairs: Map<string, { A0: Exp0001aCodexAnalysisAttempt; A1: Exp0001aCodexAnalysisAttempt }>,
  field: "accepted" | "artifactComplete",
  options: { bootstrapDraws?: number; seed?: number },
): PairedBinarySummary {
  return summarizePairedBinary([...pairs.entries()].map(([pairId, pair]) => ({
    pairId,
    taskId: pair.A0.taskId,
    taskFamily: pair.A0.taskFamily,
    baselineAccepted: pair.A0[field],
    candidateAccepted: pair.A1[field],
  })), options);
}

function ratioSummary(
  pairs: Map<string, { A0: Exp0001aCodexAnalysisAttempt; A1: Exp0001aCodexAnalysisAttempt }>,
  tasks: ReadonlyMap<string, Exp0001aCodexTaskAccounting>,
  metric: ResourceKey,
  options: { bootstrapDraws?: number; seed?: number },
): Exp0001aCodexResourceRatio {
  const observations = [...pairs.entries()].flatMap(([pairId, pair]) => {
    const baseline = taskValue(tasks.get(pair.A0.accountingId)!, metric);
    const candidate = taskValue(tasks.get(pair.A1.accountingId)!, metric);
    return baseline !== null && candidate !== null && baseline > 0 && candidate > 0 ? [{
      pairId,
      taskId: pair.A0.taskId,
      baselineValue: baseline,
      candidateValue: candidate,
    }] : [];
  });
  const unobservablePairCount = [...pairs.values()].filter((pair) =>
    taskValue(tasks.get(pair.A0.accountingId)!, metric) === null
      || taskValue(tasks.get(pair.A1.accountingId)!, metric) === null).length;
  return Object.freeze({
    comparablePairCount: observations.length,
    unobservablePairCount,
    omittedZeroPairCount: pairs.size - observations.length - unobservablePairCount,
    summary: observations.length > 0 ? summarizePairedPositiveRatio(observations, options) : null,
  });
}

/**
 * Provider-free EXP-0001A analysis. It keeps the preregistered paired,
 * task-clustered statistics while replacing API cost telemetry with exact
 * Codex-task, wall-time, WebMCP, revision, and inspection evidence.
 */
export function analyzeExp0001aCodexExperiment(input: Readonly<{
  attempts: readonly Exp0001aCodexAnalysisAttempt[];
  pairwisePreferences: readonly Exp0001aCodexPairwisePreference[];
  accountingLedger: Exp0001aCodexAccountingLedger;
}>): Exp0001aCodexAnalysisReport {
  const inputKeys = Object.keys(input).sort();
  if (inputKeys.length !== 3
      || inputKeys[0] !== "accountingLedger"
      || inputKeys[1] !== "attempts"
      || inputKeys[2] !== "pairwisePreferences") {
    throw new Error("EXP0001A_ANALYSIS_CALLER_OVERRIDES_FORBIDDEN");
  }
  const attempts = analysisAttemptsSchema.parse(input.attempts);
  const pairwisePreferences = pairwisePreferencesSchema.parse(input.pairwisePreferences);
  const ledger = exp0001aCodexAccountingLedgerSchema.parse(input.accountingLedger);
  const authorTasks = ledger.tasks.filter((task) => task.role === "author");
  const tasks = new Map(authorTasks.map((task) => [task.accountingId, task]));
  for (const attempt of attempts) {
    const task = tasks.get(attempt.accountingId);
    if (!task || task.assignmentId !== attempt.assignmentId || task.attemptId !== attempt.attemptId) {
      throw new Error(`CODEX_ANALYSIS_ACCOUNTING_BINDING_MISMATCH:${attempt.attemptId}`);
    }
    if (task.role !== "author" || task.state !== "terminal") {
      throw new Error(`CODEX_ANALYSIS_REQUIRES_TERMINAL_AUTHOR_TASK:${attempt.attemptId}`);
    }
  }
  if (authorTasks.length !== attempts.length || tasks.size !== attempts.length) {
    throw new Error("CODEX_ANALYSIS_AUTHOR_ACCOUNTING_DENOMINATOR_MISMATCH");
  }

  const pairs = pairMap(attempts);
  const preferenceByPair = new Map(pairwisePreferences.map((preference) => [preference.pairId, preference]));
  for (const [pairId, pair] of pairs) {
    const preference = preferenceByPair.get(pairId);
    if (!preference || preference.taskId !== pair.A0.taskId || preference.taskFamily !== pair.A0.taskFamily) {
      throw new Error(`EXP0001A_PAIRWISE_PREFERENCE_BINDING_MISMATCH:${pairId}`);
    }
  }
  if (preferenceByPair.size !== pairs.size) throw new Error("EXP0001A_PAIRWISE_PREFERENCE_DENOMINATOR_MISMATCH");
  const baseOptions = EXP0001A_CODEX_ANALYSIS_SETTINGS;
  const resources = Object.fromEntries(([
    "wallTimeMs",
    "webMcpCalls",
    "revisions",
    "inspections",
  ] as const).map((metric, index) => [
      metric,
      ratioSummary(pairs, tasks, metric, {
      bootstrapDraws: EXP0001A_CODEX_ANALYSIS_SETTINGS.bootstrapDraws,
      seed: EXP0001A_CODEX_ANALYSIS_SETTINGS.seed + index + 10,
    }),
  ])) as Record<ResourceKey, Exp0001aCodexResourceRatio>;
  const failureObservations = attempts.map((attempt) => ({
    condition: attempt.condition,
    observation: tasks.get(attempt.accountingId)!.webMcp.failureCount,
  }));
  const observedFailureCounts = failureObservations.filter((entry) => entry.observation !== UNOBSERVABLE);
  const failures = observedFailureCounts.reduce((counts, entry) => {
    counts[entry.condition] += entry.observation === UNOBSERVABLE ? 0 : entry.observation.value;
    return counts;
  }, { A0: 0, A1: 0 });
  const allFailuresObserved = observedFailureCounts.length === failureObservations.length;
  const acceptanceInference = exactTaskClusterSignFlip([...pairs.values()].map((pair) => ({
    taskId: pair.A0.taskId,
    signedValue: (Number(pair.A1.accepted) - Number(pair.A0.accepted)) as -1 | 0 | 1,
  })));
  const pairwiseInference = exactTaskClusterSignFlip(pairwisePreferences.map((preference) => ({
    taskId: preference.taskId,
    signedValue: preference.preferredCondition === "A1" ? 1
      : preference.preferredCondition === "A0" ? -1
        : preference.preferredCondition === "tie" ? 0 : null,
  })));

  return Object.freeze({
    schemaVersion: EXP0001A_CODEX_ANALYSIS_VERSION,
    protocolId: "EXP-0001A",
    analysisSettings: EXP0001A_CODEX_ANALYSIS_SETTINGS,
    pairCount: pairs.size,
    attemptCount: attempts.length,
    acceptance: binarySummary(pairs, "accepted", baseOptions),
    artifactCompleteness: binarySummary(pairs, "artifactComplete", {
      bootstrapDraws: EXP0001A_CODEX_ANALYSIS_SETTINGS.bootstrapDraws,
      seed: EXP0001A_CODEX_ANALYSIS_SETTINGS.seed + 1,
    }),
    clusterAwareInference: Object.freeze({
      acceptance: acceptanceInference,
      pairwiseVisualPreference: pairwiseInference,
    }),
    pairwiseVisual: pairwiseVisualSummary(pairwisePreferences),
    resources,
    webMcpFailures: Object.freeze({
      A0: allFailuresObserved ? failures.A0 : null,
      A1: allFailuresObserved ? failures.A1 : null,
      total: allFailuresObserved ? failures.A0 + failures.A1 : null,
      observedTaskCount: observedFailureCounts.length,
      unobservableTaskCount: failureObservations.length - observedFailureCounts.length,
    }),
    accounting: summarizeExp0001aCodexAccounting(ledger),
  });
}
