import { constants as fsConstants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

import { z } from "zod";

import developmentBenchmarkJson from "../../../research/benchmarks/development-v2.json";
import developmentFixtureSpecsJson from "../../../research/benchmarks/development-fixture-specs-v2.json";
import developmentRubricsJson from "../../../research/benchmarks/development-evaluator-rubrics-v2.json";
import {
  compileQualificationV2PublicTasksFromExecutionBundle,
  findQualificationV2ExactInviteCodeLeaks,
  qualificationV2BlindedReviewEnvelopeSchema,
  qualificationV2CoordinatorStateSchema,
} from "./exp0001a-model-role-qualification-v2-coordinator";
import {
  assertQualificationV2PngStructure,
  qualificationV2EvidenceSidecarManifestSchema,
  qualificationV2EvidenceSidecarReadReceiptSchema,
  startQualificationV2PngEvidenceSidecar,
  verifyQualificationV2EvidenceReadReceipt,
} from "./exp0001a-model-role-qualification-v2-png-sidecar";
import {
  parseQualificationV2SanitizedSemanticState,
} from "./exp0001a-model-role-qualification-v2-semantic-projection";
import {
  canonicalJson,
  hashCanonicalJson,
  sha256Digest,
  type JsonValue,
} from "./provenance-crypto";

const absolutePath = z.string().refine((value) => (
  path.isAbsolute(value) && path.normalize(value) === value && value !== path.parse(value).root
));
const requestSchema = z.object({
  operation: z.literal("serve_review_evidence"),
  statePath: absolutePath,
  sanitizedSemanticStatePath: absolutePath,
  exactRevisionPngPath: absolutePath,
  outputDirectory: absolutePath,
  at: z.string().datetime({ offset: true }),
}).strict();

async function readPrivate(filePath: string, label: string) {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o600) {
    throw new Error(`${label} must be a singly linked mode-600 plain file.`);
  }
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try { return await handle.readFile(); } finally { await handle.close(); }
}

async function readPrivateJson(filePath: string, label: string) {
  const bytes = await readPrivate(filePath, label);
  try { return JSON.parse(bytes.toString("utf8")) as unknown; } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

async function assertPrivatePath(repositoryRoot: string, candidate: string, allowMissingLeaf = false) {
  const root = await realpath(path.join(repositoryRoot, ".research-private", "exp0001a-qualification-v2"));
  let existing = path.resolve(candidate);
  while (true) {
    try { await lstat(existing); break; } catch (error) {
      if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!allowMissingLeaf) throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw new Error("QUALIFICATION_V2_REVIEW_SIDECAR_PATH_NOT_PRIVATE");
      existing = parent;
    }
  }
  const resolved = path.resolve(await realpath(existing), path.relative(existing, path.resolve(candidate)));
  const relative = path.relative(root, resolved);
  if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("QUALIFICATION_V2_REVIEW_SIDECAR_PATH_NOT_PRIVATE");
  }
  return resolved;
}

