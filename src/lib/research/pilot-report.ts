import { z } from "zod";

import type { AttemptRecord, AttemptRegistry } from "./attempt-schemas";
import { provenanceDigestSchema } from "./attempt-schemas";
import {
  pairedOutcomesFromRegistry,
  reconcilePilotRegistry,
  type PilotRegistryReconciliation,
} from "./pilot-coordinator";
import {
  validatePilotRandomizationManifest,
  type PilotPairAssignment,
  type PilotRandomizationManifest,
} from "./pilot-schedule";
import { hashCanonicalJson } from "./provenance-crypto";
import { summarizePairedBinary, type PairedBinarySummary } from "./statistics";

const boundedId = z.string().trim().min(1).max(160);

export const pilotAcceptanceSummarySchema = z.object({
  attemptId: boundedId,
  scorerId: boundedId,
  status: z.enum(["scored", "failed", "indeterminate"]),
  accepted: z.boolean().nullable(),
  summaryDigest: provenanceDigestSchema.nullable(),
  errorCode: boundedId.nullable(),
}).strict().superRefine((summary, context) => {
  if (summary.status === "scored" && (summary.accepted === null || summary.summaryDigest === null || summary.errorCode !== null)) {
    context.addIssue({ code: "custom", message: "A scored acceptance summary requires a decision and digest, and cannot carry an error." });
  }
  if (summary.status !== "scored" && summary.accepted !== null) {
    context.addIssue({ code: "custom", path: ["accepted"], message: "Only a scored acceptance summary may carry a decision." });
  }
  if (summary.status === "failed" && summary.errorCode === null) {
    context.addIssue({ code: "custom", path: ["errorCode"], message: "A failed acceptance summary requires an error code." });
  }
});

export const pilotScorerSummarySchema = z.object({
  attemptId: boundedId,
  scorerId: boundedId,
  status: z.enum(["succeeded", "failed", "indeterminate"]),
  summaryDigest: provenanceDigestSchema.nullable(),
  errorCode: boundedId.nullable(),
}).strict().superRefine((summary, context) => {
  if (summary.status === "succeeded" && (summary.summaryDigest === null || summary.errorCode !== null)) {
    context.addIssue({ code: "custom", message: "A successful scorer summary requires a digest and cannot carry an error." });
  }
  if (summary.status === "failed" && summary.errorCode === null) {
    context.addIssue({ code: "custom", path: ["errorCode"], message: "A failed scorer summary requires an error code." });
  }
});

export type PilotAcceptanceSummary = z.infer<typeof pilotAcceptanceSummarySchema>;
export type PilotScorerSummary = z.infer<typeof pilotScorerSummarySchema>;

export type PilotReportInput = {
  registry: AttemptRegistry;
  schedule: PilotRandomizationManifest;
  acceptanceSummaries: readonly PilotAcceptanceSummary[];
  scorerSummaries: readonly PilotScorerSummary[];
  requiredScorerIds: readonly string[];
  statistics?: { bootstrapDraws?: number; seed?: number };
};

export type PilotAttemptDisposition =
  | "accepted"
  | "rejected"
  | "missing_acceptance"
  | "acceptance_failed"
  | "acceptance_indeterminate"
  | "author_failed"
  | "timeout"
  | "infra_failure"
  | "policy_violation"
  | "unfinished"
  | "missing_attempt";

export type PilotAttemptAudit = {
  attemptId: string;
  expected: boolean;
  pairId: string | null;
  taskId: string | null;
  taskFamily: string | null;
  condition: "baseline" | "candidate" | null;
  replicateIndex: number | null;
  orderIndex: 0 | 1 | null;
  timeBlock: number | null;
  registryState: AttemptRecord["state"] | "missing";
  authorOutcome: AttemptRecord["authorOutcome"];
  authorEvidenceRoot: string | null;
  registryScoringStatus: AttemptRecord["scoringStatus"] | "missing";
  retainedScoreRunCount: number;
  acceptanceSummary: PilotAcceptanceSummary | null;
  disposition: PilotAttemptDisposition;
  effectiveAccepted: boolean;
  scorerSummaries: PilotScorerSummary[];
  missingRequiredScorerIds: string[];
};

