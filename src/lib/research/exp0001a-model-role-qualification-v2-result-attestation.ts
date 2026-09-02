import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import {
  qualificationV2AuthorEvidenceSchema,
  qualificationV2CodexAuthReceiptSchema,
  qualificationV2CoordinatorStateSchema,
  qualificationV2ExternalActionSchema,
  qualificationV2ExternalTaskReceiptSchema,
  qualificationV2RoomReceiptSchema,
  type QualificationV2CoordinatorState,
} from "./exp0001a-model-role-qualification-v2-coordinator";
import {
  parseQualificationV2CaptureAuthorization,
  parseQualificationV2CaptureControllerReceipt,
  parseQualificationV2CaptureReleaseJournal,
  parseQualificationV2CaptureTerminalReceipt,
  parseQualificationV2ProvisionControllerReceipt,
  qualificationV2HarnessRuntimeProvenanceSchema,
} from "./exp0001a-model-role-qualification-v2-room-controller-receipts";
import {
  qualificationV2EvidenceSidecarReadReceiptSchema,
} from "./exp0001a-model-role-qualification-v2-png-sidecar";
import {
  canonicalJson,
  hashCanonicalJson,
  sha256Digest,
  SHA256_DIGEST_PATTERN,
  type JsonValue,
} from "./provenance-crypto";

const execFileAsync = promisify(execFile);
const digestSchema = z.string().regex(SHA256_DIGEST_PATTERN);
const timestampSchema = z.string().datetime({ offset: true });
const relativePrivatePathSchema = z.string().min(1).refine((value) => (
  !path.isAbsolute(value)
  && path.normalize(value) === value
  && value !== "."
  && !value.startsWith(`..${path.sep}`)
  && value !== ".."
), "Expected a normalized private-root-relative path.");

const evidenceArtifactKindSchema = z.enum([
  "author_evidence",
  "bridge_create_authorization",
  "bridge_create_attempt",
  "bridge_create_result",
  "bridge_request",
  "bridge_result",
  "canonical_json",
  "capture_authorization",
  "capture_controller_receipt",
  "capture_release_journal",
  "capture_terminal_receipt",
  "dispatch_receipt",
  "external_action",
  "external_task_receipt",
  "file_bytes",
  "harness_runtime_provenance",
  "identity_reconciliation",
  "provision_controller_receipt",
  "raw_tool_observation",
  "raw_create_evidence",
  "raw_tool_result",
  "release_journal",
  "room_receipt",
  "sidecar_read_receipt",
  "terminal_trace",
  "webmcp_result",
]);

const evidenceArtifactReferenceSchema = z.object({
  kind: evidenceArtifactKindSchema,
  digest: digestSchema,
}).strict();

type EvidenceArtifactReference = z.infer<typeof evidenceArtifactReferenceSchema>;

function artifactReferenceKey(reference: EvidenceArtifactReference) {
  return `${reference.kind}:${reference.digest}`;
}

function sortedArtifactReferences(input: readonly EvidenceArtifactReference[]) {
  return [...new Map(input.map((reference) => [artifactReferenceKey(reference), reference])).values()]
    .sort((left, right) => artifactReferenceKey(left).localeCompare(artifactReferenceKey(right)));
}

const evidenceFileEntryContentSchema = z.object({
  relativePath: relativePrivatePathSchema,
  byteDigest: digestSchema,
  byteLength: z.number().int().nonnegative(),
  canonicalJsonDigest: digestSchema.nullable(),
  referencedDigests: z.array(digestSchema),
  artifactBindings: z.array(evidenceArtifactReferenceSchema),
  artifactRequirements: z.array(evidenceArtifactReferenceSchema),
}).strict();

export const qualificationV2EvidenceFileEntrySchema = evidenceFileEntryContentSchema.extend({
  entryDigest: digestSchema,
}).strict().superRefine((entry, context) => {
  const { entryDigest: _entryDigest, ...content } = entry;
  void _entryDigest;
  if (hashCanonicalJson(content as unknown as JsonValue) !== entry.entryDigest) {
    context.addIssue({ code: "custom", path: ["entryDigest"], message: "Evidence-file entry digest is invalid." });
  }
  const sorted = [...new Set(entry.referencedDigests)].sort();
  if (canonicalJson(sorted as unknown as JsonValue) !== canonicalJson(entry.referencedDigests as unknown as JsonValue)) {
    context.addIssue({ code: "custom", path: ["referencedDigests"], message: "Referenced digests must be unique and sorted." });
  }
  for (const field of ["artifactBindings", "artifactRequirements"] as const) {
    if (canonicalJson(sortedArtifactReferences(entry[field]) as unknown as JsonValue)
        !== canonicalJson(entry[field] as unknown as JsonValue)) {
      context.addIssue({ code: "custom", path: [field], message: "Artifact references must be unique and sorted." });
    }
  }
});

