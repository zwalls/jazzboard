// @vitest-environment node

import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, stat, symlink, writeFile } from "node:fs/promises";
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

import {
  acknowledgeQualificationV2CaptureDispatch,
  compileQualificationV2PublicTasksFromExecutionBundle,
  ingestQualificationV2ExternalTaskReceipt,
  initializeQualificationV2Coordinator,
  prepareQualificationV2AuthorAction,
  prepareQualificationV2CaptureAction,
  prepareQualificationV2ReviewAction,
  recordQualificationV2RunnerDispatch,
  retainQualificationV2AuthorEvidence,
  retainQualificationV2CaptureTerminalReceipt,
  retainQualificationV2Room,
  sealQualificationV2ExternalTaskReceipt,
} from "./exp0001a-model-role-qualification-v2-coordinator";
import { sealQualificationV2CaptureTerminalReceipt } from "./exp0001a-model-role-qualification-v2-room-controller-receipts";
import {
  qualificationV2RawToolObservationSchema,
  recoverQualificationV2PendingActionForTesting,
  runQualificationV2PendingActionForTesting,
  type QualificationV2CodexAppAdapter,
} from "./exp0001a-model-role-qualification-v2-task-runner";
import { canonicalJson, hashCanonicalJson, type JsonValue } from "./provenance-crypto";

const plan = JSON.parse(readFileSync("research/data/exp0001a-model-role-qualification-plan-v2.json", "utf8"));
const planSignature = JSON.parse(readFileSync(
  "research/data/exp0001a-model-role-qualification-plan-signature-v2.json",
  "utf8",
));
const benchmark = JSON.parse(readFileSync("research/benchmarks/development-v2.json", "utf8"));
const rubricBundle = JSON.parse(readFileSync("research/benchmarks/development-evaluator-rubrics-v2.json", "utf8"));
const fixtureSpecs = JSON.parse(readFileSync("research/benchmarks/development-fixture-specs-v2.json", "utf8"));
const productionBindingV2 = JSON.parse(readFileSync(
  "research/data/exp0001a-model-role-qualification-launch-binding-v2.json",
  "utf8",
));
const productionBindingSignatureV2 = JSON.parse(readFileSync(
  "research/data/exp0001a-model-role-qualification-launch-binding-signature-v2.json",
  "utf8",
));
const productionBindingV3 = JSON.parse(readFileSync(
  "research/data/exp0001a-model-role-qualification-launch-binding-v3.json",
  "utf8",
));
const productionBindingSignatureV3 = JSON.parse(readFileSync(
  "research/data/exp0001a-model-role-qualification-launch-binding-signature-v3.json",
  "utf8",
));
const executionBundle = compileQualificationV2PublicTasksFromExecutionBundle(benchmark, rubricBundle, fixtureSpecs);
const publicTasks = executionBundle.publicTasks;
const NOW = "2026-08-31T20:00:30.000Z";
const TASK_ID = "codex-task-qualification";
const HOST_ID = "local";
const OUTSIDE_CWD = "/private/tmp/exp0001a-isolated-author";
const BROWSER_CLIENT_PATH = "/Users/test/.codex/plugins/cache/openai-bundled/browser/26.825.51511/scripts/browser-client.mjs";
const AUTHOR_INVITE_URL = "https://www.jazzboard.xyz/#join=ABC234";
const REVIEWER_EVIDENCE_URL = "http://127.0.0.1:49152/evidence/0123456789abcdef0123456789abcdef.png";

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const HARNESS_RUNTIME_PROVENANCE = {
  controllerBundleDigest: digest("1"),
  wrapperSourceDigest: digest("2"),
  dependencyLockfileDigest: digest("3"),
  gitCommit: "a".repeat(40),
  gitTree: "b".repeat(40),
  worktreeClean: true as const,
};

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

function authReceipt(checkedAt = "2026-08-31T20:00:02.000Z") {
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
    baselineParticipantToolContractDigest: digest("b"),
  });
}

function initializeV3() {
  return initializeQualificationV2Coordinator({
    createdAt: "2026-08-31T20:00:00.000Z",
    plan,
    planAuthoritySignature: planSignature,
    productionBinding: productionBindingV3,
    productionBindingAuthoritySignature: productionBindingSignatureV3,
    predecessorProductionBinding: productionBindingV2,
    predecessorProductionBindingAuthoritySignature: productionBindingSignatureV2,
    publicTasks,
    benchmark,
    rubrics: rubricBundle,
    fixtureSpecs,
    baselineParticipantToolContractDigest: productionBindingV3.toolContractDigests.participant,
  });
}

function roomReceipt() {
  const privateRoomInviteUrl = "https://www.jazzboard.xyz/#join=ABC234";
  const content = {
    schemaVersion: "exp-0001a-qualification-room-receipt/v2",
    taskId: publicTasks[0]!.taskId,
    preparedAt: "2026-08-31T20:00:01.000Z",
    roomId: "room-private-qualification",
    privateRoomInviteUrl,
    inviteAuthorizationBindingDigest: hashCanonicalJson({ roomId: "room-private-qualification", privateRoomInviteUrl }),
    authorization: "exact_private_invite_only",
    globalDirectoryUsed: false,
    roomCreationReceiptDigest: digest("3"),
    initialStateKind: "blank",
    initialRoomRevision: 0,
    initialObjectCount: 0,
    fixturePreflightDigest: null,
  };
  return { ...content, receiptDigest: hashCanonicalJson(content as unknown as JsonValue) };
}

function preparedAuthorState() {
  const room = retainQualificationV2Room(initialize(), roomReceipt(), digest("c"), digest("d"), "2026-08-31T20:00:01.000Z", HARNESS_RUNTIME_PROVENANCE);
  return prepareQualificationV2AuthorAction({
    state: room,
    publicTask: publicTasks[0],
    authReceipt: authReceipt(),
    preparedAt: "2026-08-31T20:00:02.000Z",
  });
}

function preparedAuthorStateV3() {
  const room = retainQualificationV2Room(
    initializeV3(),
    roomReceipt(),
    digest("c"),
    digest("d"),
    "2026-08-31T20:00:01.000Z",
    HARNESS_RUNTIME_PROVENANCE,
  );
  return prepareQualificationV2AuthorAction({
    state: room,
    publicTask: publicTasks[0],
    authReceipt: authReceipt(),
    preparedAt: "2026-08-31T20:00:02.000Z",
  });
}

async function persistState(
  state: ReturnType<typeof preparedAuthorState>,
  privateRootVersion: "v2" | "v3" = "v2",
) {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "qualification-v2-runner-"));
  const privateRoot = join(repositoryRoot, ".research-private", `exp0001a-qualification-${privateRootVersion}`);
  await mkdir(privateRoot, { recursive: true, mode: 0o700 });
  const statePath = join(privateRoot, "state.json");
  await writeFile(statePath, `${canonicalJson(state)}\n`, { mode: 0o600 });
  await chmod(statePath, 0o600);
  return { repositoryRoot, privateRoot, statePath };
}

