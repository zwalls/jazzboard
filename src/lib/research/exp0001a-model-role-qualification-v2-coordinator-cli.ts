import { constants as fsConstants } from "node:fs";
import { link, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import {
  acknowledgeQualificationV2CaptureDispatch,
  compileQualificationV2PublicTasksFromExecutionBundle,
  initializeQualificationV2Coordinator,
  prepareQualificationV2CaptureAction,
  prepareQualificationV2AuthorAction,
  prepareQualificationV2ReviewAction,
  qualificationV2BlindedReviewEnvelopeSchema,
  qualificationV2CoordinatorStateSchema,
  qualificationV2ProductionBindingSchema,
  qualificationV2RoomReceiptSchema,
  recordQualificationV2CaptureIndeterminate,
  retainQualificationV2AuthorEvidence,
  retainQualificationV2CaptureTerminalReceipt,
  retainQualificationV2Room,
  resumeQualificationV2AfterUsageLimit,
  sealQualificationV2Result,
} from "./exp0001a-model-role-qualification-v2-coordinator";
import {
  exp0001aModelRoleQualificationV2PlanSchema,
} from "./exp0001a-model-role-qualification-v2";
import { exp0001aQualificationV2AuthoritySignatureSchema } from "./exp0001a-model-role-qualification-v2-authority";
import {
  baselineFreezeReceiptV2Schema,
  verifyBaselineV2ExecutionReady,
} from "./baseline-freeze-v2";
import {
  baselineFreezeV2AuthoritySignatureSchema,
  verifyBaselineFreezeV2AuthoritySignature,
} from "./baseline-freeze-v2-authority";
import { canonicalJson, hashCanonicalJson, sha256Digest, type JsonValue } from "./provenance-crypto";
import { deriveQualificationV2AuthorEvidence } from "./exp0001a-model-role-qualification-v2-author-evidence";
import {
  parseQualificationV2CaptureControllerReceipt,
  parseQualificationV2CaptureTerminalReceipt,
  parseQualificationV2ProvisionControllerReceipt,
} from "./exp0001a-model-role-qualification-v2-room-controller-receipts";
import {
  createQualificationV2TerminalEvidenceAttestation,
} from "./exp0001a-model-role-qualification-v2-result-attestation";

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

const absolutePathSchema = z.string().refine((value) => (
  path.isAbsolute(value) && path.normalize(value) === value && value !== path.parse(value).root
), "Path must be absolute, normalized, and non-root.");

const commonSchema = z.object({
  statePath: absolutePathSchema,
  at: z.string().datetime({ offset: true }),
}).strict();

const requestSchema = z.discriminatedUnion("operation", [
  commonSchema.extend({
    operation: z.literal("initialize"),
    planPath: absolutePathSchema,
    planSignaturePath: absolutePathSchema,
    productionBindingPath: absolutePathSchema,
    productionBindingSignaturePath: absolutePathSchema,
    baselineReceiptPath: absolutePathSchema,
    baselineSignaturePath: absolutePathSchema,
    baselineArtifacts: z.object({
      inventoryPath: absolutePathSchema,
      evidencePath: absolutePathSchema,
      captureScriptPath: absolutePathSchema,
      privateInventoryPath: absolutePathSchema,
      semanticArtifactPath: absolutePathSchema,
      semanticHandlerPath: absolutePathSchema,
      authoritativeStatePath: absolutePathSchema,
      captureHistoryPath: absolutePathSchema,
      exactRevisionPngPath: absolutePathSchema,
      authorityPublicKeyPath: absolutePathSchema,
    }).strict(),
    benchmarkPath: absolutePathSchema,
    rubricsPath: absolutePathSchema,
    fixtureSpecsPath: absolutePathSchema,
  }).strict(),
  commonSchema.extend({
    operation: z.literal("retain_room"),
    receiptPath: absolutePathSchema,
    provisionControllerReceiptPath: absolutePathSchema,
    createRoomCallResultPath: absolutePathSchema,
    blankReadRoomStateCallResultPath: absolutePathSchema,
    fixtureTransactionCallResultPath: absolutePathSchema.optional(),
    preAuthorReadRoomStateCallResultPath: absolutePathSchema,
    authorizedStorageStatePath: absolutePathSchema,
  }).strict(),
  commonSchema.extend({
    operation: z.literal("prepare_author"),
    benchmarkPath: absolutePathSchema,
    rubricsPath: absolutePathSchema,
    fixtureSpecsPath: absolutePathSchema,
  }).strict(),
  commonSchema.extend({
    operation: z.literal("prepare_capture"),
    roomReceiptPath: absolutePathSchema,
    provisionControllerReceiptPath: absolutePathSchema,
    storageStatePath: absolutePathSchema,
    outputDirectory: absolutePathSchema,
  }).strict(),
  commonSchema.extend({
    operation: z.literal("ack_capture_dispatch"),
    controllerRequestOutputPath: absolutePathSchema,
  }).strict(),
  commonSchema.extend({
    operation: z.literal("retain_capture_terminal"),
    terminalReceiptPath: absolutePathSchema,
    captureControllerReceiptPath: absolutePathSchema.optional(),
  }).strict(),
  commonSchema.extend({ operation: z.literal("record_capture_indeterminate") }).strict(),
  commonSchema.extend({ operation: z.literal("prepare_review"), reviewEnvelopePath: absolutePathSchema }).strict(),
  commonSchema.extend({ operation: z.literal("resume_after_usage_limit") }).strict(),
  commonSchema.extend({
    operation: z.literal("derive_author_evidence"),
    waitThreadResultPaths: z.array(absolutePathSchema).min(1).max(100),
    readThreadResultPaths: z.array(absolutePathSchema).min(1).max(100),
    provisionControllerReceiptPath: absolutePathSchema,
    captureControllerReceiptPath: absolutePathSchema,
    preAuthorReadRoomStateCallResultPath: absolutePathSchema,
    closingRoomReadCallResultPath: absolutePathSchema,
    inspectionCallResultPath: absolutePathSchema,
    pngExportCallResultPath: absolutePathSchema,
    authorEvidenceOutputPath: absolutePathSchema,
    sanitizedSemanticStateOutputPath: absolutePathSchema,
    exactRevisionPngOutputPath: absolutePathSchema,
  }).strict(),
  commonSchema.extend({
    operation: z.literal("seal_result"),
    outputPath: absolutePathSchema,
    attestationOutputPath: absolutePathSchema,
  }).strict(),
]);

async function readPlainFile(filePath: string, label: string, mode: number | null = null) {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error(`${label} must be a singly linked plain file.`);
  }
  if (mode !== null && (metadata.mode & 0o777) !== mode) throw new Error(`${label} must have mode ${mode.toString(8)}.`);
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try { return await handle.readFile(); } finally { await handle.close(); }
}