const terminalEvidenceAttestationContentSchema = z.object({
  schemaVersion: z.literal("exp-0001a-qualification-terminal-evidence-attestation/v2"),
  protocolId: z.literal("EXP-0001A-MODEL-ROLE-QUALIFICATION-V2"),
  kind: z.literal("terminal-evidence-attestation"),
  attestedAt: timestampSchema,
  terminalStateRelativePath: relativePrivatePathSchema,
  terminalStateDigest: digestSchema,
  terminalStateByteDigest: digestSchema,
  harnessRuntimeProvenanceDigest: digestSchema,
  harnessGitCommit: z.string().regex(/^[a-f0-9]{40}$/),
  harnessGitTree: z.string().regex(/^[a-f0-9]{40}$/),
  worktreeClean: z.literal(true),
  requiredEvidenceDigests: z.array(digestSchema).min(1),
  requiredEvidenceArtifacts: z.array(evidenceArtifactReferenceSchema).min(1),
  evidenceFiles: z.array(qualificationV2EvidenceFileEntrySchema).min(1),
  evidenceFileCount: z.number().int().positive(),
  evidenceInventoryRoot: digestSchema,
}).strict();

export const qualificationV2TerminalEvidenceAttestationSchema =
  terminalEvidenceAttestationContentSchema.extend({
    attestationDigest: digestSchema,
  }).strict().superRefine((attestation, context) => {
    const { attestationDigest: _attestationDigest, ...content } = attestation;
    void _attestationDigest;
    if (hashCanonicalJson(content as unknown as JsonValue) !== attestation.attestationDigest) {
      context.addIssue({ code: "custom", path: ["attestationDigest"], message: "Terminal evidence attestation digest is invalid." });
    }
    const sortedRequired = [...new Set(attestation.requiredEvidenceDigests)].sort();
    if (canonicalJson(sortedRequired as unknown as JsonValue)
        !== canonicalJson(attestation.requiredEvidenceDigests as unknown as JsonValue)) {
      context.addIssue({ code: "custom", path: ["requiredEvidenceDigests"], message: "Required evidence digests must be unique and sorted." });
    }
    const sortedArtifacts = sortedArtifactReferences(attestation.requiredEvidenceArtifacts);
    if (canonicalJson(sortedArtifacts as unknown as JsonValue)
        !== canonicalJson(attestation.requiredEvidenceArtifacts as unknown as JsonValue)
        || canonicalJson([...new Set(sortedArtifacts.map((reference) => reference.digest))].sort() as unknown as JsonValue)
          !== canonicalJson(attestation.requiredEvidenceDigests as unknown as JsonValue)) {
      context.addIssue({ code: "custom", path: ["requiredEvidenceArtifacts"], message: "Required artifact bindings are inconsistent." });
    }
    const sortedFiles = [...attestation.evidenceFiles]
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    if (canonicalJson(sortedFiles as unknown as JsonValue)
        !== canonicalJson(attestation.evidenceFiles as unknown as JsonValue)
        || attestation.evidenceFileCount !== attestation.evidenceFiles.length
        || hashCanonicalJson(attestation.evidenceFiles.map((entry) => entry.entryDigest) as unknown as JsonValue)
          !== attestation.evidenceInventoryRoot) {
      context.addIssue({ code: "custom", path: ["evidenceFiles"], message: "Evidence inventory ordering or root is invalid." });
    }
  });

export type QualificationV2TerminalEvidenceAttestation = z.infer<
  typeof qualificationV2TerminalEvidenceAttestationSchema
>;

function collectDigests(value: unknown, output = new Set<string>()): Set<string> {
  if (typeof value === "string" && SHA256_DIGEST_PATTERN.test(value)) output.add(value);
  else if (Array.isArray(value)) value.forEach((item) => collectDigests(item, output));
  else if (value !== null && typeof value === "object") {
    Object.values(value).forEach((item) => collectDigests(item, output));
  }
  return output;
}

function requiredEvidenceArtifacts(state: QualificationV2CoordinatorState): EvidenceArtifactReference[] {
  const required: EvidenceArtifactReference[] = [];
  const add = (kind: EvidenceArtifactReference["kind"], digest: string | null | undefined) => {
    if (digest !== null && digest !== undefined) required.push({ kind, digest });
  };
  state.releasedActionDigests.forEach((digest) => add("external_action", digest));
  state.retainedTaskReceiptDigests.forEach((digest) => add("external_task_receipt", digest));
  if (state.controllerHarnessRuntimeProvenance !== null) {
    add(
      "harness_runtime_provenance",
      hashCanonicalJson(state.controllerHarnessRuntimeProvenance as unknown as JsonValue),
    );
  }
  for (const task of state.tasks) {
    add("room_receipt", task.room?.receiptDigest);
    add("provision_controller_receipt", task.roomProvisionControllerReceiptDigest);
    add("canonical_json", task.roomAuthorizedStorageStateDigest);
    add("capture_authorization", task.captureAuthorization?.actionDigest);
    add("capture_release_journal", task.captureReleaseJournal?.journalDigest);
    add("capture_terminal_receipt", task.captureTerminalReceipt?.receiptDigest);
    add("capture_controller_receipt", task.captureTerminalReceipt?.captureControllerReceiptDigest);
    add("external_task_receipt", task.authorReceipt?.receiptDigest);
    add("author_evidence", task.authorEvidence?.evidenceRoot);
    add("file_bytes", task.authorEvidence?.revisionMatchedPngDigest);
    add("canonical_json", task.authorEvidence?.sanitizedSemanticStateDigest);
    add("canonical_json", task.authorEvidence?.preAuthoritativeReadDigest);
    add("canonical_json", task.authorEvidence?.closingAuthoritativeReadDigest);
    add("canonical_json", task.authorEvidence?.controllerInspectionDigest);
    task.primaryReviews.forEach((receipt) => add("external_task_receipt", receipt.receiptDigest));
    add("external_task_receipt", task.adjudication?.receiptDigest);
    task.usageLimitInterruptions.forEach((receipt) => add("external_task_receipt", receipt.receiptDigest));
  }
  return sortedArtifactReferences(required);
}

