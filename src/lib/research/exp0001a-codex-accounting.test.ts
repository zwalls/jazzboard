import { describe, expect, it } from "vitest";

import {
  EXP0001A_CODEX_FROZEN_ROLE_SETTINGS,
  UNOBSERVABLE,
  beginExp0001aCodexTask,
  beginNextExp0001aCodexAssignment,
  completeActiveExp0001aCodexAssignment,
  completeExp0001aCodexTask,
  createExp0001aCodexScheduler,
  exp0001aCodexAccountingLedgerSchema,
  exp0001aCodexBalanceReport,
  exp0001aCodexSchedulerStateSchema,
  exp0001aCodexTaskAccountingSchema,
  interruptExp0001aCodexTaskForUsageLimit,
  nextExp0001aCodexAssignment,
  observableCountSchema,
  pauseExp0001aCodexSchedulerForUsageLimit,
  recordExp0001aCodexTaskActivity,
  recordExp0001aCodexTaskObservability,
  resumeExp0001aCodexSchedulerAfterUsageReset,
  summarizeExp0001aCodexAccounting,
  terminalizeActiveExp0001aCodexAssignment,
  terminateExp0001aCodexTask,
  verifyExp0001aCodexAccountingLedgerAsOf,
  verifyExp0001aCodexSchedulerStateAsOf,
  type Exp0001aCodexTaskAccounting,
  type Exp0001aFrozenCodexAssignment,
} from "./exp0001a-codex-accounting";
import { hashCanonicalJson, type JsonValue } from "./provenance-crypto";

const digest = (character: string) => `sha256:${character.repeat(64)}`;

function subscriptionProbe(accountingId = "probe-accounting-0") {
  let probe = beginTask({
    accountingId,
    assignmentId: `probe-assignment-${accountingId}`,
    attemptId: `probe-attempt-${accountingId}`,
    role: "subscription_probe",
    codexTaskId: `probe-task-${accountingId}`,
    threadId: `probe-task-${accountingId}`,
    hostId: "local",
    requestedReasoningEffort: "low",
    begunAt: "2026-08-30T10:00:00.000Z",
  });
  probe = completeExp0001aCodexTask(probe, "2026-08-30T10:00:01.000Z");
  return terminateExp0001aCodexTask(probe, {
    terminalAt: "2026-08-30T10:00:01.000Z",
    outcome: "succeeded",
    reasonCode: "availability_probe_succeeded",
  });
}

function usageResetObservation(window: number, observedAt: string, resumedAt: string, character: string, priorInterruptionDigest: string) {
  const probe = subscriptionProbe();
  const usage = (amount: number) => ({
    value: {
      unit: "percent_remaining" as const,
      amount,
      windowStartedAt: null,
      windowEndsAt: null,
    },
    source: "chatgpt_account" as const,
    observedAt,
    evidenceDigest: digest(character),
  });
  const observation = {
    schemaVersion: "exp-0001a-chatgpt-usage-reset-observation/v1" as const,
    kind: "chatgpt-usage-reset-observation" as const,
    observationId: `usage-reset-${window}`,
    observedAt,
    resumedAt,
    priorUsageWindow: window,
    nextUsageWindow: window + 1,
    source: "codex_app_host" as const,
    resetState: "availability_probe_succeeded" as const,
    priorInterruptionDigest,
    subscriptionUsageBefore: usage(0),
    subscriptionUsageAfter: usage(100),
    probe: {
      role: "subscription_probe" as const,
      neutralPromptDigest: "sha256:2efa901c987a4dc1083b82ca442f3478f3226206043adf7a69023b9a3ecd4713" as const,
      benchmarkContentIncluded: false as const,
      accountingId: probe.accountingId,
      accountingRecordDigest: digest(character),
      codexTaskId: probe.codexTaskId,
      threadId: probe.threadId,
      hostId: probe.hostId as string,
      createThreadRawOutputDigest: digest(character),
      terminalRawOutputDigest: digest(character),
    },
    authoritySignature: {
      schemaVersion: "exp-0001a-codex-authority-signature/v1" as const,
      protocolId: "EXP-0001A" as const,
      kind: "codex-authority-signature" as const,
      algorithm: "Ed25519" as const,
      keyId: "exp0001a-launch-authority-2026-08-30" as const,
      publicKeyDigest: "sha256:6fdb285e74644254c72c0e58b098bb1f7d9f8091dc861f830750e89464e503de" as const,
      signedAt: resumedAt,
      purpose: "usage_reset_probe" as const,
      payloadDigest: digest(character),
      signatureBase64: `${"A".repeat(86)}==`,
    },
  };
  return { observation, probe };
}

