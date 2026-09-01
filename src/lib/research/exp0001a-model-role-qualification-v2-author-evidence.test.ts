// @vitest-environment node

import { readFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("./exp0001a-model-role-qualification-v2-authority", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./exp0001a-model-role-qualification-v2-authority")>();
  return { ...actual, verifyExp0001aQualificationV2AuthoritySignature: vi.fn(({ signature }) => signature) };
});

import { deriveQualificationV2AuthorEvidence } from "./exp0001a-model-role-qualification-v2-author-evidence";
import {
  acknowledgeQualificationV2CaptureDispatch,
  compileQualificationV2PublicTasksFromExecutionBundle,
  ingestQualificationV2ExternalTaskReceipt,
  initializeQualificationV2Coordinator,
  prepareQualificationV2AuthorAction,
  prepareQualificationV2CaptureAction,
  recordQualificationV2RunnerDispatch,
  retainQualificationV2AuthorEvidence,
  retainQualificationV2CaptureTerminalReceipt,
  retainQualificationV2Room,
  sealQualificationV2ExternalTaskReceipt,
  sealQualificationV2ProductionBinding,
  sealQualificationV2RoomReceipt,
} from "./exp0001a-model-role-qualification-v2-coordinator";
import { sealQualificationV2CaptureTerminalReceipt } from "./exp0001a-model-role-qualification-v2-room-controller-receipts";
import { serveQualificationV2ReviewerEvidence } from "./exp0001a-model-role-qualification-v2-review-sidecar-runner";
import { hashCanonicalJson, sha256Digest, type JsonValue } from "./provenance-crypto";

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const plan = JSON.parse(readFileSync("research/data/exp0001a-model-role-qualification-plan-v2.json", "utf8"));
const signature = JSON.parse(readFileSync("research/data/exp0001a-model-role-qualification-plan-signature-v2.json", "utf8"));
const benchmark = JSON.parse(readFileSync("research/benchmarks/development-v2.json", "utf8"));
const rubrics = JSON.parse(readFileSync("research/benchmarks/development-evaluator-rubrics-v2.json", "utf8"));
const fixtureSpecs = JSON.parse(readFileSync("research/benchmarks/development-fixture-specs-v2.json", "utf8"));
const bundle = compileQualificationV2PublicTasksFromExecutionBundle(benchmark, rubrics, fixtureSpecs);
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const HARNESS_RUNTIME_PROVENANCE = {
  controllerBundleDigest: digest("1"),
  wrapperSourceDigest: digest("2"),
  dependencyLockfileDigest: digest("3"),
  gitCommit: "a".repeat(40),
  gitTree: "b".repeat(40),
  worktreeClean: true as const,
};
const CONTROLLER = {
  participantId: "participant_controller",
  displayName: "Qualification Controller",
  color: "blue",
  role: "participant",
  joinedAt: 1,
  lastSeenAt: 1,
  connected: true,
  agentActive: false,
};
const AUTHOR = {
  participantId: "participant_author_exact",
  displayName: "EXP-0001A Qualification Author",
  color: "green",
  role: "participant",
  joinedAt: 2,
  lastSeenAt: 2,
  connected: true,
  agentActive: true,
};
const AUTHOR_ACTOR = {
  participantId: AUTHOR.participantId,
  displayName: AUTHOR.displayName,
  color: AUTHOR.color,
  kind: "agent",
};