export function assertQualificationV2TerminalStateForAttestation(
  stateInput: unknown,
): QualificationV2CoordinatorState {
  const state = qualificationV2CoordinatorStateSchema.parse(stateInput);
  if (state.pendingAction !== null || state.pendingDispatchReceipt !== null || !state.stopped) {
    throw new Error("QUALIFICATION_V2_ATTESTATION_REQUIRES_TERMINAL_STATE");
  }
  if (state.currentTaskIndex === state.tasks.length) {
    if (state.stopReason !== "completed" || state.tasks.some((task) => task.phase !== "complete")) {
      throw new Error("QUALIFICATION_V2_ATTESTATION_TERMINAL_STATE_INVALID");
    }
    return state;
  }
  const current = state.tasks[state.currentTaskIndex];
  if (current === undefined || current.phase !== "blocked"
      || !["invalid_setup", "usage_limit_interrupted", "capture_failed", "capture_indeterminate"].includes(state.stopReason)) {
    // A pre-creation subscription refusal is intentionally resumable and must
    // never be converted into a signed terminal result.
    throw new Error("QUALIFICATION_V2_ATTESTATION_STATE_IS_PAUSED_NOT_TERMINAL");
  }
  return state;
}

async function readSafeFile(filePath: string): Promise<Buffer> {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
      || (metadata.mode & 0o777) !== 0o600) {
    throw new Error("QUALIFICATION_V2_ATTESTATION_FILE_UNSAFE");
  }
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try { return await handle.readFile(); } finally { await handle.close(); }
}

async function assertSafeDirectory(directoryPath: string) {
  const metadata = await lstat(directoryPath);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o700) {
    throw new Error("QUALIFICATION_V2_ATTESTATION_DIRECTORY_UNSAFE");
  }
}

async function resolvePrivateCandidate(
  privateRoot: string,
  candidate: string,
  mustExist: boolean,
) {
  if (!path.isAbsolute(candidate) || path.normalize(candidate) !== candidate
      || candidate === path.parse(candidate).root) {
    throw new Error("QUALIFICATION_V2_ATTESTATION_PATH_INVALID");
  }
  let existing = path.resolve(candidate);
  while (true) {
    try {
      await lstat(existing);
      break;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      if (mustExist) throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw new Error("QUALIFICATION_V2_ATTESTATION_PATH_NOT_PRIVATE");
      existing = parent;
    }
  }
  const resolvedExisting = await realpath(existing);
  const resolvedCandidate = path.resolve(
    resolvedExisting,
    path.relative(existing, path.resolve(candidate)),
  );
  const relative = path.relative(privateRoot, resolvedCandidate);
  if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("QUALIFICATION_V2_ATTESTATION_PATH_NOT_PRIVATE");
  }
  return { resolvedCandidate, relative };
}

async function evidenceFilePaths(privateRoot: string, excludedRelativePaths: ReadonlySet<string>) {
  const files: string[] = [];
  async function visit(directoryPath: string) {
    await assertSafeDirectory(directoryPath);
    const entries = await readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const filePath = path.join(directoryPath, entry.name);
      const relativePath = path.relative(privateRoot, filePath);
      if (excludedRelativePaths.has(relativePath)) continue;
      const metadata = await lstat(filePath);
      if (metadata.isSymbolicLink()) throw new Error("QUALIFICATION_V2_ATTESTATION_SYMLINK_FORBIDDEN");
      if (metadata.isDirectory()) await visit(filePath);
      else if (metadata.isFile()) files.push(filePath);
      else throw new Error("QUALIFICATION_V2_ATTESTATION_SPECIAL_FILE_FORBIDDEN");
    }
  }
  await visit(privateRoot);
  return files;
}

