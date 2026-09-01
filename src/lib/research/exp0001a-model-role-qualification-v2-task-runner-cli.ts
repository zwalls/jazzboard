import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  authorizeQualificationV2FileBridgeCreateRequest,
  createQualificationV2FileBridgeAdapter,
  ensureQualificationV2FileBridgeRoot,
  qualificationV2BridgeRequestSchema,
  readQualificationV2FileBridgeStatus,
  recordQualificationV2FileBridgeResult,
} from "./exp0001a-model-role-qualification-v2-file-bridge";
import { qualificationV2CoordinatorStateSchema } from "./exp0001a-model-role-qualification-v2-coordinator";
import {
  recoverQualificationV2PendingAction,
  resolveQualificationTaskRunnerPrivatePath,
  runQualificationV2PendingAction,
} from "./exp0001a-model-role-qualification-v2-task-runner";
import { canonicalJson, hashCanonicalJson, sha256Digest, type JsonValue } from "./provenance-crypto";
// @ts-expect-error The auth preflight is an audited ESM script without a declaration file.
import { assertCodexNativeExperimentAuthorized, runCodexAuthPreflight } from "../../../research/scripts/codex-auth-preflight.mjs";

const absolutePath = z.string().refine((value) => path.isAbsolute(value) && path.normalize(value) === value);
const requestSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("run_pending_action"),
    statePath: absolutePath,
    bridgeRoot: absolutePath,
    reviewEvidenceReadReceiptPath: absolutePath.optional(),
  }).strict(),
  z.object({
    operation: z.literal("recover_pending_action"),
    statePath: absolutePath,
    bridgeRoot: absolutePath,
    reviewEvidenceReadReceiptPath: absolutePath.optional(),
  }).strict(),
  z.object({ operation: z.literal("status"), bridgeRoot: absolutePath }).strict(),
  z.object({
    operation: z.literal("export_exact_request"),
    bridgeRoot: absolutePath,
    outputPath: absolutePath,
  }).strict(),
  z.object({
    operation: z.literal("record_raw_create_thread_result"),
    bridgeRoot: absolutePath,
    sequence: z.number().int().positive(),
    rawResultPath: absolutePath.optional(),
    rawResultSource: z.literal("stdin").optional(),
  }).strict(),
  z.object({
    operation: z.literal("record_raw_list_threads_result"),
    bridgeRoot: absolutePath,
    sequence: z.number().int().positive(),
    rawResultPath: absolutePath.optional(),
    rawResultSource: z.literal("stdin").optional(),
  }).strict(),
  z.object({
    operation: z.literal("record_raw_wait_threads_result"),
    bridgeRoot: absolutePath,
    sequence: z.number().int().positive(),
    rawResultPath: absolutePath.optional(),
    rawResultSource: z.literal("stdin").optional(),
  }).strict(),
  z.object({
    operation: z.literal("record_raw_read_thread_result"),
    bridgeRoot: absolutePath,
    sequence: z.number().int().positive(),
    rawResultPath: absolutePath.optional(),
    rawResultSource: z.literal("stdin").optional(),
  }).strict(),
]);

async function readPrivateJson(filePath: string, label: string) {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o600) {
    throw new Error(`${label} must be a singly linked mode-600 file.`);
  }
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try { return JSON.parse((await handle.readFile()).toString("utf8")) as unknown; } finally { await handle.close(); }
}

async function assertPrivatePath(repositoryRoot: string, candidate: string, expectedRoot?: string) {
  return resolveQualificationTaskRunnerPrivatePath({
    repositoryRoot,
    candidatePath: candidate,
    expectedPrivateRoot: expectedRoot,
  });
}

