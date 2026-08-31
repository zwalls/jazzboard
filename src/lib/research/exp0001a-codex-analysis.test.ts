import { describe, expect, it } from "vitest";

import {
  EXP0001A_CODEX_FROZEN_ROLE_SETTINGS,
  UNOBSERVABLE,
  beginExp0001aCodexTask,
  completeExp0001aCodexTask,
  exp0001aCodexAccountingLedgerSchema,
  exp0001aCodexTaskAccountingSchema,
  terminateExp0001aCodexTask,
} from "./exp0001a-codex-accounting";
import { analyzeExp0001aCodexExperiment } from "./exp0001a-codex-analysis";

function terminalTask(input: {
  index: number;
  assignmentId: string;
  attemptId: string;
  seconds: number;
  calls: number;
  failures?: number;
  revisions: number;
  inspections: number;
}) {
  const begunAt = new Date(Date.parse("2026-08-30T10:00:00.000Z") + input.index * 60_000).toISOString();
  let task = beginExp0001aCodexTask({
    accountingId: `accounting-${input.index}`,
    assignmentId: input.assignmentId,
    attemptId: input.attemptId,
    role: "author",
    codexTaskId: `codex-task-${input.index}`,
    threadId: `thread-${input.index}`,
    hostId: UNOBSERVABLE,
    isolation: {
      workspace: "projectless",
      repositoryAccess: false,
      privateApiAccess: false,
      sharedHistory: false,
      forkedFromAnotherTask: false,
      preparedCoordinates: false,
      evaluatorContext: false,
    },
    requestedModel: "gpt-5.6-sol",
    requestedReasoningEffort: "max",
    begunAt,
  });
  const completedAt = new Date(Date.parse(begunAt) + input.seconds * 1_000).toISOString();
  task = completeExp0001aCodexTask(task, completedAt);
  task = terminateExp0001aCodexTask(task, {
    terminalAt: completedAt,
    outcome: "succeeded",
    reasonCode: "author_evidence_retained",
  });
  const observed = (value: number) => ({
    value,
    source: "retained_task_receipt" as const,
    observedAt: completedAt,
    evidenceDigest: `sha256:${"a".repeat(64)}`,
  });
  return exp0001aCodexTaskAccountingSchema.parse({
    ...task,
    webMcp: { callCount: observed(input.calls), failureCount: observed(input.failures ?? 0) },
    canvas: { revisionCount: observed(input.revisions), inspectionCount: observed(input.inspections) },
  });
}

function fixture() {
  const attempts = [] as Array<{
    assignmentId: string;
    attemptId: string;
    accountingId: string;
    pairId: string;
    taskId: string;
    taskFamily: "architecture" | "drawing";
    condition: "A0" | "A1";
    accepted: boolean;
    artifactComplete: boolean;
  }>;
  const pairwisePreferences = [] as Array<{
    pairId: string;
    taskId: string;
    taskFamily: "architecture" | "drawing";
    preferredCondition: "A0" | "A1" | "tie" | "unavailable";
  }>;
  const tasks = [];
  for (let taskIndex = 0; taskIndex < 12; taskIndex += 1) {
    const taskId = `task-${taskIndex}`;
    const taskFamily = taskIndex < 6 ? "architecture" as const : "drawing" as const;
    for (let replicate = 0; replicate < 2; replicate += 1) {
      const pairIndex = taskIndex * 2 + replicate;
      const pairId = `pair-${pairIndex}`;
      for (const condition of ["A0", "A1"] as const) {
        const index = pairIndex * 2 + (condition === "A0" ? 0 : 1);
        const assignmentId = `assignment-${index}`;
        const attemptId = `attempt-${index}`;
        tasks.push(terminalTask({
          index,
          assignmentId,
          attemptId,
          seconds: 8 + (index % 5),
          calls: 8 + (index % 7),
          failures: index === 2 ? 1 : 0,
          revisions: 3 + (index % 6),
          inspections: index % 4,
        }));
        attempts.push({
          assignmentId,
          attemptId,
          accountingId: `accounting-${index}`,
          pairId,
          taskId,
          taskFamily,
          condition,
          accepted: condition === "A0" ? pairIndex % 2 === 0 : pairIndex % 3 !== 0,
          artifactComplete: condition === "A1" || pairIndex !== 0,
        });
      }
      pairwisePreferences.push({
        pairId,
        taskId,
        taskFamily,
        preferredCondition: pairIndex % 3 === 0 ? "A0" : pairIndex % 3 === 1 ? "A1" : "tie",
      });
    }
  }
  return {
    attempts,
    pairwisePreferences,
    ledger: exp0001aCodexAccountingLedgerSchema.parse({
      schemaVersion: "exp-0001a-codex-accounting-ledger/v1",
      protocolId: "EXP-0001A",
      frozenRoleSettings: EXP0001A_CODEX_FROZEN_ROLE_SETTINGS,
      tasks,
    }),
  };
}

