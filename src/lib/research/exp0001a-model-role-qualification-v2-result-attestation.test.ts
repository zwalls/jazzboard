// @vitest-environment node

import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { EXP0001A_QUALIFICATION_V2_TASK_IDS } from "./exp0001a-model-role-qualification-v2";
import {
  qualificationV2CodexAuthReceiptSchema,
  qualificationV2CoordinatorStateSchema,
  qualificationV2ExternalActionSchema,
  qualificationV2ExternalTaskReceiptSchema,
} from "./exp0001a-model-role-qualification-v2-coordinator";
import {
  createQualificationV2TerminalEvidenceAttestation,
  qualificationV2EvidenceArtifactReferences,
  verifyQualificationV2TerminalEvidenceAttestation,
} from "./exp0001a-model-role-qualification-v2-result-attestation";
import { canonicalJson, hashCanonicalJson, type JsonValue } from "./provenance-crypto";

const execFileAsync = promisify(execFile);
const CREATED_AT = "2026-08-31T20:00:00.000Z";
const UPDATED_AT = "2026-08-31T20:10:00.000Z";
const ATTESTED_AT = "2026-08-31T20:11:00.000Z";
const digest = (character: string) => `sha256:${character.repeat(64)}`;
const temporaryRoots: string[] = [];

function authoritySignature(purpose: "qualification_plan" | "qualification_launch_binding") {
  return {
    schemaVersion: "exp-0001a-model-role-qualification-authority-signature/v2" as const,
    protocolId: "EXP-0001A-MODEL-ROLE-QUALIFICATION-V2" as const,
    kind: "model-role-qualification-authority-signature" as const,
    algorithm: "Ed25519" as const,
    keyId: "exp0001a-launch-authority-2026-08-30" as const,
    publicKeyDigest: "sha256:6fdb285e74644254c72c0e58b098bb1f7d9f8091dc861f830750e89464e503de" as const,
    signedAt: CREATED_AT,
    purpose,
    payloadDigest: digest(purpose === "qualification_plan" ? "1" : "2"),
    signatureBase64: `${"A".repeat(86)}==`,
  };
}

function productionBinding() {
  const content = {
    schemaVersion: "exp-0001a-qualification-production-binding/v2" as const,
    planDigest: digest("1"),
    planDeclaredSuccessorCommit: "88919b8e0070fbd1b2be4f3e4121cfdcf50638a6" as const,
    predecessorPlanBytesMutated: false as const,
    supersessionReason: "production_export_route_hotfix_and_successor_baseline_freeze" as const,
    baselineReceiptSchema: "baseline-freeze/v2" as const,
    baselineFreezeDigest: digest("3"),
    baselineAuthoritySignatureDigest: digest("4"),
    productionCommit: "66a546aaef9e006891a4cf619ed310fd9fc1c4cc" as const,
    productionTree: "071a751beadbcefc002f42d1be75a0e717bc3e4b" as const,
    deploymentId: "dpl_46pyqWtLXGfzeU1JsqXEWQjTBfd8" as const,
    buildId: "bld_3t0eopcj7" as const,
    productionAlias: "https://www.jazzboard.xyz" as const,
    verifiedAt: CREATED_AT,
    aliasAndContractDriftObserved: false as const,
    semanticExportPreflightPassed: true as const,
    exactRevisionPngPreflightPassed: true as const,
    browserWebMcpContractPassed: true as const,
  };
  return { ...content, bindingDigest: hashCanonicalJson(content as unknown as JsonValue) };
}

function taskState(taskId: (typeof EXP0001A_QUALIFICATION_V2_TASK_IDS)[number], blocked: boolean) {
  return {
    taskId,
    publicTaskDigest: digest("5"),
    benchmarkCommitments: {
      task: digest("6"),
      publicPacket: digest("7"),
      setup: digest("8"),
      event: digest("9"),
      rubric: digest("a"),
    },
    acceptanceCriterionIds: ["criterion-1"],
    expectedInitialStateKind: "blank" as const,
    expectedFixturePreflightDigest: null,
    expectedCompiledFixtureInputDigest: null,
    phase: blocked ? "blocked" as const : "awaiting_room" as const,
    room: null,
    roomProvisionControllerReceiptDigest: null,
    roomAuthorizedStorageStateDigest: null,
    captureAuthorization: null,
    captureReleaseJournal: null,
    captureTerminalReceipt: null,
    authorReceipt: null,
    authorEvidence: null,
    primaryReviews: [],
    adjudication: null,
    usageLimitInterruptions: [],
  };
}

