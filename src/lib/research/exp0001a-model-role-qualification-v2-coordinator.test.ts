// @vitest-environment node

import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./exp0001a-model-role-qualification-v2-authority", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./exp0001a-model-role-qualification-v2-authority")>();
  return {
    ...actual,
    verifyExp0001aQualificationV2AuthoritySignature: vi.fn(({ signature }) => signature),
  };
});

import { EXP0001A_QUALIFICATION_V2_TASK_IDS } from "./exp0001a-model-role-qualification-v2";
import {
  acknowledgeQualificationV2CaptureDispatch,
  compileQualificationV2PublicTasksFromExecutionBundle,
  findQualificationV2ExactInviteCodeLeaks,
  ingestQualificationV2ExternalTaskReceipt,
  initializeQualificationV2Coordinator,
  prepareQualificationV2AuthorAction,
  prepareQualificationV2CaptureAction,
  prepareQualificationV2ReviewAction,
  qualificationV2CoordinatorStateSchema,
  recordQualificationV2CaptureIndeterminate,
  recordQualificationV2RunnerDispatch,
  retainQualificationV2AuthorEvidence,
  retainQualificationV2CaptureTerminalReceipt,
  retainQualificationV2Room,
  resumeQualificationV2AfterUsageLimit,
  sealQualificationV2ProductionBinding,
  sealQualificationV2RoomReceipt,
  sealQualificationV2Result,
} from "./exp0001a-model-role-qualification-v2-coordinator";
import { sealQualificationV2CaptureTerminalReceipt } from "./exp0001a-model-role-qualification-v2-room-controller-receipts";
import { hashCanonicalJson, type JsonValue } from "./provenance-crypto";
import { runQualificationV2CoordinatorCli } from "./exp0001a-model-role-qualification-v2-coordinator-cli";
import { analyzeQualificationV2NodeReplProgram } from "./exp0001a-model-role-qualification-v2-node-repl-trace";

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const HARNESS_RUNTIME_PROVENANCE = {
  controllerBundleDigest: digest("1"),
  wrapperSourceDigest: digest("2"),
  dependencyLockfileDigest: digest("3"),
  gitCommit: "a".repeat(40),
  gitTree: "b".repeat(40),
  worktreeClean: true as const,
};
const plan = JSON.parse(readFileSync("research/data/exp0001a-model-role-qualification-plan-v2.json", "utf8"));
const planSignature = JSON.parse(readFileSync(
  "research/data/exp0001a-model-role-qualification-plan-signature-v2.json",
  "utf8",
));
const benchmark = JSON.parse(readFileSync("research/benchmarks/development-v2.json", "utf8"));
const rubricBundle = JSON.parse(readFileSync("research/benchmarks/development-evaluator-rubrics-v2.json", "utf8"));
const fixtureSpecs = JSON.parse(readFileSync("research/benchmarks/development-fixture-specs-v2.json", "utf8"));
const baselineInventory = JSON.parse(readFileSync("research/data/baseline-webmcp-inventory-v2.json", "utf8"));

function fakeAuthoritySignature(purpose: "qualification_launch_binding") {
  return {
    ...planSignature,
    purpose,
    signedAt: "2026-08-31T20:00:00.000Z",
    payloadDigest: digest("f"),
    signatureBase64: `${"A".repeat(86)}==`,
  };
}

function productionBinding() {
  const content = {
    schemaVersion: "exp-0001a-qualification-production-binding/v2",
    planDigest: plan.planDigest,
    planDeclaredSuccessorCommit: "88919b8e0070fbd1b2be4f3e4121cfdcf50638a6",
    predecessorPlanBytesMutated: false,
    supersessionReason: "production_export_route_hotfix_and_successor_baseline_freeze",
    baselineReceiptSchema: "baseline-freeze/v2",
    baselineFreezeDigest: digest("a"),
    baselineAuthoritySignatureDigest: digest("b"),
    productionCommit: "66a546aaef9e006891a4cf619ed310fd9fc1c4cc",
    productionTree: "071a751beadbcefc002f42d1be75a0e717bc3e4b",
    deploymentId: "dpl_46pyqWtLXGfzeU1JsqXEWQjTBfd8",
    buildId: "bld_3t0eopcj7",
    productionAlias: "https://www.jazzboard.xyz",
    verifiedAt: "2026-08-31T19:59:00.000Z",
    aliasAndContractDriftObserved: false,
    semanticExportPreflightPassed: true,
    exactRevisionPngPreflightPassed: true,
    browserWebMcpContractPassed: true,
  };
  return { ...content, bindingDigest: hashCanonicalJson(content as unknown as JsonValue) };
}

function authReceipt(checkedAt: string) {
  const content = {
    schemaVersion: "codex-chatgpt-auth-preflight/v1",
    checkedAt,
    command: { executable: "codex", arguments: ["login", "status"] },
    authentication: {
      method: "chatgpt",
      accountIdentifier: { observability: "unobservable", value: null },
      subscriptionPlan: { observability: "unobservable", value: null },
    },
    observation: {
      exitCode: { observability: "observed", value: 0 },
      signal: { observability: "unobservable", value: null },
      stdoutSha256: { observability: "observed", value: digest("1") },
      stderrSha256: { observability: "observed", value: digest("2") },
      rawOutputRetained: false,
      outputLimitExceeded: false,
      invocationError: false,
    },
    decision: { allowCodexNativeExperiment: true, reasonCode: "CHATGPT_AUTHENTICATED" },
  };
  return { ...content, receiptSha256: hashCanonicalJson(content as unknown as JsonValue) };
}

const executionBundle = compileQualificationV2PublicTasksFromExecutionBundle(benchmark, rubricBundle, fixtureSpecs);
const publicTasks = executionBundle.publicTasks;

function initialize() {
  return initializeQualificationV2Coordinator({
    createdAt: "2026-08-31T20:00:00.000Z",
    plan,
    planAuthoritySignature: planSignature,
    productionBinding: productionBinding(),
    productionBindingAuthoritySignature: fakeAuthoritySignature("qualification_launch_binding"),
    publicTasks,
    benchmark,
    rubrics: rubricBundle,
    fixtureSpecs,
    baselineParticipantToolContractDigest: baselineInventory.participant.contractDigest,
  });
}