function evidenceArtifactReferences(parsed: unknown): Readonly<{
  bindings: EvidenceArtifactReference[];
  requirements: EvidenceArtifactReference[];
}> {
  const bindings: EvidenceArtifactReference[] = [];
  const requirements: EvidenceArtifactReference[] = [];
  const bind = (kind: EvidenceArtifactReference["kind"], digest: string | null | undefined) => {
    if (digest !== null && digest !== undefined) bindings.push({ kind, digest });
  };
  const require = (kind: EvidenceArtifactReference["kind"], digest: string | null | undefined) => {
    if (digest !== null && digest !== undefined) requirements.push({ kind, digest });
  };
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    return { bindings, requirements };
  }
  const record = parsed as Record<string, unknown>;
  switch (record.schemaVersion) {
    case "exp-0001a-qualification-room-receipt/v2": {
      const receipt = qualificationV2RoomReceiptSchema.parse(parsed);
      bind("room_receipt", receipt.receiptDigest);
      require("webmcp_result", receipt.roomCreationReceiptDigest);
      break;
    }
    case "exp-0001a-qualification-room-controller-provision/v2":
    case "exp-0001a-qualification-room-controller-provision/v3": {
      const receipt = parseQualificationV2ProvisionControllerReceipt(parsed);
      bind("provision_controller_receipt", receipt.receiptDigest);
      bind(
        "harness_runtime_provenance",
        hashCanonicalJson(receipt.harnessRuntimeProvenance as unknown as JsonValue),
      );
      require("room_receipt", receipt.roomReceiptDigest);
      require("canonical_json", receipt.storageStateDigest);
      require("canonical_json", receipt.createRoomCallResultDigest);
      require("canonical_json", receipt.blankReadCallResultDigest);
      require("canonical_json", receipt.fixtureTransactionCallResultDigest);
      require("canonical_json", receipt.preAuthorReadCallResultDigest);
      break;
    }
    case "exp-0001a-qualification-capture-authorization/v2": {
      const authorization = parseQualificationV2CaptureAuthorization(parsed);
      bind("capture_authorization", authorization.actionDigest);
      require("room_receipt", authorization.roomReceiptDigest);
      require("provision_controller_receipt", authorization.provisionControllerReceiptDigest);
      require("canonical_json", authorization.storageStateDigest);
      break;
    }
    case "exp-0001a-qualification-capture-release-journal/v2": {
      const journal = parseQualificationV2CaptureReleaseJournal(parsed);
      bind("capture_release_journal", journal.journalDigest);
      require("capture_authorization", journal.captureActionDigest);
      break;
    }
    case "exp-0001a-qualification-capture-terminal/v2": {
      const receipt = parseQualificationV2CaptureTerminalReceipt(parsed);
      bind("capture_terminal_receipt", receipt.receiptDigest);
      require("capture_authorization", receipt.captureActionDigest);
      require("capture_release_journal", receipt.releaseJournalDigest);
      require("capture_controller_receipt", receipt.captureControllerReceiptDigest);
      break;
    }
    case "exp-0001a-qualification-room-controller-capture/v2":
    case "exp-0001a-qualification-room-controller-capture/v3": {
      const receipt = parseQualificationV2CaptureControllerReceipt(parsed);
      bind("capture_controller_receipt", receipt.receiptDigest);
      require("room_receipt", receipt.roomReceiptDigest);
      require("provision_controller_receipt", receipt.provisionControllerReceiptDigest);
      require("canonical_json", receipt.storageStateDigest);
      require("canonical_json", receipt.closingReadCallResultDigest);
      require("canonical_json", receipt.inspectionCallResultDigest);
      require("canonical_json", receipt.pngCallResultDigest);
      require("file_bytes", receipt.pngByteDigest);
      break;
    }
    case "exp-0001a-qualification-codex-app-bridge-request/v2": {
      const request = record as Record<string, unknown> & {
        requestDigest?: unknown;
        arguments?: unknown;
        argumentsDigest?: unknown;
        toolName?: unknown;
        actionDigest?: unknown;
        releaseJournalDigest?: unknown;
      };
      const { requestDigest, ...content } = request;
      const isCreate = request.toolName === "mcp__codex_app__create_thread";
      if (typeof requestDigest !== "string" || !SHA256_DIGEST_PATTERN.test(requestDigest)
          || typeof request.argumentsDigest !== "string"
          || hashCanonicalJson(request.arguments as JsonValue) !== request.argumentsDigest
          || hashCanonicalJson(content as unknown as JsonValue) !== requestDigest
          || isCreate !== (typeof request.actionDigest === "string"
            && typeof request.releaseJournalDigest === "string")) {
        throw new Error("QUALIFICATION_V2_ATTESTATION_BRIDGE_REQUEST_INVALID");
      }
      bind("bridge_request", requestDigest);
      if (isCreate) {
        require("external_action", String(request.actionDigest));
        require("release_journal", String(request.releaseJournalDigest));
      }
      break;
    }
    case "exp-0001a-qualification-create-invocation-authorization/v2": {
      const authorization = record as Record<string, unknown> & {
        requestDigest?: unknown;
        actionDigest?: unknown;
        releaseJournalDigest?: unknown;
        authReceipt?: unknown;
        authorizedAt?: unknown;
        expiresAt?: unknown;
        authorizationDigest?: unknown;
      };
      const { authorizationDigest, ...content } = authorization;
      const authReceipt = qualificationV2CodexAuthReceiptSchema.parse(authorization.authReceipt);
      const authorizedAt = typeof authorization.authorizedAt === "string"
        ? Date.parse(authorization.authorizedAt) : Number.NaN;
      const expiresAt = typeof authorization.expiresAt === "string"
        ? Date.parse(authorization.expiresAt) : Number.NaN;
      if (typeof authorizationDigest !== "string" || !SHA256_DIGEST_PATTERN.test(authorizationDigest)
          || hashCanonicalJson(content as unknown as JsonValue) !== authorizationDigest
          || !Number.isFinite(authorizedAt) || !Number.isFinite(expiresAt)
          || authorizedAt - Date.parse(authReceipt.checkedAt) < 0
          || authorizedAt - Date.parse(authReceipt.checkedAt) > 5 * 60_000
          || expiresAt - authorizedAt !== 5 * 60_000
          || typeof authorization.requestDigest !== "string"
          || typeof authorization.actionDigest !== "string"
          || typeof authorization.releaseJournalDigest !== "string") {
        throw new Error("QUALIFICATION_V2_ATTESTATION_BRIDGE_AUTHORIZATION_INVALID");
      }
      bind("bridge_create_authorization", authorizationDigest);
      bind("bridge_create_attempt", authorization.actionDigest);
      require("bridge_request", authorization.requestDigest);
      require("external_action", authorization.actionDigest);
      require("release_journal", authorization.releaseJournalDigest);
      break;
    }
    case "exp-0001a-qualification-codex-app-bridge-result/v2": {
      const result = record as Record<string, unknown> & {
        requestDigest?: unknown;
        toolName?: unknown;
        createInvocationAuthorizationDigest?: unknown;
        resultAuthReceipt?: unknown;
        resultAuthReceiptDigest?: unknown;
        rawCallToolResult?: unknown;
        rawCallToolResultDigest?: unknown;
        resultDigest?: unknown;
      };
      const { resultDigest, ...content } = result;
      const isCreate = result.toolName === "mcp__codex_app__create_thread";
      const resultAuthReceipt = result.resultAuthReceipt === null
        ? null : qualificationV2CodexAuthReceiptSchema.parse(result.resultAuthReceipt);
      if (typeof resultDigest !== "string" || !SHA256_DIGEST_PATTERN.test(resultDigest)
          || typeof result.rawCallToolResultDigest !== "string"
          || hashCanonicalJson(result.rawCallToolResult as JsonValue) !== result.rawCallToolResultDigest
          || hashCanonicalJson(content as unknown as JsonValue) !== resultDigest
          || typeof result.requestDigest !== "string"
          || isCreate !== (typeof result.createInvocationAuthorizationDigest === "string"
            && resultAuthReceipt !== null
            && result.resultAuthReceiptDigest === resultAuthReceipt.receiptSha256)) {
        throw new Error("QUALIFICATION_V2_ATTESTATION_BRIDGE_RESULT_INVALID");
      }
      bind("bridge_result", resultDigest);
      bind(isCreate ? "bridge_create_result" : "raw_tool_result", result.rawCallToolResultDigest);
      require("bridge_request", result.requestDigest);
      if (isCreate) require("bridge_create_authorization", String(result.createInvocationAuthorizationDigest));
      break;
    }
    case "exp-0001a-qualification-external-action/v2": {
      const action = qualificationV2ExternalActionSchema.parse(parsed);
      bind("external_action", action.actionDigest);
      break;
    }
    case "exp-0001a-qualification-release-journal/v2": {
      const journal = record as Record<string, unknown> & { action?: unknown; journalDigest?: unknown };
      const action = qualificationV2ExternalActionSchema.parse(journal.action);
      const { journalDigest, ...content } = journal;
      if (typeof journalDigest !== "string" || !SHA256_DIGEST_PATTERN.test(journalDigest)
          || hashCanonicalJson(content as unknown as JsonValue) !== journalDigest) {
        throw new Error("QUALIFICATION_V2_ATTESTATION_RELEASE_JOURNAL_INVALID");
      }
      bind("release_journal", journalDigest);
      bind("raw_create_evidence", journalDigest);
      bind("external_action", action.actionDigest);
      bind("dispatch_receipt", hashCanonicalJson({
        schemaVersion: "exp-0001a-qualification-dispatch-receipt/v2",
        actionDigest: action.actionDigest,
        releaseJournalDigest: journalDigest,
        acknowledgedAt: journal.recordedAt,
        invocationPermittedExactlyOnce: true,
        externalToolInvokedByCoordinatorLibrary: true,
      }));
      break;
    }
    case "exp-0001a-qualification-raw-tool-observation/v2": {
      const observation = record as Record<string, unknown> & {
        observationDigest?: unknown;
        rawResult?: unknown;
        rawResultDigest?: unknown;
      };
      const { observationDigest, ...content } = observation;
      if (typeof observationDigest !== "string" || !SHA256_DIGEST_PATTERN.test(observationDigest)
          || hashCanonicalJson(content as unknown as JsonValue) !== observationDigest
          || ((observation.rawResult === null) !== (observation.rawResultDigest === null))
          || (observation.rawResult !== null
            && (typeof observation.rawResultDigest !== "string"
              || hashCanonicalJson(observation.rawResult as JsonValue) !== observation.rawResultDigest))) {
        throw new Error("QUALIFICATION_V2_ATTESTATION_RAW_OBSERVATION_INVALID");
      }
      bind("raw_tool_observation", observationDigest);
      if (observation.toolName === "mcp__codex_app__list_threads") {
        bind("identity_reconciliation", observationDigest);
      }
      bind("raw_create_evidence", observationDigest);
      if (typeof observation.rawResultDigest === "string") {
        bind("raw_tool_result", observation.rawResultDigest);
        bind("raw_create_evidence", observation.rawResultDigest);
      }
      break;
    }
    case "exp-0001a-qualification-external-task-receipt/v2": {
      const receipt = qualificationV2ExternalTaskReceiptSchema.parse(parsed);
      bind("external_task_receipt", receipt.receiptDigest);
      require("external_action", receipt.actionDigest);
      require("dispatch_receipt", receipt.dispatchReceiptDigest);
      require("raw_create_evidence", receipt.rawCreateToolResultDigest);
      require("terminal_trace", receipt.rawTerminalToolResultDigest);
      if (receipt.listThreadsObservationDigest !== null) {
        require("identity_reconciliation", receipt.listThreadsObservationDigest);
      }
      if (receipt.createdTaskId !== null) {
        require("bridge_create_attempt", receipt.actionDigest);
        require("raw_tool_result", receipt.rawCreateToolResultDigest);
        require("bridge_create_result", receipt.rawCreateToolResultDigest);
      }
      break;
    }
    case "exp-0001a-qualification-author-evidence/v2": {
      const evidence = qualificationV2AuthorEvidenceSchema.parse(parsed);
      bind("author_evidence", evidence.evidenceRoot);
      require("file_bytes", evidence.revisionMatchedPngDigest);
      require("canonical_json", evidence.sanitizedSemanticStateDigest);
      require("canonical_json", evidence.preAuthoritativeReadDigest);
      require("canonical_json", evidence.closingAuthoritativeReadDigest);
      require("canonical_json", evidence.controllerInspectionDigest);
      break;
    }
    case "exp-0001a-qualification-evidence-sidecar-read-receipt/v2": {
      const receipt = qualificationV2EvidenceSidecarReadReceiptSchema.parse(parsed);
      bind("sidecar_read_receipt", receipt.receiptDigest);
      require("file_bytes", receipt.servedByteDigest);
      break;
    }
    default: {
      // The capture controller request intentionally carries the authorization
      // and release journal inline so the controller can receive one exact,
      // self-contained dispatch packet. Treat those nested, schema-validated
      // objects as first-class evidence bindings. Otherwise a completely
      // retained successful capture can fail the terminal evidence replay
      // merely because the operator did not duplicate the authorization into
      // a second standalone file.
      if (record.operation === "capture_author_evidence"
          && record.captureAuthorization !== undefined
          && record.captureReleaseJournal !== undefined) {
        const authorization = parseQualificationV2CaptureAuthorization(record.captureAuthorization);
        const journal = parseQualificationV2CaptureReleaseJournal(record.captureReleaseJournal);
        bind("capture_authorization", authorization.actionDigest);
        require("room_receipt", authorization.roomReceiptDigest);
        require("provision_controller_receipt", authorization.provisionControllerReceiptDigest);
        require("canonical_json", authorization.storageStateDigest);
        bind("capture_release_journal", journal.journalDigest);
        require("capture_authorization", journal.captureActionDigest);
      }
      const provenance = qualificationV2HarnessRuntimeProvenanceSchema.safeParse(parsed);
      if (provenance.success) {
        bind("harness_runtime_provenance", hashCanonicalJson(provenance.data as unknown as JsonValue));
      }
      // A retained browser WebMCP CallToolResult binds its parsed semantic
      // payload without treating arbitrary digest-shaped strings as evidence.
      if (typeof record.isError === "boolean" && Array.isArray(record.content)
          && record.content.length >= 1) {
        const first = record.content[0];
        if (first !== null && !Array.isArray(first) && typeof first === "object"
            && (first as Record<string, unknown>).type === "text"
            && typeof (first as Record<string, unknown>).text === "string") {
          try {
            const semanticResult = JSON.parse(String((first as Record<string, unknown>).text)) as JsonValue;
            bind("webmcp_result", hashCanonicalJson(semanticResult));
          } catch {
            // Error wrappers may intentionally carry non-JSON text; they are
            // still byte/canonical bound but cannot prove a semantic result.
          }
        }
      }
    }
  }
  return {
    bindings: sortedArtifactReferences(bindings),
    requirements: sortedArtifactReferences(requirements),
  };
}

