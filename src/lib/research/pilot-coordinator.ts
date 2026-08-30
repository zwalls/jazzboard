import {
  allocateAttempt,
  createAttemptRegistry,
} from "./attempt-ledger";
import type { AttemptRegistry, RunSpec } from "./attempt-schemas";
import {
  validatePilotRandomizationManifest,
  type PilotRandomizationManifest,
} from "./pilot-schedule";
import type { PairedBinaryObservation } from "./statistics";
import { verifyAttemptRegistry } from "./provenance-verification";

export type PilotTaskCommitment = {
  taskId: string;
  commitment: string;
};

export function initializePilotRegistry(
  runSpec: RunSpec,
  schedule: PilotRandomizationManifest,
  tasks: readonly PilotTaskCommitment[],
  allocatedAt: string,
): AttemptRegistry {
  const scheduleViolations = validatePilotRandomizationManifest(schedule);
  if (scheduleViolations.length > 0) {
    throw new Error(`Pilot schedule is invalid: ${scheduleViolations.join(", ")}`);
  }
  if (schedule.protocolId !== runSpec.protocol.id) {
    throw new Error("Pilot schedule protocol does not match the run specification.");
  }
  const commitments = new Map(tasks.map((task) => [task.taskId, task.commitment]));
  if (commitments.size !== tasks.length) throw new Error("Pilot task commitments must have unique task IDs.");

  let registry = createAttemptRegistry(runSpec);
  for (const assignment of [...schedule.assignments].sort((left, right) => left.timeBlock - right.timeBlock)) {
    const taskCommitment = commitments.get(assignment.taskId);
    if (!taskCommitment) throw new Error(`No frozen commitment exists for task ${assignment.taskId}.`);
    for (const attempt of assignment.attempts) {
      registry = allocateAttempt(registry, {
        attemptId: attempt.attemptId,
        taskId: assignment.taskId,
        taskCommitment,
        pairId: assignment.pairId,
        condition: attempt.condition,
        replicateIndex: assignment.replicateIndex,
        orderIndex: attempt.orderIndex,
        timeBlock: assignment.timeBlock,
        at: allocatedAt,
      });
    }
  }
  return registry;
}

export type PilotRegistryReconciliation = {
  status: "complete" | "incomplete" | "invalid";
  expectedAttemptCount: number;
  retainedAttemptCount: number;
  missingAttemptIds: string[];
  unexpectedAttemptIds: string[];
  assignmentMismatchAttemptIds: string[];
  unsealedAttemptIds: string[];
  authorOutcomeCounts: Record<"baseline" | "candidate", Record<string, number>>;
  registryVerificationErrors: string[];
};

