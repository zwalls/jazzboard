// @vitest-environment node

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { hashCanonicalJson, type JsonValue } from "../../src/lib/research/provenance-crypto";
// @ts-expect-error committed ESM command intentionally has no declaration file
import { deriveExp0001aDispatchBoundRuntimeChainForTesting, retainExp0001aCompletionMaterializationPrefixForTesting, runExp0001aBatchCommand } from "./exp0001a-batch-command.mjs";

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function preflightReceipt(actionDigest: string) {
  const coordinatorCheckpoint = {
    schemaVersion: "exp-0001a-codex-coordinator-checkpoint/v1",
    kind: "codex-coordinator-checkpoint",
    checkpointId: "checkpoint-1",
    authorizedActionDigest: actionDigest,
  };
  const content = {
    schemaVersion: "exp-0001a-codex-runtime-preflight/v1", kind: "exp-0001a-codex-runtime-preflight",
    protocolId: "EXP-0001A", checkedAt: "2026-08-31T05:00:00.000Z", authCheckedAt: "2026-08-31T05:00:00.000Z",
    decision: "ready_for_coordinator", reasons: ["SIGNED_STATE_AND_LIVE_CHATGPT_AUTH_VERIFIED"], executionAllowed: true,
    nextAction: { kind: "emit_one_coordinator_action", actionDigest,
      coordinatorActionIssuedAt: "2026-08-31T05:00:00.000Z", callerMustPerformAction: true,
      runtimeInvokedExternalTool: false },
    freezeDigest: digest("1"), authPreflightReceiptDigest: digest("2"), spikeEvidenceDigest: digest("3"),
    spikeGateDigest: digest("4"), frozenScheduleDigest: digest("5"), schedulerStateDigest: digest("6"),
    accountingLedgerDigest: digest("7"), provisioningStateDigest: digest("8"), coordinatorJournalDigest: digest("9"),
    coordinatorCheckpoint,
    accounting: {}, isolation: {},
  };
  return { ...content, receiptDigest: hashCanonicalJson(content as unknown as JsonValue) };
}

async function fixture(actionOverride?: unknown) {
  const root = await mkdtemp(path.join(tmpdir(), "exp0001a-batch-"));
  roots.push(root);
  const bundleDigest = digest("a");
  const configPath = path.join(root, "config.json");
  const files = {
    codexPrebriefFreeze: path.join(process.cwd(), "research/data/exp-0001a-codex-prebrief-freeze-v2.json"),
    codexPrebriefFreezeSignature: path.join(process.cwd(), "research/data/exp0001a-codex-prebrief-freeze-signature-v2.json"),
    spikeGate: path.join(root, "gate.json"),
    spikeEvidence: path.join(root, "spike.json"), coordinatorCheckpoint: path.join(root, "checkpoint.json"),
    schedulerState: path.join(root, "scheduler.json"), accountingLedger: path.join(root, "accounting.json"),
    provisioningCoordinatorState: path.join(root, "provisioning.json"), coordinatorJournal: path.join(root, "journal.json"),
  };
  const config = { schemaVersion: "exp-0001a-codex-runtime-contract/v1", protocolId: "EXP-0001A",
    files, outputRoot: path.join(root, "output"), runtimeBundleDigest: bundleDigest,
    authorizedPrebriefFreezePayloadDigest: digest("d"), authorizedPrebriefFreezeSignatureDigest: digest("e") };
  const action = actionOverride ?? { kind: "perform_provisioning_webmcp", command: { toolName: "read_room_state", input: {} },
    expectedIngest: { operation: "retainBlankBaselineRead", assignmentId: "assignment-1", planDigest: null,
      priorStateDigest: digest("8"), resultMustBeRetainedBeforeNextAction: true }, coordinatorDidNotInvokeTool: true };
  const actionDigest = hashCanonicalJson(action as unknown as JsonValue);
  const receipt = preflightReceipt(actionDigest);
  const checkpointJournalEntry = {
    kind: "coordinator_checkpoint",
    payloadDigest: hashCanonicalJson(receipt.coordinatorCheckpoint as unknown as JsonValue),
    payload: receipt.coordinatorCheckpoint,
    entryDigest: digest("b"),
  };
  const runtime: Record<string, unknown> = {
    exp0001aCodexRuntimeConfigSchema: { parse: (value: unknown) => value },
    verifyExp0001aCodexPrebriefFreezeAuthority: vi.fn(({ freeze }: { freeze: unknown }) => freeze),
    verifyExp0001aCodexRuntimePreflight: vi.fn((value: unknown) => value),
    createExp0001aCodexRuntimePreflight: vi.fn(() => receipt),
    runExp0001aCodexRuntime: vi.fn(async ({ mode }: { mode: string }) => ({
      mode, status: "ready_for_coordinator", executionAllowed: mode === "execute", action, actionDigest,
      externalToolInvokedByRuntime: false, callerMustPerformAndRetainResult: true,
    })),
  };
  const values = new Map<string, unknown>([[configPath, config], ...Object.values(files).map((file) => [file, {}] as const)]);
  const readJson = vi.fn(async (filePath: string) => values.get(filePath));
  const runAuthPreflight = vi.fn(async () => ({ retained: false, authentication: { method: "chatgpt" } }));
  const verifyOuterSources = vi.fn(async () => ({ sourceCount: 1 }));
  const authorityEntries: Array<Record<string, unknown>> = [checkpointJournalEntry];
  const readAuthorityJournal = vi.fn(async () => ({
    entries: [...authorityEntries],
    journalRoot: authorityEntries.at(-1)?.entryDigest ?? null,
  }));
  const appendAuthorityJournalEntry = vi.fn(async ({ kind, payload }: { kind: string; payload: unknown }) => {
    const entry = {
      kind,
      payload,
      payloadDigest: digest("d"),
      entryDigest: authorityEntries.length === 1 ? digest("c") : digest(String(authorityEntries.length % 10)),
    };
    authorityEntries.push(entry);
    return { alreadyRetained: false, entry, journalRoot: entry.entryDigest };
  });
  return { bundleDigest, configPath, config, runtime, values, readJson, runAuthPreflight, actionDigest,
    readAuthorityJournal, appendAuthorityJournalEntry, verifyOuterSources };
}