async function syncDirectory(directory: string) {
  const handle = await open(directory, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeExclusiveBytes(filePath: string, bytes: Buffer) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(filePath), `.qualification-v2-review-${randomUUID()}.tmp`);
  const temp = await open(
    temporary,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try { await temp.writeFile(bytes); await temp.sync(); } finally { await temp.close(); }
  try { await link(temporary, filePath); } finally { await unlink(temporary).catch(() => undefined); }
  const retained = await readPrivate(filePath, "Qualification-v2 review-sidecar output");
  if (!retained.equals(bytes)) throw new Error("QUALIFICATION_V2_REVIEW_SIDECAR_READBACK_MISMATCH");
  await syncDirectory(path.dirname(filePath));
}

async function writeExclusive(filePath: string, value: unknown) {
  await writeExclusiveBytes(filePath, Buffer.from(`${canonicalJson(value)}\n`, "utf8"));
}

async function waitForReadReceipt(filePath: string, maxWaitMs: number) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() <= deadline) {
    try {
      return qualificationV2EvidenceSidecarReadReceiptSchema.parse(
        await readPrivateJson(filePath, "Qualification-v2 sidecar read receipt"),
      );
    } catch (error) {
      const transientPublish = error instanceof Error
        && error.message === "Qualification-v2 sidecar read receipt must be a singly linked mode-600 plain file.";
      if (!(error instanceof Error)
          || ((error as NodeJS.ErrnoException).code !== "ENOENT" && !transientPublish)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("QUALIFICATION_V2_REVIEW_SIDECAR_READ_TIMEOUT");
}

export async function serveQualificationV2ReviewerEvidence(input: Readonly<{
  state: unknown;
  sanitizedSemanticState: unknown;
  pngBytes: Buffer;
  outputDirectory: string;
  at: string;
  maxWaitMs?: number;
  now?: () => string;
}>) {
  const state = qualificationV2CoordinatorStateSchema.parse(input.state);
  if (state.stopped || state.currentTaskIndex >= state.tasks.length || state.pendingAction !== null) {
    throw new Error("QUALIFICATION_V2_REVIEW_SIDECAR_STATE_NOT_READY");
  }
  const task = state.tasks[state.currentTaskIndex]!;
  if (task.phase !== "ready_for_review" || task.authorEvidence === null || task.room === null) {
    throw new Error("QUALIFICATION_V2_REVIEW_SIDECAR_STATE_NOT_READY");
  }
  const semanticState = parseQualificationV2SanitizedSemanticState(input.sanitizedSemanticState);
  assertQualificationV2PngStructure(input.pngBytes);
  const semanticDigest = hashCanonicalJson(semanticState as unknown as JsonValue);
  const pngDigest = sha256Digest(input.pngBytes);
  if (semanticDigest !== task.authorEvidence.sanitizedSemanticStateDigest
      || pngDigest !== task.authorEvidence.revisionMatchedPngDigest
      || semanticState.roomRevision !== task.authorEvidence.finalAuthoritativeRoomRevision) {
    throw new Error("QUALIFICATION_V2_REVIEW_SIDECAR_AUTHOR_EVIDENCE_MISMATCH");
  }
  if (findQualificationV2ExactInviteCodeLeaks(
    semanticState,
    task.room.privateRoomInviteUrl,
  ).length > 0) {
    throw new Error("QUALIFICATION_V2_REVIEW_SIDECAR_EXACT_INVITE_CODE_LEAK");
  }
  const outputMetadata = await lstat(input.outputDirectory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (outputMetadata !== null) throw new Error("QUALIFICATION_V2_REVIEW_SIDECAR_OUTPUT_EXISTS");
  await mkdir(input.outputDirectory, { mode: 0o700 });
  const manifest = qualificationV2EvidenceSidecarManifestSchema.parse({
    schemaVersion: "exp-0001a-qualification-evidence-sidecar-manifest/v2",
    opaqueArtifactKey: randomBytes(16).toString("hex"),
    mediaType: "image/png",
    byteDigest: pngDigest,
    byteLength: input.pngBytes.length,
    sourceRoomRevision: semanticState.roomRevision,
  });
  const manifestPath = path.join(input.outputDirectory, "manifest.json");
  const pngPath = path.join(input.outputDirectory, "exact-revision.png");
  const readReceiptPath = path.join(input.outputDirectory, "read-receipt.json");
  await writeExclusive(manifestPath, manifest);
  await writeExclusiveBytes(pngPath, input.pngBytes);
  const sidecar = await startQualificationV2PngEvidenceSidecar({
    manifestPath,
    pngPath,
    readReceiptPath,
    now: input.now,
  });
  try {
    const sidecarReceiptContent = {
      schemaVersion: "exp-0001a-qualification-evidence-sidecar-receipt/v2" as const,
      exactRevisionPngUrl: sidecar.url,
      manifest,
      manifestDigest: hashCanonicalJson(manifest as unknown as JsonValue),
      exactRevisionPngByteDigest: pngDigest,
      exactRevisionPngByteLength: input.pngBytes.length,
      sourceRoomRevision: semanticState.roomRevision,
      sanitizedSemanticStateRoomRevision: semanticState.roomRevision,
      queryPermitted: false as const,
      fragmentPermitted: false as const,
      persistedByJazzboard: false as const,
    };
    const sidecarReceipt = {
      ...sidecarReceiptContent,
      sidecarReceiptDigest: hashCanonicalJson(sidecarReceiptContent as unknown as JsonValue),
    };
    const bundle = compileQualificationV2PublicTasksFromExecutionBundle(
      developmentBenchmarkJson,
      developmentRubricsJson,
      developmentFixtureSpecsJson,
    );
    if (bundle.bundleDigest !== state.benchmarkExecutionBundleDigest) {
      throw new Error("QUALIFICATION_V2_REVIEW_SIDECAR_BENCHMARK_DRIFT");
    }
    const publicTask = bundle.publicTasks[state.currentTaskIndex]!;
    const rubric = z.object({ rubrics: z.array(z.record(z.string(), z.unknown())) }).passthrough()
      .parse(developmentRubricsJson).rubrics.find((item) => item.taskId === task.taskId);
    if (rubric === undefined || hashCanonicalJson(rubric as unknown as JsonValue) !== task.benchmarkCommitments.rubric) {
      throw new Error("QUALIFICATION_V2_REVIEW_SIDECAR_RUBRIC_DRIFT");
    }
    const envelopeContent = {
      schemaVersion: "exp-0001a-qualification-blinded-review-envelope/v2" as const,
      publicTask,
      frozenRubric: rubric,
      sanitizedSemanticState: semanticState,
      sanitizedSemanticStateDigest: semanticDigest,
      evidenceSidecar: sidecarReceipt,
    };
    const envelope = qualificationV2BlindedReviewEnvelopeSchema.parse({
      ...envelopeContent,
      envelopeDigest: hashCanonicalJson(envelopeContent as unknown as JsonValue),
    });
    await writeExclusive(path.join(input.outputDirectory, "sidecar-receipt.json"), sidecarReceipt);
    await writeExclusive(path.join(input.outputDirectory, "review-envelope.json"), envelope);
    const readyContent = {
      schemaVersion: "exp-0001a-qualification-review-sidecar-ready/v2" as const,
      taskId: task.taskId,
      manifestDigest: sidecar.manifestDigest,
      sidecarReceiptDigest: sidecarReceipt.sidecarReceiptDigest,
      reviewEnvelopeDigest: envelope.envelopeDigest,
      preparedAt: input.at,
      privateUrlRetainedOnlyInEnvelope: true as const,
    };
    const ready = { ...readyContent, receiptDigest: hashCanonicalJson(readyContent as unknown as JsonValue) };
    await writeExclusive(path.join(input.outputDirectory, "ready-receipt.json"), ready);
    const readReceipt = await waitForReadReceipt(readReceiptPath, input.maxWaitMs ?? 2 * 60 * 60_000);
    verifyQualificationV2EvidenceReadReceipt({ receipt: readReceipt, manifest });
    const completionContent = {
      schemaVersion: "exp-0001a-qualification-review-sidecar-completion/v2" as const,
      taskId: task.taskId,
      sidecarReceiptDigest: sidecarReceipt.sidecarReceiptDigest,
      readReceiptDigest: readReceipt.receiptDigest,
      completedAt: (input.now ?? (() => new Date().toISOString()))(),
    };
    const completion = { ...completionContent, receiptDigest: hashCanonicalJson(completionContent as unknown as JsonValue) };
    await writeExclusive(path.join(input.outputDirectory, "completion-receipt.json"), completion);
    return Object.freeze({ ready, completion, envelope, readReceipt });
  } finally {
    await sidecar.close();
  }
}

export async function runQualificationV2ReviewSidecarCli(
  argv: readonly string[],
  io: { stdout: Pick<NodeJS.WriteStream, "write">; stderr: Pick<NodeJS.WriteStream, "write"> },
  repositoryRoot: string,
) {
  let incidentDirectory: string | null = null;
  let incidentOperation: string | null = null;
  try {
    if (argv.length !== 2 || argv[0] !== "--request") throw new Error("Usage: --request /absolute/private-request.json");
    const requestPath = absolutePath.parse(argv[1]);
    await assertPrivatePath(repositoryRoot, requestPath);
    const request = requestSchema.parse(await readPrivateJson(requestPath, "Qualification-v2 review-sidecar request"));
    incidentDirectory = path.dirname(requestPath);
    incidentOperation = request.operation;
    const [statePath, semanticPath, pngPath, outputDirectory] = await Promise.all([
      assertPrivatePath(repositoryRoot, request.statePath),
      assertPrivatePath(repositoryRoot, request.sanitizedSemanticStatePath),
      assertPrivatePath(repositoryRoot, request.exactRevisionPngPath),
      assertPrivatePath(repositoryRoot, request.outputDirectory, true),
    ]);
    const result = await serveQualificationV2ReviewerEvidence({
      state: await readPrivateJson(statePath, "Qualification-v2 coordinator state"),
      sanitizedSemanticState: await readPrivateJson(semanticPath, "Qualification-v2 sanitized semantic state"),
      pngBytes: await readPrivate(pngPath, "Qualification-v2 exact-revision PNG"),
      outputDirectory,
      at: request.at,
    });
    io.stdout.write(`${canonicalJson({
      status: "review_evidence_served_once",
      taskId: result.ready.taskId,
      reviewEnvelopeDigest: result.ready.reviewEnvelopeDigest,
      readReceiptDigest: result.readReceipt.receiptDigest,
      completionReceiptDigest: result.completion.receiptDigest,
    })}\n`);
    return 0;
  } catch (error) {
    if (incidentDirectory !== null) {
      const content = {
        schemaVersion: "exp-0001a-qualification-review-sidecar-incident/v2",
        operation: incidentOperation,
        occurredAt: new Date().toISOString(),
        errorName: error instanceof Error ? error.name : "UnknownError",
        errorMessage: error instanceof Error ? error.message : "Unknown review-sidecar failure.",
        errorStackDigest: error instanceof Error && typeof error.stack === "string"
          ? sha256Digest(error.stack)
          : null,
      };
      await writeExclusive(
        path.join(incidentDirectory, `review-sidecar-incident-${randomUUID()}.json`),
        { ...content, incidentDigest: hashCanonicalJson(content as unknown as JsonValue) },
      ).catch(() => undefined);
    }
    io.stderr.write(`${canonicalJson({
      status: "error",
      errorCode: "QUALIFICATION_V2_REVIEW_SIDECAR_OPERATION_FAILED",
    })}\n`);
    return 1;
  }
}