function fnv1aDigest(value: unknown) {
  const input = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function authReceipt() {
  const content = {
    schemaVersion: "codex-chatgpt-auth-preflight/v1",
    checkedAt: "2026-08-31T22:01:00.000Z",
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

function awaitingAuthorEvidenceState(rawTrace = trace()) {
  const production = sealQualificationV2ProductionBinding({
    schemaVersion: "exp-0001a-qualification-production-binding/v2",
    planDigest: plan.planDigest,
    planDeclaredSuccessorCommit: "88919b8e0070fbd1b2be4f3e4121cfdcf50638a6",
    predecessorPlanBytesMutated: false,
    supersessionReason: "production_export_route_hotfix_and_successor_baseline_freeze",
    baselineReceiptSchema: "baseline-freeze/v2",
    baselineFreezeDigest: digest("3"),
    baselineAuthoritySignatureDigest: digest("4"),
    productionCommit: "66a546aaef9e006891a4cf619ed310fd9fc1c4cc",
    productionTree: "071a751beadbcefc002f42d1be75a0e717bc3e4b",
    deploymentId: "dpl_46pyqWtLXGfzeU1JsqXEWQjTBfd8",
    buildId: "bld_3t0eopcj7",
    productionAlias: "https://www.jazzboard.xyz",
    verifiedAt: "2026-08-31T22:00:00.000Z",
    aliasAndContractDriftObserved: false,
    semanticExportPreflightPassed: true,
    exactRevisionPngPreflightPassed: true,
    browserWebMcpContractPassed: true,
  });
  const fakeBindingSignature = {
    ...signature,
    purpose: "qualification_launch_binding",
    signedAt: "2026-08-31T22:00:01.000Z",
    payloadDigest: digest("5"),
  };
  let state = initializeQualificationV2Coordinator({
    createdAt: "2026-08-31T22:00:02.000Z",
    plan,
    planAuthoritySignature: signature,
    productionBinding: production,
    productionBindingAuthoritySignature: fakeBindingSignature,
    publicTasks: bundle.publicTasks,
    benchmark,
    rubrics,
    fixtureSpecs,
    baselineParticipantToolContractDigest: digest("b"),
  });
  const privateRoomInviteUrl = "https://www.jazzboard.xyz/#join=ABC234";
  state = retainQualificationV2Room(state, sealQualificationV2RoomReceipt({
    schemaVersion: "exp-0001a-qualification-room-receipt/v2",
    taskId: "dev-architecture-create-checkout",
    preparedAt: "2026-08-31T22:00:03.000Z",
    roomId: "room_private_exact",
    privateRoomInviteUrl,
    inviteAuthorizationBindingDigest: hashCanonicalJson({ roomId: "room_private_exact", privateRoomInviteUrl }),
    authorization: "exact_private_invite_only",
    globalDirectoryUsed: false,
    roomCreationReceiptDigest: digest("6"),
    initialStateKind: "blank",
    initialRoomRevision: 0,
    initialObjectCount: 0,
    fixturePreflightDigest: null,
  }), digest("c"), digest("d"), "2026-08-31T22:00:04.000Z", HARNESS_RUNTIME_PROVENANCE);
  state = prepareQualificationV2AuthorAction({
    state,
    publicTask: bundle.publicTasks[0],
    authReceipt: authReceipt(),
    preparedAt: "2026-08-31T22:01:01.000Z",
  });
  state = recordQualificationV2RunnerDispatch(state, "2026-08-31T22:01:02.000Z", digest("7"));
  const action = state.pendingAction!;
  const dispatch = state.pendingDispatchReceipt!;
  const observations = retainedTraceObservations(action.actionDigest, rawTrace);
  const content = {
    schemaVersion: "exp-0001a-qualification-external-task-receipt/v2",
    actionDigest: action.actionDigest,
    dispatchReceiptDigest: dispatch.receiptDigest,
    taskId: action.taskId,
    role: "author",
    roleOrdinal: 1,
    requestedModel: "gpt-5.6-terra",
    requestedReasoningEffort: "medium",
    workspace: "projectless",
    repositoryAccess: false,
    privateApiAccess: false,
    sourceTaskId: null,
    forkedFromTaskId: null,
    createdTaskId: "task_author_exact",
    hostId: "local",
    clientTaskId: null,
    rawCreateToolResultDigest: digest("8"),
    listThreadsObservationDigest: digest("7"),
    rawTerminalToolResultDigest: observations.rawTerminalToolResultDigest,
    terminalStatus: "completed",
    terminalResultDigest: digest("a"),
    reviewDecision: null,
    wallTimeMs: 1_000,
    subscriptionUsage: "unobservable",
    resolvedModelSnapshot: "unobservable",
    exactTokens: "unobservable",
    retainedAt: "2026-08-31T22:02:00.000Z",
  };
  return ingestQualificationV2ExternalTaskReceipt(state, sealQualificationV2ExternalTaskReceipt(content), "2026-08-31T22:02:01.000Z");
}

function callResult(result: unknown, png = false) {
  return {
    isError: false,
    content: [
      { type: "text", text: JSON.stringify(result) },
      ...(png ? [{ type: "image", mimeType: "image/png", data: PNG_BYTES.toString("base64") }] : []),
    ],
  };
}

function closingRoom(roomRevision = 2, hasObjects = true) {
  return callResult({
    ok: true,
    tool: "read_room_state",
    data: {
      room: {
        id: "room_private_exact", code: "ABC234", roomRevision,
        selfParticipantId: CONTROLLER.participantId,
      },
      objects: hasObjects ? [{
        id: "shape_1", kind: "shape", semanticName: "Checkout", semanticRole: "service",
        x: 10, y: 20, width: 200, height: 100, rotation: 0, zIndex: 1, revision: 1,
        groupId: null, diagramIds: [], shape: "rectangle", nodeType: "service", nodeMetadata: null,
        label: "Checkout", fill: "blue", stroke: "blue",
        createdBy: AUTHOR_ACTOR,
        lastEditedBy: AUTHOR_ACTOR,
      }] : [],
      diagrams: [],
      participants: [CONTROLLER, AUTHOR],
    },
  });
}

function preAuthorRoom(objects: unknown[] = [], diagrams: unknown[] = [], roomRevision = 0) {
  return callResult({
    ok: true,
    tool: "read_room_state",
    data: {
      room: {
        id: "room_private_exact", code: "ABC234", roomRevision,
        selfParticipantId: CONTROLLER.participantId,
      },
      objects,
      diagrams,
      participants: [CONTROLLER],
    },
  });
}

function inspectionPayload(roomRevision: number, objectIds: readonly string[]) {
  const explicitObjectRevisions = objectIds
    .map((objectId) => ({ objectId, revision: 1 }))
    .sort((left, right) => left.objectId.localeCompare(right.objectId));
  return {
    ok: true,
    tool: "inspect_canvas_scope",
    data: {
      presentation: "live_canvas",
      visualInspectionStatus: "not_performed",
      sceneContext: {
        schemaVersion: 2,
        scope: {
          identity: "objects:qualification-v2",
          kind: "objects",
          diagramId: null,
          focusObjectIds: [],
          identityBasis: "created_at_incarnations",
        },
        revisions: {
          roomRevision,
          diagramRevision: null,
          explicitObjectRevisions,
          explicitObjectRevisionCoverage: {
            totalCount: explicitObjectRevisions.length,
            returnedCount: explicitObjectRevisions.length,
            omittedCount: 0,
            limit: 1_000,
            truncated: false,
            fullSetDigest: fnv1aDigest(explicitObjectRevisions),
          },
        },
        coverage: {
          scopeObjectCount: explicitObjectRevisions.length,
          visualContributorCount: explicitObjectRevisions.length,
          compactRecordCount: explicitObjectRevisions.length,
          focusedRecordCount: 0,
          omittedCompactRecordCount: 0,
          allExplicitTargetsRepresented: true,
          resultByteLength: 1,
          resultByteLimit: 96_000,
          findings: "complete",
          geometry: "complete",
          unsupported: [],
          omittedUnsupportedCount: 0,
        },
        pixels: {
          delivery: "host_capture_required",
          nativeImageResultSupported: false,
          clip: { coordinateSpace: "viewport-css-pixels", x: 0, y: 0, width: 1, height: 1 },
          validationSelector: "[data-canvas-inspection-token=\"qualification-v2\"]",
          expiresAt: 1,
          visualInspectionStatus: "not_performed",
        },
      },
    },
  };
}

function trace(
  truncated = false,
  includeMutation = true,
  includePixelInspection = true,
  mutationChangedObjectIds: string[] = ["shape_1"],
  visualRoomResult: unknown = JSON.parse(String(closingRoom(2, true).content[0]!.text)),
) {
  const calls = [
    "const join = await tools.call('join_room', {code:'ABC234',displayName:'EXP-0001A Qualification Author',role:'participant'});",
    "const collaboration = await tools.call('read_collaboration_state', {});",
    "const room = await tools.call('read_room_state', {});",
  ];
  return callResult({
    thread: { id: "task_author_exact", hostId: "local" },
    page: { hasMore: false, nextCursor: null },
    turns: [{ id: "turn-author-exact", items: [
      ...calls.map((code, index) => ({
        type: "mcpToolCall", server: "node_repl", tool: "js", status: "completed", arguments: { code },
        ...(truncated && index === 1 ? { output: { text: "{}", originalChars: 50, truncated: true } } : {}),
      })),
      ...(includeMutation ? [{
        type: "mcpToolCall",
        server: "node_repl",
        tool: "js",
        status: "completed",
        arguments: {
          code: "var qualificationMutationResult = await tools.call('apply_canvas_transaction', {operations:[{op:'create_shape',tempRef:'node',label:'Checkout'}]}); nodeRepl.write(JSON.stringify({schemaVersion:'exp-0001a-qualification-author-mutation-result/v2',toolResult:qualificationMutationResult}));",
        },
        output: {
          text: JSON.stringify({
            schemaVersion: "exp-0001a-qualification-author-mutation-result/v2",
            toolResult: {
              ok: true,
              tool: "apply_canvas_transaction",
              data: {
                outcome: "applied",
                roomRevision: 2,
                changedObjectIds: mutationChangedObjectIds,
                changedDiagramIds: [],
              },
            },
          }),
          truncated: false,
        },
      }] : []),
      {
        type: "mcpToolCall",
        server: "node_repl",
        tool: "js",
        status: "completed",
        arguments: { code: "nodeRepl.write(JSON.stringify({schemaVersion:'exp-0001a-qualification-author-session-marker/v2',join,collaboration}));" },
        output: {
          text: JSON.stringify({
            schemaVersion: "exp-0001a-qualification-author-session-marker/v2",
            join: {
              ok: true,
              tool: "join_room",
              data: { room: { id: "room_private_exact", code: "ABC234" }, role: "participant" },
            },
            collaboration: {
              ok: true,
              tool: "read_collaboration_state",
              data: {
                room: { id: "room_private_exact", code: "ABC234", roomRevision: 1 },
                session: { participantId: AUTHOR.participantId, role: "participant", agentActive: true },
                participants: [CONTROLLER, AUTHOR],
              },
            },
          }),
          truncated: false,
        },
      },
      ...(includePixelInspection ? [{
        type: "mcpToolCall",
        server: "node_repl",
        tool: "js",
        status: "completed",
        arguments: {
          code: "const visualRoomState = await tools.call('read_room_state', {}); const visualInspection = await tools.call('inspect_canvas_scope', {scope:{kind:'objects',targets:[{objectId:'shape_1',expectedRevision:1}]}}); const visualPageUrl = await tab.url(); const visualPixels = await tab.screenshot({fullPage:false}); nodeRepl.write(JSON.stringify({schemaVersion:'exp-0001a-qualification-author-visual-marker/v2',pageUrl:visualPageUrl,roomState:visualRoomState,inspection:visualInspection})); await nodeRepl.emitImage(visualPixels);",
        },
        output: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                schemaVersion: "exp-0001a-qualification-author-visual-marker/v2",
                pageUrl: "https://www.jazzboard.xyz/room/room_private_exact",
                roomState: visualRoomResult,
                inspection: inspectionPayload(2, mutationChangedObjectIds),
              }),
            },
            { type: "image", mimeType: "image/png", data: PNG_BYTES.toString("base64") },
          ],
          truncated: false,
        },
      }] : []),
    ] }],
  });
}