/** Exposes the schema-aware binding projection for focused evidence-graph
 * regression tests without exposing any file-system attestation authority. */
export function qualificationV2EvidenceArtifactReferences(input: unknown) {
  return evidenceArtifactReferences(input);
}

async function fileEntry(privateRoot: string, filePath: string) {
  const bytes = await readSafeFile(filePath);
  let parsed: unknown = null;
  let canonicalJsonDigest: string | null = null;
  let referencedDigests: string[] = [];
  let artifactBindings: EvidenceArtifactReference[] = [];
  let artifactRequirements: EvidenceArtifactReference[] = [];
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    canonicalJsonDigest = hashCanonicalJson(parsed as JsonValue);
    referencedDigests = [...collectDigests(parsed)].sort();
    const artifacts = evidenceArtifactReferences(parsed);
    artifactBindings = artifacts.bindings;
    artifactRequirements = artifacts.requirements;
  } catch {
    if (parsed !== null) throw new Error("QUALIFICATION_V2_ATTESTATION_RETAINED_JSON_INVALID");
    // Binary artifacts such as exact-revision PNGs are bound by raw bytes.
  }
  const content = evidenceFileEntryContentSchema.parse({
    relativePath: path.relative(privateRoot, filePath),
    byteDigest: sha256Digest(bytes),
    byteLength: bytes.length,
    canonicalJsonDigest,
    referencedDigests,
    artifactBindings,
    artifactRequirements,
  });
  const entry = qualificationV2EvidenceFileEntrySchema.parse({
    ...content,
    entryDigest: hashCanonicalJson(content as unknown as JsonValue),
  });
  return { entry, parsed };
}

