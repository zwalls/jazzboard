import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createExp0001aProvisioningCoordinator } from "./exp0001a-attempt-provisioning";
import { createExp0001aCodexCoordinatorJournal } from "./exp0001a-codex-coordinator";
import {
  EXP0001A_ACTIVE_CODEX_RUNTIME_VERSIONS,
  runExp0001aCodexRuntime,
} from "./exp0001a-runtime-composition";
import * as activeRuntime from "./exp0001a-runtime-composition";
import { hashCanonicalJson, type JsonValue } from "./provenance-crypto";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function runtimeInput() {
  const root = await mkdtemp(path.join(tmpdir(), "exp0001a-runtime-"));
  roots.push(root);
  const provisioningState = await createExp0001aProvisioningCoordinator({
    filePath: path.join(root, "provisioning.json"),
    now: () => "2026-08-31T05:00:00.000Z",
    createRoomNonce: () => "rn_0123456789abcdef0123456789abcdef",
  }).initialize();
  const coordinatorJournal = createExp0001aCodexCoordinatorJournal({ provisioningState });
  const action = {
    kind: "perform_provisioning_local_transition",
    transition: "reserve_next_attempt",
    assignmentId: provisioningState.scheduler.assignments[0]!.assignmentId,
  };
  const content = {
    schemaVersion: "exp-0001a-codex-runtime-preflight/v1" as const,
    kind: "exp-0001a-codex-runtime-preflight" as const,
    protocolId: "EXP-0001A" as const,
    checkedAt: "2026-08-31T05:00:01.000Z",
    authCheckedAt: "2026-08-31T05:00:00.000Z",
    decision: "ready_for_coordinator" as const,
    reasons: ["SIGNED_STATE_AND_LIVE_CHATGPT_AUTH_VERIFIED"] as const,
    executionAllowed: true as const,
    nextAction: {
      kind: "emit_one_coordinator_action" as const,
      actionDigest: hashCanonicalJson(action as unknown as JsonValue),
      coordinatorActionIssuedAt: "2026-08-31T05:00:00.000Z",
      callerMustPerformAction: true as const,
      runtimeInvokedExternalTool: false as const,
    },
    freezeDigest: `sha256:${"1".repeat(64)}`,
    authPreflightReceiptDigest: `sha256:${"2".repeat(64)}`,
    spikeEvidenceDigest: `sha256:${"3".repeat(64)}`,
    spikeGateDigest: `sha256:${"4".repeat(64)}`,
    frozenScheduleDigest: provisioningState.scheduler.frozenScheduleDigest,
    schedulerStateDigest: hashCanonicalJson(provisioningState.scheduler as unknown as JsonValue),
    accountingLedgerDigest: `sha256:${"7".repeat(64)}`,
    provisioningStateDigest: provisioningState.stateDigest,
    coordinatorJournalDigest: coordinatorJournal.journalDigest,
    accounting: {
      codexTaskCount: 0, begunTaskCount: 0, completedTaskCount: 0, terminalTaskCount: 0,
      totalWallTimeMs: 0, webMcpCallCount: 0, webMcpFailureCount: 0, revisionCount: 0,
      inspectionCount: 0, usageLimitInterruptionCount: 0, unobservableResolvedModelCount: 0,
      unobservableInputTokenCount: 0, unobservableOutputTokenCount: 0, unobservableTotalTokenCount: 0,
      unobservableCreditCount: 0, unobservableSubscriptionUsageCount: 0,
      roleTaskCounts: { subscription_probe: 0, spike_author: 0, author: 0, primary_reviewer: 0,
        adjudicator: 0, pairwise_visual_judge: 0 },
    },
    isolation: { taskWorkspace: "projectless" as const, repositoryAccess: false as const,
      privateApiAccess: false as const, sharedHistory: false as const },
  };
  const preflight = { ...content, receiptDigest: hashCanonicalJson(content as unknown as JsonValue) };
  return { preflight, provisioningState, coordinatorJournal };
}

describe("active EXP-0001A Codex runtime composition", () => {
  it("contains the subscription transport, provisioning, accounting, analysis, and completion versions", () => {
    expect(EXP0001A_ACTIVE_CODEX_RUNTIME_VERSIONS.coordinator).toBe("exp-0001a-codex-coordinator/v2");
    expect(EXP0001A_ACTIVE_CODEX_RUNTIME_VERSIONS.taskTransport).toBe("exp-0001a-codex-task-transport/v1");
  });

  it("rejects a caller-minted preflight before emitting an action", async () => {
    const input = await runtimeInput();
    await expect(runExp0001aCodexRuntime({
      mode: "execute",
      executionCheckedAt: "2026-08-31T05:00:01.500Z",
      ...input,
    })).rejects.toThrow();
  });

  it("has no active import or literal for the retired billed-provider path", async () => {
    const source = await readFile(path.join(process.cwd(), "src/lib/research/exp0001a-runtime-composition.ts"), "utf8");
    expect(source).not.toMatch(/exp0001a-(?:spend-ledger|batch-coordinator|execution-gate|live-review-runner|pairwise-runtime|analysis-runtime)/);
    expect(source).not.toMatch(/OPENAI_API_KEY|api\.openai\.com|serviceTier|tokenBudget|pricing|costUsd|spendAuthorization/);
  });

  it("does not expose the caller-supplied observability mutator", () => {
    expect(Object.prototype.hasOwnProperty.call(
      activeRuntime,
      "recordExp0001aCodexTaskObservability",
    )).toBe(false);
  });
});
