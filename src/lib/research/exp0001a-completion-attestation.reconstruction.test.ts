// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const { graph, identitySchema } = vi.hoisted(() => ({
  graph: { value: undefined as unknown as ReturnType<typeof buildGraph> },
  identitySchema: { parse: <T>(value: T): T => value },
}));

vi.mock("./exp0001a-codex-accounting", () => ({
  exp0001aCodexAccountingLedgerSchema: identitySchema,
  exp0001aCodexSchedulerStateSchema: identitySchema,
  verifyExp0001aCodexAccountingLedgerAsOf: (value: unknown) => value,
  verifyExp0001aCodexSchedulerStateAsOf: ({ scheduler }: { scheduler: unknown }) => scheduler,
  summarizeExp0001aCodexAccounting: () => graph.value.accountingSummary,
}));

vi.mock("./exp0001a-codex-authority", async () => {
  const { z } = await import("zod");
  return {
    exp0001aCodexAuthoritySignatureSchema: z.object({}).passthrough(),
    verifyExp0001aCodexAuthoritySignature: ({ signature }: { signature: unknown }) => signature,
  };
});

vi.mock("./exp0001a-codex-prebrief-freeze", () => ({
  verifyExp0001aCodexPrebriefFreeze: (value: unknown) => value,
}));

vi.mock("./exp0001a-codex-review-runtime", () => ({
  verifyExp0001aCodexReviewPlanManifest: () => graph.value.reviewPlan,
  sealExp0001aCodexAuthorArtifactCatalog: () => graph.value.catalog,
  createExp0001aCodexPrimaryReviewWorkOrder: () => graph.value.primaryWorkOrder,
  recordExp0001aCodexPrimaryReviewResults: () => graph.value.primaryResults,
  createExp0001aCodexAdjudicationWorkOrder: () => graph.value.adjudicationWorkOrder,
  recordExp0001aCodexAdjudicationResults: () => graph.value.adjudicationResults,
  lockExp0001aCodexClassifications: () => graph.value.classifications,
  createExp0001aCodexPairwiseWorkOrder: () => graph.value.pairwiseWorkOrder,
  recordExp0001aCodexPairwiseResults: () => graph.value.pairwiseResults,
  createExp0001aCodexAnalysisReceipt: () => graph.value.analysisReceipt,
}));

vi.mock("./exp0001a-codex-runtime-contract", () => ({
  exp0001aCodexCoordinatorCheckpointSchema: identitySchema,
  verifyExp0001aCodexRuntimePreflight: (value: unknown) => value,
}));

vi.mock("./exp0001a-codex-scientific-runtime", () => ({
  exp0001aCodexScientificStateSchema: identitySchema,
}));

vi.mock("./exp0001a-codex-task-transport", () => ({
  exp0001aCodexTaskLifecycleSchema: identitySchema,
  exp0001aCodexTaskTransportPlanSchema: identitySchema,
  assertExp0001aCodexTaskContextsSeparated: () => undefined,
}));

vi.mock("./development-manifest", () => ({
  developmentExecutionManifestSchema: identitySchema,
  verifyDevelopmentExecutionManifest: (manifest: unknown) => ({ ok: true, errors: [], manifest }),
}));

vi.mock("./exp0001a-attempt-provisioning", () => ({
  verifyExp0001aAttemptProvisioningPlan: (plan: unknown) => ({ ok: true, errors: [], plan }),
}));

import { createExp0001aCodexCompletionAttestation } from "./exp0001a-completion-attestation";
import { canonicalJson, hashCanonicalJson, type JsonValue } from "./provenance-crypto";

const digest = (label: string) => hashCanonicalJson({ label });
const at = "2026-08-31T05:00:00.000Z";
type CompletionInput = Parameters<typeof createExp0001aCodexCompletionAttestation>[0];

// The production validators are deliberately mocked in this reconstruction
// test so its compact synthetic graph can exercise cross-artifact invariants.
// Keep that test-only boundary explicit without weakening it to `any`.
const reconstructCompletion = (value: unknown) =>
  createExp0001aCodexCompletionAttestation(value as CompletionInput);

type SyntheticPlan = {
  planDigest: string;
  transportId: string;
  role: string;
  privateBinding: { assignmentId: string; attemptId: string };
};

type SyntheticLifecycle = {
  planDigest: string;
  lifecycleDigest: string;
  transportId: string;
  role: string;
  state: string;
  taskBegun: boolean;
  readReceipt: object | null;
  codexTaskId: string;
  threadId: string;
  hostId: string;
  terminalOutcome: string | null;
};