function terminalTraceBindings(retained: readonly Readonly<{ parsed: unknown }>[]) {
  const actions = new Map<string, z.infer<typeof qualificationV2ExternalActionSchema>>();
  const receipts: Array<z.infer<typeof qualificationV2ExternalTaskReceiptSchema>> = [];
  const observations: Array<Readonly<{
    actionDigest: string;
    toolName: string;
    invocationOrdinal: number;
    observationDigest: string;
  }>> = [];
  const sidecarReads: Array<z.infer<typeof qualificationV2EvidenceSidecarReadReceiptSchema>> = [];
  for (const item of retained) {
    if (item.parsed === null || Array.isArray(item.parsed) || typeof item.parsed !== "object") continue;
    const record = item.parsed as Record<string, unknown>;
    if (record.schemaVersion === "exp-0001a-qualification-release-journal/v2") {
      const action = qualificationV2ExternalActionSchema.parse(record.action);
      actions.set(action.actionDigest, action);
    } else if (record.schemaVersion === "exp-0001a-qualification-external-task-receipt/v2") {
      receipts.push(qualificationV2ExternalTaskReceiptSchema.parse(record));
    } else if (record.schemaVersion === "exp-0001a-qualification-raw-tool-observation/v2") {
      if (typeof record.actionDigest !== "string" || typeof record.toolName !== "string"
          || !Number.isSafeInteger(record.invocationOrdinal) || Number(record.invocationOrdinal) < 1
          || typeof record.observationDigest !== "string") {
        throw new Error("QUALIFICATION_V2_ATTESTATION_RAW_OBSERVATION_TRACE_INVALID");
      }
      observations.push({
        actionDigest: record.actionDigest,
        toolName: record.toolName,
        invocationOrdinal: Number(record.invocationOrdinal),
        observationDigest: record.observationDigest,
      });
    } else if (record.schemaVersion === "exp-0001a-qualification-evidence-sidecar-read-receipt/v2") {
      sidecarReads.push(qualificationV2EvidenceSidecarReadReceiptSchema.parse(record));
    }
  }
  const bindings: EvidenceArtifactReference[] = [];
  for (const receipt of receipts) {
    const action = actions.get(receipt.actionDigest);
    if (action === undefined) continue;
    const ordered = (toolName: string) => observations
      .filter((observation) => observation.actionDigest === receipt.actionDigest
        && observation.toolName === toolName)
      .sort((left, right) => left.invocationOrdinal - right.invocationOrdinal);
    const waits = ordered("mcp__codex_app__wait_threads");
    const reads = ordered("mcp__codex_app__read_thread");
    if (new Set(waits.map((item) => item.invocationOrdinal)).size !== waits.length
        || new Set(reads.map((item) => item.invocationOrdinal)).size !== reads.length) {
      throw new Error("QUALIFICATION_V2_ATTESTATION_TERMINAL_TRACE_ORDINAL_DUPLICATE");
    }
    let evidenceReadReceiptDigest: string | null = null;
    if (receipt.reviewDecision !== null) {
      const manifestDigest = action.reviewEvidenceSidecar?.manifestDigest;
      const matching = manifestDigest === undefined ? []
        : sidecarReads.filter((candidate) => candidate.manifestDigest === manifestDigest);
      if (matching.length !== 1) continue;
      evidenceReadReceiptDigest = matching[0]!.receiptDigest;
    }
    const digest = hashCanonicalJson({
      waits: waits.map((item) => item.observationDigest),
      reads: reads.map((item) => item.observationDigest),
      evidenceReadReceiptDigest,
    });
    bindings.push({ kind: "terminal_trace", digest });
  }
  return sortedArtifactReferences(bindings);
}