function roomReceipt(taskIndex: number) {
  const taskId = EXP0001A_QUALIFICATION_V2_TASK_IDS[taskIndex];
  const code = ["ABC234", "DEF567", "GHJ789"][taskIndex];
  const privateRoomInviteUrl = `https://www.jazzboard.xyz/#join=${code}`;
  const initialStateKind = taskIndex === 1 ? "validated_fixture" : "blank";
  const content = {
    schemaVersion: "exp-0001a-qualification-room-receipt/v2",
    taskId,
    preparedAt: `2026-08-31T20:${String(taskIndex).padStart(2, "0")}:01.000Z`,
    roomId: `room-private-${taskIndex}`,
    privateRoomInviteUrl,
    inviteAuthorizationBindingDigest: hashCanonicalJson({ roomId: `room-private-${taskIndex}`, privateRoomInviteUrl }),
    authorization: "exact_private_invite_only",
    globalDirectoryUsed: false,
    roomCreationReceiptDigest: digest(String(taskIndex + 3)),
    initialStateKind,
    initialRoomRevision: taskIndex === 1 ? 1 : 0,
    initialObjectCount: taskIndex === 1 ? 5 : 0,
    fixturePreflightDigest: executionBundle.taskExecutions[taskIndex]!.trustedCoordinator.seedReadabilityPreflight?.receiptDigest ?? null,
  };
  return { ...content, receiptDigest: hashCanonicalJson(content as unknown as JsonValue) };
}

function retainedTextCall(result: unknown) {
  return { isError: false, content: [{ type: "text", text: JSON.stringify(result) }] };
}

function blankProvisionEvidence() {
  const created = {
    ok: true,
    tool: "create_room",
    data: { room: { id: "room-private-0", code: "ABC234", title: "Qualification workspace" }, role: "participant" },
  };
  const blank = {
    ok: true,
    tool: "read_room_state",
    data: {
      room: { id: "room-private-0", code: "ABC234", roomRevision: 0 },
      objects: [],
      diagrams: [],
      participants: [],
    },
  };
  const createCallResult = retainedTextCall(created);
  const blankCallResult = retainedTextCall(blank);
  const preAuthorCallResult = retainedTextCall(blank);
  const storageState = { cookies: [{ name: "private-session", value: "opaque" }], origins: [] };
  const existingRoom = roomReceipt(0);
  const { receiptDigest: _receiptDigest, ...roomContent } = existingRoom;
  void _receiptDigest;
  const roomDraft = {
    ...roomContent,
    roomCreationReceiptDigest: hashCanonicalJson(created as unknown as JsonValue),
  };
  const room = { ...roomDraft, receiptDigest: hashCanonicalJson(roomDraft as unknown as JsonValue) };
  const provisionContent = {
    schemaVersion: "exp-0001a-qualification-room-controller-provision/v2",
    taskId: room.taskId,
    roomReceiptDigest: room.receiptDigest,
    storageStateDigest: hashCanonicalJson(storageState as unknown as JsonValue),
    deploymentId: "dpl_46pyqWtLXGfzeU1JsqXEWQjTBfd8",
    deploymentObservations: [
      "dpl_46pyqWtLXGfzeU1JsqXEWQjTBfd8",
      "dpl_46pyqWtLXGfzeU1JsqXEWQjTBfd8",
    ],
    landingToolContractDigest: baselineInventory.landing.contractDigest,
    participantToolContractDigest: baselineInventory.participant.contractDigest,
    playwrightVersion: "1.55.0",
    chromiumVersion: "test-chromium",
    runtime: { node: process.version, platform: process.platform, architecture: process.arch },
    harnessRuntimeProvenance: HARNESS_RUNTIME_PROVENANCE,
    createRoomCallResultDigest: hashCanonicalJson(createCallResult as unknown as JsonValue),
    blankReadCallResultDigest: hashCanonicalJson(blankCallResult as unknown as JsonValue),
    fixtureTransactionCallResultDigest: null,
    preAuthorReadCallResultDigest: hashCanonicalJson(preAuthorCallResult as unknown as JsonValue),
    frozenFixtureDeclarationDigest: null,
    authoritativeInitialStateDigest: hashCanonicalJson(blank.data as unknown as JsonValue),
    initialRoomRevision: 0,
    initialObjectCount: 0,
    retainedAt: "2026-08-31T20:00:00.500Z",
  };
  return {
    room,
    provision: {
      ...provisionContent,
      receiptDigest: hashCanonicalJson(provisionContent as unknown as JsonValue),
    },
    createCallResult,
    blankCallResult,
    preAuthorCallResult,
    storageState,
  };
}

function taskReceipt(state: ReturnType<typeof initialize>, input: {
  terminalStatus?: "completed" | "failed" | "usage_limit_interrupted" | "invalid_setup";
  accepted?: boolean;
  createdTask?: boolean;
}) {
  const action = state.pendingAction!;
  const dispatch = state.pendingDispatchReceipt!;
  const terminalStatus = input.terminalStatus ?? "completed";
  const isAuthor = action.role === "author";
  const hasTask = input.createdTask ?? terminalStatus !== "invalid_setup";
  const content = {
    schemaVersion: "exp-0001a-qualification-external-task-receipt/v2",
    actionDigest: action.actionDigest,
    dispatchReceiptDigest: dispatch.receiptDigest,
    taskId: action.taskId,
    role: action.role,
    roleOrdinal: action.roleOrdinal,
    requestedModel: action.arguments.model,
    requestedReasoningEffort: action.arguments.thinking,
    workspace: "projectless",
    repositoryAccess: false,
    privateApiAccess: false,
    sourceTaskId: null,
    forkedFromTaskId: null,
    createdTaskId: hasTask ? `codex-${action.actionId}` : null,
    hostId: hasTask ? "local" : null,
    clientTaskId: null,
    rawCreateToolResultDigest: digest("8"),
    listThreadsObservationDigest: hasTask ? digest("7") : null,
    rawTerminalToolResultDigest: digest("9"),
    terminalStatus,
    terminalResultDigest: digest("c"),
    reviewDecision: !isAuthor && terminalStatus === "completed" ? {
      artifactAccepted: input.accepted ?? true,
      criterionPasses: Object.fromEntries(
        publicTasks.find((task) => task.taskId === action.taskId)!.acceptanceCriteria.map((criterion) => [criterion.id, input.accepted ?? true]),
      ),
      evidenceRoot: digest("d"),
      blindness: {
        authorTranscriptSeen: false,
        authorIdentitySeen: false,
        conditionLabelSeen: false,
        pairedArtifactSeen: false,
        repositoryAccessed: false,
        otherReviewerDecisionSeen: false,
      },
    } : null,
    wallTimeMs: 10_000,
    subscriptionUsage: "unobservable",
    resolvedModelSnapshot: "unobservable",
    exactTokens: "unobservable",
    retainedAt: state.updatedAt,
  };
  return { ...content, receiptDigest: hashCanonicalJson(content as unknown as JsonValue) };
}