describe("EXP-0001A Codex-native analysis", () => {
  it("preserves exact denominators and measures subscription-era resources", () => {
    const value = fixture();
    let reviewer = beginExp0001aCodexTask({
      accountingId: "accounting-review-0",
      assignmentId: "review-assignment-0",
      attemptId: "review-attempt-0",
      role: "primary_reviewer",
      codexTaskId: "codex-review-task-0",
      threadId: "review-thread-0",
      hostId: UNOBSERVABLE,
      isolation: {
        workspace: "projectless",
        repositoryAccess: false,
        privateApiAccess: false,
        sharedHistory: false,
        forkedFromAnotherTask: false,
        preparedCoordinates: false,
        evaluatorContext: false,
      },
      requestedModel: "gpt-5.6-sol",
      requestedReasoningEffort: "high",
      begunAt: "2026-08-30T12:00:00.000Z",
    });
    reviewer = completeExp0001aCodexTask(reviewer, "2026-08-30T12:00:01.000Z");
    reviewer = terminateExp0001aCodexTask(reviewer, {
      terminalAt: "2026-08-30T12:00:01.000Z",
      outcome: "succeeded",
      reasonCode: "review_retained",
    });
    const fullLedger = exp0001aCodexAccountingLedgerSchema.parse({
      ...value.ledger,
      tasks: [...value.ledger.tasks, reviewer],
    });
    const report = analyzeExp0001aCodexExperiment({
      attempts: value.attempts,
      pairwisePreferences: value.pairwisePreferences,
      accountingLedger: fullLedger,
    });

    expect(report).toMatchObject({
      schemaVersion: "exp-0001a-codex-analysis/v1",
      pairCount: 24,
      attemptCount: 48,
      clusterAwareInference: {
        acceptance: { taskCount: 12, permutationCount: 4096, evaluation: "evaluable" },
        pairwiseVisualPreference: { taskCount: 12, permutationCount: 4096, evaluation: "evaluable" },
      },
      pairwiseVisual: { pairCount: 24, A0Wins: 8, A1Wins: 8, ties: 8, unavailable: 0 },
      webMcpFailures: {
        A0: 1, A1: 0, total: 1, observedTaskCount: 48, unobservableTaskCount: 0,
      },
      accounting: { codexTaskCount: 49, roleTaskCounts: { author: 48, primary_reviewer: 1 } },
    });
    expect(report.resources.wallTimeMs.comparablePairCount).toBe(24);
    expect(report.resources.inspections.omittedZeroPairCount).toBeGreaterThan(0);
    expect(JSON.stringify(report)).not.toMatch(/cost|usd|price|provider/i);
    expect(analyzeExp0001aCodexExperiment({
      attempts: value.attempts,
      pairwisePreferences: value.pairwisePreferences,
      accountingLedger: fullLedger,
    })).toEqual(report);
  });

  it("fails closed on pair contamination, incomplete denominators, preference drift, or nonterminal work", () => {
    const value = fixture();
    expect(() => analyzeExp0001aCodexExperiment({
      attempts: value.attempts.map((attempt, index) => index === 1 ? { ...attempt, condition: "A0" as const } : attempt),
      pairwisePreferences: value.pairwisePreferences,
      accountingLedger: value.ledger,
    })).toThrow(/exactly one A0 and one A1/i);

    expect(() => analyzeExp0001aCodexExperiment({
      attempts: value.attempts.slice(0, 2),
      pairwisePreferences: value.pairwisePreferences,
      accountingLedger: value.ledger,
    })).toThrow(/48/);

    expect(() => analyzeExp0001aCodexExperiment({
      attempts: value.attempts,
      pairwisePreferences: value.pairwisePreferences.map((preference, index) => index === 0
        ? { ...preference, taskId: "wrong-task" }
        : preference),
      accountingLedger: value.ledger,
    })).toThrow(/PAIRWISE_PREFERENCE_BINDING_MISMATCH/);

    const ledger = exp0001aCodexAccountingLedgerSchema.parse({
      ...value.ledger,
      tasks: value.ledger.tasks.map((task, index) => index === 0 ? {
        ...task,
        state: "completed",
        terminalAt: null,
        terminalOutcome: null,
        terminalReasonCode: null,
      } : task),
    });
    expect(() => analyzeExp0001aCodexExperiment({
      attempts: value.attempts,
      pairwisePreferences: value.pairwisePreferences,
      accountingLedger: ledger,
    })).toThrow(/TERMINAL_AUTHOR_TASK/);
  });

  it("uses complete-task sign flips when duplicated replicate evidence makes pair-level tests anti-conservative", () => {
    const value = fixture();
    for (let taskIndex = 0; taskIndex < 12; taskIndex += 1) {
      const desired = taskIndex < 8 ? "A1" as const : taskIndex < 10 ? "A0" as const : "tie" as const;
      for (const attempt of value.attempts.filter((candidate) => candidate.taskId === `task-${taskIndex}`)) {
        attempt.accepted = desired === "A1" ? attempt.condition === "A1"
          : desired === "A0" ? attempt.condition === "A0" : false;
      }
      for (const preference of value.pairwisePreferences.filter((candidate) => candidate.taskId === `task-${taskIndex}`)) {
        preference.preferredCondition = desired;
      }
    }

    const report = analyzeExp0001aCodexExperiment({
      attempts: value.attempts,
      pairwisePreferences: value.pairwisePreferences,
      accountingLedger: value.ledger,
    });

    expect(report.acceptance.exactMcNemarPValue).toBeLessThan(0.10);
    expect(report.clusterAwareInference.acceptance.exactTwoSidedPValue).toBeCloseTo(0.109375, 12);
    expect(report.pairwiseVisual.exactTwoSidedSignPValue).toBeLessThan(0.10);
    expect(report.clusterAwareInference.pairwiseVisualPreference.exactTwoSidedPValue).toBeCloseTo(0.109375, 12);
  });

  it("preserves an unavailable visual judgment and makes only visual inference non-evaluable", () => {
    const value = fixture();
    value.pairwisePreferences[0]!.preferredCondition = "unavailable";
    const report = analyzeExp0001aCodexExperiment({
      attempts: value.attempts,
      pairwisePreferences: value.pairwisePreferences,
      accountingLedger: value.ledger,
    });

    expect(report.clusterAwareInference.acceptance.evaluation).toBe("evaluable");
    expect(report.clusterAwareInference.pairwiseVisualPreference).toMatchObject({
      evaluation: "not_evaluable",
      exactTwoSidedPValue: null,
    });
    expect(report.pairwiseVisual.unavailable).toBe(1);
  });

  it("rejects post-data attempts to override the frozen analysis seed or draw count", () => {
    const value = fixture();
    expect(() => analyzeExp0001aCodexExperiment({
      attempts: value.attempts,
      pairwisePreferences: value.pairwisePreferences,
      accountingLedger: value.ledger,
      seed: 7,
      bootstrapDraws: 1,
    } as unknown as Parameters<typeof analyzeExp0001aCodexExperiment>[0])).toThrow(
      /CALLER_OVERRIDES_FORBIDDEN/,
    );
  });
});