async function resolvePrivateInputs(input: Readonly<{
  repositoryRoot: string;
  statePath: string;
  excludedPaths: readonly string[];
}>) {
  const resolvedRepositoryRoot = await realpath(input.repositoryRoot);
  const allowedRoots = [
    path.join(resolvedRepositoryRoot, ".research-private", "exp0001a-qualification-v2"),
    path.join(resolvedRepositoryRoot, ".research-private", "exp0001a-qualification-v3"),
  ];
  const absoluteStatePath = await realpath(input.statePath);
  const privateRoot = allowedRoots.find((candidate) => {
    const relative = path.relative(candidate, absoluteStatePath);
    return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
  });
  if (privateRoot === undefined) {
    throw new Error("QUALIFICATION_V2_ATTESTATION_PATH_NOT_PRIVATE");
  }
  const resolvedPrivateRoot = await realpath(privateRoot);
  if (resolvedPrivateRoot !== privateRoot) throw new Error("QUALIFICATION_V2_ATTESTATION_PRIVATE_ROOT_INVALID");
  await assertSafeDirectory(resolvedPrivateRoot);
  const stateCandidate = await resolvePrivateCandidate(resolvedPrivateRoot, input.statePath, true);
  const stateRealPath = await realpath(stateCandidate.resolvedCandidate);
  const stateRelativePath = stateCandidate.relative;
  const excluded = new Set<string>([stateRelativePath]);
  for (const candidate of input.excludedPaths) {
    const resolved = await resolvePrivateCandidate(resolvedPrivateRoot, candidate, false);
    excluded.add(resolved.relative);
  }
  return { privateRoot: resolvedPrivateRoot, stateRealPath, stateRelativePath, excluded };
}