export type PilotFamilyStratum = {
  taskFamily: string;
  scheduledPairCount: number;
  expectedAttemptCount: number;
  retainedAttemptCount: number;
  dispositionCounts: Record<string, number>;
  authorOutcomeCounts: Record<string, number>;
  scorerStatusCounts: Record<string, number>;
  primaryPairedPass: Omit<PairedBinarySummary, "byTaskFamily"> | null;
};

export type PilotReport = {
  schemaVersion: 1;
  runId: string;
  protocolId: string;
  comparison: {
    kind: "aa_calibration" | "ab_improvement";
    baselineCommit: string;
    baselineBuildDigest: string;
    candidateCommit: string;
    candidateBuildDigest: string;
  };
  provenance: {
    registryRoot: string;
    scheduleDigest: string;
    analysisInputDigest: string;
  };
  integrity: {
    status: "complete" | "incomplete" | "invalid";
    scheduleViolations: string[];
    summaryViolations: string[];
    registry: PilotRegistryReconciliation;
  };
  retention: {
    expectedAttemptCount: number;
    retainedAttemptCount: number;
    attempts: PilotAttemptAudit[];
    orphanAcceptanceSummaries: PilotAcceptanceSummary[];
    orphanScorerSummaries: PilotScorerSummary[];
  };
  outcomeAccounting: {
    dispositionCounts: Record<string, number>;
    missingAcceptanceAttemptIds: string[];
    failedAcceptanceAttemptIds: string[];
    indeterminateAcceptanceAttemptIds: string[];
    missingRequiredScorerSummaries: Array<{ attemptId: string; scorerId: string }>;
    failedScorerSummaries: Array<{ attemptId: string; scorerId: string; errorCode: string | null }>;
    indeterminateScorerSummaries: Array<{ attemptId: string; scorerId: string }>;
  };
  primaryPairedPass: PairedBinarySummary | null;
  taskFamilyStrata: PilotFamilyStratum[];
  improvementClaim: {
    eligibility: "eligible" | "rejected";
    purpose: "calibration_only" | "improvement";
    rejectionReasons: string[];
  };
  reportDigest: string;
};

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function expectedAssignments(schedule: PilotRandomizationManifest) {
  return schedule.assignments.flatMap((assignment) => assignment.attempts.map((attempt) => ({
    attemptId: attempt.attemptId,
    pairId: assignment.pairId,
    taskId: assignment.taskId,
    taskFamily: assignment.taskFamily,
    condition: attempt.condition,
    replicateIndex: assignment.replicateIndex,
    orderIndex: attempt.orderIndex,
    timeBlock: assignment.timeBlock,
  }))).sort((left, right) => left.timeBlock - right.timeBlock
    || left.orderIndex - right.orderIndex
    || left.attemptId.localeCompare(right.attemptId));
}

function summaryValidation<T extends { attemptId: string }>(
  values: readonly T[],
  schema: z.ZodType<T>,
  expectedAttemptIds: ReadonlySet<string>,
  uniquenessKey: (value: T) => string,
  label: string,
): { valid: T[]; violations: string[]; orphans: T[] } {
  const valid: T[] = [];
  const violations: string[] = [];
  const orphans: T[] = [];
  const seen = new Set<string>();
  values.forEach((value, index) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      violations.push(`INVALID_${label}:${index}`);
      return;
    }
    const key = uniquenessKey(parsed.data);
    if (seen.has(key)) violations.push(`DUPLICATE_${label}:${key}`);
    seen.add(key);
    valid.push(parsed.data);
    if (!expectedAttemptIds.has(parsed.data.attemptId)) {
      violations.push(`UNEXPECTED_${label}_ATTEMPT:${parsed.data.attemptId}`);
      orphans.push(parsed.data);
    }
  });
  return { valid, violations, orphans };
}

function disposition(attempt: AttemptRecord | undefined, acceptance: PilotAcceptanceSummary | undefined): PilotAttemptDisposition {
  if (!attempt) return "missing_attempt";
  if (attempt.authorOutcome === "failed") return "author_failed";
  if (attempt.authorOutcome === "timeout") return "timeout";
  if (attempt.authorOutcome === "infra_failure") return "infra_failure";
  if (attempt.authorOutcome === "policy_violation") return "policy_violation";
  if (attempt.authorOutcome !== "completed") return "unfinished";
  if (!acceptance) return "missing_acceptance";
  if (acceptance.status === "failed") return "acceptance_failed";
  if (acceptance.status === "indeterminate") return "acceptance_indeterminate";
  return acceptance.accepted ? "accepted" : "rejected";
}