async function writePrivateExclusive(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const handle = await open(filePath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(`${canonicalJson(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readOneJsonFromStdin(
  stdin: AsyncIterable<Buffer | string> | undefined,
  maximumBytes = 64 * 1024 * 1024,
) {
  if (stdin === undefined) throw new Error("QUALIFICATION_V2_RAW_RESULT_STDIN_UNAVAILABLE");
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    byteLength += bytes.length;
    if (byteLength > maximumBytes) throw new Error("QUALIFICATION_V2_RAW_RESULT_STDIN_TOO_LARGE");
    chunks.push(bytes);
  }
  if (byteLength === 0) throw new Error("QUALIFICATION_V2_RAW_RESULT_STDIN_EMPTY");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new Error("QUALIFICATION_V2_RAW_RESULT_STDIN_NOT_EXACT_JSON");
  }
}

export async function runQualificationV2TaskRunnerCli(
  argv: readonly string[],
  io: {
    stdin?: AsyncIterable<Buffer | string>;
    stdout: Pick<NodeJS.WriteStream, "write">;
    stderr: Pick<NodeJS.WriteStream, "write">;
  },
  repositoryRoot: string,
  dependencies: Readonly<{
    now?: () => string;
    runAuthPreflightForTesting?: () => Promise<unknown>;
  }> = {},
) {
  let incidentBridgeRoot: string | null = null;
  let incidentOperation: string | null = null;
  try {
    if (argv.length !== 2 || argv[0] !== "--request") throw new Error("Usage: --request /absolute/private-request.json");
    const requestPath = absolutePath.parse(argv[1]);
    const requestPathResolution = await assertPrivatePath(repositoryRoot, requestPath);
    const qualificationPrivateRoot = requestPathResolution.privateRoot;
    const request = requestSchema.parse(await readPrivateJson(requestPath, "Qualification-v2 task-runner request"));
    const bridgePathResolution = await assertPrivatePath(
      repositoryRoot,
      request.bridgeRoot,
      qualificationPrivateRoot,
    );
    if (request.operation === "run_pending_action" || request.operation === "recover_pending_action") {
      await assertPrivatePath(repositoryRoot, request.statePath, qualificationPrivateRoot);
      const state = qualificationV2CoordinatorStateSchema.parse(
        await readPrivateJson(request.statePath, "Qualification-v2 coordinator state"),
      );
      const expectedRootName = state.productionBinding.schemaVersion
        === "exp-0001a-qualification-production-binding/v3"
        ? "exp0001a-qualification-v3"
        : "exp0001a-qualification-v2";
      if (path.basename(qualificationPrivateRoot) !== expectedRootName) {
        throw new Error("QUALIFICATION_V2_RUNNER_STATE_ROOT_MISMATCH");
      }
    }
    const privateRoot = qualificationPrivateRoot;
    const bridgeRoot = await ensureQualificationV2FileBridgeRoot({
      privateRoot,
      bridgeRoot: bridgePathResolution.candidatePath,
    });
    incidentBridgeRoot = bridgeRoot;
    incidentOperation = request.operation;
    if (request.operation === "status") {
      const status = await readQualificationV2FileBridgeStatus(bridgeRoot);
      io.stdout.write(`${canonicalJson(status.status === "idle" ? status : {
        status: status.status,
        request: {
          sequence: status.request.sequence,
          toolName: status.request.toolName,
          requestDigest: status.request.requestDigest,
          argumentsDigest: status.request.argumentsDigest,
          requestedAt: status.request.requestedAt,
        },
      })}\n`);
      return 0;
    }
    if (request.operation === "export_exact_request") {
      await assertPrivatePath(repositoryRoot, request.outputPath, qualificationPrivateRoot);
      const status = await readQualificationV2FileBridgeStatus(bridgeRoot);
      if (status.status !== "awaiting_raw_result") throw new Error("QUALIFICATION_V2_BRIDGE_NO_PENDING_REQUEST");
      const exactRequest = qualificationV2BridgeRequestSchema.parse(status.request);
      if (exactRequest.toolName === "mcp__codex_app__create_thread") {
        const authReceipt = assertCodexNativeExperimentAuthorized(
          await (dependencies.runAuthPreflightForTesting ?? runCodexAuthPreflight)(),
        );
        await authorizeQualificationV2FileBridgeCreateRequest({
          bridgeRoot,
          sequence: exactRequest.sequence,
          authReceipt,
          now: dependencies.now,
        });
      }
      await writePrivateExclusive(request.outputPath, exactRequest);
      io.stdout.write(`${canonicalJson({
        status: "exact_request_exported_privately",
        sequence: exactRequest.sequence,
        toolName: exactRequest.toolName,
        requestDigest: exactRequest.requestDigest,
      })}\n`);
      return 0;
    }
    if (request.operation === "run_pending_action" || request.operation === "recover_pending_action") {
      await assertPrivatePath(repositoryRoot, request.statePath, qualificationPrivateRoot);
      if (request.reviewEvidenceReadReceiptPath !== undefined) {
        await assertPrivatePath(repositoryRoot, request.reviewEvidenceReadReceiptPath, qualificationPrivateRoot);
      }
      const adapter = createQualificationV2FileBridgeAdapter({
        privateRoot,
        bridgeRoot,
        getCreateBinding: async () => {
          const state = qualificationV2CoordinatorStateSchema.parse(
            await readPrivateJson(request.statePath, "Qualification-v2 coordinator state"),
          );
          if (state.pendingAction === null || state.pendingDispatchReceipt === null
              || state.pendingAction.actionDigest !== state.pendingDispatchReceipt.actionDigest) {
            throw new Error("QUALIFICATION_V2_BRIDGE_CREATE_BINDING_UNAVAILABLE");
          }
          return {
            actionDigest: state.pendingAction.actionDigest,
            releaseJournalDigest: state.pendingDispatchReceipt.releaseJournalDigest,
          };
        },
      });
      const run = request.operation === "run_pending_action"
        ? runQualificationV2PendingAction
        : recoverQualificationV2PendingAction;
      const result = await run({
        repositoryRoot,
        statePath: request.statePath,
        adapter,
        reviewEvidenceReadReceiptPath: request.reviewEvidenceReadReceiptPath,
      });
      io.stdout.write(`${canonicalJson({
        status: "terminal_receipt_derived",
        actionRootRetainedPrivately: true,
        receiptDigest: result.receipt.receiptDigest,
        stateDigest: result.state.stateDigest,
      })}\n`);
      return 0;
    }
    if ((request.rawResultPath === undefined) === (request.rawResultSource === undefined)) {
      throw new Error("QUALIFICATION_V2_RAW_RESULT_SOURCE_EXACTLY_ONE_REQUIRED");
    }
    if (request.rawResultPath !== undefined) {
      await assertPrivatePath(repositoryRoot, request.rawResultPath, qualificationPrivateRoot);
    }
    const tool = request.operation === "record_raw_create_thread_result"
      ? "mcp__codex_app__create_thread" as const
      : request.operation === "record_raw_list_threads_result"
        ? "mcp__codex_app__list_threads" as const
        : request.operation === "record_raw_wait_threads_result"
          ? "mcp__codex_app__wait_threads" as const
          : "mcp__codex_app__read_thread" as const;
    const resultAuthReceipt = tool === "mcp__codex_app__create_thread"
      ? assertCodexNativeExperimentAuthorized(
        await (dependencies.runAuthPreflightForTesting ?? runCodexAuthPreflight)(),
      )
      : undefined;
    const result = await recordQualificationV2FileBridgeResult({
      bridgeRoot,
      sequence: request.sequence,
      toolName: tool,
      rawCallToolResult: request.rawResultPath === undefined
        ? await readOneJsonFromStdin(io.stdin)
        : await readPrivateJson(request.rawResultPath, "Exact raw Codex-app CallToolResult"),
      resultAuthReceipt,
      now: dependencies.now,
    });
    io.stdout.write(`${canonicalJson({ status: "raw_result_retained", resultDigest: result.resultDigest })}\n`);
    return 0;
  } catch (error) {
    if (incidentBridgeRoot !== null) {
      const content = {
        schemaVersion: "exp-0001a-qualification-task-runner-incident/v2",
        operation: incidentOperation,
        occurredAt: new Date().toISOString(),
        errorName: error instanceof Error ? error.name : "UnknownError",
        errorMessage: error instanceof Error ? error.message : "Unknown task-runner failure.",
        errorStackDigest: error instanceof Error && typeof error.stack === "string"
          ? sha256Digest(error.stack)
          : null,
      };
      await writePrivateExclusive(
        path.join(incidentBridgeRoot, "incidents", `task-runner-${randomUUID()}.json`),
        { ...content, incidentDigest: hashCanonicalJson(content as unknown as JsonValue) },
      ).catch(() => undefined);
    }
    io.stderr.write(`${canonicalJson({
      status: "error",
      errorCode: "QUALIFICATION_V2_TASK_RUNNER_OPERATION_FAILED",
    })}\n`);
    return 1;
  }
}