async function readJson(filePath: string, label: string, mode: number | null = null) {
  const bytes = await readPlainFile(filePath, label, mode);
  try { return { bytes, value: JSON.parse(bytes.toString("utf8")) as unknown }; } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

function parseRetainedWebMcpTextCallResult(value: unknown, label: string) {
  const envelope = z.object({
    isError: z.literal(false),
    content: z.tuple([z.object({ type: z.literal("text"), text: z.string() }).strict()]),
  }).strict().parse(value);
  let result: unknown;
  try { result = JSON.parse(envelope.content[0].text) as unknown; } catch {
    throw new Error(`QUALIFICATION_V2_${label}_TEXT_NOT_JSON`);
  }
  return z.object({
    ok: z.literal(true),
    tool: z.string().min(1),
    data: z.record(z.string(), z.unknown()),
  }).passthrough().parse(result);
}

function roomStateEvidence(result: ReturnType<typeof parseRetainedWebMcpTextCallResult>, label: string) {
  if (result.tool !== "read_room_state") throw new Error(`QUALIFICATION_V2_${label}_TOOL_INVALID`);
  const data = z.object({
    room: z.object({ id: z.string().min(1), code: z.string().min(1), roomRevision: z.number().int().nonnegative() }).passthrough(),
    objects: z.array(z.unknown()),
    diagrams: z.array(z.unknown()),
  }).passthrough().parse(result.data);
  return data;
}

async function assertPrivateStatePath(repositoryRoot: string, statePath: string) {
  const privateRoot = path.join(repositoryRoot, ".research-private", "exp0001a-qualification-v2");
  const rootMetadata = await lstat(privateRoot);
  const resolvedPrivateRoot = await realpath(privateRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()
      || (rootMetadata.mode & 0o777) !== 0o700) {
    throw new Error("QUALIFICATION_V2_PRIVATE_ROOT_UNSAFE");
  }
  const absolute = path.resolve(statePath);
  const relative = path.relative(privateRoot, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative) || relative.length === 0) {
    throw new Error("QUALIFICATION_V2_STATE_MUST_BE_PRIVATE");
  }
  let current = privateRoot;
  let resolvedCurrent = resolvedPrivateRoot;
  const segments = relative.split(path.sep);
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    resolvedCurrent = path.join(resolvedCurrent, segment);
    const metadata = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (metadata === null) break;
    if (!metadata.isDirectory() || metadata.isSymbolicLink()
        || (metadata.mode & 0o777) !== 0o700 || await realpath(current) !== resolvedCurrent) {
      throw new Error("QUALIFICATION_V2_PRIVATE_PARENT_UNSAFE");
    }
  }
  const leaf = await lstat(absolute).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (leaf !== null && leaf.isSymbolicLink()) throw new Error("QUALIFICATION_V2_PRIVATE_LEAF_SYMLINK_FORBIDDEN");
}