function terminalState(gitCommit: string, gitTree: string, overrides: Record<string, unknown> = {}) {
  const provenance = {
    controllerBundleDigest: digest("b"),
    wrapperSourceDigest: digest("c"),
    dependencyLockfileDigest: digest("d"),
    gitCommit,
    gitTree,
    worktreeClean: true as const,
  };
  const content = {
    schemaVersion: "exp-0001a-model-role-qualification-coordinator/v2" as const,
    protocolId: "EXP-0001A-MODEL-ROLE-QUALIFICATION-V2" as const,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    planDigest: digest("1"),
    benchmarkExecutionBundleDigest: digest("e"),
    baselineParticipantToolContractDigest: digest("f"),
    controllerHarnessRuntimeProvenance: provenance,
    planAuthoritySignature: authoritySignature("qualification_plan"),
    productionBinding: productionBinding(),
    productionBindingAuthoritySignature: authoritySignature("qualification_launch_binding"),
    currentTaskIndex: 0,
    tasks: EXP0001A_QUALIFICATION_V2_TASK_IDS.map((taskId, index) => taskState(taskId, index === 0)),
    pendingAction: null,
    pendingDispatchReceipt: null,
    releasedActionDigests: [],
    retainedTaskReceiptDigests: [],
    stopped: true,
    stopReason: "invalid_setup" as const,
    ...overrides,
  };
  return qualificationV2CoordinatorStateSchema.parse({
    ...content,
    stateDigest: hashCanonicalJson(content as unknown as JsonValue),
  });
}

async function git(repositoryRoot: string, ...arguments_: string[]) {
  return (await execFileAsync("git", arguments_, { cwd: repositoryRoot, encoding: "utf8" })).stdout.trim();
}

async function writePrivateJson(filePath: string, value: unknown) {
  await writeFile(filePath, `${canonicalJson(value as JsonValue)}\n`, { mode: 0o600 });
  await chmod(filePath, 0o600);
}

async function fixture() {
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), "qualification-v2-attestation-"));
  temporaryRoots.push(repositoryRoot);
  await writeFile(path.join(repositoryRoot, ".gitignore"), ".research-private/\n", "utf8");
  await writeFile(path.join(repositoryRoot, "harness.txt"), "frozen harness\n", "utf8");
  await git(repositoryRoot, "init");
  await git(repositoryRoot, "config", "user.name", "Qualification Test");
  await git(repositoryRoot, "config", "user.email", "qualification@example.invalid");
  await git(repositoryRoot, "add", ".gitignore", "harness.txt");
  await git(repositoryRoot, "commit", "-m", "freeze harness");
  const gitCommit = await git(repositoryRoot, "rev-parse", "HEAD");
  const gitTree = await git(repositoryRoot, "rev-parse", "HEAD^{tree}");
  const privateRoot = path.join(repositoryRoot, ".research-private", "exp0001a-qualification-v2");
  const evidenceDirectory = path.join(privateRoot, "evidence");
  await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
  await chmod(path.join(repositoryRoot, ".research-private"), 0o700);
  await chmod(privateRoot, 0o700);
  await chmod(evidenceDirectory, 0o700);
  const state = terminalState(gitCommit, gitTree);
  const statePath = path.join(privateRoot, "state.json");
  const evidencePath = path.join(evidenceDirectory, "provenance.json");
  await writePrivateJson(statePath, state);
  // This is direct canonical evidence for the required provenance digest, not
  // a document that merely repeats that digest as an unverified string.
  await writePrivateJson(evidencePath, state.controllerHarnessRuntimeProvenance);
  return { repositoryRoot, privateRoot, evidenceDirectory, evidencePath, statePath, state, gitCommit, gitTree };
}