export function reconcilePilotRegistry(
  schedule: PilotRandomizationManifest,
  registry: AttemptRegistry,
): PilotRegistryReconciliation {
  const expected = new Map(schedule.assignments.flatMap((assignment) => assignment.attempts.map((attempt) => [
    attempt.attemptId,
    {
      pairId: assignment.pairId,
      taskId: assignment.taskId,
      replicateIndex: assignment.replicateIndex,
      timeBlock: assignment.timeBlock,
      condition: attempt.condition,
      orderIndex: attempt.orderIndex,
    },
  ] as const)));
  const retained = new Map(registry.attempts.map((attempt) => [attempt.attemptId, attempt]));
  const missingAttemptIds = [...expected.keys()].filter((attemptId) => !retained.has(attemptId)).sort();
  const unexpectedAttemptIds = [...retained.keys()].filter((attemptId) => !expected.has(attemptId)).sort();
  const assignmentMismatchAttemptIds = [...expected.entries()].flatMap(([attemptId, assignment]) => {
    const attempt = retained.get(attemptId);
    if (!attempt) return [];
    return attempt.pairId === assignment.pairId
      && attempt.taskId === assignment.taskId
      && attempt.replicateIndex === assignment.replicateIndex
      && attempt.timeBlock === assignment.timeBlock
      && attempt.condition === assignment.condition
      && attempt.orderIndex === assignment.orderIndex
      ? [] : [attemptId];
  }).sort();
  const unsealedAttemptIds = registry.attempts
    .filter((attempt) => attempt.state !== "sealed")
    .map((attempt) => attempt.attemptId)
    .sort();
  const authorOutcomeCounts: PilotRegistryReconciliation["authorOutcomeCounts"] = {
    baseline: {},
    candidate: {},
  };
  for (const attempt of registry.attempts) {
    const outcome = attempt.authorOutcome ?? "not_finished";
    authorOutcomeCounts[attempt.condition][outcome] = (authorOutcomeCounts[attempt.condition][outcome] ?? 0) + 1;
  }
  const verification = verifyAttemptRegistry(registry);
  const registryVerificationErrors = verification.ok ? [] : verification.errors;
  const invalid = unexpectedAttemptIds.length > 0
    || assignmentMismatchAttemptIds.length > 0
    || registryVerificationErrors.length > 0;
  const incomplete = missingAttemptIds.length > 0 || unsealedAttemptIds.length > 0;
  return {
    status: invalid ? "invalid" : incomplete ? "incomplete" : "complete",
    expectedAttemptCount: expected.size,
    retainedAttemptCount: registry.attempts.length,
    missingAttemptIds,
    unexpectedAttemptIds,
    assignmentMismatchAttemptIds,
    unsealedAttemptIds,
    authorOutcomeCounts,
    registryVerificationErrors,
  };
}

export type AttemptAcceptance = {
  attemptId: string;
  accepted: boolean;
};

/**
 * Converts the all-attempt registry into the paired primary endpoint. Missing
 * or failed scores and every non-completed author outcome remain failures;
 * they are never removed from the denominator.
 */
export function pairedOutcomesFromRegistry(
  schedule: PilotRandomizationManifest,
  registry: AttemptRegistry,
  acceptanceResults: readonly AttemptAcceptance[],
): PairedBinaryObservation[] {
  const reconciliation = reconcilePilotRegistry(schedule, registry);
  if (reconciliation.status !== "complete") {
    throw new Error(`Pilot registry is not complete: ${JSON.stringify(reconciliation)}`);
  }
  const acceptanceByAttempt = new Map<string, boolean>();
  for (const result of acceptanceResults) {
    if (acceptanceByAttempt.has(result.attemptId)) {
      throw new Error(`Duplicate acceptance result for ${result.attemptId}.`);
    }
    acceptanceByAttempt.set(result.attemptId, result.accepted);
  }
  const attempts = new Map(registry.attempts.map((attempt) => [attempt.attemptId, attempt]));

  return [...schedule.assignments]
    .sort((left, right) => left.timeBlock - right.timeBlock)
    .map((assignment) => {
      const baselineAssignment = assignment.attempts.find((attempt) => attempt.condition === "baseline");
      const candidateAssignment = assignment.attempts.find((attempt) => attempt.condition === "candidate");
      if (!baselineAssignment || !candidateAssignment) throw new Error(`Pair ${assignment.pairId} lacks both conditions.`);
      const baselineAttempt = attempts.get(baselineAssignment.attemptId);
      const candidateAttempt = attempts.get(candidateAssignment.attemptId);
      if (!baselineAttempt || !candidateAttempt) throw new Error(`Pair ${assignment.pairId} is absent from the registry.`);
      const accepted = (attemptId: string, outcome: string | null) => outcome === "completed"
        && acceptanceByAttempt.get(attemptId) === true;
      return {
        pairId: assignment.pairId,
        taskId: assignment.taskId,
        taskFamily: assignment.taskFamily,
        baselineAccepted: accepted(baselineAttempt.attemptId, baselineAttempt.authorOutcome),
        candidateAccepted: accepted(candidateAttempt.attemptId, candidateAttempt.authorOutcome),
      };
    });
}