function modifyTrace(
  rawTrace: ReturnType<typeof trace>,
  modify: (payload: { turns: Array<{ items: Array<Record<string, unknown>> }>; thread: Record<string, unknown> }) => void,
) {
  const payload = JSON.parse(String(rawTrace.content[0]!.text)) as {
    turns: Array<{ items: Array<Record<string, unknown>> }>;
    thread: Record<string, unknown>;
  };
  modify(payload);
  return callResult(payload);
}

function retainedObservation(
  actionDigest: string,
  toolName: "mcp__codex_app__read_thread" | "mcp__codex_app__wait_threads",
  rawResult: unknown,
) {
  const raw = JSON.parse(JSON.stringify(rawResult)) as JsonValue;
  const content = {
    schemaVersion: "exp-0001a-qualification-raw-tool-observation/v2",
    actionDigest,
    toolName,
    invocationOrdinal: 1,
    argumentsDigest: digest("c"),
    invokedAt: "2026-08-31T22:02:30.000Z",
    observedAt: "2026-08-31T22:02:31.000Z",
    outcome: "returned",
    rawResult: raw,
    rawResultDigest: hashCanonicalJson(raw),
    thrownError: null,
  };
  return { ...content, observationDigest: hashCanonicalJson(content as unknown as JsonValue) };
}