function beginTask(overrides: Partial<Parameters<typeof beginExp0001aCodexTask>[0]> = {}) {
  return beginExp0001aCodexTask({
    accountingId: "accounting-1",
    assignmentId: "assignment-1",
    attemptId: "attempt-1",
    role: "author",
    codexTaskId: "codex-task-1",
    threadId: "thread-1",
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
    begunAt: "2026-08-30T10:00:00.000Z",
    ...overrides,
  });
}

function frozenSchedule(): Exp0001aFrozenCodexAssignment[] {
  return [
    { assignmentId: "assignment-0", attemptId: "attempt-0", pairId: "pair-0", condition: "A0", plannedIndex: 0, timeBlock: 0, orderInPair: 0 },
    { assignmentId: "assignment-1", attemptId: "attempt-1", pairId: "pair-0", condition: "A1", plannedIndex: 1, timeBlock: 0, orderInPair: 1 },
    { assignmentId: "assignment-2", attemptId: "attempt-2", pairId: "pair-1", condition: "A1", plannedIndex: 2, timeBlock: 1, orderInPair: 0 },
    { assignmentId: "assignment-3", attemptId: "attempt-3", pairId: "pair-1", condition: "A0", plannedIndex: 3, timeBlock: 1, orderInPair: 1 },
  ];
}

function beginCurrent(
  state: ReturnType<typeof createExp0001aCodexScheduler>,
  assignmentId: string,
  sequence: number,
) {
  return beginNextExp0001aCodexAssignment(state, {
    assignmentId,
    begunAt: `2026-08-30T10:${String(sequence).padStart(2, "0")}:00.000Z`,
    codexTaskId: `codex-task-${sequence}`,
    threadId: `thread-${sequence}`,
  });
}

function succeedCurrent(
  state: ReturnType<typeof createExp0001aCodexScheduler>,
  sequence: number,
) {
  const completed = completeActiveExp0001aCodexAssignment(
    state,
    `2026-08-30T10:${String(sequence).padStart(2, "0")}:30.000Z`,
  );
  return terminalizeActiveExp0001aCodexAssignment(completed, {
    terminalAt: `2026-08-30T10:${String(sequence).padStart(2, "0")}:31.000Z`,
    outcome: "succeeded",
  });
}