function isAa(registry: AttemptRegistry): boolean {
  const { baseline, candidate } = registry.runSpec.conditions;
  return baseline.gitCommit === candidate.gitCommit && baseline.buildDigest === candidate.buildDigest;
}

function attemptsForAssignment(assignment: PilotPairAssignment): string[] {
  return assignment.attempts.map((attempt) => attempt.attemptId);
}

function withoutReportDigest(report: Omit<PilotReport, "reportDigest"> | PilotReport) {
  const { reportDigest: _ignored, ...unsigned } = report as PilotReport;
  void _ignored;
  return unsigned;
}

export function createPilotReport(input: PilotReportInput): PilotReport {
  const scheduleViolations = validatePilotRandomizationManifest(input.schedule);
  if (input.schedule.protocolId !== input.registry.runSpec.protocol.id) scheduleViolations.push("PROTOCOL_MISMATCH");
  const registryReconciliation = reconcilePilotRegistry(input.schedule, input.registry);
  const expected = expectedAssignments(input.schedule);
  const expectedAttemptIds = new Set(expected.map((assignment) => assignment.attemptId));
  const acceptanceValidation = summaryValidation(
    input.acceptanceSummaries,
    pilotAcceptanceSummarySchema,
    expectedAttemptIds,
    (summary) => summary.attemptId,
    "ACCEPTANCE_SUMMARY",
  );
  const scorerValidation = summaryValidation(
    input.scorerSummaries,
    pilotScorerSummarySchema,
    expectedAttemptIds,
    (summary) => `${summary.attemptId}:${summary.scorerId}`,
    "SCORER_SUMMARY",
  );
  const requiredScorerIds = [...new Set(input.requiredScorerIds)].sort();
  const summaryViolations = [...acceptanceValidation.violations, ...scorerValidation.violations];
  if (requiredScorerIds.length !== input.requiredScorerIds.length) summaryViolations.push("DUPLICATE_REQUIRED_SCORER_ID");
  if (requiredScorerIds.some((id) => boundedId.safeParse(id).success === false)) summaryViolations.push("INVALID_REQUIRED_SCORER_ID");

  const integrityStatus = scheduleViolations.length > 0
    || summaryViolations.length > 0
    || registryReconciliation.status === "invalid"
    ? "invalid"
    : registryReconciliation.status === "incomplete" ? "incomplete" : "complete";

  const retained = new Map(input.registry.attempts.map((attempt) => [attempt.attemptId, attempt]));
  const acceptanceByAttempt = new Map(acceptanceValidation.valid.map((summary) => [summary.attemptId, summary]));
  const scorersByAttempt = new Map<string, PilotScorerSummary[]>();
  for (const summary of scorerValidation.valid) {
    const summaries = scorersByAttempt.get(summary.attemptId) ?? [];
    summaries.push(summary);
    scorersByAttempt.set(summary.attemptId, summaries);
  }

  const attempts: PilotAttemptAudit[] = expected.map((assignment) => {
    const attempt = retained.get(assignment.attemptId);
    const acceptance = acceptanceByAttempt.get(assignment.attemptId);
    const scorerSummaries = [...(scorersByAttempt.get(assignment.attemptId) ?? [])]
      .sort((left, right) => left.scorerId.localeCompare(right.scorerId));
    const seenScorers = new Set(scorerSummaries.map((summary) => summary.scorerId));
    const attemptDisposition = disposition(attempt, acceptance);
    return {
      ...assignment,
      expected: true,
      registryState: attempt?.state ?? "missing",
      authorOutcome: attempt?.authorOutcome ?? null,
      authorEvidenceRoot: attempt?.authorEvidenceRoot ?? null,
      registryScoringStatus: attempt?.scoringStatus ?? "missing",
      retainedScoreRunCount: attempt?.scoreRuns.length ?? 0,
      acceptanceSummary: acceptance ?? null,
      disposition: attemptDisposition,
      effectiveAccepted: attemptDisposition === "accepted",
      scorerSummaries,
      missingRequiredScorerIds: requiredScorerIds.filter((id) => !seenScorers.has(id)),
    };
  });

  const unexpectedAttempts = input.registry.attempts
    .filter((attempt) => !expectedAttemptIds.has(attempt.attemptId))
    .sort((left, right) => left.attemptId.localeCompare(right.attemptId))
    .map((attempt): PilotAttemptAudit => ({
      attemptId: attempt.attemptId,
      expected: false,
      pairId: attempt.pairId,
      taskId: attempt.taskId,
      taskFamily: null,
      condition: attempt.condition,
      replicateIndex: attempt.replicateIndex,
      orderIndex: attempt.orderIndex,
      timeBlock: attempt.timeBlock,
      registryState: attempt.state,
      authorOutcome: attempt.authorOutcome,
      authorEvidenceRoot: attempt.authorEvidenceRoot,
      registryScoringStatus: attempt.scoringStatus,
      retainedScoreRunCount: attempt.scoreRuns.length,
      acceptanceSummary: acceptanceByAttempt.get(attempt.attemptId) ?? null,
      disposition: disposition(attempt, acceptanceByAttempt.get(attempt.attemptId)),
      effectiveAccepted: false,
      scorerSummaries: [...(scorersByAttempt.get(attempt.attemptId) ?? [])].sort((left, right) => left.scorerId.localeCompare(right.scorerId)),
      missingRequiredScorerIds: [...requiredScorerIds],
    }));
  attempts.push(...unexpectedAttempts);

  let primaryPairedPass: PairedBinarySummary | null = null;
  if (integrityStatus === "complete" && input.schedule.assignments.length > 0) {
    const accepted = acceptanceValidation.valid
      .filter((summary) => summary.status === "scored")
      .map((summary) => ({ attemptId: summary.attemptId, accepted: summary.accepted === true }));
    primaryPairedPass = summarizePairedBinary(
      pairedOutcomesFromRegistry(input.schedule, input.registry, accepted),
      input.statistics,
    );
  }

  const dispositionCounts: Record<string, number> = {};
  attempts.forEach((attempt) => increment(dispositionCounts, attempt.disposition));
  const missingRequiredScorerSummaries = attempts
    .filter((attempt) => attempt.expected)
    .flatMap((attempt) => attempt.missingRequiredScorerIds.map((scorerId) => ({ attemptId: attempt.attemptId, scorerId })));
  const failedScorerSummaries = scorerValidation.valid
    .filter((summary) => summary.status === "failed")
    .map((summary) => ({ attemptId: summary.attemptId, scorerId: summary.scorerId, errorCode: summary.errorCode }))
    .sort((left, right) => left.attemptId.localeCompare(right.attemptId) || left.scorerId.localeCompare(right.scorerId));
  const indeterminateScorerSummaries = scorerValidation.valid
    .filter((summary) => summary.status === "indeterminate")
    .map((summary) => ({ attemptId: summary.attemptId, scorerId: summary.scorerId }))
    .sort((left, right) => left.attemptId.localeCompare(right.attemptId) || left.scorerId.localeCompare(right.scorerId));

  const families = [...new Set(input.schedule.assignments.map((assignment) => assignment.taskFamily))].sort();
  const taskFamilyStrata = families.map((taskFamily): PilotFamilyStratum => {
    const assignments = input.schedule.assignments.filter((assignment) => assignment.taskFamily === taskFamily);
    const attemptIds = new Set(assignments.flatMap(attemptsForAssignment));
    const familyAttempts = attempts.filter((attempt) => attempt.expected && attemptIds.has(attempt.attemptId));
    const familyDispositionCounts: Record<string, number> = {};
    const authorOutcomeCounts: Record<string, number> = {};
    const scorerStatusCounts: Record<string, number> = {};
    familyAttempts.forEach((attempt) => {
      increment(familyDispositionCounts, attempt.disposition);
      increment(authorOutcomeCounts, attempt.authorOutcome ?? "missing");
      attempt.scorerSummaries.forEach((summary) => increment(scorerStatusCounts, summary.status));
      attempt.missingRequiredScorerIds.forEach(() => increment(scorerStatusCounts, "missing"));
    });
    return {
      taskFamily,
      scheduledPairCount: assignments.length,
      expectedAttemptCount: assignments.length * 2,
      retainedAttemptCount: familyAttempts.filter((attempt) => attempt.registryState !== "missing").length,
      dispositionCounts: familyDispositionCounts,
      authorOutcomeCounts,
      scorerStatusCounts,
      primaryPairedPass: primaryPairedPass?.byTaskFamily[taskFamily] ?? null,
    };
  });

  const aa = isAa(input.registry);
  const rejectionReasons: string[] = [];
  if (aa) rejectionReasons.push("AA_CALIBRATION_CANNOT_SUPPORT_IMPROVEMENT_CLAIM");
  if (integrityStatus === "invalid") rejectionReasons.push("INVALID_PILOT_EVIDENCE");
  if (integrityStatus === "incomplete") rejectionReasons.push("INCOMPLETE_ALL_ATTEMPT_REGISTRY");
  if (primaryPairedPass === null) rejectionReasons.push("PRIMARY_PAIRED_RESULT_UNAVAILABLE");

  const normalizedInput = {
    registry: input.registry,
    schedule: input.schedule,
    acceptanceSummaries: [...input.acceptanceSummaries].sort((left, right) => left.attemptId.localeCompare(right.attemptId)),
    scorerSummaries: [...input.scorerSummaries].sort((left, right) => left.attemptId.localeCompare(right.attemptId) || left.scorerId.localeCompare(right.scorerId)),
    requiredScorerIds,
    statistics: input.statistics ?? {},
  };
  const unsigned: Omit<PilotReport, "reportDigest"> = {
    schemaVersion: 1,
    runId: input.registry.runSpec.runId,
    protocolId: input.registry.runSpec.protocol.id,
    comparison: {
      kind: aa ? "aa_calibration" : "ab_improvement",
      baselineCommit: input.registry.runSpec.conditions.baseline.gitCommit,
      baselineBuildDigest: input.registry.runSpec.conditions.baseline.buildDigest,
      candidateCommit: input.registry.runSpec.conditions.candidate.gitCommit,
      candidateBuildDigest: input.registry.runSpec.conditions.candidate.buildDigest,
    },
    provenance: {
      registryRoot: input.registry.registryRoot,
      scheduleDigest: hashCanonicalJson(input.schedule),
      analysisInputDigest: hashCanonicalJson(normalizedInput),
    },
    integrity: {
      status: integrityStatus,
      scheduleViolations: [...new Set(scheduleViolations)].sort(),
      summaryViolations: [...new Set(summaryViolations)].sort(),
      registry: registryReconciliation,
    },
    retention: {
      expectedAttemptCount: expected.length,
      retainedAttemptCount: input.registry.attempts.length,
      attempts,
      orphanAcceptanceSummaries: acceptanceValidation.orphans.sort((left, right) => left.attemptId.localeCompare(right.attemptId)),
      orphanScorerSummaries: scorerValidation.orphans.sort((left, right) => left.attemptId.localeCompare(right.attemptId) || left.scorerId.localeCompare(right.scorerId)),
    },
    outcomeAccounting: {
      dispositionCounts,
      missingAcceptanceAttemptIds: attempts.filter((attempt) => attempt.expected && attempt.disposition === "missing_acceptance").map((attempt) => attempt.attemptId),
      failedAcceptanceAttemptIds: attempts.filter((attempt) => attempt.expected && attempt.disposition === "acceptance_failed").map((attempt) => attempt.attemptId),
      indeterminateAcceptanceAttemptIds: attempts.filter((attempt) => attempt.expected && attempt.disposition === "acceptance_indeterminate").map((attempt) => attempt.attemptId),
      missingRequiredScorerSummaries,
      failedScorerSummaries,
      indeterminateScorerSummaries,
    },
    primaryPairedPass,
    taskFamilyStrata,
    improvementClaim: {
      eligibility: rejectionReasons.length === 0 ? "eligible" : "rejected",
      purpose: aa ? "calibration_only" : "improvement",
      rejectionReasons,
    },
  };
  return { ...unsigned, reportDigest: hashCanonicalJson(unsigned) };
}

export function verifyPilotReport(report: PilotReport, input: PilotReportInput): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (hashCanonicalJson(withoutReportDigest(report)) !== report.reportDigest) errors.push("REPORT_DIGEST_INVALID");
  const expected = createPilotReport(input);
  if (hashCanonicalJson(report) !== hashCanonicalJson(expected)) errors.push("REPORT_DOES_NOT_MATCH_INPUTS");
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