function authorEvidence(state: ReturnType<typeof initialize>, semanticState: unknown = sanitizedState()) {
  const task = state.tasks[state.currentTaskIndex];
  const author = task.authorReceipt!;
  const semanticDigest = hashCanonicalJson(semanticState as JsonValue);
  const identityContent = {
    participantId: "participant_author_exact",
    displayName: "EXP-0001A Qualification Author" as const,
    role: "participant" as const,
    joinResultDigest: digest("1"),
    collaborationResultDigest: digest("2"),
  };
  const leaves = [
    digest("3"), hashCanonicalJson(identityContent), digest("4"), digest("5"),
    digest("6"), semanticDigest, author.terminalResultDigest, digest("7"), digest("8"), digest("9"),
  ];
  return {
    schemaVersion: "exp-0001a-qualification-author-evidence/v2",
    taskId: task.taskId,
    authorTaskId: author.createdTaskId,
    roomId: task.room!.roomId,
    authorOutcome: "completed",
    authorSessionIdentity: { ...identityContent, bindingDigest: leaves[1] },
    webMcpDiscovered: true,
    webMcpTraceDigest: leaves[0],
    webMcpCallCount: 8,
    webMcpFailureCount: 0,
    successfulAuthoritativeMutationCount: 2,
    visualInspectionCount: 2,
    preAuthoritativeReadDigest: leaves[2],
    closingAuthoritativeReadDigest: leaves[3],
    finalAuthoritativeRoomRevision: 3,
    revisionMatchedPngDigest: leaves[4],
    pngRoomRevision: 3,
    sanitizedSemanticStateDigest: leaves[5],
    semanticStateRoomRevision: 3,
    terminalResultDigest: leaves[6],
    attributedMutationSetDigest: leaves[7],
    controllerInspectionDigest: leaves[8],
    visualProofDigest: leaves[9],
    criticalBoundaryViolations: [],
    evidenceRoot: hashCanonicalJson(leaves),
    retainedAt: state.updatedAt,
  };
}

function retainSuccessfulCapture(state: ReturnType<typeof initialize>, at: string) {
  const task = state.tasks[state.currentTaskIndex];
  const prepared = prepareQualificationV2CaptureAction({
    state,
    preparedAt: at,
    request: {
      operation: "capture_author_evidence",
      roomReceiptPath: `/private/tmp/${task.taskId}-room.json`,
      provisionControllerReceiptPath: `/private/tmp/${task.taskId}-provision.json`,
      storageStatePath: `/private/tmp/${task.taskId}-storage.json`,
      outputDirectory: `/private/tmp/${task.taskId}-capture`,
      at,
    },
  });
  const acknowledged = acknowledgeQualificationV2CaptureDispatch(prepared.state, at);
  return retainQualificationV2CaptureTerminalReceipt(acknowledged.state, sealQualificationV2CaptureTerminalReceipt({
    schemaVersion: "exp-0001a-qualification-capture-terminal/v2",
    taskId: task.taskId,
    captureActionDigest: prepared.captureAuthorization.actionDigest,
    captureNonce: prepared.captureAuthorization.captureNonce,
    requestBindingDigest: prepared.captureAuthorization.requestBindingDigest,
    releaseJournalDigest: acknowledged.captureReleaseJournal.journalDigest,
    outcome: "succeeded",
    captureControllerReceiptDigest: digest("9"),
    failureCode: null,
    retainedAt: at,
  }), at);
}

function sanitizedState() {
  return {
    schemaVersion: "exp-0001a-author-review-semantic-state/v2",
    roomRevision: 3,
    objects: [],
    diagrams: [],
  } as const;
}

function reviewEnvelopeFor(state: ReturnType<typeof initialize>, semanticState: unknown = sanitizedState()) {
  const task = state.tasks[state.currentTaskIndex];
  const publicTask = publicTasks[state.currentTaskIndex];
  const rubric = rubricBundle.rubrics.find((candidate: { taskId: string }) => candidate.taskId === task.taskId);
  const sidecarContent = {
    schemaVersion: "exp-0001a-qualification-evidence-sidecar-receipt/v2",
    exactRevisionPngUrl: "http://127.0.0.1:49152/evidence/0123456789abcdef0123456789abcdef.png",
    manifest: {
      schemaVersion: "exp-0001a-qualification-evidence-sidecar-manifest/v2",
      opaqueArtifactKey: "0123456789abcdef0123456789abcdef",
      mediaType: "image/png",
      byteDigest: task.authorEvidence!.revisionMatchedPngDigest,
      byteLength: 1024,
      sourceRoomRevision: 3,
    },
    manifestDigest: "",
    exactRevisionPngByteDigest: task.authorEvidence!.revisionMatchedPngDigest,
    exactRevisionPngByteLength: 1024,
    sourceRoomRevision: 3,
    sanitizedSemanticStateRoomRevision: 3,
    queryPermitted: false,
    fragmentPermitted: false,
    persistedByJazzboard: false,
  };
  sidecarContent.manifestDigest = hashCanonicalJson(sidecarContent.manifest as unknown as JsonValue);
  const envelopeContent = {
    schemaVersion: "exp-0001a-qualification-blinded-review-envelope/v2",
    publicTask,
    frozenRubric: rubric,
    sanitizedSemanticState: semanticState,
    sanitizedSemanticStateDigest: task.authorEvidence!.sanitizedSemanticStateDigest,
    evidenceSidecar: {
      ...sidecarContent,
      sidecarReceiptDigest: hashCanonicalJson(sidecarContent as unknown as JsonValue),
    },
  };
  return {
    ...envelopeContent,
    envelopeDigest: hashCanonicalJson(envelopeContent as unknown as JsonValue),
  };
}

function prepareReview(state: ReturnType<typeof initialize>, at: string) {
  return prepareQualificationV2ReviewAction({
    state,
    authReceipt: authReceipt(at),
    preparedAt: at,
    reviewEnvelope: reviewEnvelopeFor(state),
  });
}

function dispatch(state: ReturnType<typeof initialize>, at: string) {
  return recordQualificationV2RunnerDispatch(state, at, digest("e"));
}

function semanticStateWithDiagramTitle(title: string) {
  return {
    ...sanitizedState(),
    diagrams: [{
      id: "diagram_privacy_test",
      title,
      description: "Privacy boundary fixture",
      diagramType: "custom" as const,
      category: null,
      tags: [],
      memberObjectIds: [],
      connectorIds: [],
      bounds: { x: 0, y: 0, width: 100, height: 100 },
      revision: 1,
    }],
  };
}

function readyForReviewState(semanticState: unknown) {
  let state = initialize();
  state = retainQualificationV2Room(
    state,
    roomReceipt(0),
    digest("c"),
    digest("d"),
    "2026-08-31T20:00:01.000Z",
    HARNESS_RUNTIME_PROVENANCE,
  );
  state = prepareQualificationV2AuthorAction({
    state,
    publicTask: publicTasks[0],
    authReceipt: authReceipt("2026-08-31T20:00:02.000Z"),
    preparedAt: "2026-08-31T20:00:02.000Z",
  });
  state = dispatch(state, "2026-08-31T20:00:03.000Z");
  state = ingestQualificationV2ExternalTaskReceipt(
    state,
    taskReceipt(state, {}),
    "2026-08-31T20:00:04.000Z",
  );
  state = retainSuccessfulCapture(state, "2026-08-31T20:00:04.500Z");
  return retainQualificationV2AuthorEvidence(
    state,
    authorEvidence(state, semanticState),
    "2026-08-31T20:00:05.000Z",
  );
}