describe("EXP-0001A Codex subscription accounting", () => {
  it("allows only evidence-backed observations or the literal unobservable", () => {
    expect(observableCountSchema.parse(UNOBSERVABLE)).toBe(UNOBSERVABLE);
    expect(observableCountSchema.parse({
      value: 42,
      source: "codex_app",
      observedAt: "2026-08-30T10:00:00.000Z",
      evidenceDigest: digest("a"),
    })).toMatchObject({ value: 42 });
    expect(observableCountSchema.safeParse(42).success).toBe(false);
    expect(observableCountSchema.safeParse({ value: 42, source: "estimate" }).success).toBe(false);
    expect(observableCountSchema.safeParse("estimated").success).toBe(false);
  });

  it("enforces the projectless, repository-free, private-API-free isolation boundary", () => {
    const record = beginTask();
    expect(record.isolation).toEqual({
      workspace: "projectless",
      repositoryAccess: false,
      privateApiAccess: false,
      sharedHistory: false,
      forkedFromAnotherTask: false,
      preparedCoordinates: false,
      evaluatorContext: false,
    });
    expect(exp0001aCodexTaskAccountingSchema.safeParse({
      ...record,
      isolation: { ...record.isolation, repositoryAccess: true },
    }).success).toBe(false);
  });

  it("begins activity telemetry as unobservable and rejects caller-supplied increments", () => {
    const active = beginTask();
    expect(active).toMatchObject({
      webMcp: { callCount: UNOBSERVABLE, failureCount: UNOBSERVABLE },
      canvas: { revisionCount: UNOBSERVABLE, inspectionCount: UNOBSERVABLE },
    });
    expect(() => recordExp0001aCodexTaskActivity(active, {
      webMcpCalls: 7,
      webMcpFailures: 1,
      revisions: 4,
      inspections: 3,
    })).toThrow(/CALLER_INCREMENT_RETIRED/);
    const completed = completeExp0001aCodexTask(active, "2026-08-30T10:00:05.000Z");
    const terminal = terminateExp0001aCodexTask(completed, {
      terminalAt: "2026-08-30T10:00:06.000Z",
      outcome: "succeeded",
      reasonCode: "author_result_retained",
    });
    expect(terminal).toMatchObject({
      state: "terminal",
      terminalOutcome: "succeeded",
      wallTimeMs: 6_000,
      webMcp: { callCount: UNOBSERVABLE, failureCount: UNOBSERVABLE },
      canvas: { revisionCount: UNOBSERVABLE, inspectionCount: UNOBSERVABLE },
    });
  });

  it("can attach exact receipt observations after completion but never estimates or revises a terminal record", () => {
    const evidence = (value: number) => ({
      value,
      source: "retained_task_receipt" as const,
      observedAt: "2026-08-30T10:00:05.000Z",
      evidenceDigest: digest("8"),
    });
    const completed = completeExp0001aCodexTask(beginTask(), "2026-08-30T10:00:05.000Z");
    const observed = recordExp0001aCodexTaskObservability(completed, {
      inputTokens: evidence(120),
      outputTokens: evidence(30),
      totalTokens: evidence(150),
      chatGptCredits: UNOBSERVABLE,
    });
    expect(observed).toMatchObject({ inputTokens: { value: 120 }, totalTokens: { value: 150 } });
    expect(() => recordExp0001aCodexTaskObservability(completed, {
      inputTokens: evidence(120),
      outputTokens: evidence(30),
      totalTokens: evidence(999),
    })).toThrow(/total tokens/i);
    const terminal = terminateExp0001aCodexTask(observed, {
      terminalAt: "2026-08-30T10:00:06.000Z",
      outcome: "succeeded",
      reasonCode: "retained",
    });
    expect(() => recordExp0001aCodexTaskObservability(terminal, { totalTokens: UNOBSERVABLE })).toThrow(/AFTER_TERMINAL/);
  });

  it("retains a usage-limit interruption as a terminal begun attempt", () => {
    const terminal = interruptExp0001aCodexTaskForUsageLimit(beginTask(), {
      observedAt: "2026-08-30T10:00:09.000Z",
      phase: "task_execution",
      evidenceDigest: digest("b"),
      reasonCode: "subscription_usage_limit",
    });
    expect(terminal).toMatchObject({
      state: "terminal",
      completedAt: null,
      terminalOutcome: "usage_limit_interrupted",
      wallTimeMs: 9_000,
    });
    expect(terminal.usageLimitInterruptions).toHaveLength(1);
  });

  it("summarizes task-based subscription accounting without dollar or estimated-token fields", () => {
    const observed = {
      value: 123,
      source: "retained_task_receipt" as const,
      observedAt: "2026-08-30T10:00:00.000Z",
      evidenceDigest: digest("c"),
    };
    const activity = (value: number) => ({
      value,
      source: "retained_task_receipt" as const,
      observedAt: "2026-08-30T10:00:00.000Z",
      evidenceDigest: digest("c"),
    });
    let first: Exp0001aCodexTaskAccounting = recordExp0001aCodexTaskObservability(beginTask(), { inputTokens: observed });
    first = exp0001aCodexTaskAccountingSchema.parse({
      ...first,
      webMcp: { callCount: activity(3), failureCount: activity(0) },
      canvas: { revisionCount: activity(2), inspectionCount: activity(1) },
    });
    first = completeExp0001aCodexTask(first, "2026-08-30T10:00:05.000Z");
    first = terminateExp0001aCodexTask(first, { terminalAt: "2026-08-30T10:00:06.000Z", outcome: "succeeded", reasonCode: "retained" });
    const second = interruptExp0001aCodexTaskForUsageLimit(beginTask({
      accountingId: "accounting-2",
      assignmentId: "assignment-2",
      attemptId: "attempt-2",
      role: "primary_reviewer",
      codexTaskId: "codex-task-2",
      threadId: "thread-2",
      requestedReasoningEffort: "high",
    }), {
      observedAt: "2026-08-30T10:00:02.000Z",
      phase: "task_wait",
      evidenceDigest: digest("d"),
      reasonCode: "usage_limit",
    });
    const ledger = exp0001aCodexAccountingLedgerSchema.parse({
      schemaVersion: "exp-0001a-codex-accounting-ledger/v1",
      protocolId: "EXP-0001A",
      frozenRoleSettings: EXP0001A_CODEX_FROZEN_ROLE_SETTINGS,
      tasks: [first, second],
    });
    expect(summarizeExp0001aCodexAccounting(ledger)).toEqual(expect.objectContaining({
      codexTaskCount: 2,
      begunTaskCount: 2,
      completedTaskCount: 1,
      terminalTaskCount: 2,
      totalWallTimeMs: 8_000,
      webMcpCallCount: { observedTotal: 3, observedTaskCount: 1, unobservableTaskCount: 1 },
      revisionCount: { observedTotal: 2, observedTaskCount: 1, unobservableTaskCount: 1 },
      inspectionCount: { observedTotal: 1, observedTaskCount: 1, unobservableTaskCount: 1 },
      usageLimitInterruptionCount: 1,
      unobservableInputTokenCount: 1,
      unobservableOutputTokenCount: 2,
      unobservableCreditCount: 2,
      roleTaskCounts: expect.objectContaining({ author: 1, primary_reviewer: 1 }),
    }));
    expect(JSON.stringify(ledger)).not.toMatch(/cost|usd|price|estimate/i);
  });

  it("requires fresh task/thread IDs and the frozen model settings", () => {
    const first = beginTask();
    const duplicate = beginTask({ accountingId: "accounting-2", assignmentId: "assignment-2", attemptId: "attempt-2" });
    const base = {
      schemaVersion: "exp-0001a-codex-accounting-ledger/v1",
      protocolId: "EXP-0001A",
      frozenRoleSettings: EXP0001A_CODEX_FROZEN_ROLE_SETTINGS,
      tasks: [first, duplicate],
    };
    expect(exp0001aCodexAccountingLedgerSchema.safeParse(base).success).toBe(false);
    expect(exp0001aCodexAccountingLedgerSchema.safeParse({
      ...base,
      tasks: [first, beginTask({
        accountingId: "accounting-2",
        assignmentId: "assignment-2",
        attemptId: "attempt-2",
        codexTaskId: "codex-task-2",
        threadId: "thread-2",
        requestedReasoningEffort: "high",
      })],
    }).success).toBe(false);
    expect(exp0001aCodexAccountingLedgerSchema.safeParse({
      ...base,
      tasks: [beginTask({
        role: "primary_reviewer",
        requestedReasoningEffort: "max",
      })],
    }).success).toBe(false);
    expect(exp0001aCodexAccountingLedgerSchema.safeParse({
      ...base,
      tasks: [beginTask({
        role: "primary_reviewer",
        requestedReasoningEffort: "high",
      })],
    }).success).toBe(true);
  });

  it("begins with only unobservable telemetry and rejects future evidence in a directly ingested ledger", () => {
    const begun = beginTask();
    expect(begun).toMatchObject({
      resolvedModelSnapshot: UNOBSERVABLE,
      inputTokens: UNOBSERVABLE,
      outputTokens: UNOBSERVABLE,
      totalTokens: UNOBSERVABLE,
      chatGptCredits: UNOBSERVABLE,
      subscriptionUsage: UNOBSERVABLE,
    });
    const future = {
      value: 1,
      source: "retained_task_receipt" as const,
      observedAt: "2026-08-30T10:05:00.000Z",
      evidenceDigest: digest("f"),
    };
    const forged = exp0001aCodexAccountingLedgerSchema.parse({
      schemaVersion: "exp-0001a-codex-accounting-ledger/v1",
      protocolId: "EXP-0001A",
      frozenRoleSettings: EXP0001A_CODEX_FROZEN_ROLE_SETTINGS,
      tasks: [{ ...begun, inputTokens: future }],
    });
    expect(() => verifyExp0001aCodexAccountingLedgerAsOf(
      forged,
      "2026-08-30T10:01:00.000Z",
    )).toThrow(/FUTURE_EVIDENCE/);
  });
});