function authReceipt() {
  const content = {
    schemaVersion: "codex-chatgpt-auth-preflight/v1" as const,
    checkedAt: "2026-08-31T20:04:00.000Z",
    command: { executable: "codex" as const, arguments: ["login", "status"] as const },
    authentication: {
      method: "chatgpt" as const,
      accountIdentifier: { observability: "unobservable" as const, value: null },
      subscriptionPlan: { observability: "unobservable" as const, value: null },
    },
    observation: {
      exitCode: { observability: "observed" as const, value: 0 as const },
      signal: { observability: "unobservable" as const, value: null },
      stdoutSha256: { observability: "observed" as const, value: digest("1") },
      stderrSha256: { observability: "observed" as const, value: digest("2") },
      rawOutputRetained: false as const,
      outputLimitExceeded: false as const,
      invocationError: false as const,
    },
    decision: { allowCodexNativeExperiment: true as const, reasonCode: "CHATGPT_AUTHENTICATED" as const },
  };
  return qualificationV2CodexAuthReceiptSchema.parse({
    ...content,
    receiptSha256: hashCanonicalJson(content as unknown as JsonValue),
  });
}

function sealed<T extends Record<string, unknown>, K extends string>(
  content: T,
  digestKey: K,
): T & Record<K, string> {
  return { ...content, [digestKey]: hashCanonicalJson(content as unknown as JsonValue) } as T & Record<K, string>;
}