async function currentHarnessIdentity(repositoryRoot: string) {
  const [commit, tree, status] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }),
    execFileAsync("git", ["rev-parse", "HEAD^{tree}"], { cwd: repositoryRoot, encoding: "utf8" }),
    execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    }),
  ]);
  if (status.stdout.trim().length !== 0) throw new Error("QUALIFICATION_V2_ATTESTATION_WORKTREE_NOT_CLEAN");
  return { gitCommit: commit.stdout.trim(), gitTree: tree.stdout.trim() };
}

export async function createQualificationV2TerminalEvidenceAttestation(input: Readonly<{
  repositoryRoot: string;
  statePath: string;
  excludedPaths: readonly string[];
  attestedAt: string;
}>) {
  const resolved = await resolvePrivateInputs(input);
  const stateBytes = await readSafeFile(resolved.stateRealPath);
  const state = assertQualificationV2TerminalStateForAttestation(JSON.parse(stateBytes.toString("utf8")));
  if (Date.parse(input.attestedAt) < Date.parse(state.updatedAt)) {
    throw new Error("QUALIFICATION_V2_ATTESTATION_PREDATES_STATE");
  }
  const provenance = state.controllerHarnessRuntimeProvenance;
  if (provenance === null) throw new Error("QUALIFICATION_V2_ATTESTATION_HARNESS_PROVENANCE_MISSING");
  const harness = await currentHarnessIdentity(input.repositoryRoot);
  if (harness.gitCommit !== provenance.gitCommit || harness.gitTree !== provenance.gitTree) {
    throw new Error("QUALIFICATION_V2_ATTESTATION_HARNESS_PROVENANCE_DRIFT");
  }
  const files = await evidenceFilePaths(resolved.privateRoot, resolved.excluded);
  const retained = await Promise.all(files.map((filePath) => fileEntry(resolved.privateRoot, filePath)));
  const entries = retained.map((item) => item.entry)
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const aggregateBindings = terminalTraceBindings(retained);
  const requiredArtifacts = sortedArtifactReferences([
    ...requiredEvidenceArtifacts(state),
    ...entries.flatMap((entry) => entry.artifactRequirements),
  ]);
  const availableArtifactReferences = entries.flatMap((entry) => [
    artifactReferenceKey({ kind: "file_bytes", digest: entry.byteDigest }),
    ...(entry.canonicalJsonDigest === null ? [] : [
      artifactReferenceKey({ kind: "canonical_json", digest: entry.canonicalJsonDigest }),
    ]),
    ...entry.artifactBindings.map(artifactReferenceKey),
  ]).concat(aggregateBindings.map(artifactReferenceKey));
  const availableArtifactKeys = new Set(availableArtifactReferences);
  const missing = requiredArtifacts.filter((candidate) => !availableArtifactKeys.has(artifactReferenceKey(candidate)));
  if (missing.length > 0) throw new Error("QUALIFICATION_V2_ATTESTATION_REQUIRED_EVIDENCE_MISSING");
  const required = [...new Set(requiredArtifacts.map((reference) => reference.digest))].sort();
  const content = terminalEvidenceAttestationContentSchema.parse({
    schemaVersion: "exp-0001a-qualification-terminal-evidence-attestation/v2",
    protocolId: "EXP-0001A-MODEL-ROLE-QUALIFICATION-V2",
    kind: "terminal-evidence-attestation",
    attestedAt: input.attestedAt,
    terminalStateRelativePath: resolved.stateRelativePath,
    terminalStateDigest: state.stateDigest,
    terminalStateByteDigest: sha256Digest(stateBytes),
    harnessRuntimeProvenanceDigest: hashCanonicalJson(provenance as unknown as JsonValue),
    harnessGitCommit: harness.gitCommit,
    harnessGitTree: harness.gitTree,
    worktreeClean: true,
    requiredEvidenceDigests: required,
    requiredEvidenceArtifacts: requiredArtifacts,
    evidenceFiles: entries,
    evidenceFileCount: entries.length,
    evidenceInventoryRoot: hashCanonicalJson(entries.map((entry) => entry.entryDigest) as unknown as JsonValue),
  });
  return Object.freeze(qualificationV2TerminalEvidenceAttestationSchema.parse({
    ...content,
    attestationDigest: hashCanonicalJson(content as unknown as JsonValue),
  }));
}

export async function verifyQualificationV2TerminalEvidenceAttestation(input: Readonly<{
  repositoryRoot: string;
  statePath: string;
  excludedPaths: readonly string[];
  attestation: unknown;
}>) {
  const expected = qualificationV2TerminalEvidenceAttestationSchema.parse(input.attestation);
  const observed = await createQualificationV2TerminalEvidenceAttestation({
    repositoryRoot: input.repositoryRoot,
    statePath: input.statePath,
    excludedPaths: input.excludedPaths,
    attestedAt: expected.attestedAt,
  });
  if (canonicalJson(observed as unknown as JsonValue) !== canonicalJson(expected as unknown as JsonValue)) {
    throw new Error("QUALIFICATION_V2_ATTESTATION_REPLAY_MISMATCH");
  }
  return expected;
}