function retainedTraceObservations(actionDigest: string, rawTrace = trace()) {
  const wait = retainedObservation(actionDigest, "mcp__codex_app__wait_threads", callResult({
    timedOut: false,
    polls: [{ cursor: "terminal", latestTurn: { status: "completed" } }],
  }));
  const read = retainedObservation(actionDigest, "mcp__codex_app__read_thread", rawTrace);
  return {
    waitThreadCallResults: [wait],
    readThreadCallResults: [read],
    rawTerminalToolResultDigest: hashCanonicalJson({
      waits: [wait.observationDigest],
      reads: [read.observationDigest],
      evidenceReadReceiptDigest: null,
    }),
  };
}

function evidenceInput(
  state: ReturnType<typeof awaitingAuthorEvidenceState>,
  roomRevision = 2,
  hasObjects = true,
  rawTrace = trace(),
) {
  return {
    state,
    ...retainedTraceObservations(state.tasks[0].authorReceipt!.actionDigest, rawTrace),
    preAuthorRoomReadCallResult: preAuthorRoom(),
    closingRoomReadCallResult: closingRoom(roomRevision, hasObjects),
    inspectionCallResult: callResult(inspectionPayload(roomRevision, hasObjects ? ["shape_1"] : [])),
    pngExportCallResult: callResult({
      ok: true,
      tool: "export_canvas_png",
      data: {
        sourceRevisions: { roomRevision }, persistedByJazzboard: false, mimeType: "image/png", byteLength: PNG_BYTES.length,
      },
    }, true),
    retainedAt: "2026-08-31T22:03:00.000Z",
  };
}