describe("EXP-0001A qualification-v2 coordinator", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deterministically seals launch and private-room receipts", () => {
    const sealedBinding = productionBinding();
    const { bindingDigest: _bindingDigest, ...bindingDraft } = sealedBinding;
    const sealedRoom = roomReceipt(0);
    const { receiptDigest: _receiptDigest, ...roomDraft } = sealedRoom;
    void _bindingDigest;
    void _receiptDigest;
    expect(sealQualificationV2ProductionBinding(bindingDraft)).toEqual(sealedBinding);
    expect(sealQualificationV2RoomReceipt(roomDraft)).toEqual(sealedRoom);
  });

  it("releases only an invite-based fresh Terra/medium author action after signed gates", () => {
    let state = initialize();
    state = retainQualificationV2Room(state, roomReceipt(0), digest("c"), digest("d"), "2026-08-31T20:00:01.000Z", HARNESS_RUNTIME_PROVENANCE);
    state = prepareQualificationV2AuthorAction({
      state,
      publicTask: publicTasks[0],
      authReceipt: authReceipt("2026-08-31T20:00:02.000Z"),
      preparedAt: "2026-08-31T20:00:02.000Z",
    });
    expect(state.pendingAction).toMatchObject({
      role: "author",
      arguments: {
        target: { type: "projectless" },
        model: "gpt-5.6-terra",
        thinking: "medium",
      },
      sourceTaskId: null,
      forkedFromTaskId: null,
    });
    const actionSuffix = state.pendingAction!.actionId.split("-").at(-1)!;
    expect(state.pendingAction!.arguments.title).toBe(`Q ${actionSuffix} author 1`);
    expect(state.pendingAction!.arguments.title.length).toBeLessThanOrEqual(60);
    expect(state.pendingAction!.arguments.prompt).toContain("PRIVATE_ROOM_INVITE_URL=https://www.jazzboard.xyz/#join=ABC234");
    expect(state.pendingAction!.arguments.prompt).toContain("call join_room");
    expect(state.pendingAction!.arguments.prompt).toContain("sed -n '1,220p' ~/.codex/plugins/cache/openai-bundled/browser/26.825.51511/skills/control-in-app-browser/SKILL.md");
    expect(state.pendingAction!.arguments.prompt).toContain("Copy it exactly; do not guess, rewrite, or probe any alternate path");
    expect(state.pendingAction!.arguments.prompt).toContain("only permitted terminal or filesystem access");
    expect(state.pendingAction!.arguments.prompt).toContain("required selected-browser documentation read");
    expect(state.pendingAction!.arguments.prompt).toContain("let tools = await webmcp.fetchTools()");
    expect(state.pendingAction!.arguments.prompt).toContain("do not redeclare it or introduce a roomTools");
    expect(state.pendingAction!.arguments.prompt).not.toContain("room-private-0");
    expect(state.pendingAction!.arguments.prompt).not.toContain("FROZEN_RUBRIC");
    expect(state.pendingAction!.arguments.prompt).not.toContain("api.openai.com");

    state = dispatch(state, "2026-08-31T20:00:03.000Z");
    expect(state.pendingDispatchReceipt).toMatchObject({
      invocationPermittedExactlyOnce: true,
      externalToolInvokedByCoordinatorLibrary: true,
    });
    expect(() => dispatch(state, "2026-08-31T20:00:04.000Z"))
      .toThrow("ACTION_NOT_DISPATCHABLE");
  });

  it("rejects stale or non-ChatGPT authentication and mismatched room initialization", () => {
    let state = initialize();
    expect(() => retainQualificationV2Room(state, { ...roomReceipt(0), initialStateKind: "validated_fixture" }, digest("c"), digest("d"), "2026-08-31T20:00:01.000Z", HARNESS_RUNTIME_PROVENANCE))
      .toThrow();
    state = retainQualificationV2Room(state, roomReceipt(0), digest("c"), digest("d"), "2026-08-31T20:00:01.000Z", HARNESS_RUNTIME_PROVENANCE);
    expect(() => prepareQualificationV2AuthorAction({
      state,
      publicTask: publicTasks[0],
      authReceipt: authReceipt("2026-08-31T19:40:00.000Z"),
      preparedAt: "2026-08-31T20:00:02.000Z",
    })).toThrow("FRESH_CHATGPT_AUTH_REQUIRED");
    const apiKey = { ...authReceipt("2026-08-31T20:00:02.000Z"), authentication: { ...authReceipt("2026-08-31T20:00:02.000Z").authentication, method: "api_key" } };
    expect(() => prepareQualificationV2AuthorAction({
      state,
      publicTask: publicTasks[0],
      authReceipt: apiKey,
      preparedAt: "2026-08-31T20:00:02.000Z",
    })).toThrow();
  });

  it("runs exactly three authors and two fresh blinded reviews per artifact, then seals a pass", () => {
    let state = initialize();
    for (let index = 0; index < 3; index += 1) {
      const minute = String(index * 10).padStart(2, "0");
      state = retainQualificationV2Room(state, roomReceipt(index), digest("c"), digest("d"), `2026-08-31T20:${minute}:01.000Z`, HARNESS_RUNTIME_PROVENANCE);
      state = prepareQualificationV2AuthorAction({
        state,
        publicTask: publicTasks[index],
        authReceipt: authReceipt(`2026-08-31T20:${minute}:02.000Z`),
        preparedAt: `2026-08-31T20:${minute}:02.000Z`,
      });
      state = dispatch(state, `2026-08-31T20:${minute}:03.000Z`);
      state = ingestQualificationV2ExternalTaskReceipt(state, taskReceipt(state, {}), `2026-08-31T20:${minute}:04.000Z`);
      state = retainSuccessfulCapture(state, `2026-08-31T20:${minute}:04.500Z`);
      state = retainQualificationV2AuthorEvidence(state, authorEvidence(state), `2026-08-31T20:${minute}:05.000Z`);
      for (let reviewer = 0; reviewer < 2; reviewer += 1) {
        const second = 6 + reviewer * 2;
        state = prepareReview(state, `2026-08-31T20:${minute}:${String(second).padStart(2, "0")}.000Z`);
        expect(state.pendingAction).toMatchObject({ role: "primary_reviewer", roleOrdinal: reviewer + 1 });
        expect(state.pendingAction!.arguments.prompt).not.toContain("PRIVATE_ROOM_INVITE_URL");
        state = dispatch(state, `2026-08-31T20:${minute}:${String(second + 1).padStart(2, "0")}.000Z`);
        state = ingestQualificationV2ExternalTaskReceipt(state, taskReceipt(state, { accepted: true }), `2026-08-31T20:${minute}:${String(second + 1).padStart(2, "0")}.500Z`);
      }
    }
    expect(state).toMatchObject({ currentTaskIndex: 3, stopped: true, stopReason: "completed" });
    expect(state.releasedActionDigests).toHaveLength(9);
    expect(new Set(state.releasedActionDigests)).toHaveLength(9);
    const result = sealQualificationV2Result(state, "2026-08-31T21:00:00.000Z", {
      attestedAt: "2026-08-31T21:00:00.000Z",
      attestationDigest: digest("7"),
      terminalStateDigest: state.stateDigest,
      harnessRuntimeProvenanceDigest: hashCanonicalJson(HARNESS_RUNTIME_PROVENANCE as unknown as JsonValue),
      evidenceInventoryRoot: digest("8"),
      evidenceFileCount: 42,
    });
    expect(result.gateDecision).toMatchObject({ decision: "pass", compatibleTaskIds: EXP0001A_QUALIFICATION_V2_TASK_IDS });
    expect(result.aaExecutionStatus).toBe("eligible_for_successor_freeze");
    expect(JSON.stringify(result)).not.toMatch(/costUsd|OPENAI_API_KEY|api\.openai\.com/);
    expect(result.metrics.every((metric) => metric.exactTokens === "unobservable")).toBe(true);
  });

  it("seals an incomplete stopped run from a full terminal attestation", () => {
    let state = initialize();
    state = retainQualificationV2Room(
      state,
      roomReceipt(0),
      digest("c"),
      digest("d"),
      "2026-08-31T20:00:01.000Z",
      HARNESS_RUNTIME_PROVENANCE,
    );
    state = prepareQualificationV2AuthorAction({
      state,
      publicTask: publicTasks[0],
      authReceipt: authReceipt("2026-08-31T20:00:02.000Z"),
      preparedAt: "2026-08-31T20:00:02.000Z",
    });
    state = dispatch(state, "2026-08-31T20:00:03.000Z");
    state = ingestQualificationV2ExternalTaskReceipt(
      state,
      taskReceipt(state, { terminalStatus: "invalid_setup", createdTask: false }),
      "2026-08-31T20:00:04.000Z",
    );
    expect(state).toMatchObject({ stopped: true, stopReason: "invalid_setup" });

    const fullAttestation = {
      schemaVersion: "exp-0001a-qualification-terminal-evidence-attestation/v2",
      protocolId: "EXP-0001A-MODEL-ROLE-QUALIFICATION-V2",
      kind: "terminal-evidence-attestation",
      attestedAt: "2026-08-31T21:00:00.000Z",
      attestationDigest: digest("7"),
      terminalStateDigest: state.stateDigest,
      harnessRuntimeProvenanceDigest: hashCanonicalJson(HARNESS_RUNTIME_PROVENANCE as unknown as JsonValue),
      evidenceInventoryRoot: digest("8"),
      evidenceFileCount: 34,
      evidenceFiles: [],
    };
    const result = sealQualificationV2Result(state, fullAttestation.attestedAt, fullAttestation);
    expect(result.gateDecision).toEqual({
      decision: "incomplete",
      compatibleTaskIds: [],
      failedTaskIds: [],
      incompleteTaskIds: EXP0001A_QUALIFICATION_V2_TASK_IDS,
      diagnosticQuality: {},
    });
    expect(result.aaExecutionStatus).toBe("blocked");
  });

  it("uses a fresh blinded adjudicator only for binary primary disagreement", () => {
    let state = initialize();
    state = retainQualificationV2Room(state, roomReceipt(0), digest("c"), digest("d"), "2026-08-31T20:00:01.000Z", HARNESS_RUNTIME_PROVENANCE);
    state = prepareQualificationV2AuthorAction({ state, publicTask: publicTasks[0], authReceipt: authReceipt("2026-08-31T20:00:02.000Z"), preparedAt: "2026-08-31T20:00:02.000Z" });
    state = dispatch(state, "2026-08-31T20:00:03.000Z");
    state = ingestQualificationV2ExternalTaskReceipt(state, taskReceipt(state, {}), "2026-08-31T20:00:04.000Z");
    state = retainSuccessfulCapture(state, "2026-08-31T20:00:04.500Z");
    state = retainQualificationV2AuthorEvidence(state, authorEvidence(state), "2026-08-31T20:00:05.000Z");
    for (const accepted of [true, false]) {
      state = prepareReview(state, accepted ? "2026-08-31T20:00:06.000Z" : "2026-08-31T20:00:08.000Z");
      state = dispatch(state, accepted ? "2026-08-31T20:00:07.000Z" : "2026-08-31T20:00:09.000Z");
      state = ingestQualificationV2ExternalTaskReceipt(state, taskReceipt(state, { accepted }), accepted ? "2026-08-31T20:00:07.500Z" : "2026-08-31T20:00:09.500Z");
    }
    state = prepareReview(state, "2026-08-31T20:00:10.000Z");
    expect(state.pendingAction).toMatchObject({ role: "adjudicator", roleOrdinal: 1, arguments: { model: "gpt-5.6-sol", thinking: "high" } });
    expect(state.pendingAction!.arguments.prompt).not.toContain("PRIMARY_DECISION=");
    expect(state.pendingAction!.arguments.prompt).not.toContain(state.tasks[0].primaryReviews[0].createdTaskId!);
    expect(state.pendingAction!.arguments.prompt).not.toContain(state.tasks[0].primaryReviews[1].createdTaskId!);
  });

  it("rejects production URLs, unbound semantic bytes, and identity leakage from blinded review evidence", () => {
    let state = initialize();
    state = retainQualificationV2Room(state, roomReceipt(0), digest("c"), digest("d"), "2026-08-31T20:00:01.000Z", HARNESS_RUNTIME_PROVENANCE);
    state = prepareQualificationV2AuthorAction({ state, publicTask: publicTasks[0], authReceipt: authReceipt("2026-08-31T20:00:02.000Z"), preparedAt: "2026-08-31T20:00:02.000Z" });
    state = dispatch(state, "2026-08-31T20:00:03.000Z");
    state = ingestQualificationV2ExternalTaskReceipt(state, taskReceipt(state, {}), "2026-08-31T20:00:04.000Z");
    state = retainSuccessfulCapture(state, "2026-08-31T20:00:04.500Z");
    state = retainQualificationV2AuthorEvidence(state, authorEvidence(state), "2026-08-31T20:00:05.000Z");
    const valid = reviewEnvelopeFor(state);
    const attempt = (reviewEnvelope: unknown) => prepareQualificationV2ReviewAction({
      state,
      authReceipt: authReceipt("2026-08-31T20:00:06.000Z"),
      preparedAt: "2026-08-31T20:00:06.000Z",
      reviewEnvelope,
    });
    const productionSidecar = {
      ...valid.evidenceSidecar,
      exactRevisionPngUrl: "https://www.jazzboard.xyz/room/room_private/artifact.png",
    };
    const productionEnvelopeContent = { ...valid, evidenceSidecar: productionSidecar };
    delete (productionEnvelopeContent as { envelopeDigest?: string }).envelopeDigest;
    expect(() => attempt({
      ...productionEnvelopeContent,
      envelopeDigest: hashCanonicalJson(productionEnvelopeContent as unknown as JsonValue),
    })).toThrow();

    const leakedContent = {
      ...valid,
      sanitizedSemanticState: { ...sanitizedState(), roomId: "room_private_identifier" },
    };
    delete (leakedContent as { envelopeDigest?: string }).envelopeDigest;
    expect(() => attempt({
      ...leakedContent,
      sanitizedSemanticStateDigest: hashCanonicalJson(leakedContent.sanitizedSemanticState),
      envelopeDigest: hashCanonicalJson({
        ...leakedContent,
        sanitizedSemanticStateDigest: hashCanonicalJson(leakedContent.sanitizedSemanticState),
      } as unknown as JsonValue),
    })).toThrow(/roomId|forbidden identity material/);

    const unboundContent = { ...valid, sanitizedSemanticState: { ...sanitizedState(), roomRevision: 4 } };
    expect(() => attempt(unboundContent)).toThrow();
  });

  it("rejects exact, lowercase, hyphenated, spaced, and embedded variants of the bound private invite code", () => {
    const invite = roomReceipt(0).privateRoomInviteUrl;
    for (const variant of ["ABC234", "abc234", "ABC-234", "A B C 2 3 4", "nodeABC234box"]) {
      expect(findQualificationV2ExactInviteCodeLeaks(
        { nested: { title: `Private access ${variant}` } },
        invite,
      )).toEqual(["$/nested/title"]);
      const semanticState = semanticStateWithDiagramTitle(`Private access ${variant}`);
      const state = readyForReviewState(semanticState);
      expect(() => prepareQualificationV2ReviewAction({
        state,
        authReceipt: authReceipt("2026-08-31T20:00:06.000Z"),
        preparedAt: "2026-08-31T20:00:06.000Z",
        reviewEnvelope: reviewEnvelopeFor(state, semanticState),
      })).toThrow("QUALIFICATION_V2_REVIEW_EXACT_INVITE_CODE_LEAK");
    }
    expect(findQualificationV2ExactInviteCodeLeaks(
      { nested: { title: "Unrelated token XYZ789 and architecture" } },
      invite,
    )).toEqual([]);
    const controlStateValue = semanticStateWithDiagramTitle("Unrelated token XYZ789");
    const controlState = readyForReviewState(controlStateValue);
    expect(() => prepareQualificationV2ReviewAction({
      state: controlState,
      authReceipt: authReceipt("2026-08-31T20:00:06.000Z"),
      preparedAt: "2026-08-31T20:00:06.000Z",
      reviewEnvelope: reviewEnvelopeFor(controlState, controlStateValue),
    })).not.toThrow();
  });

  it("retains usage-limit interruption and blocks every later assignment without replacement", () => {
    let state = initialize();
    state = retainQualificationV2Room(state, roomReceipt(0), digest("c"), digest("d"), "2026-08-31T20:00:01.000Z", HARNESS_RUNTIME_PROVENANCE);
    state = prepareQualificationV2AuthorAction({ state, publicTask: publicTasks[0], authReceipt: authReceipt("2026-08-31T20:00:02.000Z"), preparedAt: "2026-08-31T20:00:02.000Z" });
    state = dispatch(state, "2026-08-31T20:00:03.000Z");
    state = ingestQualificationV2ExternalTaskReceipt(state, taskReceipt(state, { terminalStatus: "usage_limit_interrupted" }), "2026-08-31T20:00:04.000Z");
    expect(state).toMatchObject({ stopped: true, stopReason: "usage_limit_interrupted", currentTaskIndex: 0 });
    expect(state.tasks[0].usageLimitInterruptions).toHaveLength(1);
    expect(() => resumeQualificationV2AfterUsageLimit(
      state,
      "2026-08-31T20:00:05.000Z",
      authReceipt("2026-08-31T20:00:05.000Z"),
    )).toThrow("USAGE_LIMIT_ASSIGNMENT_ALREADY_BEGUN");
    expect(() => retainQualificationV2Room(state, roomReceipt(1), digest("c"), digest("d"), "2026-08-31T20:00:05.000Z", HARNESS_RUNTIME_PROVENANCE)).toThrow();
    expect(() => qualificationV2CoordinatorStateSchema.parse({ ...state, stopped: false })).toThrow();
  });

  it("resumes the same genuinely unstarted author after a pre-creation usage-limit refusal", () => {
    let state = initialize();
    state = retainQualificationV2Room(state, roomReceipt(0), digest("c"), digest("d"), "2026-08-31T20:00:01.000Z", HARNESS_RUNTIME_PROVENANCE);
    state = prepareQualificationV2AuthorAction({ state, publicTask: publicTasks[0], authReceipt: authReceipt("2026-08-31T20:00:02.000Z"), preparedAt: "2026-08-31T20:00:02.000Z" });
    const firstActionDigest = state.pendingAction!.actionDigest;
    state = dispatch(state, "2026-08-31T20:00:03.000Z");
    state = ingestQualificationV2ExternalTaskReceipt(state, taskReceipt(state, {
      terminalStatus: "usage_limit_interrupted",
      createdTask: false,
    }), "2026-08-31T20:00:04.000Z");
    expect(state.tasks[0]).toMatchObject({
      taskId: "dev-architecture-create-checkout",
      phase: "ready_for_author",
      authorReceipt: null,
      usageLimitInterruptions: [{ createdTaskId: null, hostId: null }],
    });
    expect(state).toMatchObject({ stopped: true, stopReason: "usage_limit_interrupted", currentTaskIndex: 0 });
    expect(() => resumeQualificationV2AfterUsageLimit(
      state,
      "2026-08-31T20:06:00.000Z",
      authReceipt("2026-08-31T20:00:04.000Z"),
    )).toThrow("FRESH_CHATGPT_AUTH_REQUIRED");
    state = resumeQualificationV2AfterUsageLimit(
      state,
      "2026-08-31T20:00:05.000Z",
      authReceipt("2026-08-31T20:00:05.000Z"),
    );
    expect(state).toMatchObject({ stopped: false, stopReason: "none", currentTaskIndex: 0 });
    state = prepareQualificationV2AuthorAction({
      state,
      publicTask: publicTasks[0],
      authReceipt: authReceipt("2026-08-31T20:00:06.000Z"),
      preparedAt: "2026-08-31T20:00:06.000Z",
    });
    expect(state.pendingAction).toMatchObject({ taskId: "dev-architecture-create-checkout", role: "author", roleOrdinal: 1 });
    expect(state.pendingAction!.actionDigest).not.toBe(firstActionDigest);
    expect(state.releasedActionDigests).toEqual([firstActionDigest]);
  });

  it("releases the exact mutation and visual proof protocols required by the evidence parser", () => {
    let state = initialize();
    state = retainQualificationV2Room(state, roomReceipt(0), digest("c"), digest("d"), "2026-08-31T20:00:01.000Z", HARNESS_RUNTIME_PROVENANCE);
    state = prepareQualificationV2AuthorAction({
      state,
      publicTask: publicTasks[0],
      authReceipt: authReceipt("2026-08-31T20:00:02.000Z"),
      preparedAt: "2026-08-31T20:00:02.000Z",
    });
    const prompt = state.pendingAction!.arguments.prompt;
    expect(prompt).toContain("exp-0001a-qualification-author-mutation-result/v2");
    expect(prompt).toContain("var qualificationMutationResult = await tools.call('TOOL_NAME', INPUT)");
    expect(prompt).toContain("exp-0001a-qualification-author-visual-marker/v2");
    expect(prompt).toContain("const visualInspection = await tools.call('inspect_canvas_scope', {scope:{kind:'objects',targets:visualRoomState.data.objects.map((object)=>({objectId:object.id,expectedRevision:object.revision})).sort((left,right)=>left.objectId.localeCompare(right.objectId))},representation:'overview'})");
    expect(prompt).toContain("Do not add, remove, reorder, or replace statements");
    expect(prompt).toContain("pageUrl:visualPageUrl,roomState:visualRoomState,inspection:visualInspection");
    const visualCode = prompt.split("copying this exact code: ")[1]!.split("; Do not add, remove")[0]!;
    expect(analyzeQualificationV2NodeReplProgram(visualCode)).toMatchObject({
      visualProofBound: true,
      toolCalls: [
        { toolName: "read_room_state", resultBinding: "visualRoomState" },
        { toolName: "inspect_canvas_scope", resultBinding: "visualInspection" },
      ],
    });
  });

  it("acknowledges capture before launch and makes success, failure, or indeterminate first-terminal only", () => {
    let state = initialize();
    state = retainQualificationV2Room(state, roomReceipt(0), digest("c"), digest("d"), "2026-08-31T20:00:01.000Z", HARNESS_RUNTIME_PROVENANCE);
    state = prepareQualificationV2AuthorAction({ state, publicTask: publicTasks[0], authReceipt: authReceipt("2026-08-31T20:00:02.000Z"), preparedAt: "2026-08-31T20:00:02.000Z" });
    state = dispatch(state, "2026-08-31T20:00:03.000Z");
    state = ingestQualificationV2ExternalTaskReceipt(state, taskReceipt(state, {}), "2026-08-31T20:00:04.000Z");
    const prepared = prepareQualificationV2CaptureAction({
      state,
      preparedAt: "2026-08-31T20:00:05.000Z",
      request: {
        operation: "capture_author_evidence",
        roomReceiptPath: "/private/tmp/capture-room.json",
        provisionControllerReceiptPath: "/private/tmp/capture-provision.json",
        storageStatePath: "/private/tmp/capture-storage.json",
        outputDirectory: "/private/tmp/capture-output",
        at: "2026-08-31T20:00:05.000Z",
      },
    });
    expect(prepared.state.tasks[0].captureReleaseJournal).toBeNull();
    expect(() => retainQualificationV2CaptureTerminalReceipt(
      prepared.state,
      sealQualificationV2CaptureTerminalReceipt({
        schemaVersion: "exp-0001a-qualification-capture-terminal/v2",
        taskId: "dev-architecture-create-checkout",
        captureActionDigest: prepared.captureAuthorization.actionDigest,
        captureNonce: prepared.captureAuthorization.captureNonce,
        requestBindingDigest: prepared.captureAuthorization.requestBindingDigest,
        releaseJournalDigest: digest("0"),
        outcome: "failed",
        captureControllerReceiptDigest: null,
        failureCode: "QUALIFICATION_V2_CAPTURE_FAILED",
        retainedAt: "2026-08-31T20:00:06.000Z",
      }),
      "2026-08-31T20:00:06.000Z",
    )).toThrow(/TERMINAL_UNEXPECTED/);

    const acknowledged = acknowledgeQualificationV2CaptureDispatch(
      prepared.state,
      "2026-08-31T20:00:05.500Z",
    );
    expect(acknowledged.captureReleaseJournal).toMatchObject({ invocationOrdinal: 1, retryPermitted: false });
    expect(acknowledged.controllerRequest).toMatchObject({
      captureAuthorization: { actionDigest: prepared.captureAuthorization.actionDigest },
      captureReleaseJournal: { journalDigest: acknowledged.captureReleaseJournal.journalDigest },
    });
    expect(acknowledgeQualificationV2CaptureDispatch(
      acknowledged.state,
      "2026-08-31T20:00:05.500Z",
    ).materializedExistingAcknowledgement).toBe(true);
    expect(() => acknowledgeQualificationV2CaptureDispatch(
      acknowledged.state,
      "2026-08-31T20:00:05.600Z",
    )).toThrow(/ALREADY_ACKNOWLEDGED/);

    const indeterminate = recordQualificationV2CaptureIndeterminate(
      acknowledged.state,
      "2026-08-31T20:00:07.000Z",
    );
    expect(indeterminate).toMatchObject({ stopped: true, stopReason: "capture_indeterminate" });
    expect(indeterminate.tasks[0].captureTerminalReceipt).toMatchObject({
      outcome: "indeterminate",
      releaseJournalDigest: acknowledged.captureReleaseJournal.journalDigest,
    });
    expect(() => recordQualificationV2CaptureIndeterminate(
      indeterminate,
      "2026-08-31T20:00:08.000Z",
    )).toThrow();
    expect(() => retainQualificationV2CaptureTerminalReceipt(
      indeterminate,
      indeterminate.tasks[0].captureTerminalReceipt,
      "2026-08-31T20:00:08.000Z",
    )).toThrow();
  });

  it("production retain_room requires and independently binds the controller receipt and exact raw evidence", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "qualification-v2-retain-room-cli-"));
    const privateRoot = join(repositoryRoot, ".research-private", "exp0001a-qualification-v2");
    await mkdir(privateRoot, { recursive: true, mode: 0o700 });
    const statePath = join(privateRoot, "state.json");
    const evidence = blankProvisionEvidence();
    const paths = {
      room: join(privateRoot, "room-receipt.json"),
      provision: join(privateRoot, "provision-controller-receipt.json"),
      create: join(privateRoot, "create-result.json"),
      blank: join(privateRoot, "blank-result.json"),
      preAuthor: join(privateRoot, "preauthor-result.json"),
      storage: join(privateRoot, "storage.json"),
      request: join(privateRoot, "retain-request.json"),
    };
    const writePrivate = async (filePath: string, value: unknown) => {
      await writeFile(filePath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
      await chmod(filePath, 0o600);
    };
    const initial = initialize();
    await Promise.all([
      writePrivate(statePath, initial),
      writePrivate(paths.room, evidence.room),
      writePrivate(paths.create, evidence.createCallResult),
      writePrivate(paths.blank, evidence.blankCallResult),
      writePrivate(paths.preAuthor, evidence.preAuthorCallResult),
      writePrivate(paths.storage, evidence.storageState),
    ]);
    const request = {
      operation: "retain_room",
      statePath,
      at: "2026-08-31T20:00:01.000Z",
      receiptPath: paths.room,
      provisionControllerReceiptPath: paths.provision,
      createRoomCallResultPath: paths.create,
      blankReadRoomStateCallResultPath: paths.blank,
      preAuthorReadRoomStateCallResultPath: paths.preAuthor,
      authorizedStorageStatePath: paths.storage,
    };
    await writePrivate(paths.request, request);
    const forgedContent = {
      ...evidence.provision,
      preAuthorReadCallResultDigest: digest("0"),
    };
    delete (forgedContent as { receiptDigest?: string }).receiptDigest;
    await writePrivate(paths.provision, {
      ...forgedContent,
      receiptDigest: hashCanonicalJson(forgedContent as unknown as JsonValue),
    });
    const firstError: string[] = [];
    expect(await runQualificationV2CoordinatorCli(
      ["--request", paths.request],
      { stdout: { write: () => true }, stderr: { write: (value: string | Uint8Array) => { firstError.push(String(value)); return true; } } },
      repositoryRoot,
    )).toBe(1);
    expect(firstError.join("")).toContain("QUALIFICATION_V2_COORDINATOR_OPERATION_FAILED");
    expect(firstError.join("")).not.toContain("PROVISION_CONTROLLER_RECEIPT_BINDING_INVALID");
    const incidentName = (await readdir(privateRoot)).find((name) => name.startsWith("state.json.incident-"));
    expect(incidentName).toBeDefined();
    expect(JSON.parse(await readFile(join(privateRoot, incidentName!), "utf8")))
      .toMatchObject({ errorMessage: expect.stringContaining("PROVISION_CONTROLLER_RECEIPT_BINDING_INVALID") });
    expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual(initial);

    await writePrivate(paths.provision, evidence.provision);
    const stdout: string[] = [];
    expect(await runQualificationV2CoordinatorCli(
      ["--request", paths.request],
      { stdout: { write: (value: string | Uint8Array) => { stdout.push(String(value)); return true; } }, stderr: { write: () => true } },
      repositoryRoot,
    )).toBe(0);
    const retained = qualificationV2CoordinatorStateSchema.parse(JSON.parse(await readFile(statePath, "utf8")));
    expect(retained.tasks[0]).toMatchObject({
      phase: "ready_for_author",
      roomProvisionControllerReceiptDigest: evidence.provision.receiptDigest,
      roomAuthorizedStorageStateDigest: evidence.provision.storageStateDigest,
    });
    expect(stdout.join("")).not.toContain("ABC234");
    expect(stdout.join("")).not.toContain("room-private-0");
  });

  it("production CLI has no caller-supplied auth path and refuses non-ChatGPT direct preflight", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "qualification-v2-cli-"));
    const privateRoot = join(repositoryRoot, ".research-private", "exp0001a-qualification-v2");
    await mkdir(privateRoot, { recursive: true, mode: 0o700 });
    const statePath = join(privateRoot, "state.json");
    const requestPath = join(privateRoot, "request.json");
    const benchmarkPath = join(privateRoot, "benchmark.json");
    const rubricsPath = join(privateRoot, "rubrics.json");
    const fixtureSpecsPath = join(privateRoot, "fixture-specs.json");
    const state = retainQualificationV2Room(initialize(), roomReceipt(0), digest("c"), digest("d"), "2026-08-31T20:00:01.000Z", HARNESS_RUNTIME_PROVENANCE);
    await writeFile(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    await chmod(statePath, 0o600);
    await writeFile(benchmarkPath, `${JSON.stringify(benchmark)}\n`, { mode: 0o600 });
    await chmod(benchmarkPath, 0o600);
    await writeFile(rubricsPath, `${JSON.stringify(rubricBundle)}\n`, { mode: 0o600 });
    await writeFile(fixtureSpecsPath, `${JSON.stringify(fixtureSpecs)}\n`, { mode: 0o600 });
    await chmod(rubricsPath, 0o600);
    await chmod(fixtureSpecsPath, 0o600);
    const baseRequest = {
      operation: "prepare_author",
      statePath,
      at: "2026-08-31T20:00:02.000Z",
      benchmarkPath,
      rubricsPath,
      fixtureSpecsPath,
    };
    await writeFile(requestPath, `${JSON.stringify(baseRequest)}\n`, { mode: 0o600 });
    await chmod(requestPath, 0o600);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const apiReceipt = authReceipt("2026-08-31T20:00:02.000Z");
    const forgedApiReceipt = {
      ...apiReceipt,
      authentication: { ...apiReceipt.authentication, method: "api_key" },
    };
    expect(await runQualificationV2CoordinatorCli(
      ["--request", requestPath],
      { stdout: { write: (value: string | Uint8Array) => { stdout.push(String(value)); return true; } }, stderr: { write: (value: string | Uint8Array) => { stderr.push(String(value)); return true; } } },
      repositoryRoot,
      { runAuthPreflightForTesting: async () => forgedApiReceipt },
    )).toBe(1);
    expect(stderr.join("")).toContain("QUALIFICATION_V2_COORDINATOR_OPERATION_FAILED");
    expect(stderr.join("")).not.toContain("api_key");
    expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual(state);

    await writeFile(requestPath, `${JSON.stringify({
      ...baseRequest,
      authReceiptPath: join(privateRoot, "forged-auth.json"),
    })}\n`, { mode: 0o600 });
    await chmod(requestPath, 0o600);
    let preflightInvoked = false;
    expect(await runQualificationV2CoordinatorCli(
      ["--request", requestPath],
      { stdout: { write: () => true }, stderr: { write: () => true } },
      repositoryRoot,
      { runAuthPreflightForTesting: async () => { preflightInvoked = true; return authReceipt("2026-08-31T20:00:02.000Z"); } },
    )).toBe(1);
    expect(preflightInvoked).toBe(false);

    await writeFile(requestPath, `${JSON.stringify(baseRequest)}\n`, { mode: 0o600 });
    await chmod(requestPath, 0o600);
    const internallyObservedPreparedAt = "2026-08-31T20:00:03.100Z";
    expect(await runQualificationV2CoordinatorCli(
      ["--request", requestPath],
      { stdout: { write: () => true }, stderr: { write: () => true } },
      repositoryRoot,
      {
        runAuthPreflightForTesting: async () => authReceipt("2026-08-31T20:00:03.000Z"),
        nowForTesting: () => internallyObservedPreparedAt,
      },
    )).toBe(0);
    const prepared = qualificationV2CoordinatorStateSchema.parse(JSON.parse(await readFile(statePath, "utf8")));
    expect(prepared.pendingAction?.preparedAt).toBe(internallyObservedPreparedAt);
    expect(prepared.updatedAt).toBe(internallyObservedPreparedAt);
  });
});
