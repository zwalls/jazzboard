import { describe, expect, it } from "vitest";

import {
  createArtifactIndex,
  sealAttempt,
  transitionAttempt,
} from "./attempt-ledger";
import type { AttemptRegistry, RunSpec } from "./attempt-schemas";
import {
  initializePilotRegistry,
  pairedOutcomesFromRegistry,
  reconcilePilotRegistry,
} from "./pilot-coordinator";
import { createPilotRandomizationManifest } from "./pilot-schedule";
import { sha256Digest } from "./provenance-crypto";

const at = [
  "2026-08-30T20:00:00.000Z",
  "2026-08-30T20:00:01.000Z",
  "2026-08-30T20:00:02.000Z",
  "2026-08-30T20:00:03.000Z",
  "2026-08-30T20:00:04.000Z",
];
const digest = (value: string) => sha256Digest(value);
const tasks = [
  { taskId: "dev-arch", taskFamily: "architecture" },
  { taskId: "dev-draw", taskFamily: "drawing" },
];
const taskCommitments = tasks.map((task) => ({ taskId: task.taskId, commitment: digest(task.taskId) }));

function runSpec(): RunSpec {
  return {
    schemaVersion: 1,
    runId: "run-exp-0001",
    protocol: { id: "EXP-0001", digest: digest("protocol") },
    conditions: {
      baseline: { gitCommit: "a".repeat(40), buildDigest: digest("baseline"), deploymentUrl: "https://baseline.test" },
      candidate: { gitCommit: "b".repeat(40), buildDigest: digest("candidate"), deploymentUrl: "https://candidate.test" },
    },
    runner: { runnerDigest: digest("runner") },
    taskSet: { id: "dev", version: "v1", split: "development", commitment: digest("tasks") },
    model: { provider: "openai", snapshot: "gpt-test", reasoningEffort: "high", temperature: null, seed: null },
    environment: {
      imageDigest: digest("image"),
      browser: "Chromium test",
      viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
      locale: "en-US",
      timezone: "UTC",
    },
    budgets: { wallTimeMs: 600_000, maxToolCalls: 200, maxInputTokens: 100_000, maxOutputTokens: 20_000 },
    createdAt: at[0],
  };
}

function finish(
  registry: AttemptRegistry,
  attemptId: string,
  outcome: "author_completed" | "author_failed" | "timeout" = "author_completed",
): AttemptRegistry {
  let next = transitionAttempt(registry, attemptId, "provisioned", at[1]);
  next = transitionAttempt(next, attemptId, "started", at[2]);
  next = transitionAttempt(next, attemptId, outcome, at[3]);
  return sealAttempt(next, attemptId, at[4], createArtifactIndex(attemptId, []));
}

describe("pilot coordinator", () => {
  it("allocates the entire randomized sample before any author starts", () => {
    const schedule = createPilotRandomizationManifest("EXP-0001", tasks, 2, 7);
    const registry = initializePilotRegistry(runSpec(), schedule, taskCommitments, at[0]);
    expect(registry.attempts).toHaveLength(8);
    expect(registry.attempts.every((attempt) => attempt.state === "allocated")).toBe(true);
    expect(reconcilePilotRegistry(schedule, registry)).toMatchObject({
      status: "incomplete",
      expectedAttemptCount: 8,
      retainedAttemptCount: 8,
      missingAttemptIds: [],
      unexpectedAttemptIds: [],
    });
  });

  it("retains failed and timeout attempts and reaches a complete all-attempt registry", () => {
    const schedule = createPilotRandomizationManifest("EXP-0001", tasks, 1, 8);
    let registry = initializePilotRegistry(runSpec(), schedule, taskCommitments, at[0]);
    const attempts = schedule.assignments.flatMap((assignment) => assignment.attempts);
    registry = finish(registry, attempts[0].attemptId, "author_completed");
    registry = finish(registry, attempts[1].attemptId, "author_failed");
    registry = finish(registry, attempts[2].attemptId, "timeout");
    registry = finish(registry, attempts[3].attemptId, "author_completed");
    const result = reconcilePilotRegistry(schedule, registry);
    expect(result.status).toBe("complete");
    expect(result.authorOutcomeCounts.baseline).toEqual(expect.objectContaining({
      completed: expect.any(Number),
    }));
    expect(Object.values(result.authorOutcomeCounts.baseline).reduce((sum, value) => sum + value, 0)).toBe(2);
    expect(Object.values(result.authorOutcomeCounts.candidate).reduce((sum, value) => sum + value, 0)).toBe(2);
  });

  it("turns missing scores and unsuccessful authors into primary failures", () => {
    const schedule = createPilotRandomizationManifest("EXP-0001", tasks, 1, 9);
    let registry = initializePilotRegistry(runSpec(), schedule, taskCommitments, at[0]);
    for (const assignment of schedule.assignments) {
      for (const attempt of assignment.attempts) {
        registry = finish(
          registry,
          attempt.attemptId,
          assignment.taskId === "dev-draw" && attempt.condition === "candidate" ? "timeout" : "author_completed",
        );
      }
    }
    const firstPair = schedule.assignments.find((assignment) => assignment.taskId === "dev-arch");
    if (!firstPair) throw new Error("Missing architecture pair.");
    const baseline = firstPair.attempts.find((attempt) => attempt.condition === "baseline");
    const candidate = firstPair.attempts.find((attempt) => attempt.condition === "candidate");
    if (!baseline || !candidate) throw new Error("Missing condition.");
    const outcomes = pairedOutcomesFromRegistry(schedule, registry, [
      { attemptId: baseline.attemptId, accepted: true },
      // Candidate score is deliberately absent and therefore fails.
    ]);
    expect(outcomes.find((outcome) => outcome.taskId === "dev-arch")).toMatchObject({
      baselineAccepted: true,
      candidateAccepted: false,
    });
    expect(outcomes.find((outcome) => outcome.taskId === "dev-draw")?.candidateAccepted).toBe(false);
  });

  it("detects assignment tampering even when the nested registry is re-rooted", () => {
    const schedule = createPilotRandomizationManifest("EXP-0001", tasks, 1, 11);
    const registry = initializePilotRegistry(runSpec(), schedule, taskCommitments, at[0]);
    const tampered = structuredClone(registry);
    tampered.attempts[0].condition = tampered.attempts[0].condition === "baseline" ? "candidate" : "baseline";
    expect(reconcilePilotRegistry(schedule, tampered)).toMatchObject({
      status: "invalid",
      assignmentMismatchAttemptIds: [tampered.attempts[0].attemptId],
    });
  });

  it("refuses a schedule from another protocol or a task without a commitment", () => {
    const schedule = createPilotRandomizationManifest("OTHER", tasks, 1, 1);
    expect(() => initializePilotRegistry(runSpec(), schedule, taskCommitments, at[0]))
      .toThrow("protocol does not match");
    const correct = createPilotRandomizationManifest("EXP-0001", tasks, 1, 1);
    expect(() => initializePilotRegistry(runSpec(), correct, taskCommitments.slice(0, 1), at[0]))
      .toThrow("No frozen commitment");
  });
});