function withSuccessfulCapture(state: ReturnType<typeof awaitingAuthorEvidenceState>) {
  const prepared = prepareQualificationV2CaptureAction({
    state,
    preparedAt: "2026-08-31T22:02:10.000Z",
    request: {
      operation: "capture_author_evidence",
      roomReceiptPath: "/private/tmp/qualification-room.json",
      provisionControllerReceiptPath: "/private/tmp/qualification-provision.json",
      storageStatePath: "/private/tmp/qualification-storage.json",
      outputDirectory: "/private/tmp/qualification-capture",
      at: "2026-08-31T22:02:10.000Z",
    },
  });
  const acknowledged = acknowledgeQualificationV2CaptureDispatch(
    prepared.state,
    "2026-08-31T22:02:11.000Z",
  );
  return retainQualificationV2CaptureTerminalReceipt(
    acknowledged.state,
    sealQualificationV2CaptureTerminalReceipt({
      schemaVersion: "exp-0001a-qualification-capture-terminal/v2",
      taskId: "dev-architecture-create-checkout",
      captureActionDigest: prepared.captureAuthorization.actionDigest,
      captureNonce: prepared.captureAuthorization.captureNonce,
      requestBindingDigest: prepared.captureAuthorization.requestBindingDigest,
      releaseJournalDigest: acknowledged.captureReleaseJournal.journalDigest,
      outcome: "succeeded",
      captureControllerReceiptDigest: digest("e"),
      failureCode: null,
      retainedAt: "2026-08-31T22:02:12.000Z",
    }),
    "2026-08-31T22:02:12.000Z",
  );
}