type SyntheticAccountingTask = {
  accountingId: string;
  assignmentId: string;
  attemptId: string;
  role: string;
  state: string;
  codexTaskId: string;
  threadId: string;
  terminalOutcome: string;
  begunAt: string;
  completedAt: string | null;
  terminalAt: string;
};

type SyntheticRoleResult = {
  planDigest: string;
  lifecycleDigest: string;
  terminalOutcome: string;
};

function buildGraph() {
  const freeze = {
    freezeDigest: digest("freeze"),
    activeRuntime: { bundleDigest: digest("runtime") },
    passedSpikeGate: { spikeEvidenceDigest: digest("spike-evidence"), gateDigest: digest("spike-gate") },
    schedule: { manifestDigest: digest("manifest"), codexSchedulerDigest: digest("schedule") },
    reviewCommitments: { reviewPlanManifestDigest: digest("review-plan") },
  };
  const executionManifest = { manifestDigest: freeze.schedule.manifestDigest };
  const reviewPlan = { manifestDigest: freeze.reviewCommitments.reviewPlanManifestDigest };
  const schedulerAssignments = Array.from({ length: 48 }, (_, index) => ({
    assignmentId: `author-assignment-${index}`,
    attemptId: `author-attempt-${index}`,
    codexTaskId: `author-task-${index}`,
    threadId: `author-task-${index}`,
    state: "terminal",
    terminalOutcome: index === 47 ? "usage_limit_interrupted" : "succeeded",
  }));
  const scheduler = {
    frozenScheduleDigest: freeze.schedule.codexSchedulerDigest,
    pause: null,
    assignments: schedulerAssignments,
    usageLimitInterruptions: [{ observedAt: at }],
    usageResets: [{
      observationId: "reset-0",
      observedAt: at,
      resumedAt: at,
      authoritySignature: { signedAt: at },
      probe: { accountingId: "probe-accounting", codexTaskId: "probe-task", threadId: "probe-task" },
    }],
  };
  const plans: SyntheticPlan[] = [];
  const lifecycles: SyntheticLifecycle[] = [];
  const accountingTasks: SyntheticAccountingTask[] = [];
  const addRole = (role: string, count: number, outcomeAt?: number) => {
    const results: SyntheticRoleResult[] = [];
    for (let index = 0; index < count; index += 1) {
      const assignmentId = role === "author" ? schedulerAssignments[index].assignmentId : `${role}-assignment-${index}`;
      const attemptId = role === "author" ? schedulerAssignments[index].attemptId : `${role}-attempt-${index}`;
      const codexTaskId = role === "author" ? schedulerAssignments[index].codexTaskId : `${role}-task-${index}`;
      const terminalOutcome = index === outcomeAt ? "usage_limit_interrupted" : "succeeded";
      const plan = {
        planDigest: digest(`${role}-plan-${index}`), transportId: `${role}-transport-${index}`, role,
        privateBinding: { assignmentId, attemptId },
      };
      const lifecycle = {
        planDigest: plan.planDigest, lifecycleDigest: digest(`${role}-lifecycle-${index}`),
        transportId: plan.transportId, role, state: "terminal", taskBegun: true,
        readReceipt: {}, codexTaskId, threadId: codexTaskId, hostId: "local", terminalOutcome,
      };
      plans.push(plan);
      lifecycles.push(lifecycle);
      accountingTasks.push({
        accountingId: `${role}-accounting-${index}`, assignmentId, attemptId, role, state: "terminal",
        codexTaskId, threadId: codexTaskId,
        terminalOutcome, begunAt: at, completedAt: terminalOutcome === "succeeded" ? at : null, terminalAt: at,
      });
      results.push({ planDigest: plan.planDigest, lifecycleDigest: lifecycle.lifecycleDigest, terminalOutcome });
    }
    return results;
  };
  const authorResults = addRole("author", 48, 47);
  const primaryResultsEntries = addRole("primary_reviewer", 96);
  const adjudicationResultsEntries = addRole("adjudicator", 1);
  const pairwiseResultsEntries = addRole("pairwise_visual_judge", 24);
  accountingTasks.push({
    accountingId: "probe-accounting", assignmentId: "probe-assignment", attemptId: "probe-attempt",
    role: "subscription_probe", state: "terminal", codexTaskId: "probe-task", threadId: "probe-task",
    terminalOutcome: "succeeded", begunAt: at, completedAt: at, terminalAt: at,
  });
  const catalog = {
    catalogDigest: digest("catalog"),
    entries: authorResults.map((result, index) => ({
      authorPlanDigest: result.planDigest,
      artifactId: `artifact-${index}`,
    })),
  };
  const primaryWorkOrder = { workOrderDigest: digest("primary-work-order"), workItems: Array(96).fill({}) };
  const primaryResults = { resultLedgerDigest: digest("primary-results"), results: primaryResultsEntries };
  const adjudicationWorkOrder = { workOrderDigest: digest("adjudication-work-order"), workItems: [{}] };
  const adjudicationResults = { resultLedgerDigest: digest("adjudication-results"), results: adjudicationResultsEntries };
  const classifications = { classificationBookDigest: digest("classifications"), lockedAt: at };
  const pairwiseWorkOrder = { workOrderDigest: digest("pairwise-work-order"), workItems: Array(24).fill({}) };
  const pairwiseResults = { resultLedgerDigest: digest("pairwise-results"), results: pairwiseResultsEntries };
  const analysisReceipt = {
    receiptDigest: digest("analysis-receipt"), analysisReportDigest: digest("analysis-report"), createdAt: at,
  };
  const artifacts = [catalog, primaryWorkOrder, primaryResults, adjudicationWorkOrder,
    adjudicationResults, classifications, pairwiseWorkOrder, pairwiseResults, analysisReceipt];
  const scientificState = {
    stateDigest: digest("scientific-state"),
    reviewPlanManifest: reviewPlan,
    authorCatalog: catalog,
    primaryWorkOrder,
    primaryResults,
    adjudicationWorkOrder,
    adjudicationResults,
    classifications,
    pairwiseWorkOrder,
    pairwiseResults,
    analysisReceipt,
    transitionDigests: artifacts.map((artifact) => hashCanonicalJson(artifact as JsonValue)),
  };
  const checkpoint = {
    authorizedActionDigest: digest("action"), freezeDigest: freeze.freezeDigest,
    runtimeBundleDigest: freeze.activeRuntime.bundleDigest, schedulerStateDigest: digest("scheduler"),
    accountingLedgerDigest: digest("accounting"), provisioningStateDigest: digest("provisioning-state"),
    coordinatorJournalDigest: digest("journal"), journalPreviousEntryDigest: null,
    recordedAt: at, expiresAt: "2026-08-31T05:10:00.000Z", authoritySignature: { signedAt: at },
  };
  const preflight = {
    checkedAt: at, coordinatorCheckpoint: checkpoint,
    nextAction: { actionDigest: checkpoint.authorizedActionDigest },
    freezeDigest: freeze.freezeDigest,
    spikeGateDigest: freeze.passedSpikeGate.gateDigest,
    spikeEvidenceDigest: freeze.passedSpikeGate.spikeEvidenceDigest,
    schedulerStateDigest: checkpoint.schedulerStateDigest,
    accountingLedgerDigest: checkpoint.accountingLedgerDigest,
    provisioningStateDigest: checkpoint.provisioningStateDigest,
    coordinatorJournalDigest: checkpoint.coordinatorJournalDigest,
  };
  const accountingSummary = {
    codexTaskCount: 170, begunTaskCount: 170, completedTaskCount: 169, terminalTaskCount: 170,
    totalWallTimeMs: 0,
    webMcpCallCount: { observedTotal: 0, observedTaskCount: 0, unobservableTaskCount: 170 },
    webMcpFailureCount: { observedTotal: 0, observedTaskCount: 0, unobservableTaskCount: 170 },
    revisionCount: { observedTotal: 0, observedTaskCount: 0, unobservableTaskCount: 170 },
    inspectionCount: { observedTotal: 0, observedTaskCount: 0, unobservableTaskCount: 170 },
    usageLimitInterruptionCount: 1, unobservableResolvedModelCount: 170, unobservableInputTokenCount: 170,
    unobservableOutputTokenCount: 170, unobservableTotalTokenCount: 170, unobservableCreditCount: 170,
    unobservableSubscriptionUsageCount: 170,
    roleTaskCounts: { subscription_probe: 1, spike_author: 0, author: 48, primary_reviewer: 96,
      adjudicator: 1, pairwise_visual_judge: 24 },
  };
  return {
    freeze, executionManifest, reviewPlan, scheduler, plans, lifecycles, accountingSummary,
    catalog, primaryWorkOrder, primaryResults, adjudicationWorkOrder, adjudicationResults,
    classifications, pairwiseWorkOrder, pairwiseResults, analysisReceipt, scientificState,
    evidence: {
      completedAt: at,
      freeze,
      executionManifest,
      runtimePreflightReceipts: [preflight],
      coordinatorCheckpoints: [checkpoint],
      scheduler,
      accountingLedger: { tasks: accountingTasks },
      provisioningPlan: {},
      plans,
      lifecycles,
      scientificState,
    },
  };
}