function appResult(payload: unknown, isError = false) {
  return { isError, content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function liveThreadTitle(requestedTitle: string) {
  const characters = Array.from(requestedTitle.trim().replace(/\s+/g, " "));
  return characters.length <= 60 ? characters.join("") : `${characters.slice(0, 59).join("")}…`;
}

function delegationTextNode(requestedPrompt: string) {
  return requestedPrompt.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function listResult(title: string, matches: Array<{ id: string; hostId: string }> = [{ id: TASK_ID, hostId: HOST_ID }]) {
  return appResult({
    pinnedThreads: [],
    threads: matches.map((match) => ({ kind: "codex", title: liveThreadTitle(title), ...match })),
  });
}

function waitCompletedResult() {
  return appResult({
    timedOut: false,
    polls: [{ cursor: "cursor-terminal", latestTurn: { status: "completed", error: null } }],
  });
}

function browserBootstrapCode(targetUrl: string, suffix = "") {
  const origin = new URL(targetUrl).origin;
  return [
    `const { setupBrowserRuntime } = await import('${BROWSER_CLIENT_PATH}')`,
    "const browserAgent = await setupBrowserRuntime()",
    `const browser = await browserAgent.browsers.getForUrl('${origin}')`,
    "nodeRepl.write(await browser.documentation())",
    "const tab = await browser.tabs.new()",
    `await tab.goto('${targetUrl}')`,
    suffix,
  ].filter(Boolean).join("; ");
}

function authorBootstrapCode(suffix = "") {
  return browserBootstrapCode(AUTHOR_INVITE_URL, [
    "const webmcp = await tab.capabilities.get('webmcp')",
    "const tools = await webmcp.fetchTools()",
    "const joined = await tools.call('join_room', {code: 'ABC234'})",
    suffix,
  ].filter(Boolean).join("; "));
}

function authorItems(finalText = "completed", overrideCode?: string, truncated = false) {
  return [
    {
      type: "mcpToolCall",
      id: "mcp-1",
      server: "node_repl",
      tool: "js",
      arguments: { code: overrideCode ?? authorBootstrapCode() },
      status: "completed",
      output: { text: "joined", originalChars: 6, truncated: false },
    },
    {
      type: "mcpToolCall",
      id: "mcp-2",
      server: "node_repl",
      tool: "js",
      arguments: { code: "const transaction = await tools.call('apply_canvas_transaction', {operations: []});" },
      status: "completed",
      result: { text: "mutation complete", originalChars: 17, truncated },
    },
    { type: "agentMessage", phase: "final_answer", text: finalText },
  ];
}

function readResult(
  title: string,
  items: unknown[] = authorItems(),
  delegatedPrompt = preparedAuthorState().pendingAction!.arguments.prompt,
) {
  const titleMatch = /^Q ([a-f0-9]{12}) (author|primary_reviewer|adjudicator) [12]$/.exec(title);
  if (titleMatch === null) throw new Error("test title does not encode projectless directory");
  const projectlessCwd = `/private/tmp/qual-${titleMatch[2]}-${titleMatch[1]}`;
  return appResult({
    thread: { id: TASK_ID, hostId: HOST_ID, title: liveThreadTitle(title), cwd: projectlessCwd },
    page: { order: "newest_first", limit: 10, hasMore: false, nextCursor: null },
    turns: [{ id: "turn-1", status: "completed", items: [
      {
        type: "functionCallOutput",
        id: "fco-create",
        name: "create_thread",
        namespace: "codex_app",
        output: {
          text: `<codex_delegation>\n  <source_thread_id>01a03ca8-9508-7581-bcdc-cb7e73c7adde</source_thread_id>\n  <input>${delegationTextNode(delegatedPrompt)}</input>\n</codex_delegation>`,
          truncated: false,
        },
      },
      {
        type: "commandExecution",
        id: "bootstrap",
        command: "/bin/zsh -lc \"sed -n '1,240p' /Users/test/.codex/plugins/cache/openai-bundled/browser/26.825.51511/skills/control-in-app-browser/SKILL.md\"",
        cwd: projectlessCwd,
        status: "completed",
        exitCode: 0,
        durationMs: 1,
        output: { text: "browser skill", truncated: false },
      },
      ...items,
    ] }],
  });
}

function modifyReadResult(
  result: ReturnType<typeof readResult>,
  modify: (payload: { turns: Array<{ items: Array<Record<string, unknown>> }> }) => void,
) {
  const payload = JSON.parse(String(result.content[0]!.text)) as {
    turns: Array<{ items: Array<Record<string, unknown>> }>;
  };
  modify(payload);
  return appResult(payload);
}

function adapterFor(title: string, overrides: Partial<QualificationV2CodexAppAdapter> = {}) {
  const adapter = {
    createThread: vi.fn(async () => appResult({ threadId: TASK_ID, hostId: HOST_ID })),
    listThreads: vi.fn(async () => listResult(title)),
    waitThreads: vi.fn(async () => waitCompletedResult()),
    readThread: vi.fn(async () => readResult(title)),
    ...overrides,
  } as QualificationV2CodexAppAdapter;
  return adapter;
}

function runnerDependencies(adapter: QualificationV2CodexAppAdapter) {
  return { adapter, now: () => NOW, runAuthPreflight: async () => authReceipt() };
}

function fakeCompletedAuthorReceipt(state: ReturnType<typeof recordQualificationV2RunnerDispatch>) {
  const action = state.pendingAction!;
  return sealQualificationV2ExternalTaskReceipt({
    schemaVersion: "exp-0001a-qualification-external-task-receipt/v2",
    actionDigest: action.actionDigest,
    dispatchReceiptDigest: state.pendingDispatchReceipt!.receiptDigest,
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
    createdTaskId: TASK_ID,
    hostId: HOST_ID,
    clientTaskId: null,
    rawCreateToolResultDigest: digest("4"),
    listThreadsObservationDigest: digest("7"),
    rawTerminalToolResultDigest: digest("5"),
    terminalStatus: "completed",
    terminalResultDigest: digest("6"),
    reviewDecision: null,
    wallTimeMs: 1000,
    subscriptionUsage: "unobservable",
    resolvedModelSnapshot: "unobservable",
    exactTokens: "unobservable",
    retainedAt: "2026-08-31T20:00:04.000Z",
  });
}

function preparedReviewState() {
  let state = preparedAuthorState();
  state = recordQualificationV2RunnerDispatch(state, "2026-08-31T20:00:03.000Z", digest("7"));
  state = ingestQualificationV2ExternalTaskReceipt(state, fakeCompletedAuthorReceipt(state), "2026-08-31T20:00:04.000Z");
  const capture = prepareQualificationV2CaptureAction({
    state,
    preparedAt: "2026-08-31T20:00:04.250Z",
    request: {
      operation: "capture_author_evidence",
      roomReceiptPath: "/private/tmp/task-runner-room.json",
      provisionControllerReceiptPath: "/private/tmp/task-runner-provision.json",
      storageStatePath: "/private/tmp/task-runner-storage.json",
      outputDirectory: "/private/tmp/task-runner-capture",
      at: "2026-08-31T20:00:04.250Z",
    },
  });
  const acknowledgedCapture = acknowledgeQualificationV2CaptureDispatch(
    capture.state,
    "2026-08-31T20:00:04.300Z",
  );
  state = retainQualificationV2CaptureTerminalReceipt(acknowledgedCapture.state, sealQualificationV2CaptureTerminalReceipt({
    schemaVersion: "exp-0001a-qualification-capture-terminal/v2",
    taskId: publicTasks[0]!.taskId,
    captureActionDigest: capture.captureAuthorization.actionDigest,
    captureNonce: capture.captureAuthorization.captureNonce,
    requestBindingDigest: capture.captureAuthorization.requestBindingDigest,
    releaseJournalDigest: acknowledgedCapture.captureReleaseJournal.journalDigest,
    outcome: "succeeded",
    captureControllerReceiptDigest: digest("8"),
    failureCode: null,
    retainedAt: "2026-08-31T20:00:04.500Z",
  }), "2026-08-31T20:00:04.500Z");
  const semanticState = {
    schemaVersion: "exp-0001a-author-review-semantic-state/v2" as const,
    roomRevision: 3,
    objects: [],
    diagrams: [],
  };
  const authorEvidence = {
    schemaVersion: "exp-0001a-qualification-author-evidence/v2",
    taskId: publicTasks[0]!.taskId,
    authorTaskId: TASK_ID,
    roomId: roomReceipt().roomId,
    authorOutcome: "completed",
    authorSessionIdentity: {
      participantId: "participant_author_exact",
      displayName: "EXP-0001A Qualification Author",
      role: "participant",
      joinResultDigest: digest("1"),
      collaborationResultDigest: digest("2"),
      bindingDigest: hashCanonicalJson({
        participantId: "participant_author_exact",
        displayName: "EXP-0001A Qualification Author",
        role: "participant",
        joinResultDigest: digest("1"),
        collaborationResultDigest: digest("2"),
      }),
    },
    webMcpDiscovered: true,
    webMcpTraceDigest: digest("8"),
    webMcpCallCount: 4,
    webMcpFailureCount: 0,
    successfulAuthoritativeMutationCount: 1,
    visualInspectionCount: 1,
    preAuthoritativeReadDigest: digest("3"),
    closingAuthoritativeReadDigest: digest("9"),
    finalAuthoritativeRoomRevision: 3,
    revisionMatchedPngDigest: digest("a"),
    pngRoomRevision: 3,
    sanitizedSemanticStateDigest: hashCanonicalJson(semanticState),
    semanticStateRoomRevision: 3,
    terminalResultDigest: digest("6"),
    attributedMutationSetDigest: digest("4"),
    controllerInspectionDigest: digest("5"),
    visualProofDigest: digest("7"),
    criticalBoundaryViolations: [],
    evidenceRoot: hashCanonicalJson([
      digest("8"),
      hashCanonicalJson({
        participantId: "participant_author_exact",
        displayName: "EXP-0001A Qualification Author",
        role: "participant",
        joinResultDigest: digest("1"),
        collaborationResultDigest: digest("2"),
      }),
      digest("3"), digest("9"), digest("a"), hashCanonicalJson(semanticState), digest("6"), digest("4"),
      digest("5"), digest("7"),
    ]),
    retainedAt: "2026-08-31T20:00:05.000Z",
  };
  state = retainQualificationV2AuthorEvidence(state, authorEvidence, "2026-08-31T20:00:05.000Z");
  const rubric = rubricBundle.rubrics.find((candidate: { taskId: string }) => candidate.taskId === publicTasks[0]!.taskId);
  const manifest = {
    schemaVersion: "exp-0001a-qualification-evidence-sidecar-manifest/v2" as const,
    opaqueArtifactKey: "0123456789abcdef0123456789abcdef",
    mediaType: "image/png" as const,
    byteDigest: digest("a"),
    byteLength: 1024,
    sourceRoomRevision: 3,
  };
  const sidecarContent = {
    schemaVersion: "exp-0001a-qualification-evidence-sidecar-receipt/v2",
    exactRevisionPngUrl: `http://127.0.0.1:49152/evidence/${manifest.opaqueArtifactKey}.png`,
    manifest,
    manifestDigest: hashCanonicalJson(manifest),
    exactRevisionPngByteDigest: digest("a"),
    exactRevisionPngByteLength: 1024,
    sourceRoomRevision: 3,
    sanitizedSemanticStateRoomRevision: 3,
    queryPermitted: false,
    fragmentPermitted: false,
    persistedByJazzboard: false,
  };
  const evidenceSidecar = {
    ...sidecarContent,
    sidecarReceiptDigest: hashCanonicalJson(sidecarContent as unknown as JsonValue),
  };
  const envelopeContent = {
    schemaVersion: "exp-0001a-qualification-blinded-review-envelope/v2",
    publicTask: publicTasks[0],
    frozenRubric: rubric,
    sanitizedSemanticState: semanticState,
    sanitizedSemanticStateDigest: hashCanonicalJson(semanticState),
    evidenceSidecar,
  };
  return prepareQualificationV2ReviewAction({
    state,
    authReceipt: authReceipt(),
    preparedAt: "2026-08-31T20:00:06.000Z",
    reviewEnvelope: {
      ...envelopeContent,
      envelopeDigest: hashCanonicalJson(envelopeContent as unknown as JsonValue),
    },
  });
}

async function writeSidecarReadReceipt(privateRoot: string, state: ReturnType<typeof preparedReviewState>) {
  const manifest = state.pendingAction!.reviewEvidenceSidecar!.manifest;
  const content = {
    schemaVersion: "exp-0001a-qualification-evidence-sidecar-read-receipt/v2",
    manifestDigest: hashCanonicalJson(manifest as unknown as JsonValue),
    requestPath: `/evidence/${manifest.opaqueArtifactKey}.png`,
    method: "GET",
    responseStatus: 200,
    responseCacheControl: "no-store, max-age=0",
    servedByteDigest: manifest.byteDigest,
    servedByteLength: manifest.byteLength,
    readOrdinal: 1,
    servedAt: NOW,
  };
  const receiptPath = join(privateRoot, "review-sidecar-read-receipt.json");
  await writeFile(receiptPath, `${canonicalJson({ ...content, receiptDigest: hashCanonicalJson(content as unknown as JsonValue) })}\n`, { mode: 0o600 });
  await chmod(receiptPath, 0o600);
  return receiptPath;
}

describe("EXP-0001A qualification-v2 task runner", () => {
  beforeEach(() => vi.clearAllMocks());

  it("dispatches an exact v3-bound state from the checkout-local v3 private root", async () => {
    const state = preparedAuthorStateV3();
    const paths = await persistState(state, "v3");
    const title = state.pendingAction!.arguments.title;
    const adapter = adapterFor(title, {
      readThread: vi.fn(async () => readResult(
        title,
        authorItems(),
        state.pendingAction!.arguments.prompt,
      )),
    });

    const result = await runQualificationV2PendingActionForTesting(paths, runnerDependencies(adapter));

    expect(result.receipt).toMatchObject({ terminalStatus: "completed", role: "author" });
    expect(paths.privateRoot).toContain("exp0001a-qualification-v3");
    expect(result.actionRoot.startsWith(`${await realpath(paths.privateRoot)}/`)).toBe(true);
  });

  it("rejects v2/v3 production-binding and private-root mixing before dispatch", async () => {
    const v3StateInV2Root = await persistState(preparedAuthorStateV3(), "v2");
    const v3Adapter = adapterFor(preparedAuthorStateV3().pendingAction!.arguments.title);
    await expect(runQualificationV2PendingActionForTesting(
      v3StateInV2Root,
      runnerDependencies(v3Adapter),
    )).rejects.toThrow("QUALIFICATION_V2_RUNNER_STATE_ROOT_MISMATCH");
    expect(v3Adapter.createThread).not.toHaveBeenCalled();

    const v2StateInV3Root = await persistState(preparedAuthorState(), "v3");
    const v2Adapter = adapterFor(preparedAuthorState().pendingAction!.arguments.title);
    await expect(runQualificationV2PendingActionForTesting(
      v2StateInV3Root,
      runnerDependencies(v2Adapter),
    )).rejects.toThrow("QUALIFICATION_V2_RUNNER_STATE_ROOT_MISMATCH");
    expect(v2Adapter.createThread).not.toHaveBeenCalled();
  });

  it("rejects a coordinator state reached through a symlink inside the selected v3 root", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "qualification-v3-runner-symlink-"));
    const privateRoot = join(repositoryRoot, ".research-private", "exp0001a-qualification-v3");
    const realStateDirectory = join(privateRoot, "real-state");
    const linkedStateDirectory = join(privateRoot, "linked-state");
    await mkdir(realStateDirectory, { recursive: true, mode: 0o700 });
    await chmod(privateRoot, 0o700);
    const state = preparedAuthorStateV3();
    await writeFile(join(realStateDirectory, "state.json"), `${canonicalJson(state)}\n`, { mode: 0o600 });
    await symlink(realStateDirectory, linkedStateDirectory);
    const adapter = adapterFor(state.pendingAction!.arguments.title);

    await expect(runQualificationV2PendingActionForTesting({
      repositoryRoot,
      statePath: join(linkedStateDirectory, "state.json"),
    }, runnerDependencies(adapter))).rejects.toThrow("QUALIFICATION_V2_TASK_RUNNER_PATH_SYMLINK_FORBIDDEN");
    expect(adapter.createThread).not.toHaveBeenCalled();
  });

  it("derives a completed receipt directly from retained ready-create/wait/read results", async () => {
    const state = preparedAuthorState();
    const paths = await persistState(state);
    const adapter = adapterFor(state.pendingAction!.arguments.title);
    const result = await runQualificationV2PendingActionForTesting(paths, runnerDependencies(adapter));

    expect(result.receipt).toMatchObject({
      terminalStatus: "completed",
      createdTaskId: TASK_ID,
      hostId: HOST_ID,
      repositoryAccess: false,
      privateApiAccess: false,
    });
    expect(adapter.createThread).toHaveBeenCalledTimes(1);
    expect(adapter.listThreads).not.toHaveBeenCalled();
    expect(adapter.waitThreads).toHaveBeenCalledTimes(1);
    expect(adapter.readThread).toHaveBeenCalledWith(expect.objectContaining({
      includeOutputs: true,
      maxOutputCharsPerItem: 20_000,
    }));
    for (const fileName of ["create-result.json", "wait-001.json", "read-001.json"]) {
      const observation = qualificationV2RawToolObservationSchema.parse(JSON.parse(
        await readFile(join(result.actionRoot, fileName), "utf8"),
      ));
      expect(observation.rawResultDigest).toBe(hashCanonicalJson(observation.rawResult as JsonValue));
    }
  });

  it("accepts an equivalent complete browser-skill read with a wider bounded sed range", async () => {
    const state = preparedAuthorState();
    const paths = await persistState(state);
    const title = state.pendingAction!.arguments.title;
    const adapter = adapterFor(title, {
      readThread: vi.fn(async () => modifyReadResult(readResult(title), (payload) => {
        const command = payload.turns[0]!.items.find((item) => item.type === "commandExecution")!;
        command.command = String(command.command).replace("1,240p", "1,260p");
      })),
    });
    const result = await runQualificationV2PendingActionForTesting(paths, runnerDependencies(adapter));
    expect(result.receipt).toMatchObject({
      terminalStatus: "completed",
      repositoryAccess: false,
      privateApiAccess: false,
    });
  });

  it("accepts the exact portable home-relative browser-skill bootstrap", async () => {
    const state = preparedAuthorState();
    const paths = await persistState(state);
    const title = state.pendingAction!.arguments.title;
    const adapter = adapterFor(title, {
      readThread: vi.fn(async () => modifyReadResult(readResult(title), (payload) => {
        const command = payload.turns[0]!.items.find((item) => item.type === "commandExecution")!;
        command.command = "/bin/zsh -lc \"sed -n '1,220p' ~/.codex/plugins/cache/openai-bundled/browser/26.825.51511/skills/control-in-app-browser/SKILL.md\"";
      })),
    });
    const result = await runQualificationV2PendingActionForTesting(paths, runnerDependencies(adapter));
    expect(result.receipt).toMatchObject({
      terminalStatus: "completed",
      repositoryAccess: false,
      privateApiAccess: false,
    });
  });

  it("validates documented browser discovery across real per-invocation lexical scopes", async () => {
    const state = preparedAuthorState();
    const paths = await persistState(state);
    const title = state.pendingAction!.arguments.title;
    const items = [
      {
        type: "mcpToolCall", id: "browser-setup", server: "node_repl", tool: "js", status: "completed",
        arguments: { code: browserBootstrapCode(AUTHOR_INVITE_URL, [
          "await tab.playwright.waitForLoadState({state:'domcontentloaded',timeoutMs:30000})",
          "const webmcp = await tab.capabilities.get('webmcp')",
          "const tools = await webmcp.fetchTools()",
          "nodeRepl.write(await tools.description())",
        ].join("; ")) },
        output: { text: "browser tools", truncated: false },
      },
      {
        type: "mcpToolCall", id: "room-tools", server: "node_repl", tool: "js", status: "completed",
        arguments: { code: [
          "await tab.playwright.waitForLoadState({state:'domcontentloaded',timeoutMs:30000})",
          "const roomWebmcp = await tab.capabilities.get('webmcp')",
          "const tools = await roomWebmcp.fetchTools()",
          "const joined = await tools.call('join_room', {code:'ABC234'})",
        ].join("; ") },
        output: { text: "joined", truncated: false },
      },
      {
        type: "mcpToolCall", id: "mutation", server: "node_repl", tool: "js", status: "completed",
        arguments: { code: "const transaction = await tools.call('apply_canvas_transaction', {operations: []});" },
        output: { text: "mutated", truncated: false },
      },
      { type: "agentMessage", phase: "final_answer", text: "completed" },
    ];
    const adapter = adapterFor(title, { readThread: vi.fn(async () => readResult(title, items)) });
    const result = await runQualificationV2PendingActionForTesting(paths, runnerDependencies(adapter));
    expect(result.receipt).toMatchObject({
      terminalStatus: "completed",
      repositoryAccess: false,
      privateApiAccess: false,
    });
  });

  it("fails closed when the selected browser documentation is never read", async () => {
    const state = preparedAuthorState();
    const paths = await persistState(state);
    const title = state.pendingAction!.arguments.title;
    const adapter = adapterFor(title, {
      readThread: vi.fn(async () => modifyReadResult(readResult(title), (payload) => {
        const call = payload.turns[0]!.items.find((item) => item.type === "mcpToolCall")!;
        const args = call.arguments as { code: string };
        args.code = args.code.replace("nodeRepl.write(await browser.documentation()); ", "");
      })),
    });
    const result = await runQualificationV2PendingActionForTesting(paths, runnerDependencies(adapter));
    expect(result.receipt).toMatchObject({
      terminalStatus: "failed",
      repositoryAccess: "unobservable",
      privateApiAccess: "unobservable",
    });
  });

  it("fails closed when retained task output proves disallowed private API access", async () => {
    const state = preparedAuthorState();
    const paths = await persistState(state);
    const title = state.pendingAction!.arguments.title;
    const adapter = adapterFor(title, {
      readThread: vi.fn(async () => readResult(title, authorItems(
        "completed",
        authorBootstrapCode("const response = await fetch('https://api.openai.com/v1/responses')"),
      ))),
    });
    const result = await runQualificationV2PendingActionForTesting(paths, runnerDependencies(adapter));
    expect(result.receipt).toMatchObject({
      terminalStatus: "failed",
      repositoryAccess: "unobservable",
      privateApiAccess: "unobservable",
    });
  });

  it.each([
    ["an aliased fetch", "const f = fetch; await f('https://example.com')"],
    ["a shadowed fetch binding", "const fetch = async () => ({ok:true}); await fetch()"],
    ["a globalThis fetch", "await globalThis.fetch('https://example.com')"],
    ["a sequence-call fetch", "await (0, fetch)('https://example.com')"],
    ["a Node builtin module escape", "process.getBuiltinModule('fs').readFileSync('/tmp/private', 'utf8')"],
    ["a computed dynamic constructor", "[].filter.constructor('return process')()"],
    ["an unapproved browser tab enumerator", "await browser.tabs.list()"],
    ["an unapproved tab evaluation surface", "await tab.evaluate('document.cookie')"],
    ["a non-WebMCP capability", "await tab.capabilities.get('cookies')"],
  ])("fails closed on AST-visible %s", async (_label, exploit) => {
    const state = preparedAuthorState();
    const paths = await persistState(state);
    const title = state.pendingAction!.arguments.title;
    const adapter = adapterFor(title, {
      readThread: vi.fn(async () => readResult(title, authorItems(
        "completed",
        authorBootstrapCode(exploit),
      ))),
    });
    const result = await runQualificationV2PendingActionForTesting(paths, runnerDependencies(adapter));
    expect(result.receipt).toMatchObject({
      terminalStatus: "failed",
      repositoryAccess: "unobservable",
      privateApiAccess: "unobservable",
    });
  });

  it.each([
    ["a chained shell payload", (item: Record<string, unknown>) => {
      item.command = `${String(item.command)}; pwd`;
    }],
    ["a private repository path", (item: Record<string, unknown>) => {
      item.command = "/bin/zsh -lc \"sed -n '1,240p' /Volumes/Development/Projects/jazzboard/PRODUCT-SPEC.md\"";
    }],
    ["an incomplete browser-skill read", (item: Record<string, unknown>) => {
      item.command = String(item.command).replace("1,240p", "1,149p");
    }],
    ["a second command", (_item: Record<string, unknown>, items: Array<Record<string, unknown>>) => {
      items.push({
        type: "commandExecution", id: "extra", command: "pwd", cwd: OUTSIDE_CWD,
        status: "completed", exitCode: 0, durationMs: 1,
        output: { text: OUTSIDE_CWD, truncated: false },
      });
    }],
    ["an unrecognized executable item", (_item: Record<string, unknown>, items: Array<Record<string, unknown>>) => {
      items.push({
        type: "shellCommand", id: "hidden-exec", command: "pwd", cwd: OUTSIDE_CWD,
        status: "completed", exitCode: 0,
      });
    }],
  ])("fails closed on %s despite the valid Browser-skill substring", async (_label, mutate) => {
    const state = preparedAuthorState();
    const paths = await persistState(state);
    const title = state.pendingAction!.arguments.title;
    const adapter = adapterFor(title, {
      readThread: vi.fn(async () => modifyReadResult(readResult(title), (payload) => {
        const items = payload.turns[0]!.items;
        const command = items.find((item) => item.type === "commandExecution")!;
        mutate(command, items);
      })),
    });
    const result = await runQualificationV2PendingActionForTesting(paths, runnerDependencies(adapter));
    expect(result.receipt).toMatchObject({
      terminalStatus: "failed",
      repositoryAccess: "unobservable",
      privateApiAccess: "unobservable",
    });
  });

  it("fails closed when the retained delegated prompt differs from the exact released action", async () => {
    const state = preparedAuthorState();
    const paths = await persistState(state);
    const title = state.pendingAction!.arguments.title;
    const adapter = adapterFor(title, {
      readThread: vi.fn(async () => modifyReadResult(readResult(title), (payload) => {
        const promptRecord = payload.turns[0]!.items.find((item) => item.type === "functionCallOutput")!;
        const output = promptRecord.output as { text: string; truncated: false };
        output.text = output.text.replace("PUBLIC_TASK_PACKET=", "PUBLIC_TASK_PACKET_TAMPERED=");
      })),
    });
    const result = await runQualificationV2PendingActionForTesting(paths, runnerDependencies(adapter));
    expect(result.receipt.terminalStatus).toBe("failed");
    expect(result.receipt.repositoryAccess).toBe("unobservable");
  });

  it("accepts a substantial ordered ellipsis projection of the exact delegated prompt", async () => {
    const state = preparedAuthorState();
    const paths = await persistState(state);
    const title = state.pendingAction!.arguments.title;
    const adapter = adapterFor(title, {
      readThread: vi.fn(async () => modifyReadResult(readResult(title), (payload) => {
        const promptRecord = payload.turns[0]!.items.find((item) => item.type === "functionCallOutput")!;
        const output = promptRecord.output as { text: string; truncated: false };
        const match = /^(<codex_delegation>\n  <source_thread_id>[A-Za-z0-9-]+<\/source_thread_id>\n  <input>)([\s\S]*)(<\/input>\n<\/codex_delegation>)$/.exec(output.text)!;
        const body = match[2]!;
        output.text = `${match[1]}${body.slice(0, 1_500)}…${body.slice(2_500, 3_200)}…${body.slice(-1_200)}${match[3]}`;
      })),
    });
    const result = await runQualificationV2PendingActionForTesting(paths, runnerDependencies(adapter));
    expect(result.receipt).toMatchObject({
      terminalStatus: "completed",
      repositoryAccess: false,
      privateApiAccess: false,
    });
  });

  it("rejects an ellipsis projection with altered retained bytes", async () => {
    const state = preparedAuthorState();
    const paths = await persistState(state);
    const title = state.pendingAction!.arguments.title;
    const adapter = adapterFor(title, {
      readThread: vi.fn(async () => modifyReadResult(readResult(title), (payload) => {
        const promptRecord = payload.turns[0]!.items.find((item) => item.type === "functionCallOutput")!;
        const output = promptRecord.output as { text: string; truncated: false };
        const match = /^(<codex_delegation>\n  <source_thread_id>[A-Za-z0-9-]+<\/source_thread_id>\n  <input>)([\s\S]*)(<\/input>\n<\/codex_delegation>)$/.exec(output.text)!;
        const body = match[2]!;
        output.text = `${match[1]}${body.slice(0, 1_500)}ALTERED…${body.slice(-1_200)}${match[3]}`;
      })),
    });
    const result = await runQualificationV2PendingActionForTesting(paths, runnerDependencies(adapter));
    expect(result.receipt.terminalStatus).toBe("failed");
  });

  it("fails closed when the retained live-normalized title differs", async () => {
    const state = preparedAuthorState();
    const paths = await persistState(state);
    const title = state.pendingAction!.arguments.title;
    const adapter = adapterFor(title, {
      readThread: vi.fn(async () => {
        const result = readResult(title);
        const payload = JSON.parse(String(result.content[0]!.text)) as { thread: { title: string } };
        payload.thread.title = `${payload.thread.title.slice(0, -1)}?`;
        return appResult(payload);
      }),
    });
    const result = await runQualificationV2PendingActionForTesting(paths, runnerDependencies(adapter));
    expect(result.receipt).toMatchObject({
      terminalStatus: "failed",
      repositoryAccess: "unobservable",
      privateApiAccess: "unobservable",
    });
  });

  it("rejects explicit output truncation metadata", async () => {
    const state = preparedAuthorState();
    const paths = await persistState(state);
    const title = state.pendingAction!.arguments.title;
    const adapter = adapterFor(title, {
      readThread: vi.fn(async () => readResult(title, authorItems("completed", undefined, true))),
    });
    const result = await runQualificationV2PendingActionForTesting(paths, runnerDependencies(adapter));
    expect(result.receipt.terminalStatus).toBe("failed");
    expect(result.receipt.repositoryAccess).toBe("unobservable");
  });

  it("derives invalid_setup for duplicate exact-title client-setup reconciliation", async () => {
    const state = preparedAuthorState();
    const paths = await persistState(state);
    const title = state.pendingAction!.arguments.title;
    const adapter = adapterFor(title, {
      createThread: vi.fn(async () => appResult({ clientThreadId: "pending-client-task" })),
      listThreads: vi.fn(async () => listResult(title, [
        { id: TASK_ID, hostId: HOST_ID },
        { id: "second-task", hostId: HOST_ID },
      ])),
    });
    const result = await runQualificationV2PendingActionForTesting(paths, runnerDependencies(adapter));
    expect(result.receipt).toMatchObject({ terminalStatus: "invalid_setup", createdTaskId: null, hostId: null });
    expect(adapter.waitThreads).not.toHaveBeenCalled();
  });

  it("does not reject a direct-ready task merely because list_threads would omit it", async () => {
    const state = preparedAuthorState();
    const paths = await persistState(state);
    const adapter = adapterFor(state.pendingAction!.arguments.title, {
      listThreads: vi.fn(async () => listResult("different-title", [])),
    });
    const result = await runQualificationV2PendingActionForTesting(paths, runnerDependencies(adapter));
    expect(result.receipt).toMatchObject({ terminalStatus: "completed", createdTaskId: TASK_ID, hostId: HOST_ID });
    expect(adapter.listThreads).not.toHaveBeenCalled();
    expect(adapter.waitThreads).toHaveBeenCalledWith(expect.objectContaining({
      targets: [expect.objectContaining({ threadId: TASK_ID, hostId: HOST_ID })],
    }));
  });

  it("recovers a journaled ambiguous create without ever invoking create_thread", async () => {
    const state = preparedAuthorState();
    const paths = await persistState(state);
    const adapter = adapterFor(state.pendingAction!.arguments.title);
    await expect(runQualificationV2PendingActionForTesting(paths, {
      ...runnerDependencies(adapter),
      crashAfterRetained: "release_journal",
    })).rejects.toThrow("TEST_CRASH_AFTER_RELEASE_JOURNAL");
    expect(adapter.createThread).not.toHaveBeenCalled();
    expect(await stat(`${paths.statePath}.dispatch.lock`)).toBeDefined();

    const result = await recoverQualificationV2PendingActionForTesting(paths, runnerDependencies(adapter));
    expect(result.receipt.terminalStatus).toBe("completed");
    expect(adapter.createThread).not.toHaveBeenCalled();
    await expect(stat(`${paths.statePath}.dispatch.lock`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(`${paths.statePath}.dispatch.lock.recovery`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves no dispatch lock when the fresh auth preflight fails", async () => {
    const state = preparedAuthorState();
    const paths = await persistState(state);
    const adapter = adapterFor(state.pendingAction!.arguments.title);
    await expect(runQualificationV2PendingActionForTesting(paths, {
      ...runnerDependencies(adapter),
      runAuthPreflight: async () => { throw new Error("preflight unavailable"); },
    })).rejects.toThrow("preflight unavailable");
    await expect(stat(`${paths.statePath}.dispatch.lock`)).rejects.toMatchObject({ code: "ENOENT" });
    expect(adapter.createThread).not.toHaveBeenCalled();
  });

  it("recovers a crash after the dispatch lock but before the release journal", async () => {
    const state = preparedAuthorState();
    const paths = await persistState(state);
    const adapter = adapterFor(state.pendingAction!.arguments.title);
    await expect(runQualificationV2PendingActionForTesting(paths, {
      ...runnerDependencies(adapter),
      crashAfterRetained: "dispatch_lock",
    })).rejects.toThrow("TEST_CRASH_AFTER_DISPATCH_LOCK");
    expect(adapter.createThread).not.toHaveBeenCalled();
    await expect(stat(join(
      paths.privateRoot,
      "external-actions",
      state.pendingAction!.actionId,
      "release-journal.json",
    ))).rejects.toMatchObject({ code: "ENOENT" });

    const result = await recoverQualificationV2PendingActionForTesting(paths, runnerDependencies(adapter));
    expect(result.receipt.terminalStatus).toBe("completed");
    expect(adapter.createThread).toHaveBeenCalledTimes(1);
    expect(await stat(join(result.actionRoot, "release-journal.json"))).toBeDefined();
  });

  it("takes over an abandoned action-bound recovery lock without duplicating create_thread", async () => {
    const state = preparedAuthorState();
    const paths = await persistState(state);
    const adapter = adapterFor(state.pendingAction!.arguments.title);
    await expect(runQualificationV2PendingActionForTesting(paths, {
      ...runnerDependencies(adapter),
      crashAfterRetained: "dispatch_lock",
    })).rejects.toThrow("TEST_CRASH_AFTER_DISPATCH_LOCK");
    await expect(recoverQualificationV2PendingActionForTesting(paths, {
      ...runnerDependencies(adapter),
      processId: 999_999_937,
      crashAfterRetained: "recovery_lock",
    })).rejects.toThrow("TEST_CRASH_AFTER_RECOVERY_LOCK");
    expect(adapter.createThread).not.toHaveBeenCalled();

    const result = await recoverQualificationV2PendingActionForTesting(paths, {
      ...runnerDependencies(adapter),
      isProcessAlive: () => false,
    });
    expect(result.receipt.terminalStatus).toBe("completed");
    expect(adapter.createThread).toHaveBeenCalledTimes(1);
    expect(await readdir(`${paths.statePath}.terminal-recovery-locks`)).toHaveLength(1);
  });

  it("recovers when the process died after journaling but before the dispatch-state CAS", async () => {
    const state = preparedAuthorState();
    const paths = await persistState(state);
    const adapter = adapterFor(state.pendingAction!.arguments.title);
    await expect(runQualificationV2PendingActionForTesting(paths, {
      ...runnerDependencies(adapter),
      crashAfterRetained: "release_journal",
    })).rejects.toThrow("TEST_CRASH_AFTER_RELEASE_JOURNAL");
    // Reconstruct the narrower real crash window: journal and lock are durable,
    // while the state file still contains the pre-dispatch digest.
    await writeFile(paths.statePath, `${canonicalJson(state)}\n`, { mode: 0o600 });
    await chmod(paths.statePath, 0o600);

    const result = await recoverQualificationV2PendingActionForTesting(paths, runnerDependencies(adapter));
    expect(result.receipt.terminalStatus).toBe("completed");
    expect(adapter.createThread).not.toHaveBeenCalled();
    expect(result.journal.preReleaseStateDigest).toBe(state.stateDigest);
  });

  it("reuses retained create and list observations after a crash and never recreates the task", async () => {
    const state = preparedAuthorState();
    const paths = await persistState(state);
    const adapter = adapterFor(state.pendingAction!.arguments.title, {
      createThread: vi.fn(async () => appResult({ clientThreadId: "pending-client-task" })),
    });
    await expect(runQualificationV2PendingActionForTesting(paths, {
      ...runnerDependencies(adapter),
      crashAfterRetained: "list_observation",
    })).rejects.toThrow("TEST_CRASH_AFTER_LIST_OBSERVATION");
    expect(adapter.createThread).toHaveBeenCalledTimes(1);
    expect(adapter.listThreads).toHaveBeenCalledTimes(1);

    const result = await recoverQualificationV2PendingActionForTesting(paths, runnerDependencies(adapter));
    expect(result.receipt.terminalStatus).toBe("completed");
    expect(adapter.createThread).toHaveBeenCalledTimes(1);
    expect(adapter.listThreads).toHaveBeenCalledTimes(1);
  });

  it("archives an evidence-proven terminal prior-action lock before the next action", async () => {
    const first = preparedAuthorState();
    const paths = await persistState(first);
    const firstAdapter = adapterFor(first.pendingAction!.arguments.title);
    await expect(runQualificationV2PendingActionForTesting(paths, {
      ...runnerDependencies(firstAdapter),
      crashAfterRetained: "final_state_cas",
    })).rejects.toThrow("TEST_CRASH_AFTER_FINAL_STATE_CAS");
    const staleLockPath = `${paths.statePath}.dispatch.lock`;
    expect(await stat(staleLockPath)).toBeDefined();

    const next = preparedReviewState();
    expect(next.pendingAction!.actionDigest).not.toBe(first.pendingAction!.actionDigest);
    expect(next.releasedActionDigests).toContain(first.pendingAction!.actionDigest);
    const terminalFirst = JSON.parse(await readFile(paths.statePath, "utf8")) as typeof next;
    const { stateDigest: _nextDigest, ...nextContent } = next;
    void _nextDigest;
    const evidencedNextContent = {
      ...nextContent,
      retainedTaskReceiptDigests: [...new Set([
        ...next.retainedTaskReceiptDigests,
        ...terminalFirst.retainedTaskReceiptDigests,
      ])],
    };
    const evidencedNext = {
      ...evidencedNextContent,
      stateDigest: hashCanonicalJson(evidencedNextContent as unknown as JsonValue),
    } as typeof next;
    await writeFile(paths.statePath, `${canonicalJson(evidencedNext)}\n`, { mode: 0o600 });
    await chmod(paths.statePath, 0o600);
    const nextAdapter = adapterFor(evidencedNext.pendingAction!.arguments.title);
    const result = await runQualificationV2PendingActionForTesting(
      paths,
      runnerDependencies(nextAdapter),
    );
    expect(result.receipt.actionDigest).toBe(evidencedNext.pendingAction!.actionDigest);
    const archivedLockPath = join(
      `${paths.statePath}.terminal-dispatch-locks`,
      `${first.pendingAction!.actionDigest.replace("sha256:", "")}.json`,
    );
    expect(await stat(archivedLockPath)).toBeDefined();
    await expect(stat(staleLockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("observes a final-state crash as terminal, then permits a later action to crash and recover", async () => {
    const first = preparedAuthorState();
    const paths = await persistState(first);
    const firstAdapter = adapterFor(first.pendingAction!.arguments.title);
    await expect(runQualificationV2PendingActionForTesting(paths, {
      ...runnerDependencies(firstAdapter),
      crashAfterRetained: "final_state_cas",
    })).rejects.toThrow("TEST_CRASH_AFTER_FINAL_STATE_CAS");
    await expect(recoverQualificationV2PendingActionForTesting(
      paths,
      runnerDependencies(firstAdapter),
    )).rejects.toThrow("QUALIFICATION_V2_RECOVERY_ALREADY_TERMINAL");
    await expect(stat(`${paths.statePath}.dispatch.lock`)).rejects.toMatchObject({ code: "ENOENT" });

    const terminalFirst = JSON.parse(await readFile(paths.statePath, "utf8")) as ReturnType<typeof preparedReviewState>;
    const next = preparedReviewState();
    const { stateDigest: _nextDigest, ...nextContent } = next;
    void _nextDigest;
    const evidencedNextContent = {
      ...nextContent,
      retainedTaskReceiptDigests: [...new Set([
        ...next.retainedTaskReceiptDigests,
        ...terminalFirst.retainedTaskReceiptDigests,
      ])],
    };
    const evidencedNext = {
      ...evidencedNextContent,
      stateDigest: hashCanonicalJson(evidencedNextContent as unknown as JsonValue),
    } as typeof next;
    await writeFile(paths.statePath, `${canonicalJson(evidencedNext)}\n`, { mode: 0o600 });
    await chmod(paths.statePath, 0o600);

    const nextAdapter = adapterFor(evidencedNext.pendingAction!.arguments.title);
    await expect(runQualificationV2PendingActionForTesting(paths, {
      ...runnerDependencies(nextAdapter),
      crashAfterRetained: "dispatch_lock",
    })).rejects.toThrow("TEST_CRASH_AFTER_DISPATCH_LOCK");
    const recovered = await recoverQualificationV2PendingActionForTesting(
      paths,
      runnerDependencies(nextAdapter),
    );
    expect(recovered.receipt.actionDigest).toBe(evidencedNext.pendingAction!.actionDigest);
    expect(nextAdapter.createThread).toHaveBeenCalledTimes(1);
  });

  it("refuses an unbound retained lock without deleting the crash evidence", async () => {
    const state = preparedAuthorState();
    const paths = await persistState(state);
    const adapter = adapterFor(state.pendingAction!.arguments.title);
    await expect(runQualificationV2PendingActionForTesting(paths, {
      ...runnerDependencies(adapter),
      crashAfterRetained: "release_journal",
    })).rejects.toThrow("TEST_CRASH_AFTER_RELEASE_JOURNAL");
    const lockPath = `${paths.statePath}.dispatch.lock`;
    await writeFile(lockPath, `${canonicalJson({
      schemaVersion: "exp-0001a-qualification-runner-lock/v2",
      mode: "dispatch",
      acquiredAt: NOW,
      actionDigest: digest("e"),
    })}\n`, { mode: 0o600 });
    await chmod(lockPath, 0o600);

    await expect(recoverQualificationV2PendingActionForTesting(paths, runnerDependencies(adapter)))
      .rejects.toThrow("RECOVERY_LOCK_BINDING_INVALID");
    expect(await readFile(lockPath, "utf8")).toContain(digest("e"));
    expect(adapter.createThread).not.toHaveBeenCalled();
  });

  it("preserves an unstarted reviewer ordinal when create_thread reports a subscription limit", async () => {
    const state = preparedReviewState();
    const paths = await persistState(state as ReturnType<typeof preparedAuthorState>);
    const adapter = adapterFor(state.pendingAction!.arguments.title, {
      createThread: vi.fn(async () => appResult({
        taskCreated: false,
        error: { code: "subscription_usage_limit", message: "limit reached" },
      }, true)),
    });
    const result = await runQualificationV2PendingActionForTesting(paths, runnerDependencies(adapter));
    expect(result.receipt).toMatchObject({ terminalStatus: "usage_limit_interrupted", createdTaskId: null });
    expect(result.state).toMatchObject({ stopped: true, stopReason: "usage_limit_interrupted" });
    expect(result.state.tasks[0].primaryReviews).toHaveLength(0);
    expect(result.state.tasks[0].usageLimitInterruptions).toHaveLength(1);
    expect(adapter.listThreads).not.toHaveBeenCalled();
  });

  it("accepts only the reviewer's exact terminal JSON and binds the one-read PNG receipt", async () => {
    const state = preparedReviewState();
    const paths = await persistState(state as ReturnType<typeof preparedAuthorState>);
    const receiptPath = await writeSidecarReadReceipt(paths.privateRoot, state);
    const criteria = state.tasks[0].acceptanceCriterionIds;
    const decision = {
      artifactAccepted: true,
      criterionPasses: Object.fromEntries(criteria.map((criterion) => [criterion, true])),
      evidenceRoot: digest("d"),
      blindness: {
        authorTranscriptSeen: false,
        authorIdentitySeen: false,
        conditionLabelSeen: false,
        pairedArtifactSeen: false,
        repositoryAccessed: false,
        otherReviewerDecisionSeen: false,
      },
    };
    const title = state.pendingAction!.arguments.title;
    const reviewerItems = [
      {
        type: "mcpToolCall",
        id: "review-mcp",
        server: "node_repl",
        tool: "js",
        arguments: { code: browserBootstrapCode(REVIEWER_EVIDENCE_URL) },
        status: "completed",
        output: { text: "image read", originalChars: 10, truncated: false },
      },
      { type: "agentMessage", phase: "final_answer", text: JSON.stringify(decision) },
    ];
    const adapter = adapterFor(title, { readThread: vi.fn(async () => (
      readResult(title, reviewerItems, state.pendingAction!.arguments.prompt)
    )) });
    const result = await runQualificationV2PendingActionForTesting(paths, {
      ...runnerDependencies(adapter),
      reviewEvidenceReadReceiptPath: receiptPath,
    });
    expect(result.receipt).toMatchObject({ terminalStatus: "completed", reviewDecision: decision });
    expect(result.state.tasks[0].primaryReviews).toHaveLength(1);
  });

  it("rejects reviewer prose wrapped around otherwise valid JSON", async () => {
    const state = preparedReviewState();
    const paths = await persistState(state as ReturnType<typeof preparedAuthorState>);
    const receiptPath = await writeSidecarReadReceipt(paths.privateRoot, state);
    const title = state.pendingAction!.arguments.title;
    const items = [
      {
        type: "mcpToolCall", id: "review-mcp", server: "node_repl", tool: "js",
        arguments: { code: browserBootstrapCode(REVIEWER_EVIDENCE_URL) },
        status: "completed",
        output: { text: "image read", originalChars: 10, truncated: false },
      },
      { type: "agentMessage", phase: "final_answer", text: "Here is my decision: {}" },
    ];
    const adapter = adapterFor(title, { readThread: vi.fn(async () => (
      readResult(title, items, state.pendingAction!.arguments.prompt)
    )) });
    const result = await runQualificationV2PendingActionForTesting(paths, {
      ...runnerDependencies(adapter),
      reviewEvidenceReadReceiptPath: receiptPath,
    });
    expect(result.receipt.terminalStatus).toBe("failed");
    expect(result.receipt.reviewDecision).toBeNull();
  });
});