describe("EXP-0001A qualification-v2 independently derived author evidence", () => {
  it("confirms mutation from the authoritative revision delta and keeps per-WebMCP failures unobservable", () => {
    const state = awaitingAuthorEvidenceState();
    const input = evidenceInput(state);
    const derived = deriveQualificationV2AuthorEvidence(input);
    expect(derived.evidence).toMatchObject({
      webMcpFailureCount: "unobservable",
      successfulAuthoritativeMutationCount: 1,
      visualInspectionCount: 1,
      finalAuthoritativeRoomRevision: 2,
      revisionMatchedPngDigest: sha256Digest(PNG_BYTES),
    });
    expect(derived.sanitizedSemanticState.objects).toHaveLength(1);
    expect(derived.exactRevisionPngBytes).toEqual(PNG_BYTES);
  });

  it("rejects truncated retained outputs and a regex-only mutation without authoritative change", () => {
    const truncatedTrace = trace(true);
    const truncatedState = awaitingAuthorEvidenceState(truncatedTrace);
    expect(() => deriveQualificationV2AuthorEvidence(
      evidenceInput(truncatedState, 2, true, truncatedTrace),
    )).toThrow(/OUTPUT_TRUNCATED/);
    const state = awaitingAuthorEvidenceState();
    expect(() => deriveQualificationV2AuthorEvidence(evidenceInput(state, 1, false))).toThrow(/ATTRIBUTION_NO_MUTATION/);
    const noMutationTrace = trace(false, false);
    const noMutationState = awaitingAuthorEvidenceState(noMutationTrace);
    expect(() => deriveQualificationV2AuthorEvidence(
      evidenceInput(noMutationState, 2, true, noMutationTrace),
    )).toThrow(/MUTATION_PROOF_ATTRIBUTION_MISMATCH|ATTRIBUTION_NO_MUTATION|ACTIVITY_INSUFFICIENT/);
  });

  it("does not misrepresent scene-context metadata as a pixel inspection", () => {
    const noPixelsTrace = trace(false, true, false);
    const state = awaitingAuthorEvidenceState(noPixelsTrace);
    expect(() => deriveQualificationV2AuthorEvidence(
      evidenceInput(state, 2, true, noPixelsTrace),
    )).toThrow(/ACTIVITY_INSUFFICIENT/);
  });

  it("rejects inconsistent bounded coverage or a mismatched full-set digest", () => {
    const state = awaitingAuthorEvidenceState();
    const partial = evidenceInput(state);
    const partialResult = JSON.parse(String(partial.inspectionCallResult.content[0]!.text)) as {
      data: { sceneContext: { revisions: {
        explicitObjectRevisions: unknown[];
        explicitObjectRevisionCoverage: Record<string, unknown>;
      } } };
    };
    partialResult.data.sceneContext.revisions.explicitObjectRevisions = [];
    Object.assign(partialResult.data.sceneContext.revisions.explicitObjectRevisionCoverage, {
      returnedCount: 0,
      omittedCount: 1,
      truncated: true,
    });
    expect(() => deriveQualificationV2AuthorEvidence({
      ...partial,
      inspectionCallResult: callResult(partialResult),
    })).toThrow(/REVISION_BINDING_INVALID/);

    const wrongDigest = evidenceInput(state);
    const wrongDigestResult = JSON.parse(String(wrongDigest.inspectionCallResult.content[0]!.text)) as {
      data: { sceneContext: { revisions: { explicitObjectRevisionCoverage: { fullSetDigest: string } } } };
    };
    wrongDigestResult.data.sceneContext.revisions.explicitObjectRevisionCoverage.fullSetDigest = "fnv1a32:00000000";
    expect(() => deriveQualificationV2AuthorEvidence({
      ...wrongDigest,
      inspectionCallResult: callResult(wrongDigestResult),
    })).toThrow(/REVISION_BINDING_INVALID/);
  });

  it("accepts the truthful bounded revision prefix for artifacts above the scene-context record limit", () => {
    const objects = Array.from({ length: 65 }, (_, index) => ({
      id: `shape_${String(index + 1).padStart(3, "0")}`,
      kind: "shape",
      semanticName: `Node ${index + 1}`,
      semanticRole: "service",
      x: index * 10,
      y: 20,
      width: 100,
      height: 60,
      rotation: 0,
      zIndex: index,
      revision: 1,
      groupId: null,
      diagramIds: [],
      shape: "rectangle",
      nodeType: "service",
      nodeMetadata: null,
      label: `Node ${index + 1}`,
      fill: "blue",
      stroke: "blue",
      createdBy: AUTHOR_ACTOR,
      lastEditedBy: AUTHOR_ACTOR,
    }));
    const closingPayload = {
      ok: true,
      tool: "read_room_state",
      data: {
        room: {
          id: "room_private_exact", code: "ABC234", roomRevision: 2,
          selfParticipantId: CONTROLLER.participantId,
        },
        objects,
        diagrams: [],
        participants: [CONTROLLER, AUTHOR],
      },
    };
    const rawTrace = trace(false, true, true, objects.map((object) => object.id), closingPayload);
    const state = awaitingAuthorEvidenceState(rawTrace);
    const revisions = objects.map((object) => ({ objectId: object.id, revision: object.revision }));
    const input = evidenceInput(state, 2, true, rawTrace);
    const inspection = JSON.parse(String(input.inspectionCallResult.content[0]!.text)) as {
      data: { sceneContext: {
        revisions: {
          explicitObjectRevisions: unknown[];
          explicitObjectRevisionCoverage: Record<string, unknown>;
        };
        coverage: Record<string, unknown>;
      } };
    };
    inspection.data.sceneContext.revisions.explicitObjectRevisions = revisions.slice(0, 64);
    Object.assign(inspection.data.sceneContext.revisions.explicitObjectRevisionCoverage, {
      totalCount: 65,
      returnedCount: 64,
      omittedCount: 1,
      limit: 64,
      truncated: true,
      fullSetDigest: fnv1aDigest(revisions),
    });
    inspection.data.sceneContext.coverage.scopeObjectCount = 65;
    inspection.data.sceneContext.coverage.visualContributorCount = 65;
    const derived = deriveQualificationV2AuthorEvidence({
      ...input,
      closingRoomReadCallResult: callResult(closingPayload),
      inspectionCallResult: callResult(inspection),
    });
    expect(derived.sanitizedSemanticState.objects).toHaveLength(65);
    expect(derived.evidence.successfulAuthoritativeMutationCount).toBe(1);
  });

  it("binds retained tool observations to the released action and exact task/host identity", () => {
    const state = awaitingAuthorEvidenceState();
    const input = evidenceInput(state);
    const substituted = JSON.parse(JSON.stringify(input.readThreadCallResults[0])) as Record<string, unknown>;
    substituted.actionDigest = digest("f");
    const { observationDigest: _oldDigest, ...substitutedContent } = substituted;
    void _oldDigest;
    substituted.observationDigest = hashCanonicalJson(substitutedContent as unknown as JsonValue);
    expect(() => deriveQualificationV2AuthorEvidence({
      ...input,
      readThreadCallResults: [substituted],
    })).toThrow(/READ_THREAD_CHAIN_INVALID/);

    const wrongHostTrace = modifyTrace(trace(), (payload) => { payload.thread.hostId = "other-host"; });
    const wrongHostState = awaitingAuthorEvidenceState(wrongHostTrace);
    expect(() => deriveQualificationV2AuthorEvidence(
      evidenceInput(wrongHostState, 2, true, wrongHostTrace),
    )).toThrow(/READ_THREAD_IDENTITY_INVALID/);
  });

  it("accepts a cross-session visual read of the same canvas but rejects unrelated or pre-mutation screenshots", () => {
    const authorSessionVisualRoom = JSON.parse(String(closingRoom(2, true).content[0]!.text)) as {
      data: { room: { selfParticipantId: string }; participants: unknown[] };
    };
    authorSessionVisualRoom.data.room.selfParticipantId = AUTHOR.participantId;
    authorSessionVisualRoom.data.participants = [AUTHOR];
    const crossSessionTrace = trace(false, true, true, ["shape_1"], authorSessionVisualRoom);
    const crossSessionState = awaitingAuthorEvidenceState(crossSessionTrace);
    expect(deriveQualificationV2AuthorEvidence(
      evidenceInput(crossSessionState, 2, true, crossSessionTrace),
    ).evidence.visualInspectionCount).toBe(1);

    const unrelatedTrace = modifyTrace(trace(), (payload) => {
      const visual = payload.turns[0]!.items.find((item) => (
        typeof (item.arguments as { code?: unknown } | undefined)?.code === "string"
        && String((item.arguments as { code: string }).code).includes("author-visual-marker")
      ))!;
      const output = visual.output as { content: Array<{ type: string; text?: string }> };
      const marker = JSON.parse(String(output.content[0]!.text)) as { pageUrl: string };
      marker.pageUrl = "https://www.jazzboard.xyz/room/room_unrelated";
      output.content[0]!.text = JSON.stringify(marker);
    });
    const unrelatedState = awaitingAuthorEvidenceState(unrelatedTrace);
    expect(() => deriveQualificationV2AuthorEvidence(
      evidenceInput(unrelatedState, 2, true, unrelatedTrace),
    )).toThrow(/ACTIVITY_INSUFFICIENT/);

    const preMutationTrace = modifyTrace(trace(), (payload) => {
      const items = payload.turns[0]!.items;
      const visualIndex = items.findIndex((item) => (
        typeof (item.arguments as { code?: unknown } | undefined)?.code === "string"
        && String((item.arguments as { code: string }).code).includes("author-visual-marker")
      ));
      const [visual] = items.splice(visualIndex, 1);
      const mutationIndex = items.findIndex((item) => (
        typeof (item.arguments as { code?: unknown } | undefined)?.code === "string"
        && String((item.arguments as { code: string }).code).includes("author-mutation-result")
      ));
      items.splice(mutationIndex, 0, visual!);
    });
    const preMutationState = awaitingAuthorEvidenceState(preMutationTrace);
    expect(() => deriveQualificationV2AuthorEvidence(
      evidenceInput(preMutationState, 2, true, preMutationTrace),
    )).toThrow(/ACTIVITY_INSUFFICIENT/);
  });

  it("rejects a join plus source-mentioned but failed mutation result", () => {
    const failedMutationTrace = modifyTrace(trace(), (payload) => {
      const mutation = payload.turns[0]!.items.find((item) => (
        typeof (item.arguments as { code?: unknown } | undefined)?.code === "string"
        && String((item.arguments as { code: string }).code).includes("author-mutation-result")
      ))!;
      const output = mutation.output as { text: string };
      const marker = JSON.parse(output.text) as {
        toolResult: { ok: boolean; data: unknown; error?: unknown };
      };
      marker.toolResult.ok = false;
      marker.toolResult.data = undefined;
      marker.toolResult.error = { code: "REVISION_CONFLICT" };
      output.text = JSON.stringify(marker);
    });
    const state = awaitingAuthorEvidenceState(failedMutationTrace);
    expect(() => deriveQualificationV2AuthorEvidence(
      evidenceInput(state, 2, true, failedMutationTrace),
    )).toThrow(/MUTATION_RESULT_INVALID/);
  });

  it.each([
    ["comment/string-only mutation source", "const harmless = \"tools.call('apply_canvas_transaction', {}) author-mutation-result/v2\"; // tools.call('apply_canvas_transaction', {})"],
    ["a fabricated result variable", "var qualificationMutationResult = {ok:true}; nodeRepl.write(JSON.stringify({schemaVersion:'exp-0001a-qualification-author-mutation-result/v2',toolResult:qualificationMutationResult}));"],
    ["a marker bound to a different value", "var actualMutationResult = await tools.call('apply_canvas_transaction', {operations:[]}); var qualificationMutationResult = actualMutationResult; nodeRepl.write(JSON.stringify({schemaVersion:'exp-0001a-qualification-author-mutation-result/v2',toolResult:qualificationMutationResult}));"],
    ["a member-mutated exact result", "var qualificationMutationResult = await tools.call('apply_canvas_transaction', {operations:[]}); qualificationMutationResult.data.changedObjectIds = ['shape_1']; nodeRepl.write(JSON.stringify({schemaVersion:'exp-0001a-qualification-author-mutation-result/v2',toolResult:qualificationMutationResult}));"],
    ["an Object.assign-mutated exact result", "var qualificationMutationResult = await tools.call('apply_canvas_transaction', {operations:[]}); Object.assign(qualificationMutationResult, {ok:true}); nodeRepl.write(JSON.stringify({schemaVersion:'exp-0001a-qualification-author-mutation-result/v2',toolResult:qualificationMutationResult}));"],
  ])("rejects %s as positive mutation proof", (_label, replacementCode) => {
    const forgedTrace = modifyTrace(trace(), (payload) => {
      const mutation = payload.turns[0]!.items.find((item) => (
        typeof (item.arguments as { code?: unknown } | undefined)?.code === "string"
        && String((item.arguments as { code: string }).code).includes("qualificationMutationResult")
      ))!;
      (mutation.arguments as { code: string }).code = replacementCode;
    });
    const state = awaitingAuthorEvidenceState(forgedTrace);
    expect(() => deriveQualificationV2AuthorEvidence(
      evidenceInput(state, 2, true, forgedTrace),
    )).toThrow(/MUTATION_PROOF|ACTIVITY_INSUFFICIENT/);
  });

  it("rejects fabricated or mutation-preceding visual marker output and a mismatched inspection revision set", () => {
    const fabricatedTrace = modifyTrace(trace(), (payload) => {
      const visual = payload.turns[0]!.items.find((item) => (
        typeof (item.arguments as { code?: unknown } | undefined)?.code === "string"
        && String((item.arguments as { code: string }).code).includes("visualRoomState")
      ))!;
      (visual.arguments as { code: string }).code = "const note = 'visualRoomState inspect_canvas_scope emitImage author-visual-marker/v2';";
    });
    const fabricatedState = awaitingAuthorEvidenceState(fabricatedTrace);
    expect(() => deriveQualificationV2AuthorEvidence(
      evidenceInput(fabricatedState, 2, true, fabricatedTrace),
    )).toThrow(/ACTIVITY_INSUFFICIENT/);

    const mismatchTrace = modifyTrace(trace(), (payload) => {
      const visual = payload.turns[0]!.items.find((item) => (
        typeof (item.arguments as { code?: unknown } | undefined)?.code === "string"
        && String((item.arguments as { code: string }).code).includes("author-visual-marker")
      ))!;
      const output = visual.output as { content: Array<{ type: string; text?: string }> };
      const marker = JSON.parse(String(output.content[0]!.text)) as {
        inspection: { data: { sceneContext: { revisions: { explicitObjectRevisionCoverage: { fullSetDigest: string } } } } };
      };
      marker.inspection.data.sceneContext.revisions.explicitObjectRevisionCoverage.fullSetDigest = "fnv1a32:00000000";
      output.content[0]!.text = JSON.stringify(marker);
    });
    const mismatchState = awaitingAuthorEvidenceState(mismatchTrace);
    expect(() => deriveQualificationV2AuthorEvidence(
      evidenceInput(mismatchState, 2, true, mismatchTrace),
    )).toThrow(/ACTIVITY_INSUFFICIENT/);
  });

  it("rejects a session marker after either exact tool-result binding was overwritten", () => {
    const reboundTrace = modifyTrace(trace(), (payload) => {
      const markerItem = payload.turns[0]!.items.find((item) => (
        typeof (item.arguments as { code?: unknown } | undefined)?.code === "string"
        && String((item.arguments as { code: string }).code).includes("author-session-marker")
      ))!;
      (markerItem.arguments as { code: string }).code = `join = {ok:true}; ${(markerItem.arguments as { code: string }).code}`;
    });
    const state = awaitingAuthorEvidenceState(reboundTrace);
    expect(() => deriveQualificationV2AuthorEvidence(
      evidenceInput(state, 2, true, reboundTrace),
    )).toThrow(/SESSION_MARKER_PROTOCOL_INVALID/);
  });

  it("seals and serves one fresh blinded reviewer envelope from the independently retained evidence", async () => {
    const authorState = withSuccessfulCapture(awaitingAuthorEvidenceState());
    const derived = deriveQualificationV2AuthorEvidence(evidenceInput(authorState));
    const reviewState = retainQualificationV2AuthorEvidence(
      authorState,
      derived.evidence,
      "2026-08-31T22:03:01.000Z",
    );
    const root = await mkdtemp(path.join(tmpdir(), "qualification-v2-review-sidecar-"));
    const outputDirectory = path.join(root, "review-1");
    const serving = serveQualificationV2ReviewerEvidence({
      state: reviewState,
      sanitizedSemanticState: derived.sanitizedSemanticState,
      pngBytes: derived.exactRevisionPngBytes,
      outputDirectory,
      at: "2026-08-31T22:03:02.000Z",
      maxWaitMs: 5_000,
      now: () => "2026-08-31T22:03:03.000Z",
    });
    let envelope: { evidenceSidecar: { exactRevisionPngUrl: string } } | null = null;
    for (let attempt = 0; attempt < 100 && envelope === null; attempt += 1) {
      envelope = await readFile(path.join(outputDirectory, "review-envelope.json"), "utf8")
        .then((value) => JSON.parse(value) as { evidenceSidecar: { exactRevisionPngUrl: string } })
        .catch(() => null);
      if (envelope === null) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(envelope).not.toBeNull();
    const response = await fetch(envelope!.evidenceSidecar.exactRevisionPngUrl);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG_BYTES);
    const result = await serving;
    expect(result.envelope.sanitizedSemanticState).toEqual(derived.sanitizedSemanticState);
    expect(result.readReceipt.servedByteDigest).toBe(sha256Digest(PNG_BYTES));
    expect(JSON.parse(await readFile(path.join(outputDirectory, "completion-receipt.json"), "utf8")))
      .toEqual(result.completion);
  });
});