async function writeAtomic(filePath: string, value: unknown, replace: boolean) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const existing = await lstat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!replace && existing !== null) throw new Error("QUALIFICATION_V2_OUTPUT_ALREADY_EXISTS");
  if (existing !== null && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1
      || (existing.mode & 0o777) !== 0o600)) {
    throw new Error("QUALIFICATION_V2_EXISTING_STATE_UNSAFE");
  }
  const temporary = path.join(path.dirname(filePath), `.qualification-v2-state-${randomUUID()}.tmp`);
  const bytes = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  const handle = await open(
    temporary,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, filePath);
  const readback = await readPlainFile(filePath, "Qualification-v2 retained output", 0o600);
  if (!readback.equals(bytes)) throw new Error("QUALIFICATION_V2_STATE_READBACK_MISMATCH");
}

async function writeAtomicBytes(filePath: string, bytes: Buffer, replace: boolean) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const existing = await lstat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!replace && existing !== null) throw new Error("QUALIFICATION_V2_OUTPUT_ALREADY_EXISTS");
  const temporary = path.join(path.dirname(filePath), `.qualification-v2-bytes-${randomUUID()}.tmp`);
  const handle = await open(
    temporary,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, filePath);
}

async function writeExclusiveOrVerify(filePath: string, value: unknown) {
  const expected = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(filePath), `.qualification-v2-seal-${randomUUID()}.tmp`);
  const handle = await open(
    temporary,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try { await handle.writeFile(expected); await handle.sync(); } finally { await handle.close(); }
  try {
    await link(temporary, filePath);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    const existing = await readPlainFile(filePath, "Qualification-v2 retained output", 0o600);
    if (!existing.equals(expected)) throw new Error("QUALIFICATION_V2_OUTPUT_ALREADY_EXISTS_DIFFERENT");
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  const readback = await readPlainFile(filePath, "Qualification-v2 retained output", 0o600);
  if (!readback.equals(expected)) throw new Error("QUALIFICATION_V2_OUTPUT_READBACK_MISMATCH");
}

async function readState(statePath: string) {
  const { value } = await readJson(statePath, "Qualification-v2 coordinator state", 0o600);
  return qualificationV2CoordinatorStateSchema.parse(value);
}

function publicStatus(state: z.infer<typeof qualificationV2CoordinatorStateSchema>) {
  const task = state.currentTaskIndex < state.tasks.length ? state.tasks[state.currentTaskIndex] : null;
  return {
    status: "retained",
    stateDigest: state.stateDigest,
    currentTaskIndex: state.currentTaskIndex,
    currentTaskId: task?.taskId ?? null,
    phase: task?.phase ?? "complete",
    stopped: state.stopped,
    stopReason: state.stopReason,
    pendingAction: state.pendingAction === null ? null : {
      actionDigest: state.pendingAction.actionDigest,
      toolName: state.pendingAction.toolName,
      role: state.pendingAction.role,
      roleOrdinal: state.pendingAction.roleOrdinal,
      model: state.pendingAction.arguments.model,
      reasoningEffort: state.pendingAction.arguments.thinking,
      targetType: state.pendingAction.arguments.target.type,
      privateArgumentsRetainedInState: true,
    },
    capture: task?.captureAuthorization === null || task === null ? null : {
      actionDigest: task.captureAuthorization.actionDigest,
      releaseJournalDigest: task.captureReleaseJournal?.journalDigest ?? null,
      terminalOutcome: task.captureTerminalReceipt?.outcome ?? null,
      privateRequestRetainedInState: true,
    },
  };
}

export async function runQualificationV2CoordinatorCli(
  argv: readonly string[],
  io: { stdout: Pick<NodeJS.WriteStream, "write">; stderr: Pick<NodeJS.WriteStream, "write"> },
  repositoryRoot: string,
  dependencies: Readonly<{
    runAuthPreflightForTesting?: () => Promise<unknown>;
    nowForTesting?: () => string;
  }> = {},
) {
  let incidentStatePath: string | null = null;
  let incidentOperation: string | null = null;
  try {
    if (argv.length !== 2 || argv[0] !== "--request") throw new Error("Usage: --request /absolute/private-request.json");
    const requestPath = absolutePathSchema.parse(argv[1]);
    await assertPrivateStatePath(repositoryRoot, requestPath);
    const { value: requestRaw } = await readJson(requestPath, "Qualification-v2 coordinator request", 0o600);
    const request = requestSchema.parse(requestRaw);
    await assertPrivateStatePath(repositoryRoot, request.statePath);
    incidentStatePath = request.statePath;
    incidentOperation = request.operation;
    let state;
    let deferredControllerRequest: Readonly<{ outputPath: string; value: unknown }> | null = null;
    if (request.operation === "initialize") {
      const [planRaw, planSignatureRaw, bindingRaw, bindingSignatureRaw, baselineRaw, baselineSignatureRaw, benchmarkRaw,
        rubricsRaw, fixtureSpecsRaw,
        inventoryRaw, evidenceRaw, captureScriptBytes, privateInventoryBytes, semanticArtifactBytes,
        semanticHandlerBytes, authoritativeStateBytes, captureHistoryBytes, pngBytes, publicKeyBytes] = await Promise.all([
        readJson(request.planPath, "Qualification-v2 plan"),
        readJson(request.planSignaturePath, "Qualification-v2 plan signature"),
        readJson(request.productionBindingPath, "Qualification-v2 production binding"),
        readJson(request.productionBindingSignaturePath, "Qualification-v2 production-binding signature"),
        readJson(request.baselineReceiptPath, "Baseline-v2 receipt"),
        readJson(request.baselineSignaturePath, "Baseline-v2 signature"),
        readJson(request.benchmarkPath, "Development-v2 benchmark"),
        readJson(request.rubricsPath, "Development-v2 rubrics"),
        readJson(request.fixtureSpecsPath, "Development-v2 fixture specs"),
        readJson(request.baselineArtifacts.inventoryPath, "Baseline-v2 inventory"),
        readJson(request.baselineArtifacts.evidencePath, "Baseline-v2 evidence"),
        readPlainFile(request.baselineArtifacts.captureScriptPath, "Baseline-v2 capture script"),
        readPlainFile(request.baselineArtifacts.privateInventoryPath, "Baseline-v2 private inventory"),
        readPlainFile(request.baselineArtifacts.semanticArtifactPath, "Baseline-v2 semantic artifact"),
        readPlainFile(request.baselineArtifacts.semanticHandlerPath, "Baseline-v2 semantic handler response"),
        readPlainFile(request.baselineArtifacts.authoritativeStatePath, "Baseline-v2 authoritative state"),
        readPlainFile(request.baselineArtifacts.captureHistoryPath, "Baseline-v2 capture history"),
        readPlainFile(request.baselineArtifacts.exactRevisionPngPath, "Baseline-v2 exact-revision PNG"),
        readPlainFile(request.baselineArtifacts.authorityPublicKeyPath, "Baseline-v2 authority public key"),
      ]);
      const plan = exp0001aModelRoleQualificationV2PlanSchema.parse(planRaw.value);
      const binding = qualificationV2ProductionBindingSchema.parse(bindingRaw.value);
      const baselineReceipt = baselineFreezeReceiptV2Schema.parse(baselineRaw.value);
      const baselineSignature = baselineFreezeV2AuthoritySignatureSchema.parse(baselineSignatureRaw.value);
      verifyBaselineFreezeV2AuthoritySignature({
        receipt: baselineReceipt as unknown as JsonValue,
        signature: baselineSignature,
        notBefore: baselineReceipt.frozenAt,
      });
      const baselineVerification = verifyBaselineV2ExecutionReady(
        baselineReceipt,
        inventoryRaw.value,
        evidenceRaw.value,
        {
          receiptFileBytes: baselineRaw.bytes,
          inventoryFileBytes: inventoryRaw.bytes,
          evidenceFileBytes: evidenceRaw.bytes,
          captureScriptBytes,
          privateInventoryFileBytes: privateInventoryBytes,
          semanticArtifactFileBytes: semanticArtifactBytes,
          semanticHandlerFileBytes: semanticHandlerBytes,
          authoritativeStateFileBytes: authoritativeStateBytes,
          captureHistoryFileBytes: captureHistoryBytes,
          exactRevisionPngBytes: pngBytes,
          authoritySignature: baselineSignature,
          authoritySignatureFileBytes: baselineSignatureRaw.bytes,
          authorityPublicKeyFileBytes: publicKeyBytes,
        },
      );
      if (!baselineVerification.ok) {
        throw new Error(`QUALIFICATION_V2_BASELINE_NOT_EXECUTION_READY:${baselineVerification.errors.join("|")}`);
      }
      const baselineInventory = z.object({
        participant: z.object({ contractDigest: digestSchema }).passthrough(),
      }).passthrough().parse(inventoryRaw.value);
      if (baselineReceipt.receiptDigest !== binding.baselineFreezeDigest
          || hashCanonicalJson(baselineSignature as unknown as JsonValue) !== binding.baselineAuthoritySignatureDigest
          || Date.parse(binding.verifiedAt) < Date.parse(baselineSignature.signedAt)) {
        throw new Error("QUALIFICATION_V2_BASELINE_BINDING_INVALID");
      }
      const executionBundle = compileQualificationV2PublicTasksFromExecutionBundle(
        benchmarkRaw.value,
        rubricsRaw.value,
        fixtureSpecsRaw.value,
      );
      state = initializeQualificationV2Coordinator({
        createdAt: request.at,
        plan,
        planAuthoritySignature: exp0001aQualificationV2AuthoritySignatureSchema.parse(planSignatureRaw.value),
        productionBinding: binding,
        productionBindingAuthoritySignature: exp0001aQualificationV2AuthoritySignatureSchema.parse(bindingSignatureRaw.value),
        publicTasks: executionBundle.publicTasks,
        benchmark: benchmarkRaw.value,
        rubrics: rubricsRaw.value,
        fixtureSpecs: fixtureSpecsRaw.value,
        baselineParticipantToolContractDigest: baselineInventory.participant.contractDigest,
      });
      await writeAtomic(request.statePath, state, false);
    } else if (request.operation === "seal_result") {
      const current = await readState(request.statePath);
      await assertPrivateStatePath(repositoryRoot, request.outputPath);
      await assertPrivateStatePath(repositoryRoot, request.attestationOutputPath);
      const attestation = await createQualificationV2TerminalEvidenceAttestation({
        repositoryRoot,
        statePath: request.statePath,
        excludedPaths: [request.outputPath, request.attestationOutputPath],
        attestedAt: request.at,
      });
      const result = sealQualificationV2Result(current, request.at, attestation);
      await writeExclusiveOrVerify(request.attestationOutputPath, attestation);
      await writeExclusiveOrVerify(request.outputPath, result);
      io.stdout.write(`${canonicalJson({
        status: "sealed",
        resultDigest: result.resultDigest,
        terminalEvidenceAttestationDigest: attestation.attestationDigest,
      })}\n`);
      return 0;
    } else {
      const current = await readState(request.statePath);
      if (request.operation === "retain_room") {
        for (const privatePath of [
          request.receiptPath,
          request.provisionControllerReceiptPath,
          request.createRoomCallResultPath,
          request.blankReadRoomStateCallResultPath,
          ...(request.fixtureTransactionCallResultPath === undefined ? [] : [request.fixtureTransactionCallResultPath]),
          request.preAuthorReadRoomStateCallResultPath,
          request.authorizedStorageStatePath,
        ]) await assertPrivateStatePath(repositoryRoot, privatePath);
        const [roomReceiptRaw, provisionControllerReceiptRaw, createRoomRaw, blankReadRaw, preAuthorReadRaw,
          storageStateRaw] = await Promise.all([
          readJson(request.receiptPath, "Private room receipt", 0o600),
          readJson(request.provisionControllerReceiptPath, "Provision-controller receipt", 0o600),
          readJson(request.createRoomCallResultPath, "create_room CallToolResult", 0o600),
          readJson(request.blankReadRoomStateCallResultPath, "Blank read_room_state CallToolResult", 0o600),
          readJson(request.preAuthorReadRoomStateCallResultPath, "Pre-author read_room_state CallToolResult", 0o600),
          readJson(request.authorizedStorageStatePath, "Authorized browser storage state", 0o600),
        ]);
        const roomReceipt = qualificationV2RoomReceiptSchema.parse(roomReceiptRaw.value);
        const provisionControllerReceipt = parseQualificationV2ProvisionControllerReceipt(
          provisionControllerReceiptRaw.value,
        );
        const task = current.tasks[current.currentTaskIndex];
        if (task === undefined) throw new Error("QUALIFICATION_V2_RETAIN_ROOM_TASK_MISSING");
        const fixtureTransactionRaw = request.fixtureTransactionCallResultPath === undefined
          ? null
          : await readJson(request.fixtureTransactionCallResultPath, "Fixture transaction CallToolResult", 0o600);
        const createRoomResult = parseRetainedWebMcpTextCallResult(createRoomRaw.value, "CREATE_ROOM");
        const blankState = roomStateEvidence(
          parseRetainedWebMcpTextCallResult(blankReadRaw.value, "BLANK_READ_ROOM_STATE"),
          "BLANK_READ_ROOM_STATE",
        );
        const preAuthorResult = parseRetainedWebMcpTextCallResult(
          preAuthorReadRaw.value,
          "PRE_AUTHOR_READ_ROOM_STATE",
        );
        const preAuthorState = roomStateEvidence(preAuthorResult, "PRE_AUTHOR_READ_ROOM_STATE");
        const createdRoom = z.object({ id: z.string().min(1), code: z.string().regex(/^[A-HJ-NP-Z2-9]{6}$/) })
          .passthrough().parse(z.object({ room: z.unknown() }).passthrough().parse(createRoomResult.data).room);
        if (createRoomResult.tool !== "create_room"
            || roomReceipt.taskId !== task.taskId
            || provisionControllerReceipt.taskId !== task.taskId
            || provisionControllerReceipt.roomReceiptDigest !== roomReceipt.receiptDigest
            || provisionControllerReceipt.deploymentId !== current.productionBinding.deploymentId
            || provisionControllerReceipt.participantToolContractDigest
              !== current.baselineParticipantToolContractDigest
            || provisionControllerReceipt.createRoomCallResultDigest
              !== hashCanonicalJson(createRoomRaw.value as JsonValue)
            || provisionControllerReceipt.blankReadCallResultDigest
              !== hashCanonicalJson(blankReadRaw.value as JsonValue)
            || provisionControllerReceipt.preAuthorReadCallResultDigest
              !== hashCanonicalJson(preAuthorReadRaw.value as JsonValue)
            || provisionControllerReceipt.storageStateDigest
              !== hashCanonicalJson(storageStateRaw.value as JsonValue)
            || provisionControllerReceipt.fixtureTransactionCallResultDigest
              !== (fixtureTransactionRaw === null ? null : hashCanonicalJson(fixtureTransactionRaw.value as JsonValue))
            || provisionControllerReceipt.frozenFixtureDeclarationDigest
              !== task.expectedCompiledFixtureInputDigest
            || provisionControllerReceipt.authoritativeInitialStateDigest
              !== hashCanonicalJson(preAuthorResult.data as unknown as JsonValue)
            || provisionControllerReceipt.initialRoomRevision !== roomReceipt.initialRoomRevision
            || provisionControllerReceipt.initialObjectCount !== roomReceipt.initialObjectCount
            || roomReceipt.roomId !== createdRoom.id
            || roomReceipt.privateRoomInviteUrl !== `https://www.jazzboard.xyz/#join=${createdRoom.code}`
            || roomReceipt.roomCreationReceiptDigest
              !== hashCanonicalJson(createRoomResult as unknown as JsonValue)
            || blankState.room.id !== roomReceipt.roomId || blankState.objects.length !== 0
            || blankState.diagrams.length !== 0
            || preAuthorState.room.id !== roomReceipt.roomId
            || preAuthorState.room.roomRevision !== roomReceipt.initialRoomRevision
            || preAuthorState.objects.length !== roomReceipt.initialObjectCount
            || Date.parse(provisionControllerReceipt.retainedAt) > Date.parse(request.at)) {
          throw new Error("QUALIFICATION_V2_PROVISION_CONTROLLER_RECEIPT_BINDING_INVALID");
        }
        state = retainQualificationV2Room(
          current,
          roomReceipt,
          provisionControllerReceipt.receiptDigest,
          provisionControllerReceipt.storageStateDigest,
          request.at,
          provisionControllerReceipt.harnessRuntimeProvenance,
        );
      } else if (request.operation === "prepare_author") {
        const [benchmark, rubrics, fixtureSpecs] = await Promise.all([
          readJson(request.benchmarkPath, "Development-v2 benchmark"),
          readJson(request.rubricsPath, "Development-v2 rubrics"),
          readJson(request.fixtureSpecsPath, "Development-v2 fixture specs"),
        ]);
        const executionBundle = compileQualificationV2PublicTasksFromExecutionBundle(
          benchmark.value,
          rubrics.value,
          fixtureSpecs.value,
        );
        const authRuntime = dependencies.runAuthPreflightForTesting === undefined
          ? await import(pathToFileURL(path.join(repositoryRoot, "research/scripts/codex-auth-preflight.mjs")).href)
          : null;
        const authReceipt = dependencies.runAuthPreflightForTesting === undefined
          ? await authRuntime.runCodexAuthPreflight()
          : await dependencies.runAuthPreflightForTesting();
        if (authRuntime !== null) authRuntime.assertCodexNativeExperimentAuthorized(authReceipt);
        const preparedAt = (dependencies.nowForTesting ?? (() => new Date().toISOString()))();
        state = prepareQualificationV2AuthorAction({
          state: current,
          publicTask: executionBundle.publicTasks[current.currentTaskIndex],
          authReceipt,
          preparedAt,
        });
      } else if (request.operation === "prepare_capture") {
        for (const privatePath of [
          request.roomReceiptPath,
          request.provisionControllerReceiptPath,
          request.storageStatePath,
          request.outputDirectory,
        ]) await assertPrivateStatePath(repositoryRoot, privatePath);
        const prepared = prepareQualificationV2CaptureAction({
          state: current,
          preparedAt: request.at,
          request: {
            operation: "capture_author_evidence",
            roomReceiptPath: request.roomReceiptPath,
            provisionControllerReceiptPath: request.provisionControllerReceiptPath,
            storageStatePath: request.storageStatePath,
            outputDirectory: request.outputDirectory,
            at: request.at,
          },
        });
        state = prepared.state;
      } else if (request.operation === "ack_capture_dispatch") {
        await assertPrivateStatePath(repositoryRoot, request.controllerRequestOutputPath);
        const acknowledged = acknowledgeQualificationV2CaptureDispatch(current, request.at);
        state = acknowledged.state;
        deferredControllerRequest = {
          outputPath: request.controllerRequestOutputPath,
          value: acknowledged.controllerRequest,
        };
      } else if (request.operation === "retain_capture_terminal") {
        await assertPrivateStatePath(repositoryRoot, request.terminalReceiptPath);
        if (request.captureControllerReceiptPath !== undefined) {
          await assertPrivateStatePath(repositoryRoot, request.captureControllerReceiptPath);
        }
        const terminalReceipt = parseQualificationV2CaptureTerminalReceipt(
          (await readJson(request.terminalReceiptPath, "Capture terminal receipt", 0o600)).value,
        );
        if ((terminalReceipt.outcome === "succeeded") !== (request.captureControllerReceiptPath !== undefined)) {
          throw new Error("QUALIFICATION_V2_CAPTURE_TERMINAL_CONTROLLER_RECEIPT_PRESENCE_INVALID");
        }
        if (request.captureControllerReceiptPath !== undefined) {
          const captureControllerReceipt = parseQualificationV2CaptureControllerReceipt(
            (await readJson(request.captureControllerReceiptPath, "Capture-controller receipt", 0o600)).value,
          );
          if (captureControllerReceipt.receiptDigest !== terminalReceipt.captureControllerReceiptDigest) {
            throw new Error("QUALIFICATION_V2_CAPTURE_TERMINAL_CONTROLLER_RECEIPT_DIGEST_INVALID");
          }
        }
        state = retainQualificationV2CaptureTerminalReceipt(current, terminalReceipt, request.at);
      } else if (request.operation === "record_capture_indeterminate") {
        state = recordQualificationV2CaptureIndeterminate(current, request.at);
      } else if (request.operation === "prepare_review") {
        await assertPrivateStatePath(repositoryRoot, request.reviewEnvelopePath);
        const envelope = qualificationV2BlindedReviewEnvelopeSchema.parse(
          (await readJson(request.reviewEnvelopePath, "Blinded review envelope", 0o600)).value,
        );
        const authRuntime = dependencies.runAuthPreflightForTesting === undefined
          ? await import(pathToFileURL(path.join(repositoryRoot, "research/scripts/codex-auth-preflight.mjs")).href)
          : null;
        const authReceipt = dependencies.runAuthPreflightForTesting === undefined
          ? await authRuntime.runCodexAuthPreflight()
          : await dependencies.runAuthPreflightForTesting();
        if (authRuntime !== null) authRuntime.assertCodexNativeExperimentAuthorized(authReceipt);
        const preparedAt = (dependencies.nowForTesting ?? (() => new Date().toISOString()))();
        state = prepareQualificationV2ReviewAction({
          state: current,
          authReceipt,
          preparedAt,
          reviewEnvelope: envelope,
        });
      } else if (request.operation === "resume_after_usage_limit") {
        const authRuntime = dependencies.runAuthPreflightForTesting === undefined
          ? await import(pathToFileURL(path.join(repositoryRoot, "research/scripts/codex-auth-preflight.mjs")).href)
          : null;
        const authReceipt = dependencies.runAuthPreflightForTesting === undefined
          ? await authRuntime.runCodexAuthPreflight()
          : await dependencies.runAuthPreflightForTesting();
        if (authRuntime !== null) authRuntime.assertCodexNativeExperimentAuthorized(authReceipt);
        const resumedAt = (dependencies.nowForTesting ?? (() => new Date().toISOString()))();
        state = resumeQualificationV2AfterUsageLimit(current, resumedAt, authReceipt);
      } else if (request.operation === "derive_author_evidence") {
        for (const privatePath of [
          ...request.waitThreadResultPaths,
          ...request.readThreadResultPaths,
          request.provisionControllerReceiptPath,
          request.captureControllerReceiptPath,
          request.preAuthorReadRoomStateCallResultPath,
          request.closingRoomReadCallResultPath,
          request.inspectionCallResultPath,
          request.pngExportCallResultPath,
          request.authorEvidenceOutputPath,
          request.sanitizedSemanticStateOutputPath,
          request.exactRevisionPngOutputPath,
        ]) await assertPrivateStatePath(repositoryRoot, privatePath);
        const [waitThreadResults, readThreadResults, provisionControllerReceiptRaw, captureControllerReceiptRaw,
          preAuthorRoomRead, roomRead, inspection, pngExport] = await Promise.all([
          Promise.all(request.waitThreadResultPaths.map(async (filePath) => (
            (await readJson(filePath, "Retained wait_threads raw observation", 0o600)).value
          ))),
          Promise.all(request.readThreadResultPaths.map(async (filePath) => (
            (await readJson(filePath, "Retained read_thread raw observation", 0o600)).value
          ))),
          readJson(request.provisionControllerReceiptPath, "Provision-controller receipt", 0o600),
          readJson(request.captureControllerReceiptPath, "Capture-controller receipt", 0o600),
          readJson(request.preAuthorReadRoomStateCallResultPath, "Pre-author read_room_state CallToolResult", 0o600),
          readJson(request.closingRoomReadCallResultPath, "Closing read_room_state CallToolResult", 0o600),
          readJson(request.inspectionCallResultPath, "Closing inspect_canvas_scope CallToolResult", 0o600),
          readJson(request.pngExportCallResultPath, "Closing export_canvas_png CallToolResult", 0o600),
        ]);
        const derived = deriveQualificationV2AuthorEvidence({
          state: current,
          waitThreadCallResults: waitThreadResults,
          readThreadCallResults: readThreadResults,
          preAuthorRoomReadCallResult: preAuthorRoomRead.value,
          closingRoomReadCallResult: roomRead.value,
          inspectionCallResult: inspection.value,
          pngExportCallResult: pngExport.value,
          retainedAt: request.at,
        });
        const provisionControllerReceipt = parseQualificationV2ProvisionControllerReceipt(
          provisionControllerReceiptRaw.value,
        );
        const captureControllerReceipt = parseQualificationV2CaptureControllerReceipt(
          captureControllerReceiptRaw.value,
        );
        const currentTask = current.tasks[current.currentTaskIndex];
        if (currentTask === undefined || currentTask.room === null
            || captureControllerReceipt.taskId !== currentTask.taskId
            || currentTask.captureTerminalReceipt?.outcome !== "succeeded"
            || currentTask.captureTerminalReceipt.captureControllerReceiptDigest
              !== captureControllerReceipt.receiptDigest
            || captureControllerReceipt.roomReceiptDigest !== currentTask.room.receiptDigest
            || provisionControllerReceipt.taskId !== currentTask.taskId
            || provisionControllerReceipt.roomReceiptDigest !== currentTask.room.receiptDigest
            || provisionControllerReceipt.receiptDigest !== currentTask.roomProvisionControllerReceiptDigest
            || captureControllerReceipt.provisionControllerReceiptDigest
              !== currentTask.roomProvisionControllerReceiptDigest
            || captureControllerReceipt.storageStateDigest !== currentTask.roomAuthorizedStorageStateDigest
            || captureControllerReceipt.deploymentId !== current.productionBinding.deploymentId
            || captureControllerReceipt.participantToolContractDigest
              !== current.baselineParticipantToolContractDigest
            || current.controllerHarnessRuntimeProvenance === null
            || canonicalJson(provisionControllerReceipt.harnessRuntimeProvenance)
              !== canonicalJson(current.controllerHarnessRuntimeProvenance)
            || canonicalJson(captureControllerReceipt.harnessRuntimeProvenance)
              !== canonicalJson(current.controllerHarnessRuntimeProvenance)
            || provisionControllerReceipt.preAuthorReadCallResultDigest
              !== derived.retainedSourceDigests.preAuthorRoomReadCallResult
            || captureControllerReceipt.closingReadCallResultDigest !== derived.retainedSourceDigests.roomReadCallResult
            || captureControllerReceipt.inspectionCallResultDigest !== derived.retainedSourceDigests.inspectionCallResult
            || captureControllerReceipt.pngCallResultDigest !== derived.retainedSourceDigests.pngExportCallResult
            || captureControllerReceipt.pngByteDigest !== derived.evidence.revisionMatchedPngDigest
            || captureControllerReceipt.pngByteLength !== derived.exactRevisionPngBytes.length
            || captureControllerReceipt.roomRevision !== derived.evidence.finalAuthoritativeRoomRevision
            || captureControllerReceipt.objectCount !== derived.sanitizedSemanticState.objects.length
            || captureControllerReceipt.diagramCount !== derived.sanitizedSemanticState.diagrams.length
            || Date.parse(captureControllerReceipt.retainedAt) > Date.parse(request.at)) {
          throw new Error("QUALIFICATION_V2_CAPTURE_CONTROLLER_RECEIPT_BINDING_INVALID");
        }
        await writeAtomic(request.authorEvidenceOutputPath, derived.evidence, false);
        await writeAtomic(request.sanitizedSemanticStateOutputPath, derived.sanitizedSemanticState, false);
        await writeAtomicBytes(request.exactRevisionPngOutputPath, derived.exactRevisionPngBytes, false);
        state = retainQualificationV2AuthorEvidence(current, derived.evidence, request.at);
      } else {
        throw new Error("QUALIFICATION_V2_OPERATION_UNREACHABLE");
      }
      await writeAtomic(request.statePath, state, true);
      if (deferredControllerRequest !== null) {
        await writeExclusiveOrVerify(deferredControllerRequest.outputPath, deferredControllerRequest.value);
      }
    }
    io.stdout.write(`${canonicalJson(publicStatus(state))}\n`);
    return 0;
  } catch (error) {
    if (incidentStatePath !== null) {
      const content = {
        schemaVersion: "exp-0001a-qualification-coordinator-incident/v2",
        operation: incidentOperation,
        occurredAt: new Date().toISOString(),
        errorName: error instanceof Error ? error.name : "UnknownError",
        errorMessage: error instanceof Error ? error.message : "Unknown coordinator failure.",
        errorStackDigest: error instanceof Error && typeof error.stack === "string"
          ? sha256Digest(error.stack)
          : null,
      };
      await writeAtomic(
        `${incidentStatePath}.incident-${randomUUID()}.json`,
        { ...content, incidentDigest: hashCanonicalJson(content as unknown as JsonValue) },
        false,
      ).catch(() => undefined);
    }
    io.stderr.write(`${canonicalJson({
      status: "error",
      errorCode: "QUALIFICATION_V2_COORDINATOR_OPERATION_FAILED",
    })}\n`);
    return 1;
  }
}