describe("EXP-0001A completion evidence reconstruction", () => {
  beforeEach(() => { graph.value = buildGraph(); });

  it("completes the exact 48/96/conditional/24 chain and retains a usage-limited author", () => {
    const draft = reconstructCompletion(graph.value.evidence);
    expect(draft.schedule).toEqual({
      assignmentCount: 48,
      terminalAssignmentCount: 48,
      succeededAssignmentCount: 47,
      failedAssignmentCount: 0,
      usageLimitInterruptedAssignmentCount: 1,
      usageResetCount: 1,
    });
    expect(draft.transport.begunTerminalRoleCounts).toEqual({
      author: 48, primary_reviewer: 96, adjudicator: 1, pairwise_visual_judge: 24,
    });
    expect(draft.review.scientificStateDigest).toBe(graph.value.scientificState.stateDigest);
    expect(canonicalJson(draft)).not.toMatch(/provider|api|dollar|costUsd|authorizedMaximumUsd/i);
  });

  it("rejects a caller-substituted result ledger even when the caller rehashes the scientific state", () => {
    const substituted = structuredClone(graph.value.scientificState);
    substituted.primaryResults.results[0].terminalOutcome = "policy_violation";
    substituted.primaryResults.resultLedgerDigest = digest("caller-rehashed-ledger");
    substituted.transitionDigests[2] = hashCanonicalJson(substituted.primaryResults);
    substituted.stateDigest = digest("caller-rehashed-state");
    expect(() => reconstructCompletion({
      ...graph.value.evidence,
      scientificState: substituted,
    })).toThrow(/PRIMARY_RESULT_LEDGER_DRIFT/);
  });

  it("rejects a lifecycle/accounting terminal-outcome mismatch, including usage-limit erasure", () => {
    const lifecycles = structuredClone(graph.value.lifecycles);
    lifecycles.find((value) => value.role === "author" && value.terminalOutcome === "usage_limit_interrupted")!
      .terminalOutcome = "succeeded";
    expect(() => reconstructCompletion({
      ...graph.value.evidence,
      lifecycles,
    })).toThrow(/TRANSPORT_ACCOUNTING_DRIFT/);
  });

  it("rejects role substitution and a begun task without terminal retained evidence", () => {
    const roleSubstituted = structuredClone(graph.value.plans);
    roleSubstituted.find((value) => value.role === "primary_reviewer")!.role = "adjudicator";
    expect(() => reconstructCompletion({
      ...graph.value.evidence,
      plans: roleSubstituted,
    })).toThrow(/TRANSPORT_ACCOUNTING_DRIFT/);

    const nonterminal = structuredClone(graph.value.lifecycles);
    const lifecycle = nonterminal.find((value) => value.role === "primary_reviewer")!;
    lifecycle.state = "running";
    lifecycle.readReceipt = null;
    lifecycle.terminalOutcome = null;
    expect(() => reconstructCompletion({
      ...graph.value.evidence,
      lifecycles: nonterminal,
    })).toThrow(/EVERY_BEGUN_TASK_TERMINAL/);
  });

  it("rejects denominator loss and incomplete retained scientific state", () => {
    expect(() => reconstructCompletion({
      ...graph.value.evidence,
      plans: graph.value.plans.slice(0, -1),
      lifecycles: graph.value.lifecycles.slice(0, -1),
      accountingLedger: { tasks: graph.value.evidence.accountingLedger.tasks.slice(0, -2).concat(
        graph.value.evidence.accountingLedger.tasks.slice(-1),
      ) },
    })).toThrow(/DENOMINATOR_INVALID|UNCLAIMED_BEGUN_TASK|TRANSPORT_DRIFT/);

    expect(() => reconstructCompletion({
      ...graph.value.evidence,
      scientificState: { ...graph.value.scientificState, analysisReceipt: null, transitionDigests: Array(8).fill(digest("x")) },
    })).toThrow(/REQUIRES_FINAL_SCIENTIFIC_STATE/);
  });
});