describe("EXP-0001A subscription-only batch command", () => {
  for (const boundary of ["afterEvidencePublished", "afterDraftPublished"] as const) {
    it(`repairs an exact completion prefix after a crash ${boundary}`, async () => {
      const outputRoot = await mkdtemp(path.join(tmpdir(), `exp0001a-completion-prefix-${boundary}-`));
      roots.push(outputRoot);
      const evidence = { completedAt: "2026-08-31T05:00:00.000Z", state: "complete" };
      const draft = { completionDigest: digest("4"), state: "draft" };
      const appendAuthorityJournalEntry = vi.fn(async ({ payload }: { payload: unknown }) => ({
        entry: { kind: "completion_draft", payload, entryDigest: digest("5") },
      }));
      const base = {
        outputRoot,
        completedAt: evidence.completedAt,
        evidence,
        draft,
        scientificStateDigest: digest("6"),
        provisioningPlanDigest: digest("7"),
        appendAuthorityJournalEntry,
      };
      await expect(retainExp0001aCompletionMaterializationPrefixForTesting({
        ...base,
        [boundary]: async () => { throw new Error(`synthetic-${boundary}`); },
      })).rejects.toThrow(`synthetic-${boundary}`);
      const repaired = await retainExp0001aCompletionMaterializationPrefixForTesting(base);
      expect(JSON.parse(await readFile(repaired.evidencePath, "utf8"))).toEqual(evidence);
      expect(JSON.parse(await readFile(repaired.draftPath, "utf8"))).toEqual(draft);
      expect(appendAuthorityJournalEntry).toHaveBeenCalledTimes(1);
      expect(appendAuthorityJournalEntry).toHaveBeenCalledWith(expect.objectContaining({
        recordedAt: evidence.completedAt,
        payload: expect.objectContaining({ completionDigest: draft.completionDigest }),
      }));
    });
  }

  it("uses only dispatch-bound preflights and checkpoints in completion denominators", () => {
    const usedCheckpoint = { checkpointId: "used", authorizedActionDigest: digest("a") };
    const orphanCheckpoint = { checkpointId: "orphan", authorizedActionDigest: digest("b") };
    const usedPreflight = { receiptDigest: digest("c"), coordinatorCheckpoint: usedCheckpoint,
      nextAction: { actionDigest: digest("a") } };
    const orphanPreflight = { receiptDigest: digest("d"), coordinatorCheckpoint: orphanCheckpoint,
      nextAction: { actionDigest: digest("b") } };
    const chain = deriveExp0001aDispatchBoundRuntimeChainForTesting([
      { sequence: 0, kind: "coordinator_checkpoint", payload: usedCheckpoint,
        payloadDigest: hashCanonicalJson(usedCheckpoint as unknown as JsonValue) },
      { sequence: 1, kind: "runtime_preflight", entryDigest: digest("e"), payload: usedPreflight },
      { sequence: 2, kind: "coordinator_checkpoint", payload: orphanCheckpoint,
        payloadDigest: hashCanonicalJson(orphanCheckpoint as unknown as JsonValue) },
      { sequence: 3, kind: "runtime_preflight", entryDigest: digest("f"), payload: orphanPreflight },
    ], [{
      authorityJournalEntryDigest: digest("e"),
      runtimePreflightReceiptDigest: digest("c"),
      actionDigest: digest("a"),
    }]);
    expect(chain.runtimePreflightReceipts).toEqual([usedPreflight]);
    expect(chain.coordinatorCheckpoints).toEqual([usedCheckpoint]);
  });

  it("dry-run validates fresh auth and previews without dispatching", async () => {
    const value = await fixture();
    const result = await runExp0001aBatchCommand(["--config", value.configPath], {
      readJson: value.readJson, verifyRuntimeBundle: async () => ({ bundleDigest: value.bundleDigest }),
      loadRuntime: async () => value.runtime, runAuthPreflight: value.runAuthPreflight,
      verifyOuterSources: value.verifyOuterSources,
      now: () => new Date("2026-08-31T05:00:00.000Z"),
    });
    expect(value.runAuthPreflight).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ mode: "dry-run", status: "ready_for_coordinator", executionAllowed: false,
      externalToolInvokedByCli: false, dispatchReceipt: null,
      readiness: { decision: "ready_for_coordinator", executionAllowed: true } });
  });

  it("requires a durable delivery acknowledgement before invocation and then forbids blind replay", async () => {
    const value = await fixture();
    const dependencies = { readJson: value.readJson, verifyRuntimeBundle: async () => ({ bundleDigest: value.bundleDigest }),
      loadRuntime: async () => value.runtime, runAuthPreflight: value.runAuthPreflight,
      verifyOuterSources: value.verifyOuterSources,
      readAuthorityJournal: value.readAuthorityJournal,
      appendAuthorityJournalEntry: value.appendAuthorityJournalEntry,
      now: () => new Date("2026-08-31T05:00:00.000Z") };
    const first = await runExp0001aBatchCommand(["--execute", "--config", value.configPath], dependencies);
    expect(first).toMatchObject({ mode: "execute", status: "dispatch_prepared_requires_delivery_acknowledgement",
      executionAllowed: false, callerMustNotInvokeBeforeAcknowledgement: true,
      externalToolInvokedByCli: false, actionReemitted: false,
      dispatchReceipt: { actionDigest: value.actionDigest, externalToolInvokedByCli: false } });
    expect(value.appendAuthorityJournalEntry).toHaveBeenCalledTimes(1);
    const beforeAckReplay = await runExp0001aBatchCommand(["--execute", "--config", value.configPath], dependencies);
    expect(beforeAckReplay).toMatchObject({ status: "dispatch_prepared_requires_delivery_acknowledgement",
      actionReemitted: true, callerMustNotInvokeBeforeAcknowledgement: true });
    const acknowledged = await runExp0001aBatchCommand([
      "--ack-dispatch", value.actionDigest, "--config", value.configPath,
    ], dependencies);
    expect(acknowledged).toMatchObject({ status: "dispatch_delivery_acknowledged", executionAllowed: true,
      callerMayInvokePreviouslyRetainedActionExactlyOnce: true, actionReemitted: false });
    expect(acknowledged).not.toHaveProperty("result.action");
    const replay = await runExp0001aBatchCommand(["--execute", "--config", value.configPath], dependencies);
    expect(replay).toMatchObject({ status: "acknowledged_dispatch_delivery_ambiguous_requires_result_or_reconciliation",
      executionAllowed: false, actionReemitted: false,
      reconciliation: { kind: "retain_raw_result_or_fail_closed_manual_reconciliation",
        blindRetryOfMutatingCommandForbidden: true } });
    expect(replay).not.toHaveProperty("result.action");
  });

  it("rejects runtime bundle drift before invoking auth", async () => {
    const value = await fixture();
    await expect(runExp0001aBatchCommand(["--config", value.configPath], {
      readJson: value.readJson, verifyRuntimeBundle: async () => ({ bundleDigest: digest("b") }),
      loadRuntime: async () => value.runtime, runAuthPreflight: value.runAuthPreflight,
    })).rejects.toThrow(/BUNDLE_DIGEST_DRIFT/);
    expect(value.runAuthPreflight).not.toHaveBeenCalled();
  });

  it("executes one durable packet-sidecar action and atomically ingests its exact result", async () => {
    const startAction = {
      kind: "start_artifact_packet_sidecar",
      packetId: "primary-work-1-d1",
      startInput: { schemaVersion: "exp-0001a-artifact-packet-sidecar-start-input/v1", role: "primary_reviewer",
        subject: { subjectDigest: digest("4") }, evidence: { authorPlan: {}, authorLifecycle: {} } },
      expectedIngest: { operation: "retainArtifactPacketStartResult", assignmentId: "primary-assignment-1",
        planDigest: null, priorStateDigest: digest("9"), resultMustBeRetainedBeforeNextAction: true },
      coordinatorDidNotInvokeTool: true,
    };
    const value = await fixture(startAction);
    const rawSidecarResult = { schemaVersion: "exp-0001a-artifact-packet-sidecar/v1", packetId: startAction.packetId,
      state: "active" };
    const mutation = { provisioningState: { stateDigest: digest("8"), scheduler: {} },
      coordinatorJournal: { journalDigest: digest("f") }, retainedEvidenceDigest: digest("1") };
    value.runtime.createExp0001aProvisioningCoordinator = vi.fn(() => ({ read: vi.fn() }));
    const ingestCoordinatorAction = vi.fn(async () => mutation);
    value.runtime.ingestExp0001aCoordinatorActionResult = ingestCoordinatorAction;
    const executePacketSidecarAction = vi.fn(async () => rawSidecarResult);
    const persistCoordinatorMutation = vi.fn(async () => ({ coordinatorJournalDigest: digest("f") }));
    const result = await runExp0001aBatchCommand(["--execute", "--config", value.configPath], {
      readJson: value.readJson,
      verifyRuntimeBundle: async () => ({ bundleDigest: value.bundleDigest, bytes: Buffer.from("bundle") }),
      loadRuntime: async () => value.runtime,
      runAuthPreflight: value.runAuthPreflight,
      verifyOuterSources: value.verifyOuterSources,
      readAuthorityJournal: value.readAuthorityJournal,
      appendAuthorityJournalEntry: value.appendAuthorityJournalEntry,
      executePacketSidecarAction,
      persistCoordinatorMutation,
      now: () => new Date("2026-08-31T05:00:00.000Z"),
    });
    expect(executePacketSidecarAction).toHaveBeenCalledTimes(1);
    expect(ingestCoordinatorAction).toHaveBeenCalledWith(expect.objectContaining({
      action: startAction,
      rawResult: rawSidecarResult,
    }));
    expect(persistCoordinatorMutation).toHaveBeenCalledWith(value.runtime, expect.anything(), mutation);
    expect(result).toMatchObject({ status: "coordinator_action_completed", packetSidecarInvokedByCli: true,
      completedActionKind: "start_artifact_packet_sidecar", nextCheckpointRequired: true });
  });

  it("ingests one previously dispatched external raw result and retains its exact authority chain", async () => {
    const value = await fixture();
    const resultPath = path.join(path.dirname(value.configPath), "raw-result.json");
    const rawResult = { content: [{ type: "text", text: JSON.stringify({ ok: true }) }], isError: false };
    value.values.set(resultPath, rawResult);
    const mutation = { provisioningState: { stateDigest: digest("8"), scheduler: {} },
      coordinatorJournal: { journalDigest: digest("f") }, retainedEvidenceDigest: digest("1") };
    value.runtime.createExp0001aProvisioningCoordinator = vi.fn(() => ({ read: vi.fn() }));
    value.runtime.ingestExp0001aCoordinatorActionResult = vi.fn(async () => mutation);
    const persistCoordinatorMutation = vi.fn(async () => ({ coordinatorJournalDigest: digest("f") }));
    const dependencies = {
      readJson: value.readJson,
      verifyRuntimeBundle: async () => ({ bundleDigest: value.bundleDigest }),
      loadRuntime: async () => value.runtime,
      runAuthPreflight: value.runAuthPreflight,
      verifyOuterSources: value.verifyOuterSources,
      readAuthorityJournal: value.readAuthorityJournal,
      appendAuthorityJournalEntry: value.appendAuthorityJournalEntry,
      persistCoordinatorMutation,
      now: () => new Date("2026-08-31T05:00:00.000Z"),
    };
    await runExp0001aBatchCommand(["--execute", "--config", value.configPath], dependencies);
    await runExp0001aBatchCommand(["--ack-dispatch", value.actionDigest, "--config", value.configPath], dependencies);
    const ingested = await runExp0001aBatchCommand([
      "--ingest-result", resultPath, "--dispatch-action", value.actionDigest, "--config", value.configPath,
    ], dependencies);
    expect(value.runtime.ingestExp0001aCoordinatorActionResult).toHaveBeenCalledWith(expect.objectContaining({
      rawResult,
      action: expect.objectContaining({ kind: "perform_provisioning_webmcp" }),
    }));
    expect(value.appendAuthorityJournalEntry).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: "coordinator_action_result",
      payload: expect.objectContaining({ rawResult, rawResultDigest: hashCanonicalJson(rawResult as unknown as JsonValue) }),
    }));
    expect(persistCoordinatorMutation).toHaveBeenCalledWith(value.runtime, value.config, mutation);
    expect(ingested).toMatchObject({ mode: "ingest", status: "coordinator_action_result_ingested",
      completedActionKind: "perform_provisioning_webmcp", nextCheckpointRequired: true });
  });

  it("ingests the exact acknowledged pending dispatch after its current checkpoint expires", async () => {
    const value = await fixture();
    const resultPath = path.join(path.dirname(value.configPath), "late-raw-result.json");
    const rawResult = { content: [{ type: "text", text: JSON.stringify({ ok: true, late: true }) }], isError: false };
    value.values.set(resultPath, rawResult);
    value.values.set(value.config.files.provisioningCoordinatorState, { stateDigest: digest("8") });
    value.values.set(value.config.files.coordinatorJournal, { journalDigest: digest("9") });
    const mutation = { provisioningState: { stateDigest: digest("0"), scheduler: {} },
      coordinatorJournal: { journalDigest: digest("f") }, retainedEvidenceDigest: digest("1") };
    value.runtime.createExp0001aProvisioningCoordinator = vi.fn(() => ({ read: vi.fn() }));
    value.runtime.ingestExp0001aCoordinatorActionResult = vi.fn(async () => mutation);
    const persistCoordinatorMutation = vi.fn(async () => ({ coordinatorJournalDigest: digest("f") }));
    const dependencies = {
      readJson: value.readJson,
      verifyRuntimeBundle: async () => ({ bundleDigest: value.bundleDigest }),
      loadRuntime: async () => value.runtime,
      runAuthPreflight: value.runAuthPreflight,
      verifyOuterSources: value.verifyOuterSources,
      readAuthorityJournal: value.readAuthorityJournal,
      appendAuthorityJournalEntry: value.appendAuthorityJournalEntry,
      persistCoordinatorMutation,
      now: () => new Date("2026-08-31T05:00:00.000Z"),
    };
    await runExp0001aBatchCommand(["--execute", "--config", value.configPath], dependencies);
    await runExp0001aBatchCommand([
      "--ack-dispatch", value.actionDigest, "--config", value.configPath,
    ], dependencies);
    value.runtime.createExp0001aCodexRuntimePreflight = vi.fn(() => {
      throw new Error("EXP0001A_CODEX_COORDINATOR_CHECKPOINT_STALE");
    });
    const retained = await runExp0001aBatchCommand([
      "--ingest-result", resultPath,
      "--dispatch-action", value.actionDigest,
      "--config", value.configPath,
    ], dependencies);
    expect(value.runtime.verifyExp0001aCodexRuntimePreflight).toHaveBeenCalledWith(
      expect.objectContaining({ receiptDigest: expect.any(String) }),
      "2026-08-31T05:00:00.000Z",
    );
    expect(value.runtime.ingestExp0001aCoordinatorActionResult).toHaveBeenCalledWith(expect.objectContaining({
      action: expect.objectContaining({ kind: "perform_provisioning_webmcp" }),
      rawResult,
    }));
    expect(retained).toMatchObject({ status: "coordinator_action_result_ingested",
      completedActionKind: "perform_provisioning_webmcp" });
  });

  it("routes a dispatched neutral usage probe through the fixed authority signer", async () => {
    const createThreadCommandContent = {
      schemaVersion: 1,
      toolName: "mcp__codex_app__create_thread",
      arguments: {
        prompt: "Availability probe only. Do not open Jazzboard, access a repository, or perform experiment work. Return exactly SUBSCRIPTION_AVAILABLE.",
        title: "EXP0001A subscription probe 0-0123456789ab",
        target: { type: "projectless", directoryName: "exp0001a-subscription-probe-0-0123456789ab" },
        model: "gpt-5.6-sol",
        thinking: "low",
      },
    };
    const createThreadCommand = {
      ...createThreadCommandContent,
      commandDigest: hashCanonicalJson(createThreadCommandContent as unknown as JsonValue),
    };
    const action = {
      kind: "run_subscription_availability_probe",
      prompt: "Availability probe only. Do not open Jazzboard, access a repository, or perform experiment work. Return exactly SUBSCRIPTION_AVAILABLE.",
      promptDigest: digest("1"), accountingRole: "subscription_probe", target: { type: "projectless" },
      createThreadCommand,
      benchmarkContentIncluded: false, mayReleaseExperimentBrief: false, authorityReceiptRequiredBeforeResume: true,
      expectedIngest: { operation: "retainSubscriptionProbeResult", assignmentId: null, planDigest: null,
        priorStateDigest: digest("9"), resultMustBeRetainedBeforeNextAction: true }, coordinatorDidNotInvokeTool: true,
    };
    const value = await fixture(action);
    const evidencePath = path.join(path.dirname(value.configPath), "probe-evidence.json");
    value.values.set(evidencePath, {
      request: {
        prompt: action.prompt,
        promptDigest: action.promptDigest,
        accountingRole: action.accountingRole,
        target: action.target,
        createThreadCommand,
        benchmarkContentIncluded: false,
        mayReleaseExperimentBrief: false,
      },
    });
    const signUsageResetProbe = vi.fn(async () => ({ status: "resumed", coordinatorJournalDigest: digest("f") }));
    const dependencies = {
      readJson: value.readJson,
      verifyRuntimeBundle: async () => ({ bundleDigest: value.bundleDigest }),
      loadRuntime: async () => value.runtime,
      runAuthPreflight: value.runAuthPreflight,
      verifyOuterSources: value.verifyOuterSources,
      readAuthorityJournal: value.readAuthorityJournal,
      appendAuthorityJournalEntry: value.appendAuthorityJournalEntry,
      signUsageResetProbe,
      now: () => new Date("2026-08-31T05:00:00.000Z"),
    };
    await runExp0001aBatchCommand(["--execute", "--config", value.configPath], dependencies);
    await runExp0001aBatchCommand(["--ack-dispatch", value.actionDigest, "--config", value.configPath], dependencies);
    const retained = await runExp0001aBatchCommand([
      "--ingest-result", evidencePath, "--dispatch-action", value.actionDigest, "--config", value.configPath,
    ], dependencies);
    expect(signUsageResetProbe).toHaveBeenCalledWith({ configPath: value.configPath, probeEvidencePath: evidencePath });
    expect(retained).toMatchObject({ mode: "ingest", status: "subscription_probe_result_retained",
      retainedProbeResult: { status: "resumed" }, nextCheckpointRequired: true });
  });

  it("writes the minimal reconstructed completion draft, waits for exact approval, and ingests the signed attestation", async () => {
    const action = {
      kind: "perform_scientific_phase_transition",
      transition: "create_and_sign_completion_attestation",
      requiredPriorDigest: digest("1"),
      expectedCount: null,
      mayReleaseTaskBrief: false,
    };
    const value = await fixture(action);
    const evidence = {
      completedAt: "2026-08-31T05:00:00.000Z",
      provisioningPlan: { planDigest: digest("2") },
      scientificState: { stateDigest: digest("3"), transitionDigests: Array.from({ length: 9 }, (_, index) => digest(String(index))) },
      plans: [],
      lifecycles: [],
    };
    const draft = { schemaVersion: "exp-0001a-codex-completion-attestation/v2", completionDigest: digest("4") };
    const attestation = { ...draft, authoritySignature: { purpose: "completion_attestation" } };
    const evidencePath = path.join(value.config.outputRoot, "codex-completion-evidence.json");
    const draftPath = path.join(value.config.outputRoot, "codex-completion-attestation-draft.json");
    const attestationPath = path.join(value.config.outputRoot, "codex-completion-attestation.json");
    value.values.set(evidencePath, evidence);
    value.values.set(draftPath, draft);
    value.values.set(attestationPath, attestation);
    value.runtime.createExp0001aCodexCompletionAttestation = vi.fn(() => draft);
    const writeCompletionDraft = vi.fn(async (input: { completedAt: string }) => {
      void input;
      return ({
      evidence,
      draft,
      evidencePath,
      draftPath,
      authorityJournalEntry: { kind: "completion_draft", entryDigest: digest("5") },
      });
    });
    const mutation = { provisioningState: { stateDigest: digest("8"), scheduler: {} },
      coordinatorJournal: { journalDigest: digest("6") }, retainedEvidenceDigest: digest("7") };
    value.runtime.retainExp0001aCoordinatorCompletionAttestation = vi.fn(() => mutation);
    const persistCoordinatorMutation = vi.fn(async () => ({ coordinatorJournalDigest: digest("6") }));
    const dependencies = {
      readJson: value.readJson,
      verifyRuntimeBundle: async () => ({ bundleDigest: value.bundleDigest }),
      loadRuntime: async () => value.runtime,
      runAuthPreflight: value.runAuthPreflight,
      verifyOuterSources: value.verifyOuterSources,
      readAuthorityJournal: value.readAuthorityJournal,
      appendAuthorityJournalEntry: value.appendAuthorityJournalEntry,
      writeCompletionDraft,
      persistCoordinatorMutation,
      now: () => new Date("2026-08-31T05:00:00.000Z"),
    };

    const prepared = await runExp0001aBatchCommand(["--execute", "--config", value.configPath], dependencies);
    expect(prepared).toMatchObject({
      status: "awaiting_completion_digest_approval",
      completionDigest: draft.completionDigest,
      completionEvidencePath: evidencePath,
      completionDraftPath: draftPath,
      signerCommand: { arguments: expect.arrayContaining(["--approved-completion-digest", draft.completionDigest]) },
      nextCheckpointRequired: false,
    });
    expect(writeCompletionDraft).toHaveBeenCalledTimes(1);

    const replay = await runExp0001aBatchCommand(["--execute", "--config", value.configPath], dependencies);
    expect(replay).toMatchObject({ status: "awaiting_completion_digest_approval", completionDigest: draft.completionDigest });
    expect(writeCompletionDraft).toHaveBeenCalledTimes(2);
    expect(writeCompletionDraft.mock.calls.map(([input]) => input.completedAt))
      .toEqual(["2026-08-31T05:00:00.000Z", "2026-08-31T05:00:00.000Z"]);

    const retained = await runExp0001aBatchCommand([
      "--ingest-result", attestationPath, "--dispatch-action", value.actionDigest, "--config", value.configPath,
    ], dependencies);
    expect(value.runtime.retainExp0001aCoordinatorCompletionAttestation).toHaveBeenCalledWith({
      verifiedAt: "2026-08-31T05:00:00.000Z",
      provisioningState: {},
      coordinatorJournal: {},
      evidence,
      attestation,
    });
    expect(value.appendAuthorityJournalEntry).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: "completion_attestation",
      payload: expect.objectContaining({ attestation, signedCompletionAttestationDigest: digest("7") }),
    }));
    expect(persistCoordinatorMutation).toHaveBeenCalledWith(value.runtime, value.config, mutation);
    expect(retained).toMatchObject({
      status: "completion_attestation_ingested",
      signedCompletionAttestationDigest: digest("7"),
      nextCheckpointRequired: true,
    });
  });
});