async function completedTransportChainFixture() {
  const item = await fixture();
  const auth = authReceipt();
  const actionContent = {
    schemaVersion: "exp-0001a-qualification-external-action/v2" as const,
    actionId: "action-1",
    preparedAt: "2026-08-31T20:03:00.000Z",
    planDigest: digest("1"),
    productionBindingDigest: productionBinding().bindingDigest,
    taskId: EXP0001A_QUALIFICATION_V2_TASK_IDS[0],
    role: "author" as const,
    roleOrdinal: 1,
    authReceiptDigest: auth.receiptSha256,
    inputEnvelopeDigest: digest("3"),
    toolName: "mcp__codex_app__create_thread" as const,
    arguments: {
      prompt: "Create the public qualification artifact.",
      target: { type: "projectless" as const, directoryName: "qualification-author-1" },
      model: "gpt-5.6-terra" as const,
      thinking: "medium" as const,
      title: "Qualification author",
    },
    sourceTaskId: null,
    forkedFromTaskId: null,
    reviewEvidenceSidecar: null,
  };
  const action = qualificationV2ExternalActionSchema.parse(sealed(actionContent, "actionDigest"));
  const releaseJournalContent = {
    schemaVersion: "exp-0001a-qualification-release-journal/v2" as const,
    action,
    preReleaseStateDigest: digest("4"),
    dispatchAuthReceiptDigest: auth.receiptSha256,
    recordedAt: "2026-08-31T20:05:00.000Z",
    invocationOrdinal: 1,
    invocationWillOccurExactlyOnce: true,
    createResultMustBeRetainedBeforeTerminalObservation: true,
  };
  const releaseJournal = sealed(releaseJournalContent, "journalDigest");
  const dispatchContent = {
    schemaVersion: "exp-0001a-qualification-dispatch-receipt/v2" as const,
    actionDigest: action.actionDigest,
    releaseJournalDigest: releaseJournal.journalDigest,
    acknowledgedAt: releaseJournal.recordedAt,
    invocationPermittedExactlyOnce: true,
    externalToolInvokedByCoordinatorLibrary: true,
  };
  const dispatchReceiptDigest = hashCanonicalJson(dispatchContent as unknown as JsonValue);
  const requestContent = {
    schemaVersion: "exp-0001a-qualification-codex-app-bridge-request/v2" as const,
    sequence: 1,
    toolName: "mcp__codex_app__create_thread" as const,
    arguments: action.arguments,
    argumentsDigest: hashCanonicalJson(action.arguments as unknown as JsonValue),
    actionDigest: action.actionDigest,
    releaseJournalDigest: releaseJournal.journalDigest,
    requestedAt: "2026-08-31T20:05:01.000Z",
  };
  const bridgeRequest = sealed(requestContent, "requestDigest");
  const authorizationContent = {
    schemaVersion: "exp-0001a-qualification-create-invocation-authorization/v2" as const,
    requestDigest: bridgeRequest.requestDigest,
    actionDigest: action.actionDigest,
    releaseJournalDigest: releaseJournal.journalDigest,
    authReceipt: auth,
    authorizedAt: "2026-08-31T20:05:02.000Z",
    expiresAt: "2026-08-31T20:10:02.000Z",
  };
  const bridgeAuthorization = sealed(authorizationContent, "authorizationDigest");
  const rawCreateResult = {
    content: [{ type: "text", text: JSON.stringify({ threadId: "task-1", hostId: "local" }) }],
    isError: false,
    structuredContent: { threadId: "task-1", hostId: "local" },
  };
  const rawCreateResultDigest = hashCanonicalJson(rawCreateResult as unknown as JsonValue);
  const bridgeResultContent = {
    schemaVersion: "exp-0001a-qualification-codex-app-bridge-result/v2" as const,
    requestDigest: bridgeRequest.requestDigest,
    toolName: "mcp__codex_app__create_thread" as const,
    recordedAt: "2026-08-31T20:05:03.000Z",
    createInvocationAuthorizationDigest: bridgeAuthorization.authorizationDigest,
    resultAuthReceipt: auth,
    resultAuthReceiptDigest: auth.receiptSha256,
    rawCallToolResult: rawCreateResult,
    rawCallToolResultDigest: rawCreateResultDigest,
  };
  const bridgeResult = sealed(bridgeResultContent, "resultDigest");
  const createObservationContent = {
    schemaVersion: "exp-0001a-qualification-raw-tool-observation/v2" as const,
    actionDigest: action.actionDigest,
    toolName: "mcp__codex_app__create_thread" as const,
    invocationOrdinal: 1,
    argumentsDigest: hashCanonicalJson(action.arguments as unknown as JsonValue),
    invokedAt: "2026-08-31T20:05:02.000Z",
    observedAt: "2026-08-31T20:05:03.000Z",
    outcome: "returned" as const,
    rawResult: rawCreateResult,
    rawResultDigest: rawCreateResultDigest,
    thrownError: null,
  };
  const createObservation = sealed(createObservationContent, "observationDigest");
  const observation = (
    toolName: "mcp__codex_app__list_threads" | "mcp__codex_app__wait_threads" | "mcp__codex_app__read_thread",
    invocationOrdinal: number,
    rawResult: JsonValue,
  ) => {
    const content = {
      schemaVersion: "exp-0001a-qualification-raw-tool-observation/v2" as const,
      actionDigest: action.actionDigest,
      toolName,
      invocationOrdinal,
      argumentsDigest: digest(toolName === "mcp__codex_app__wait_threads" ? "5"
        : toolName === "mcp__codex_app__read_thread" ? "6" : "4"),
      invokedAt: `2026-08-31T20:06:0${invocationOrdinal}.000Z`,
      observedAt: `2026-08-31T20:06:0${invocationOrdinal + 1}.000Z`,
      outcome: "returned" as const,
      rawResult,
      rawResultDigest: hashCanonicalJson(rawResult),
      thrownError: null,
    };
    return sealed(content, "observationDigest");
  };
  const listObservation = observation("mcp__codex_app__list_threads", 1, {
    content: [{ type: "text", text: JSON.stringify({ threads: [{ id: "task-1", hostId: "local" }] }) }],
    isError: false,
  });
  const waitObservation = observation("mcp__codex_app__wait_threads", 1, {
    content: [{ type: "text", text: JSON.stringify({ status: "completed", threadId: "task-1" }) }],
    isError: false,
  });
  const readObservation = observation("mcp__codex_app__read_thread", 1, {
    content: [{ type: "text", text: JSON.stringify({ taskId: "task-1", final: "complete" }) }],
    isError: false,
  });
  const terminalTraceDigest = hashCanonicalJson({
    waits: [waitObservation.observationDigest],
    reads: [readObservation.observationDigest],
    evidenceReadReceiptDigest: null,
  });
  const receiptContent = {
    schemaVersion: "exp-0001a-qualification-external-task-receipt/v2" as const,
    actionDigest: action.actionDigest,
    dispatchReceiptDigest,
    taskId: action.taskId,
    role: "author" as const,
    roleOrdinal: 1,
    requestedModel: "gpt-5.6-terra" as const,
    requestedReasoningEffort: "medium" as const,
    workspace: "projectless" as const,
    repositoryAccess: false as const,
    privateApiAccess: false as const,
    sourceTaskId: null,
    forkedFromTaskId: null,
    createdTaskId: "task-1",
    hostId: "local",
    clientTaskId: null,
    rawCreateToolResultDigest: rawCreateResultDigest,
    listThreadsObservationDigest: listObservation.observationDigest,
    rawTerminalToolResultDigest: terminalTraceDigest,
    terminalStatus: "completed" as const,
    terminalResultDigest: digest("7"),
    reviewDecision: null,
    wallTimeMs: 90_000,
    subscriptionUsage: "unobservable" as const,
    resolvedModelSnapshot: "unobservable" as const,
    exactTokens: "unobservable" as const,
    retainedAt: "2026-08-31T20:09:00.000Z",
  };
  const receipt = qualificationV2ExternalTaskReceiptSchema.parse(sealed(receiptContent, "receiptDigest"));
  const tasks = EXP0001A_QUALIFICATION_V2_TASK_IDS.map((taskId, index) => ({
    ...taskState(taskId, index === 0),
    authorReceipt: index === 0 ? receipt : null,
  })) as ReturnType<typeof taskState>[];
  const state = terminalState(item.gitCommit, item.gitTree, {
    tasks,
    releasedActionDigests: [action.actionDigest],
    retainedTaskReceiptDigests: [receipt.receiptDigest],
  });
  await writePrivateJson(item.statePath, state);
  const artifacts = {
    "external-action.json": action,
    "release-journal.json": releaseJournal,
    "bridge-request.json": bridgeRequest,
    "bridge-authorization.json": bridgeAuthorization,
    "bridge-result.json": bridgeResult,
    "create-observation.json": createObservation,
    "list-observation.json": listObservation,
    "wait-observation.json": waitObservation,
    "read-observation.json": readObservation,
    "external-task-receipt.json": receipt,
  } as const;
  const artifactPaths = Object.fromEntries(Object.entries(artifacts).map(([name]) => [
    name,
    path.join(item.evidenceDirectory, name),
  ])) as Record<keyof typeof artifacts, string>;
  await Promise.all(Object.entries(artifacts).map(([name, value]) => (
    writePrivateJson(artifactPaths[name as keyof typeof artifacts], value)
  )));
  return { ...item, state, artifacts, artifactPaths };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("qualification v2 terminal evidence attestation", () => {
  it("binds inline capture authorization and release evidence from the exact controller request", () => {
    const request = {
      operation: "capture_author_evidence" as const,
      at: "2026-08-31T20:05:00.000Z",
      roomReceiptPath: "/tmp/room-receipt.json",
      provisionControllerReceiptPath: "/tmp/provision-controller-receipt.json",
      storageStatePath: "/tmp/authorized-storage-state.json",
      outputDirectory: "/tmp/capture",
    };
    const authorizationContent = {
      schemaVersion: "exp-0001a-qualification-capture-authorization/v2" as const,
      taskId: "dev-architecture-create-checkout" as const,
      preparedAt: "2026-08-31T20:05:00.000Z",
      captureNonce: digest("1"),
      roomReceiptDigest: digest("4"),
      provisionControllerReceiptDigest: digest("5"),
      storageStateDigest: digest("6"),
      request,
      requestBindingDigest: hashCanonicalJson(request as unknown as JsonValue),
    };
    const authorization = {
      ...authorizationContent,
      actionDigest: hashCanonicalJson(authorizationContent as unknown as JsonValue),
    };
    const releaseContent = {
      schemaVersion: "exp-0001a-qualification-capture-release-journal/v2" as const,
      captureActionDigest: authorization.actionDigest,
      captureNonce: authorization.captureNonce,
      requestBindingDigest: authorization.requestBindingDigest,
      invocationOrdinal: 1 as const,
      invokedAt: "2026-08-31T20:05:01.000Z",
      retryPermitted: false as const,
    };
    const releaseJournal = {
      ...releaseContent,
      journalDigest: hashCanonicalJson(releaseContent as unknown as JsonValue),
    };

    expect(qualificationV2EvidenceArtifactReferences({
      operation: "capture_author_evidence",
      captureAuthorization: authorization,
      captureReleaseJournal: releaseJournal,
    })).toEqual({
      bindings: [
        { kind: "capture_authorization", digest: authorization.actionDigest },
        { kind: "capture_release_journal", digest: releaseJournal.journalDigest },
      ],
      requirements: [
        { kind: "canonical_json", digest: authorization.storageStateDigest },
        { kind: "capture_authorization", digest: authorization.actionDigest },
        { kind: "provision_controller_receipt", digest: authorization.provisionControllerReceiptDigest },
        { kind: "room_receipt", digest: authorization.roomReceiptDigest },
      ],
    });
  });

  it("creates and exactly replays a complete private evidence inventory in a clean ignored repository", async () => {
    const item = await fixture();
    const attestation = await createQualificationV2TerminalEvidenceAttestation({
      repositoryRoot: item.repositoryRoot,
      statePath: item.statePath,
      excludedPaths: [],
      attestedAt: ATTESTED_AT,
    });

    expect(attestation).toMatchObject({
      terminalStateDigest: item.state.stateDigest,
      harnessGitCommit: item.gitCommit,
      harnessGitTree: item.gitTree,
      worktreeClean: true,
      evidenceFileCount: 1,
    });
    expect(attestation.evidenceFiles.map((entry) => entry.relativePath))
      .toEqual(["evidence/provenance.json"]);
    await expect(verifyQualificationV2TerminalEvidenceAttestation({
      repositoryRoot: item.repositoryRoot,
      statePath: item.statePath,
      excludedPaths: [],
      attestation,
    })).resolves.toEqual(attestation);
  });

  it("rejects evidence mutation during replay, digest-mention filler, and removal during creation", async () => {
    const item = await fixture();
    const attestation = await createQualificationV2TerminalEvidenceAttestation({
      repositoryRoot: item.repositoryRoot,
      statePath: item.statePath,
      excludedPaths: [],
      attestedAt: ATTESTED_AT,
    });
    const retained = JSON.parse(await readFile(item.evidencePath, "utf8")) as Record<string, unknown>;
    await writeFile(item.evidencePath, `${JSON.stringify(retained, null, 2)}\n`, { mode: 0o600 });
    await chmod(item.evidencePath, 0o600);
    await expect(verifyQualificationV2TerminalEvidenceAttestation({
      repositoryRoot: item.repositoryRoot,
      statePath: item.statePath,
      excludedPaths: [],
      attestation,
    })).rejects.toThrow("QUALIFICATION_V2_ATTESTATION_REPLAY_MISMATCH");

    await writePrivateJson(item.evidencePath, {
      claimedRequiredDigest: hashCanonicalJson(
        item.state.controllerHarnessRuntimeProvenance as unknown as JsonValue,
      ),
    });
    await expect(createQualificationV2TerminalEvidenceAttestation({
      repositoryRoot: item.repositoryRoot,
      statePath: item.statePath,
      excludedPaths: [],
      attestedAt: ATTESTED_AT,
    })).rejects.toThrow("QUALIFICATION_V2_ATTESTATION_REQUIRED_EVIDENCE_MISSING");

    await unlink(item.evidencePath);
    await expect(createQualificationV2TerminalEvidenceAttestation({
      repositoryRoot: item.repositoryRoot,
      statePath: item.statePath,
      excludedPaths: [],
      attestedAt: ATTESTED_AT,
    })).rejects.toThrow();
  });

  it("rejects private-root symlinks and state paths that escape the private root", async () => {
    const item = await fixture();
    const outsidePath = path.join(item.repositoryRoot, ".research-private", "outside.json");
    await writeFile(outsidePath, "{}\n", { mode: 0o600 });
    await chmod(outsidePath, 0o600);
    await symlink(outsidePath, path.join(item.evidenceDirectory, "escape.json"));
    await expect(createQualificationV2TerminalEvidenceAttestation({
      repositoryRoot: item.repositoryRoot,
      statePath: item.statePath,
      excludedPaths: [],
      attestedAt: ATTESTED_AT,
    })).rejects.toThrow("QUALIFICATION_V2_ATTESTATION_SYMLINK_FORBIDDEN");

    await expect(createQualificationV2TerminalEvidenceAttestation({
      repositoryRoot: item.repositoryRoot,
      statePath: outsidePath,
      excludedPaths: [],
      attestedAt: ATTESTED_AT,
    })).rejects.toThrow("QUALIFICATION_V2_ATTESTATION_PATH_NOT_PRIVATE");
  });

  it("rejects evidence files and directories with unsafe permissions", async () => {
    const fileItem = await fixture();
    await chmod(fileItem.evidencePath, 0o644);
    await expect(createQualificationV2TerminalEvidenceAttestation({
      repositoryRoot: fileItem.repositoryRoot,
      statePath: fileItem.statePath,
      excludedPaths: [],
      attestedAt: ATTESTED_AT,
    })).rejects.toThrow("QUALIFICATION_V2_ATTESTATION_FILE_UNSAFE");

    const directoryItem = await fixture();
    await chmod(directoryItem.evidenceDirectory, 0o755);
    await expect(createQualificationV2TerminalEvidenceAttestation({
      repositoryRoot: directoryItem.repositoryRoot,
      statePath: directoryItem.statePath,
      excludedPaths: [],
      attestedAt: ATTESTED_AT,
    })).rejects.toThrow("QUALIFICATION_V2_ATTESTATION_DIRECTORY_UNSAFE");
  });

  it("binds replay to the terminal state and creation to the committed harness provenance", async () => {
    const item = await fixture();
    const attestation = await createQualificationV2TerminalEvidenceAttestation({
      repositoryRoot: item.repositoryRoot,
      statePath: item.statePath,
      excludedPaths: [],
      attestedAt: ATTESTED_AT,
    });
    const changedState = terminalState(item.gitCommit, item.gitTree, {
      updatedAt: "2026-08-31T20:10:30.000Z",
    });
    await writePrivateJson(item.statePath, changedState);
    await expect(verifyQualificationV2TerminalEvidenceAttestation({
      repositoryRoot: item.repositoryRoot,
      statePath: item.statePath,
      excludedPaths: [],
      attestation,
    })).rejects.toThrow("QUALIFICATION_V2_ATTESTATION_REPLAY_MISMATCH");

    const driftedState = terminalState("f".repeat(40), item.gitTree);
    await writePrivateJson(item.statePath, driftedState);
    await expect(createQualificationV2TerminalEvidenceAttestation({
      repositoryRoot: item.repositoryRoot,
      statePath: item.statePath,
      excludedPaths: [],
      attestedAt: ATTESTED_AT,
    })).rejects.toThrow("QUALIFICATION_V2_ATTESTATION_HARNESS_PROVENANCE_DRIFT");
  });

  it("requires every retained leaf in a completed Codex task transport chain", async () => {
    const item = await completedTransportChainFixture();
    await expect(createQualificationV2TerminalEvidenceAttestation({
      repositoryRoot: item.repositoryRoot,
      statePath: item.statePath,
      excludedPaths: [],
      attestedAt: ATTESTED_AT,
    })).resolves.toMatchObject({ terminalStateDigest: item.state.stateDigest });

    const requiredLeaves = [
      "release-journal.json",
      "bridge-authorization.json",
      "bridge-result.json",
      "create-observation.json",
      "list-observation.json",
      "wait-observation.json",
      "read-observation.json",
      "external-task-receipt.json",
    ] as const;
    for (const name of requiredLeaves) {
      await unlink(item.artifactPaths[name]);
      await expect(createQualificationV2TerminalEvidenceAttestation({
        repositoryRoot: item.repositoryRoot,
        statePath: item.statePath,
        excludedPaths: [],
        attestedAt: ATTESTED_AT,
      }), name).rejects.toThrow("QUALIFICATION_V2_ATTESTATION_REQUIRED_EVIDENCE_MISSING");
      await writePrivateJson(item.artifactPaths[name], item.artifacts[name]);
    }
  });

  it("allows a byte-identical operator export of an authoritative bridge request", async () => {
    const item = await completedTransportChainFixture();
    await writePrivateJson(
      path.join(item.evidenceDirectory, "bridge-request-operator-export.json"),
      item.artifacts["bridge-request.json"],
    );

    const attestation = await createQualificationV2TerminalEvidenceAttestation({
      repositoryRoot: item.repositoryRoot,
      statePath: item.statePath,
      excludedPaths: [],
      attestedAt: ATTESTED_AT,
    });
    expect(attestation.requiredEvidenceArtifacts).toContainEqual({
      kind: "bridge_request",
      digest: item.artifacts["bridge-request.json"].requestDigest,
    });
    expect(attestation.evidenceFiles.map((entry) => entry.relativePath)).toContain(
      "evidence/bridge-request-operator-export.json",
    );
  });
});