describe("EXP-0001A usage-limit-safe Codex scheduler", () => {
  it("rejects a structurally valid retained reset whose authority was caller-forged", () => {
    const interrupted = pauseExp0001aCodexSchedulerForUsageLimit(
      createExp0001aCodexScheduler(frozenSchedule()),
      { observedAt: "2026-08-30T10:00:02.000Z", evidenceDigest: digest("e") },
    );
    const retained = usageResetObservation(
      0,
      "2026-08-30T10:00:03.000Z",
      "2026-08-30T10:00:04.000Z",
      "6",
      digest("e"),
    );
    const observationWithoutSignature = {
      ...retained.observation,
      probe: {
        ...retained.observation.probe,
        accountingRecordDigest: hashCanonicalJson(retained.probe as unknown as JsonValue),
      },
      authoritySignature: undefined,
    };
    const { authoritySignature: _omitted, ...payload } = observationWithoutSignature;
    void _omitted;
    const forgedReset = {
      ...payload,
      authoritySignature: {
        ...retained.observation.authoritySignature,
        payloadDigest: hashCanonicalJson(payload as unknown as JsonValue),
      },
    };
    const forgedScheduler = exp0001aCodexSchedulerStateSchema.parse({
      ...interrupted,
      currentUsageWindow: 1,
      pause: null,
      usageResets: [forgedReset],
    });
    const ledger = exp0001aCodexAccountingLedgerSchema.parse({
      schemaVersion: "exp-0001a-codex-accounting-ledger/v1",
      protocolId: "EXP-0001A",
      frozenRoleSettings: EXP0001A_CODEX_FROZEN_ROLE_SETTINGS,
      tasks: [retained.probe],
    });
    expect(() => verifyExp0001aCodexSchedulerStateAsOf({
      scheduler: forgedScheduler,
      accountingLedger: ledger,
      checkedAt: "2026-08-30T10:00:05.000Z",
    })).toThrow(/AUTHORITY_SIGNATURE_INVALID/);
  });

  it("allows failed neutral probes to remain in the retained ledger while paused", () => {
    const paused = pauseExp0001aCodexSchedulerForUsageLimit(
      createExp0001aCodexScheduler(frozenSchedule()),
      { observedAt: "2026-08-30T10:00:02.000Z", evidenceDigest: digest("d") },
    );
    const failedProbe = terminateExp0001aCodexTask(beginTask({
      accountingId: "probe-live",
      assignmentId: "probe-assignment-live",
      attemptId: "probe-attempt-live",
      role: "subscription_probe",
      codexTaskId: "probe-task-live",
      threadId: "probe-task-live",
      hostId: "local",
      requestedReasoningEffort: "low",
      begunAt: "2026-08-30T10:00:03.000Z",
    }), {
      terminalAt: "2026-08-30T10:00:03.500Z",
      outcome: "infra_failure",
      reasonCode: "availability_probe_failed",
    });
    const ledger = exp0001aCodexAccountingLedgerSchema.parse({
      schemaVersion: "exp-0001a-codex-accounting-ledger/v1",
      protocolId: "EXP-0001A",
      frozenRoleSettings: EXP0001A_CODEX_FROZEN_ROLE_SETTINGS,
      tasks: [failedProbe],
    });
    expect(verifyExp0001aCodexSchedulerStateAsOf({
      scheduler: paused,
      accountingLedger: ledger,
      checkedAt: "2026-08-30T10:00:04.000Z",
    }).pause).not.toBeNull();
  });

  it("releases only the exact next frozen assignment and never overlaps tasks", () => {
    let state = createExp0001aCodexScheduler(frozenSchedule());
    expect(() => beginCurrent(state, "assignment-1", 1)).toThrow(/EXACT_NEXT/);
    state = beginCurrent(state, "assignment-0", 1);
    expect(nextExp0001aCodexAssignment(state)).toMatchObject({ kind: "awaiting_terminal", assignment: { assignmentId: "assignment-0" } });
    expect(() => beginCurrent(state, "assignment-1", 2)).toThrow(/PREVIOUS_ATTEMPT_NOT_TERMINAL/);
    state = terminalizeActiveExp0001aCodexAssignment(state, {
      terminalAt: "2026-08-30T10:01:01.000Z",
      outcome: "failed",
    });
    expect(nextExp0001aCodexAssignment(state)).toMatchObject({ kind: "ready", assignment: { assignmentId: "assignment-1" } });
  });

  it("stops before releasing a brief when a usage limit is observed before task creation", () => {
    let state = createExp0001aCodexScheduler(frozenSchedule());
    state = pauseExp0001aCodexSchedulerForUsageLimit(state, {
      observedAt: "2026-08-30T10:00:00.000Z",
      evidenceDigest: digest("e"),
    });
    expect(nextExp0001aCodexAssignment(state)).toMatchObject({ kind: "paused", pause: { affectedAssignmentId: null } });
    expect(state.assignments.every((assignment) => assignment.state === "unstarted")).toBe(true);
    expect(() => beginCurrent(state, "assignment-0", 1)).toThrow(/PAUSED_FOR_USAGE_LIMIT/);
    const reset = usageResetObservation(
      0,
      "2026-08-30T10:00:01.000Z",
      "2026-08-30T10:00:01.000Z",
      "6",
      digest("e"),
    );
    expect(() => resumeExp0001aCodexSchedulerAfterUsageReset(
      state,
      { observation: reset.observation, probeAccounting: reset.probe },
    )).toThrow(/CODEX_USAGE_RESET_PROBE_ACCOUNTING_BINDING_INVALID/);
    expect(nextExp0001aCodexAssignment(state)).toMatchObject({ kind: "paused" });
    expect(state.assignments.every((assignment) => assignment.state === "unstarted")).toBe(true);
  });

  it("preserves an interrupted begun attempt and never releases its genuinely unstarted partner from caller evidence", () => {
    let state = createExp0001aCodexScheduler(frozenSchedule());
    state = beginCurrent(state, "assignment-0", 1);
    state = pauseExp0001aCodexSchedulerForUsageLimit(state, {
      observedAt: "2026-08-30T10:01:09.000Z",
      evidenceDigest: digest("f"),
    });
    expect(state.assignments[0]).toMatchObject({
      state: "terminal",
      terminalOutcome: "usage_limit_interrupted",
      codexTaskId: "codex-task-1",
      threadId: "thread-1",
    });
    expect(state.assignments[1].state).toBe("unstarted");
    const reset = usageResetObservation(
      0,
      "2026-08-30T10:01:10.000Z",
      "2026-08-30T10:01:10.000Z",
      "7",
      digest("f"),
    );
    expect(() => resumeExp0001aCodexSchedulerAfterUsageReset(
      state,
      { observation: reset.observation, probeAccounting: reset.probe },
    )).toThrow(/CODEX_USAGE_RESET_PROBE_ACCOUNTING_BINDING_INVALID/);
    expect(nextExp0001aCodexAssignment(state)).toMatchObject({ kind: "paused" });
    expect(exp0001aCodexBalanceReport(state)).toMatchObject({
      begunA0: 1,
      begunA1: 0,
      cumulativeImbalance: 1,
      maximumAbsolutePrefixImbalance: 1,
      fullyBegunPairCount: 0,
      splitAcrossUsageWindowPairCount: 0,
      partialPairIds: ["pair-0"],
    });
  });

  it("retains exact randomization order when a reset observation cannot be independently verified", () => {
    let state = createExp0001aCodexScheduler(frozenSchedule());
    const retainedAttemptIds = state.assignments.map((assignment) => assignment.attemptId);

    state = beginCurrent(state, "assignment-0", 1);
    state = pauseExp0001aCodexSchedulerForUsageLimit(state, { observedAt: "2026-08-30T10:01:11.000Z", evidenceDigest: digest("1") });
    const reset = usageResetObservation(
      0,
      "2026-08-30T10:01:12.000Z",
      "2026-08-30T10:01:12.000Z",
      "3",
      digest("1"),
    );
    expect(() => resumeExp0001aCodexSchedulerAfterUsageReset(
      state,
      { observation: reset.observation, probeAccounting: reset.probe },
    )).toThrow(/CODEX_USAGE_RESET_PROBE_ACCOUNTING_BINDING_INVALID/);

    expect(nextExp0001aCodexAssignment(state)).toMatchObject({ kind: "paused" });
    expect(state.assignments.map((assignment) => assignment.attemptId)).toEqual(retainedAttemptIds);
    expect(state.assignments.map((assignment) => assignment.condition)).toEqual(["A0", "A1", "A1", "A0"]);
    expect(state.assignments.map((assignment) => assignment.codexTaskId)).toEqual([
      "codex-task-1", null, null, null,
    ]);
    expect(exp0001aCodexBalanceReport(state)).toMatchObject({
      begunA0: 1,
      begunA1: 0,
      cumulativeImbalance: 1,
      maximumAbsolutePrefixImbalance: 1,
      fullyBegunPairCount: 0,
      splitAcrossUsageWindowPairCount: 0,
      partialPairIds: ["pair-0"],
    });
    expect(state.usageLimitInterruptions).toHaveLength(1);
    expect(state.usageResets).toHaveLength(0);
  });

  it("rejects an unbalanced, reordered, or non-adjacent frozen schedule", () => {
    const schedule = frozenSchedule();
    expect(() => createExp0001aCodexScheduler([
      schedule[1],
      schedule[0],
      schedule[2],
      schedule[3],
    ])).toThrow(/INDEX_OR_ORDER_CHANGED/);
    expect(() => createExp0001aCodexScheduler([
      schedule[0],
      { ...schedule[1], condition: "A0" },
      schedule[2],
      schedule[3],
    ])).toThrow(/PAIR_NOT_BALANCED/);
    expect(() => createExp0001aCodexScheduler([
      schedule[0],
      { ...schedule[2], plannedIndex: 1 },
      { ...schedule[1], plannedIndex: 2 },
      schedule[3],
    ])).toThrow(/PAIR_NOT_BALANCED/);
  });

  it("rejects state rewrites that drop a begun prefix or reuse a Codex task identity", () => {
    let state = createExp0001aCodexScheduler(frozenSchedule());
    state = beginCurrent(state, "assignment-0", 1);
    state = terminalizeActiveExp0001aCodexAssignment(state, { terminalAt: "2026-08-30T10:01:01.000Z", outcome: "failed" });
    state = beginCurrent(state, "assignment-1", 2);

    expect(exp0001aCodexSchedulerStateSchema.safeParse({
      ...state,
      assignments: state.assignments.map((assignment, index) => index === 0 ? {
        ...assignment,
        state: "unstarted",
        usageWindow: null,
        begunAt: null,
        terminalAt: null,
        terminalOutcome: null,
        codexTaskId: null,
        threadId: null,
      } : assignment),
    }).success).toBe(false);
    expect(exp0001aCodexSchedulerStateSchema.safeParse({
      ...state,
      assignments: state.assignments.map((assignment, index) => index === 1 ? {
        ...assignment,
        codexTaskId: "codex-task-1",
      } : assignment),
    }).success).toBe(false);
    expect(exp0001aCodexSchedulerStateSchema.safeParse({
      ...state,
      frozenScheduleDigest: digest("9"),
    }).success).toBe(false);
    expect(exp0001aCodexSchedulerStateSchema.safeParse({
      ...state,
      assignments: state.assignments.map((assignment, index) => index === 1 ? {
        ...assignment,
        attemptId: "replacement-attempt",
      } : assignment),
    }).success).toBe(false);
  });
});
