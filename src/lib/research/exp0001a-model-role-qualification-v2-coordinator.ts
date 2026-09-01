import { z } from "zod";

import {
  EXP0001A_QUALIFICATION_V2_AUTHOR,
  EXP0001A_QUALIFICATION_V2_TASK_IDS,
  evaluateExp0001aModelRoleQualificationV2,
  exp0001aModelRoleQualificationV2PlanSchema,
  exp0001aModelRoleQualificationV2AttemptSchema,
} from "./exp0001a-model-role-qualification-v2";
import {
  exp0001aQualificationV2AuthoritySignatureSchema,
  verifyExp0001aQualificationV2AuthoritySignature,
} from "./exp0001a-model-role-qualification-v2-authority";
import {
  canonicalJson,
  hashCanonicalJson,
  SHA256_DIGEST_PATTERN,
  type JsonValue,
} from "./provenance-crypto";
import {
  benchmarkCommitments,
  compileBenchmarkTaskExecution,
  parseBenchmarkExecutionBundle,
} from "./benchmark-execution";
import {
  parseQualificationV2SanitizedSemanticState,
  qualificationV2SanitizedSemanticStateSchema,
} from "./exp0001a-model-role-qualification-v2-semantic-projection";
import { qualificationV2EvidenceSidecarManifestSchema } from "./exp0001a-model-role-qualification-v2-png-sidecar";
import {
  parseQualificationV2CaptureTerminalReceipt,
  qualificationV2CaptureAuthorizationSchema,
  qualificationV2CaptureReleaseJournalSchema,
  qualificationV2CaptureRequestBasisSchema,
  qualificationV2CaptureTerminalReceiptSchema,
  qualificationV2HarnessRuntimeProvenanceSchema,
  sealQualificationV2CaptureAuthorization,
  sealQualificationV2CaptureReleaseJournal,
  sealQualificationV2CaptureTerminalReceipt,
} from "./exp0001a-model-role-qualification-v2-room-controller-receipts";

const digestSchema = z.string().regex(SHA256_DIGEST_PATTERN);
const timestampSchema = z.string().datetime({ offset: true });
const idSchema = z.string().trim().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const taskIdSchema = z.enum(EXP0001A_QUALIFICATION_V2_TASK_IDS);

export const EXP0001A_QUALIFICATION_V2_COORDINATOR_VERSION =
  "exp-0001a-model-role-qualification-coordinator/v2" as const;

export const EXP0001A_QUALIFICATION_V2_AUTHOR_DISPLAY_NAME =
  "EXP-0001A Qualification Author" as const;

const observedDigestSchema = z.object({
  observability: z.literal("observed"),
  value: digestSchema,
}).strict();

const unobservableSchema = z.object({
  observability: z.literal("unobservable"),
  value: z.null(),
}).strict();

export const qualificationV2CodexAuthReceiptSchema = z.object({
  schemaVersion: z.literal("codex-chatgpt-auth-preflight/v1"),
  checkedAt: timestampSchema,
  command: z.object({
    executable: z.literal("codex"),
    arguments: z.tuple([z.literal("login"), z.literal("status")]),
  }).strict(),
  authentication: z.object({
    method: z.literal("chatgpt"),
    accountIdentifier: unobservableSchema,
    subscriptionPlan: unobservableSchema,
  }).strict(),
  observation: z.object({
    exitCode: z.object({ observability: z.literal("observed"), value: z.literal(0) }).strict(),
    signal: unobservableSchema,
    stdoutSha256: observedDigestSchema,
    stderrSha256: observedDigestSchema,
    rawOutputRetained: z.literal(false),
    outputLimitExceeded: z.literal(false),
    invocationError: z.literal(false),
  }).strict(),
  decision: z.object({
    allowCodexNativeExperiment: z.literal(true),
    reasonCode: z.literal("CHATGPT_AUTHENTICATED"),
  }).strict(),
  receiptSha256: digestSchema,
}).strict().superRefine((receipt, context) => {
  const { receiptSha256: _receiptSha256, ...content } = receipt;
  void _receiptSha256;
  if (hashCanonicalJson(content as unknown as JsonValue) !== receipt.receiptSha256) {
    context.addIssue({ code: "custom", path: ["receiptSha256"], message: "Auth receipt digest is invalid." });
  }
});

export const qualificationV2ProductionBindingSchema = z.object({
  schemaVersion: z.literal("exp-0001a-qualification-production-binding/v2"),
  planDigest: digestSchema,
  planDeclaredSuccessorCommit: z.literal("88919b8e0070fbd1b2be4f3e4121cfdcf50638a6"),
  predecessorPlanBytesMutated: z.literal(false),
  supersessionReason: z.literal("production_export_route_hotfix_and_successor_baseline_freeze"),
  baselineReceiptSchema: z.literal("baseline-freeze/v2"),
  baselineFreezeDigest: digestSchema,
  baselineAuthoritySignatureDigest: digestSchema,
  productionCommit: z.literal("66a546aaef9e006891a4cf619ed310fd9fc1c4cc"),
  productionTree: z.literal("071a751beadbcefc002f42d1be75a0e717bc3e4b"),
  deploymentId: z.literal("dpl_46pyqWtLXGfzeU1JsqXEWQjTBfd8"),
  buildId: z.literal("bld_3t0eopcj7"),
  productionAlias: z.literal("https://www.jazzboard.xyz"),
  verifiedAt: timestampSchema,
  aliasAndContractDriftObserved: z.literal(false),
  semanticExportPreflightPassed: z.literal(true),
  exactRevisionPngPreflightPassed: z.literal(true),
  browserWebMcpContractPassed: z.literal(true),
  bindingDigest: digestSchema,
}).strict().superRefine((binding, context) => {
  const { bindingDigest: _bindingDigest, ...content } = binding;
  void _bindingDigest;
  if (hashCanonicalJson(content as unknown as JsonValue) !== binding.bindingDigest) {
    context.addIssue({ code: "custom", path: ["bindingDigest"], message: "Production binding digest is invalid." });
  }
});

export function sealQualificationV2ProductionBinding(input: unknown) {
  const content = z.object(
    Object.fromEntries(
      Object.entries(qualificationV2ProductionBindingSchema.shape)
        .filter(([key]) => key !== "bindingDigest"),
    ) as Omit<typeof qualificationV2ProductionBindingSchema.shape, "bindingDigest">,
  ).strict().parse(input);
  return Object.freeze(qualificationV2ProductionBindingSchema.parse({
    ...content,
    bindingDigest: hashCanonicalJson(content as unknown as JsonValue),
  }));
}

export const qualificationV2PublicTaskInputSchema = z.object({
  taskId: taskIdSchema,
  title: z.string().trim().min(1).max(300),
  brief: z.string().trim().min(1).max(5_000),
  acceptanceCriteria: z.array(z.object({
    id: idSchema,
    text: z.string().trim().min(1).max(5_000),
  }).strict()).min(1).max(30),
  initialState: z.record(z.string(), z.unknown()),
  publicTaskPacket: z.record(z.string(), z.unknown()),
  benchmarkTaskDigest: digestSchema,
  publicPacketCommitment: digestSchema,
  publicTaskDigest: digestSchema,
}).strict().superRefine((task, context) => {
  const { publicTaskDigest: _publicTaskDigest, ...content } = task;
  void _publicTaskDigest;
  if (hashCanonicalJson(content as unknown as JsonValue) !== task.publicTaskDigest) {
    context.addIssue({ code: "custom", path: ["publicTaskDigest"], message: "Public task digest is invalid." });
  }
});

export function compileQualificationV2PublicTaskInput(
  benchmarkInput: unknown,
  taskId: typeof EXP0001A_QUALIFICATION_V2_TASK_IDS[number],
  commitmentsInput: Readonly<{ task: string; publicPacket: string }>,
) {
  const benchmark = z.object({
    benchmarkId: z.literal("jazzboard-development-v2"),
    split: z.literal("development"),
    tasks: z.array(z.object({
      id: z.string(),
      title: z.string(),
      brief: z.string(),
      acceptanceCriteria: z.array(z.object({ id: z.string(), text: z.string() }).passthrough()),
      initialState: z.record(z.string(), z.unknown()),
      publicTaskPacket: z.record(z.string(), z.unknown()),
    }).passthrough()),
  }).passthrough().parse(benchmarkInput);
  const source = benchmark.tasks.find((task) => task.id === taskId);
  if (!source) throw new Error("QUALIFICATION_V2_PUBLIC_TASK_NOT_FOUND");
  const content = {
    taskId,
    title: source.title,
    brief: source.brief,
    acceptanceCriteria: source.acceptanceCriteria.map(({ id, text }) => ({ id, text })),
    initialState: source.initialState,
    publicTaskPacket: source.publicTaskPacket,
    benchmarkTaskDigest: commitmentsInput.task,
    publicPacketCommitment: commitmentsInput.publicPacket,
  };
  return Object.freeze(qualificationV2PublicTaskInputSchema.parse({
    ...content,
    publicTaskDigest: hashCanonicalJson(content as unknown as JsonValue),
  }));
}

export function compileQualificationV2PublicTasksFromExecutionBundle(
  rawBenchmark: unknown,
  rawRubrics: unknown,
  rawFixtureSpecs: unknown,
) {
  const bundle = parseBenchmarkExecutionBundle(rawBenchmark, rawRubrics, rawFixtureSpecs);
  const commitments = benchmarkCommitments(bundle);
  return Object.freeze({
    bundle,
    bundleDigest: commitments.fullBundle,
    publicTasks: EXP0001A_QUALIFICATION_V2_TASK_IDS.map((taskId) => (
      compileQualificationV2PublicTaskInput(bundle.benchmark, taskId, commitments.tasks[taskId])
    )),
    taskExecutions: EXP0001A_QUALIFICATION_V2_TASK_IDS.map((taskId) => compileBenchmarkTaskExecution(bundle, taskId)),
  });
}

export const qualificationV2RoomReceiptSchema = z.object({
  schemaVersion: z.literal("exp-0001a-qualification-room-receipt/v2"),
  taskId: taskIdSchema,
  preparedAt: timestampSchema,
  roomId: idSchema,
  privateRoomInviteUrl: z.string().regex(/^https:\/\/www\.jazzboard\.xyz\/#join=[A-HJ-NP-Z2-9]{6}$/),
  inviteAuthorizationBindingDigest: digestSchema,
  authorization: z.literal("exact_private_invite_only"),
  globalDirectoryUsed: z.literal(false),
  roomCreationReceiptDigest: digestSchema,
  initialStateKind: z.enum(["blank", "validated_fixture"]),
  initialRoomRevision: z.number().int().nonnegative(),
  initialObjectCount: z.number().int().nonnegative(),
  fixturePreflightDigest: digestSchema.nullable(),
  receiptDigest: digestSchema,
}).strict().superRefine((receipt, context) => {
  const { receiptDigest: _receiptDigest, ...content } = receipt;
  void _receiptDigest;
  if (hashCanonicalJson({
    roomId: receipt.roomId,
    privateRoomInviteUrl: receipt.privateRoomInviteUrl,
  }) !== receipt.inviteAuthorizationBindingDigest) {
    context.addIssue({ code: "custom", path: ["inviteAuthorizationBindingDigest"], message: "Private invite is not cryptographically bound to the retained room." });
  }
  if ((receipt.initialStateKind === "blank") !== (receipt.fixturePreflightDigest === null)) {
    context.addIssue({ code: "custom", path: ["fixturePreflightDigest"], message: "Only validated fixtures require a preflight digest." });
  }
  if (receipt.initialStateKind === "blank" && receipt.initialObjectCount !== 0) {
    context.addIssue({ code: "custom", path: ["initialObjectCount"], message: "Blank qualification rooms must be empty." });
  }
  if (hashCanonicalJson(content as unknown as JsonValue) !== receipt.receiptDigest) {
    context.addIssue({ code: "custom", path: ["receiptDigest"], message: "Room receipt digest is invalid." });
  }
});

export function sealQualificationV2RoomReceipt(input: unknown) {
  const content = z.object(
    Object.fromEntries(
      Object.entries(qualificationV2RoomReceiptSchema.shape)
        .filter(([key]) => key !== "receiptDigest"),
    ) as Omit<typeof qualificationV2RoomReceiptSchema.shape, "receiptDigest">,
  ).strict().parse(input);
  return Object.freeze(qualificationV2RoomReceiptSchema.parse({
    ...content,
    receiptDigest: hashCanonicalJson(content as unknown as JsonValue),
  }));
}

const taskRoleSchema = z.enum(["author", "primary_reviewer", "adjudicator"]);

const loopbackPngUrlSchema = z.string().regex(
  /^http:\/\/(?:127\.0\.0\.1|localhost):([1-9][0-9]{0,4})\/evidence\/[a-f0-9]{32}\.png$/,
).superRefine((value, context) => {
  const port = Number(new URL(value).port);
  if (port > 65_535) context.addIssue({ code: "custom", message: "Loopback evidence port is invalid." });
});

export const qualificationV2ExternalActionSchema = z.object({
  schemaVersion: z.literal("exp-0001a-qualification-external-action/v2"),
  actionId: idSchema,
  preparedAt: timestampSchema,
  planDigest: digestSchema,
  productionBindingDigest: digestSchema,
  taskId: taskIdSchema,
  role: taskRoleSchema,
  roleOrdinal: z.number().int().min(1).max(2),
  authReceiptDigest: digestSchema,
  inputEnvelopeDigest: digestSchema,
  toolName: z.literal("mcp__codex_app__create_thread"),
  arguments: z.object({
    prompt: z.string().min(1).max(100_000),
    target: z.object({ type: z.literal("projectless"), directoryName: idSchema }).strict(),
    model: z.enum(["gpt-5.6-terra", "gpt-5.6-sol"]),
    thinking: z.enum(["medium", "high"]),
    title: z.string().trim().min(1).max(160),
  }).strict(),
  sourceTaskId: z.null(),
  forkedFromTaskId: z.null(),
  reviewEvidenceSidecar: z.object({
    exactRevisionPngUrl: loopbackPngUrlSchema,
    manifest: qualificationV2EvidenceSidecarManifestSchema,
    manifestDigest: digestSchema,
    sidecarReceiptDigest: digestSchema,
    oneSuccessfulReadRequired: z.literal(true),
  }).strict().nullable(),
  actionDigest: digestSchema,
}).strict().superRefine((action, context) => {
  const expected = action.role === "author"
    ? { model: "gpt-5.6-terra", thinking: "medium", ordinal: 1 }
    : { model: "gpt-5.6-sol", thinking: "high", ordinal: action.roleOrdinal };
  if (action.arguments.model !== expected.model || action.arguments.thinking !== expected.thinking
      || (action.role === "author" && action.roleOrdinal !== expected.ordinal)) {
    context.addIssue({ code: "custom", path: ["arguments"], message: "Role model or reasoning drifted." });
  }
  if ((action.reviewEvidenceSidecar === null) !== (action.role === "author")) {
    context.addIssue({ code: "custom", path: ["reviewEvidenceSidecar"], message: "Only reviewer actions require an evidence sidecar." });
  }
  const { actionDigest: _actionDigest, ...content } = action;
  void _actionDigest;
  if (hashCanonicalJson(content as unknown as JsonValue) !== action.actionDigest) {
    context.addIssue({ code: "custom", path: ["actionDigest"], message: "External action digest is invalid." });
  }
});

export const qualificationV2DispatchReceiptSchema = z.object({
  schemaVersion: z.literal("exp-0001a-qualification-dispatch-receipt/v2"),
  actionDigest: digestSchema,
  releaseJournalDigest: digestSchema,
  acknowledgedAt: timestampSchema,
  invocationPermittedExactlyOnce: z.literal(true),
  externalToolInvokedByCoordinatorLibrary: z.literal(true),
  receiptDigest: digestSchema,
}).strict().superRefine((receipt, context) => {
  const { receiptDigest: _receiptDigest, ...content } = receipt;
  void _receiptDigest;
  if (hashCanonicalJson(content as unknown as JsonValue) !== receipt.receiptDigest) {
    context.addIssue({ code: "custom", path: ["receiptDigest"], message: "Dispatch receipt digest is invalid." });
  }
});

const blindnessSchema = z.object({
  authorTranscriptSeen: z.literal(false),
  authorIdentitySeen: z.literal(false),
  conditionLabelSeen: z.literal(false),
  pairedArtifactSeen: z.literal(false),
  repositoryAccessed: z.literal(false),
  otherReviewerDecisionSeen: z.literal(false),
}).strict();

const reviewDecisionSchema = z.object({
  artifactAccepted: z.boolean(),
  criterionPasses: z.record(idSchema, z.boolean()),
  evidenceRoot: digestSchema,
  blindness: blindnessSchema,
}).strict();

export const qualificationV2ExternalTaskReceiptSchema = z.object({
  schemaVersion: z.literal("exp-0001a-qualification-external-task-receipt/v2"),
  actionDigest: digestSchema,
  dispatchReceiptDigest: digestSchema,
  taskId: taskIdSchema,
  role: taskRoleSchema,
  roleOrdinal: z.number().int().min(1).max(2),
  requestedModel: z.enum(["gpt-5.6-terra", "gpt-5.6-sol"]),
  requestedReasoningEffort: z.enum(["medium", "high"]),
  workspace: z.literal("projectless"),
  repositoryAccess: z.union([z.literal(false), z.literal("unobservable")]),
  privateApiAccess: z.union([z.literal(false), z.literal("unobservable")]),
  sourceTaskId: z.null(),
  forkedFromTaskId: z.null(),
  createdTaskId: idSchema.nullable(),
  hostId: idSchema.nullable(),
  clientTaskId: idSchema.nullable(),
  rawCreateToolResultDigest: digestSchema,
  listThreadsObservationDigest: digestSchema.nullable(),
  rawTerminalToolResultDigest: digestSchema,
  terminalStatus: z.enum(["completed", "failed", "usage_limit_interrupted", "invalid_setup"]),
  terminalResultDigest: digestSchema,
  reviewDecision: reviewDecisionSchema.nullable(),
  wallTimeMs: z.union([z.number().int().nonnegative(), z.literal("unobservable")]),
  subscriptionUsage: z.literal("unobservable"),
  resolvedModelSnapshot: z.literal("unobservable"),
  exactTokens: z.literal("unobservable"),
  retainedAt: timestampSchema,
  receiptDigest: digestSchema,
}).strict().superRefine((receipt, context) => {
  const expected = receipt.role === "author"
    ? { model: "gpt-5.6-terra", effort: "medium", review: false }
    : { model: "gpt-5.6-sol", effort: "high", review: true };
  if (receipt.requestedModel !== expected.model || receipt.requestedReasoningEffort !== expected.effort
      || ((receipt.reviewDecision !== null) !== (expected.review && receipt.terminalStatus === "completed"))) {
    context.addIssue({ code: "custom", message: "Task receipt role evidence is inconsistent." });
  }
  if (receipt.terminalStatus === "completed"
      && (receipt.repositoryAccess !== false || receipt.privateApiAccess !== false)) {
    context.addIssue({ code: "custom", message: "A completed task requires a complete retained isolation trace." });
  }
  const hasCreatedTask = receipt.createdTaskId !== null && receipt.hostId !== null;
  if ((receipt.createdTaskId === null) !== (receipt.hostId === null)
      || ((receipt.terminalStatus === "completed" || receipt.terminalStatus === "failed") && !hasCreatedTask)
      || (receipt.terminalStatus === "invalid_setup" && hasCreatedTask)
      || (receipt.clientTaskId !== null && receipt.listThreadsObservationDigest === null)) {
    context.addIssue({ code: "custom", path: ["createdTaskId"], message: "Task identity is inconsistent with the derived terminal outcome." });
  }
  const { receiptDigest: _receiptDigest, ...content } = receipt;
  void _receiptDigest;
  if (hashCanonicalJson(content as unknown as JsonValue) !== receipt.receiptDigest) {
    context.addIssue({ code: "custom", path: ["receiptDigest"], message: "Task receipt digest is invalid." });
  }
});

export function sealQualificationV2ExternalTaskReceipt(input: unknown) {
  const content = z.object(
    Object.fromEntries(
      Object.entries(qualificationV2ExternalTaskReceiptSchema.shape)
        .filter(([key]) => key !== "receiptDigest"),
    ) as Omit<typeof qualificationV2ExternalTaskReceiptSchema.shape, "receiptDigest">,
  ).strict().parse(input);
  return Object.freeze(qualificationV2ExternalTaskReceiptSchema.parse({
    ...content,
    receiptDigest: hashCanonicalJson(content as unknown as JsonValue),
  }));
}

export const qualificationV2AuthorEvidenceSchema = z.object({
  schemaVersion: z.literal("exp-0001a-qualification-author-evidence/v2"),
  taskId: taskIdSchema,
  authorTaskId: idSchema,
  roomId: idSchema,
  authorOutcome: z.literal("completed"),
  authorSessionIdentity: z.object({
    participantId: idSchema,
    displayName: z.literal(EXP0001A_QUALIFICATION_V2_AUTHOR_DISPLAY_NAME),
    role: z.literal("participant"),
    joinResultDigest: digestSchema,
    collaborationResultDigest: digestSchema,
    bindingDigest: digestSchema,
  }).strict(),
  webMcpDiscovered: z.literal(true),
  webMcpTraceDigest: digestSchema,
  // read_thread exposes JavaScript invocations, not an independently framed
  // result for every nested WebMCP call. Never infer a precise total from
  // source-code mentions.
  webMcpCallCount: z.union([z.number().int().positive(), z.literal("unobservable")]),
  webMcpFailureCount: z.union([z.number().int().nonnegative(), z.literal("unobservable")]),
  successfulAuthoritativeMutationCount: z.number().int().positive(),
  visualInspectionCount: z.number().int().positive(),
  preAuthoritativeReadDigest: digestSchema,
  closingAuthoritativeReadDigest: digestSchema,
  finalAuthoritativeRoomRevision: z.number().int().positive(),
  revisionMatchedPngDigest: digestSchema,
  pngRoomRevision: z.number().int().positive(),
  sanitizedSemanticStateDigest: digestSchema,
  semanticStateRoomRevision: z.number().int().positive(),
  terminalResultDigest: digestSchema,
  attributedMutationSetDigest: digestSchema,
  controllerInspectionDigest: digestSchema,
  visualProofDigest: digestSchema,
  criticalBoundaryViolations: z.array(idSchema).max(100),
  evidenceRoot: digestSchema,
  retainedAt: timestampSchema,
}).strict().superRefine((evidence, context) => {
  if (evidence.pngRoomRevision !== evidence.finalAuthoritativeRoomRevision
      || evidence.semanticStateRoomRevision !== evidence.finalAuthoritativeRoomRevision) {
    context.addIssue({ code: "custom", path: ["finalAuthoritativeRoomRevision"], message: "PNG and semantic evidence must name the closing room revision." });
  }
  const { bindingDigest: _bindingDigest, ...identityContent } = evidence.authorSessionIdentity;
  void _bindingDigest;
  if (hashCanonicalJson(identityContent as unknown as JsonValue) !== evidence.authorSessionIdentity.bindingDigest) {
    context.addIssue({ code: "custom", path: ["authorSessionIdentity", "bindingDigest"], message: "Author session identity binding is invalid." });
  }
  const leaves = [
    evidence.webMcpTraceDigest,
    evidence.authorSessionIdentity.bindingDigest,
    evidence.preAuthoritativeReadDigest,
    evidence.closingAuthoritativeReadDigest,
    evidence.revisionMatchedPngDigest,
    evidence.sanitizedSemanticStateDigest,
    evidence.terminalResultDigest,
    evidence.attributedMutationSetDigest,
    evidence.controllerInspectionDigest,
    evidence.visualProofDigest,
  ];
  if (hashCanonicalJson(leaves as unknown as JsonValue) !== evidence.evidenceRoot) {
    context.addIssue({ code: "custom", path: ["evidenceRoot"], message: "Author evidence root is invalid." });
  }
});

export function sealQualificationV2AuthorEvidence(input: unknown) {
  const evidence = qualificationV2AuthorEvidenceSchema.parse(input);
  return Object.freeze(evidence);
}

const taskStateSchema = z.object({
  taskId: taskIdSchema,
  publicTaskDigest: digestSchema,
  benchmarkCommitments: z.object({
    task: digestSchema,
    publicPacket: digestSchema,
    setup: digestSchema,
    event: digestSchema,
    rubric: digestSchema,
  }).strict(),
  acceptanceCriterionIds: z.array(idSchema).min(1).max(30),
  expectedInitialStateKind: z.enum(["blank", "validated_fixture"]),
  expectedFixturePreflightDigest: digestSchema.nullable(),
  expectedCompiledFixtureInputDigest: digestSchema.nullable(),
  phase: z.enum([
    "awaiting_room",
    "ready_for_author",
    "author_action_prepared",
    "author_action_dispatched",
    "awaiting_author_evidence",
    "ready_for_review",
    "review_action_prepared",
    "review_action_dispatched",
    "complete",
    "blocked",
  ]),
  room: qualificationV2RoomReceiptSchema.nullable(),
  roomProvisionControllerReceiptDigest: digestSchema.nullable(),
  roomAuthorizedStorageStateDigest: digestSchema.nullable(),
  captureAuthorization: qualificationV2CaptureAuthorizationSchema.nullable(),
  captureReleaseJournal: qualificationV2CaptureReleaseJournalSchema.nullable(),
  captureTerminalReceipt: qualificationV2CaptureTerminalReceiptSchema.nullable(),
  authorReceipt: qualificationV2ExternalTaskReceiptSchema.nullable(),
  authorEvidence: qualificationV2AuthorEvidenceSchema.nullable(),
  primaryReviews: z.array(qualificationV2ExternalTaskReceiptSchema).max(2),
  adjudication: qualificationV2ExternalTaskReceiptSchema.nullable(),
  usageLimitInterruptions: z.array(qualificationV2ExternalTaskReceiptSchema).max(100),
}).strict();

const coordinatorContentSchema = z.object({
  schemaVersion: z.literal(EXP0001A_QUALIFICATION_V2_COORDINATOR_VERSION),
  protocolId: z.literal("EXP-0001A-MODEL-ROLE-QUALIFICATION-V2"),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  planDigest: digestSchema,
  benchmarkExecutionBundleDigest: digestSchema,
  baselineParticipantToolContractDigest: digestSchema,
  controllerHarnessRuntimeProvenance: qualificationV2HarnessRuntimeProvenanceSchema.nullable(),
  planAuthoritySignature: exp0001aQualificationV2AuthoritySignatureSchema,
  productionBinding: qualificationV2ProductionBindingSchema,
  productionBindingAuthoritySignature: exp0001aQualificationV2AuthoritySignatureSchema,
  currentTaskIndex: z.number().int().min(0).max(3),
  tasks: z.tuple([taskStateSchema, taskStateSchema, taskStateSchema]),
  pendingAction: qualificationV2ExternalActionSchema.nullable(),
  pendingDispatchReceipt: qualificationV2DispatchReceiptSchema.nullable(),
  releasedActionDigests: z.array(digestSchema),
  retainedTaskReceiptDigests: z.array(digestSchema),
  stopped: z.boolean(),
  stopReason: z.enum([
    "none",
    "usage_limit_interrupted",
    "invalid_setup",
    "capture_failed",
    "capture_indeterminate",
    "completed",
  ]),
}).strict();

export const qualificationV2CoordinatorStateSchema = coordinatorContentSchema.extend({
  stateDigest: digestSchema,
}).strict().superRefine((state, context) => {
  const { stateDigest: _stateDigest, ...content } = state;
  void _stateDigest;
  if (hashCanonicalJson(content as unknown as JsonValue) !== state.stateDigest) {
    context.addIssue({ code: "custom", path: ["stateDigest"], message: "Coordinator state digest is invalid." });
  }
  if (new Set(state.releasedActionDigests).size !== state.releasedActionDigests.length
      || new Set(state.retainedTaskReceiptDigests).size !== state.retainedTaskReceiptDigests.length) {
    context.addIssue({ code: "custom", message: "Coordinator ledgers contain a duplicate action or receipt." });
  }
  const taskIds = state.tasks.map((task) => task.taskId);
  if (canonicalJson(taskIds) !== canonicalJson(EXP0001A_QUALIFICATION_V2_TASK_IDS)) {
    context.addIssue({ code: "custom", path: ["tasks"], message: "Qualification task order drifted." });
  }
});

export type QualificationV2CoordinatorState = z.infer<typeof qualificationV2CoordinatorStateSchema>;
export type QualificationV2ExternalTaskReceipt = z.infer<typeof qualificationV2ExternalTaskReceiptSchema>;

function sealState(contentInput: z.input<typeof coordinatorContentSchema>): QualificationV2CoordinatorState {
  const content = coordinatorContentSchema.parse(contentInput);
  return Object.freeze(qualificationV2CoordinatorStateSchema.parse({
    ...content,
    stateDigest: hashCanonicalJson(content as unknown as JsonValue),
  }));
}

function replaceCurrentTask(
  state: QualificationV2CoordinatorState,
  task: z.infer<typeof taskStateSchema>,
  updatedAt: string,
  extra: Partial<z.input<typeof coordinatorContentSchema>> = {},
) {
  const tasks = [...state.tasks] as [typeof task, typeof task, typeof task];
  tasks[state.currentTaskIndex] = task;
  const { stateDigest: _stateDigest, ...content } = state;
  void _stateDigest;
  return sealState({ ...content, ...extra, tasks, updatedAt });
}

function currentTask(state: QualificationV2CoordinatorState) {
  if (state.currentTaskIndex >= state.tasks.length) throw new Error("QUALIFICATION_V2_COMPLETE");
  return state.tasks[state.currentTaskIndex];
}

function requireFreshAuth(receiptInput: unknown, at: string) {
  const receipt = qualificationV2CodexAuthReceiptSchema.parse(receiptInput);
  const ageMs = Date.parse(at) - Date.parse(receipt.checkedAt);
  if (ageMs < 0 || ageMs > 5 * 60_000) throw new Error("QUALIFICATION_V2_FRESH_CHATGPT_AUTH_REQUIRED");
  return receipt;
}

export function initializeQualificationV2Coordinator(input: Readonly<{
  createdAt: string;
  plan: unknown;
  planAuthoritySignature: unknown;
  productionBinding: unknown;
  productionBindingAuthoritySignature: unknown;
  publicTasks: readonly unknown[];
  benchmark: unknown;
  rubrics: unknown;
  fixtureSpecs: unknown;
  baselineParticipantToolContractDigest: string;
}>): QualificationV2CoordinatorState {
  const plan = exp0001aModelRoleQualificationV2PlanSchema.parse(input.plan);
  const signature = exp0001aQualificationV2AuthoritySignatureSchema.parse(input.planAuthoritySignature);
  verifyExp0001aQualificationV2AuthoritySignature({
    payload: input.plan as JsonValue,
    signature,
    purpose: "qualification_plan",
    notBefore: plan.frozenAt,
  });
  const binding = qualificationV2ProductionBindingSchema.parse(input.productionBinding);
  if (binding.planDigest !== plan.planDigest) throw new Error("QUALIFICATION_V2_PRODUCTION_BINDING_PLAN_INVALID");
  const bindingSignature = exp0001aQualificationV2AuthoritySignatureSchema.parse(
    input.productionBindingAuthoritySignature,
  );
  verifyExp0001aQualificationV2AuthoritySignature({
    payload: binding as unknown as JsonValue,
    signature: bindingSignature,
    purpose: "qualification_launch_binding",
    notBefore: binding.verifiedAt,
  });
  const publicTasks = input.publicTasks.map((task) => qualificationV2PublicTaskInputSchema.parse(task));
  const benchmarkExecutionBundle = compileQualificationV2PublicTasksFromExecutionBundle(
    input.benchmark,
    input.rubrics,
    input.fixtureSpecs,
  );
  if (publicTasks.length !== 3
      || canonicalJson(publicTasks.map((task) => task.taskId)) !== canonicalJson(EXP0001A_QUALIFICATION_V2_TASK_IDS)) {
    throw new Error("QUALIFICATION_V2_PUBLIC_TASK_SET_INVALID");
  }
  if (benchmarkExecutionBundle.bundleDigest !== plan.benchmark.bundleDigest
      || canonicalJson(benchmarkExecutionBundle.publicTasks) !== canonicalJson(publicTasks)) {
    throw new Error("QUALIFICATION_V2_BENCHMARK_EXECUTION_BINDING_INVALID");
  }
  const baselineParticipantToolContractDigest = digestSchema.parse(input.baselineParticipantToolContractDigest);
  return sealState({
    schemaVersion: EXP0001A_QUALIFICATION_V2_COORDINATOR_VERSION,
    protocolId: "EXP-0001A-MODEL-ROLE-QUALIFICATION-V2",
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    planDigest: plan.planDigest,
    benchmarkExecutionBundleDigest: benchmarkExecutionBundle.bundleDigest,
    baselineParticipantToolContractDigest,
    controllerHarnessRuntimeProvenance: null,
    planAuthoritySignature: signature,
    productionBinding: binding,
    productionBindingAuthoritySignature: bindingSignature,
    currentTaskIndex: 0,
    tasks: publicTasks.map((task, index) => ({
      taskId: task.taskId,
      publicTaskDigest: task.publicTaskDigest,
      benchmarkCommitments: benchmarkExecutionBundle.taskExecutions[index]!.commitments,
      acceptanceCriterionIds: task.acceptanceCriteria.map((criterion) => criterion.id),
      expectedInitialStateKind: task.initialState.kind === "blank" ? "blank" as const : "validated_fixture" as const,
      expectedFixturePreflightDigest:
        benchmarkExecutionBundle.taskExecutions[index]!.trustedCoordinator.seedReadabilityPreflight?.receiptDigest ?? null,
      expectedCompiledFixtureInputDigest:
        benchmarkExecutionBundle.taskExecutions[index]!.trustedCoordinator.preBriefSetup === null
          ? null
          : hashCanonicalJson(
            benchmarkExecutionBundle.taskExecutions[index]!.trustedCoordinator.preBriefSetup!.input as unknown as JsonValue,
          ),
      phase: "awaiting_room" as const,
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
    })) as unknown as [z.infer<typeof taskStateSchema>, z.infer<typeof taskStateSchema>, z.infer<typeof taskStateSchema>],
    pendingAction: null,
    pendingDispatchReceipt: null,
    releasedActionDigests: [],
    retainedTaskReceiptDigests: [],
    stopped: false,
    stopReason: "none",
  });
}

export function retainQualificationV2Room(
  stateInput: unknown,
  receiptInput: unknown,
  provisionControllerReceiptDigestInput: string,
  authorizedStorageStateDigestInput: string,
  updatedAt: string,
  harnessRuntimeProvenanceInput: unknown,
) {
  const state = qualificationV2CoordinatorStateSchema.parse(stateInput);
  if (state.stopped || state.pendingAction !== null) throw new Error("QUALIFICATION_V2_COORDINATOR_NOT_READY");
  const task = currentTask(state);
  const receipt = qualificationV2RoomReceiptSchema.parse(receiptInput);
  const provisionControllerReceiptDigest = digestSchema.parse(provisionControllerReceiptDigestInput);
  const authorizedStorageStateDigest = digestSchema.parse(authorizedStorageStateDigestInput);
  const harnessRuntimeProvenance = qualificationV2HarnessRuntimeProvenanceSchema.parse(
    harnessRuntimeProvenanceInput,
  );
  if (task.phase !== "awaiting_room" || receipt.taskId !== task.taskId
      || receipt.initialStateKind !== task.expectedInitialStateKind
      || receipt.fixturePreflightDigest !== task.expectedFixturePreflightDigest
      || (state.controllerHarnessRuntimeProvenance !== null
        && canonicalJson(state.controllerHarnessRuntimeProvenance)
          !== canonicalJson(harnessRuntimeProvenance))) {
    throw new Error("QUALIFICATION_V2_ROOM_RECEIPT_UNEXPECTED");
  }
  return replaceCurrentTask(state, {
    ...task,
    room: receipt,
    roomProvisionControllerReceiptDigest: provisionControllerReceiptDigest,
    roomAuthorizedStorageStateDigest: authorizedStorageStateDigest,
    phase: "ready_for_author",
  }, updatedAt, {
    controllerHarnessRuntimeProvenance:
      state.controllerHarnessRuntimeProvenance ?? harnessRuntimeProvenance,
  });
}

function authorPrompt(task: z.infer<typeof qualificationV2PublicTaskInputSchema>, privateRoomInviteUrl: string) {
  const packet = canonicalJson({
    title: task.title,
    brief: task.brief,
    acceptanceCriteria: task.acceptanceCriteria,
    initialState: task.initialState,
    publicTaskPacket: task.publicTaskPacket,
  });
  return [
    "You are the isolated author in a Jazzboard model-role qualification.",
    "Use only the supplied public task packet, private room URL, and browser-exposed WebMCP tools.",
    "Before browser work, satisfy the platform skill requirement by running exactly this one command and no other command: `/bin/zsh -lc \"sed -n '1,220p' ~/.codex/plugins/cache/openai-bundled/browser/26.825.51511/skills/control-in-app-browser/SKILL.md\"`. Copy it exactly; do not guess, rewrite, or probe any alternate path.",
    "That single browser-skill read is the only permitted terminal or filesystem access. Do not otherwise access a terminal, filesystem, repository, private API, shared task history, prepared coordinates, evaluator material, or another agent's work.",
    "Follow the browser skill's required selected-browser documentation read. Bind the landing-page WebMCP tool collection with `let tools = await webmcp.fetchTools()`. After join_room navigates into the participant room, refresh that same changing handle with `tools = await participantWebmcp.fetchTools()`; do not redeclare it or introduce a roomTools or other tool-collection alias. Every WebMCP operation, including session proof, authoring, inspection, and visual proof, must use the same `tools.call(...)` handle.",
    `Open the private invite on Jazzboard's landing page, discover its browser-exposed WebMCP tools, and call join_room with the exact invite code, displayName ${JSON.stringify(EXP0001A_QUALIFICATION_V2_AUTHOR_DISPLAY_NAME)}, and role participant before any room read or mutation.`,
    "After the room navigation completes, discover the participant WebMCP tools and immediately call read_collaboration_state. Retain the exact successful join_room and read_collaboration_state results in one private node_repl output by calling nodeRepl.write(JSON.stringify({schemaVersion:'exp-0001a-qualification-author-session-marker/v2',join:joinResult,collaboration:collaborationResult})). Do not put this marker or its private identity fields in the terminal response.",
    "For every mutation WebMCP call, use one node_repl invocation and retain its exact result with this protocol (replace TOOL_NAME and INPUT only): var qualificationMutationResult = await tools.call('TOOL_NAME', INPUT); nodeRepl.write(JSON.stringify({schemaVersion:'exp-0001a-qualification-author-mutation-result/v2',toolResult:qualificationMutationResult})); Do not issue an unmarked mutation call. Drafted/not-applied results are retained but only an exact outcome:'applied' result with authoritative revision and changed IDs counts.",
    "After joining, inspect the authoritative room, author the requested artifact, visually inspect it, correct it when useful, and finish with a closing authoritative state read and exact-revision PNG inspection.",
    "After the final mutation, perform the private visual proof in one completed node_repl invocation by copying this exact code: const visualRoomState = await tools.call('read_room_state', {}); const visualInspection = await tools.call('inspect_canvas_scope', {scope:{kind:'objects',targets:visualRoomState.data.objects.map((object)=>({objectId:object.id,expectedRevision:object.revision})).sort((left,right)=>left.objectId.localeCompare(right.objectId))},representation:'overview'}); const visualPageUrl = await tab.url(); const visualPixels = await tab.screenshot({fullPage:false}); nodeRepl.write(JSON.stringify({schemaVersion:'exp-0001a-qualification-author-visual-marker/v2',pageUrl:visualPageUrl,roomState:visualRoomState,inspection:visualInspection})); await nodeRepl.emitImage(visualPixels); Do not add, remove, reorder, or replace statements. The screenshot and explicit scope must cover the production room after the attributed mutation.",
    "Do not reveal the private invite URL or code in your terminal response.",
    `PRIVATE_ROOM_INVITE_URL=${privateRoomInviteUrl}`,
    `PUBLIC_TASK_PACKET=${packet}`,
    "Return a concise terminal result stating completion or the exact failure/usage-limit reason; the coordinator independently retains the WebMCP trace and authoritative artifacts.",
  ].join("\n");
}

function reviewerPrompt(input: Readonly<{
  publicRequirement: unknown;
  frozenRubric: unknown;
  sanitizedSemanticState: unknown;
  exactRevisionPngUrl: string;
}>) {
  return [
    "You are a fresh blinded reviewer for one Jazzboard qualification artifact.",
    "Use only the public requirement, frozen rubric, sanitized semantic state, and exact-revision PNG supplied below.",
    "Do not access repositories, author transcripts, author identity, condition labels, paired artifacts, or any other reviewer's decision.",
    "Independently return one binary artifactAccepted decision plus a boolean decision for every frozen criterion, grounded only in the supplied evidence.",
    "Return exactly one JSON object and no prose with keys artifactAccepted, criterionPasses, evidenceRoot, and blindness. criterionPasses must contain every and only frozen criterion ID. blindness must set authorTranscriptSeen, authorIdentitySeen, conditionLabelSeen, pairedArtifactSeen, repositoryAccessed, and otherReviewerDecisionSeen to false. evidenceRoot must be a sha256: digest of the evidence basis you actually reviewed.",
    `PUBLIC_REQUIREMENT=${canonicalJson(input.publicRequirement)}`,
    `FROZEN_RUBRIC=${canonicalJson(input.frozenRubric)}`,
    `SANITIZED_SEMANTIC_STATE=${canonicalJson(input.sanitizedSemanticState)}`,
    `EXACT_REVISION_PNG_URL=${input.exactRevisionPngUrl}`,
  ].join("\n");
}

const forbiddenBlindedKeyPattern = /^(?:roomId|roomCode|invite(?:Code|Url)?|participantId|sessionId|authorTaskId|threadId|hostId|clientTaskId|conditionLabel|repositoryPath)$/i;
const forbiddenBlindedValuePatterns = [
  /\broom_[A-Za-z0-9_-]{8,}\b/,
  /#join=[A-HJ-NP-Z2-9]{6}\b/,
  /\b(?:participant|session)[-_][A-Za-z0-9_-]{6,}\b/i,
  /\b(?:A0|A1)\b/,
  /(?:^|\s)(?:\/Volumes\/|\/Users\/|\.git(?:\/|\b))/,
  /\b01[A-HJKMNP-TV-Z0-9]{24}\b/,
];

export function findQualificationV2BlindedEvidenceLeaks(value: unknown, path = "$" ): string[] {
  const findings: string[] = [];
  if (typeof value === "string") {
    if (forbiddenBlindedValuePatterns.some((pattern) => pattern.test(value))) findings.push(path);
    return findings;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => findings.push(...findQualificationV2BlindedEvidenceLeaks(item, `${path}/${index}`)));
    return findings;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (forbiddenBlindedKeyPattern.test(key)) findings.push(`${path}/${key}`);
      findings.push(...findQualificationV2BlindedEvidenceLeaks(item, `${path}/${key}`));
    }
  }
  return findings;
}

export function findQualificationV2ExactInviteCodeLeaks(
  value: unknown,
  privateRoomInviteUrl: string,
  path = "$",
): string[] {
  const match = /^https:\/\/www\.jazzboard\.xyz\/#join=([A-HJ-NP-Z2-9]{6})$/.exec(privateRoomInviteUrl);
  if (match === null) throw new Error("QUALIFICATION_V2_PRIVATE_INVITE_URL_INVALID");
  const separatedCode = [...match[1]!].join("[\\s-]*");
  const exactNormalizedCode = new RegExp(separatedCode, "i");
  const findings: string[] = [];
  if (typeof value === "string") {
    if (exactNormalizedCode.test(value)) findings.push(path);
    return findings;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => findings.push(
      ...findQualificationV2ExactInviteCodeLeaks(item, privateRoomInviteUrl, `${path}/${index}`),
    ));
    return findings;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      findings.push(
        ...findQualificationV2ExactInviteCodeLeaks(item, privateRoomInviteUrl, `${path}/${key}`),
      );
    }
  }
  return findings;
}

export const qualificationV2BlindedReviewEnvelopeSchema = z.object({
  schemaVersion: z.literal("exp-0001a-qualification-blinded-review-envelope/v2"),
  publicTask: qualificationV2PublicTaskInputSchema,
  frozenRubric: z.record(z.string(), z.unknown()),
  sanitizedSemanticState: qualificationV2SanitizedSemanticStateSchema,
  sanitizedSemanticStateDigest: digestSchema,
  evidenceSidecar: z.object({
    schemaVersion: z.literal("exp-0001a-qualification-evidence-sidecar-receipt/v2"),
    exactRevisionPngUrl: loopbackPngUrlSchema,
    manifest: qualificationV2EvidenceSidecarManifestSchema,
    manifestDigest: digestSchema,
    exactRevisionPngByteDigest: digestSchema,
    exactRevisionPngByteLength: z.number().int().positive(),
    sourceRoomRevision: z.number().int().positive(),
    sanitizedSemanticStateRoomRevision: z.number().int().positive(),
    queryPermitted: z.literal(false),
    fragmentPermitted: z.literal(false),
    persistedByJazzboard: z.literal(false),
    sidecarReceiptDigest: digestSchema,
  }).strict().superRefine((receipt, context) => {
    const { sidecarReceiptDigest: _sidecarReceiptDigest, ...content } = receipt;
    void _sidecarReceiptDigest;
    if (hashCanonicalJson(content as unknown as JsonValue) !== receipt.sidecarReceiptDigest) {
      context.addIssue({ code: "custom", path: ["sidecarReceiptDigest"], message: "Evidence-sidecar receipt digest is invalid." });
    }
    if (receipt.sourceRoomRevision !== receipt.sanitizedSemanticStateRoomRevision) {
      context.addIssue({ code: "custom", path: ["sourceRoomRevision"], message: "Sidecar PNG and semantic state revisions differ." });
    }
    if (hashCanonicalJson(receipt.manifest as unknown as JsonValue) !== receipt.manifestDigest
        || receipt.manifest.byteDigest !== receipt.exactRevisionPngByteDigest
        || receipt.manifest.byteLength !== receipt.exactRevisionPngByteLength
        || receipt.manifest.sourceRoomRevision !== receipt.sourceRoomRevision
        || new URL(receipt.exactRevisionPngUrl).pathname !== `/evidence/${receipt.manifest.opaqueArtifactKey}.png`) {
      context.addIssue({ code: "custom", path: ["manifest"], message: "Sidecar manifest is not bound to the served PNG bytes and route." });
    }
  }),
  envelopeDigest: digestSchema,
}).strict().superRefine((envelope, context) => {
  const { envelopeDigest: _envelopeDigest, ...content } = envelope;
  void _envelopeDigest;
  if (hashCanonicalJson(content as unknown as JsonValue) !== envelope.envelopeDigest) {
    context.addIssue({ code: "custom", path: ["envelopeDigest"], message: "Blinded review envelope digest is invalid." });
  }
  if (hashCanonicalJson(envelope.sanitizedSemanticState as JsonValue) !== envelope.sanitizedSemanticStateDigest) {
    context.addIssue({ code: "custom", path: ["sanitizedSemanticStateDigest"], message: "Sanitized semantic state digest is invalid." });
  }
  try {
    parseQualificationV2SanitizedSemanticState(envelope.sanitizedSemanticState);
  } catch (error) {
    context.addIssue({
      code: "custom",
      path: ["sanitizedSemanticState"],
      message: error instanceof Error ? error.message : "Sanitized semantic state is not an allowlisted projection.",
    });
  }
  const leaks = findQualificationV2BlindedEvidenceLeaks({
    frozenRubric: envelope.frozenRubric,
    sanitizedSemanticState: envelope.sanitizedSemanticState,
  });
  if (leaks.length > 0) {
    context.addIssue({ code: "custom", message: `Blinded evidence leaks forbidden identity material: ${leaks.join(", ")}` });
  }
});

function buildAction(input: Readonly<{
  state: QualificationV2CoordinatorState;
  taskId: typeof EXP0001A_QUALIFICATION_V2_TASK_IDS[number];
  role: "author" | "primary_reviewer" | "adjudicator";
  roleOrdinal: 1 | 2;
  preparedAt: string;
  authReceiptDigest: string;
  inputEnvelopeDigest: string;
  prompt: string;
  reviewEvidenceSidecar: z.infer<typeof qualificationV2ExternalActionSchema>["reviewEvidenceSidecar"];
}>) {
  const suffix = hashCanonicalJson({
    stateDigest: input.state.stateDigest,
    taskId: input.taskId,
    role: input.role,
    roleOrdinal: input.roleOrdinal,
  }).slice(-12);
  const content = {
    schemaVersion: "exp-0001a-qualification-external-action/v2" as const,
    actionId: `qualification-${input.taskId}-${input.role}-${input.roleOrdinal}-${suffix}`,
    preparedAt: input.preparedAt,
    planDigest: input.state.planDigest,
    productionBindingDigest: input.state.productionBinding.bindingDigest,
    taskId: input.taskId,
    role: input.role,
    roleOrdinal: input.roleOrdinal,
    authReceiptDigest: input.authReceiptDigest,
    inputEnvelopeDigest: input.inputEnvelopeDigest,
    toolName: "mcp__codex_app__create_thread" as const,
    arguments: {
      prompt: input.prompt,
      target: { type: "projectless" as const, directoryName: `qual-${input.role}-${suffix}` },
      model: input.role === "author" ? "gpt-5.6-terra" as const : "gpt-5.6-sol" as const,
      thinking: input.role === "author" ? "medium" as const : "high" as const,
      title: `Q ${suffix} ${input.role} ${input.roleOrdinal}`,
    },
    sourceTaskId: null,
    forkedFromTaskId: null,
    reviewEvidenceSidecar: input.reviewEvidenceSidecar,
  };
  return Object.freeze(qualificationV2ExternalActionSchema.parse({
    ...content,
    actionDigest: hashCanonicalJson(content as unknown as JsonValue),
  }));
}

export function prepareQualificationV2AuthorAction(input: Readonly<{
  state: unknown;
  publicTask: unknown;
  authReceipt: unknown;
  preparedAt: string;
}>) {
  const state = qualificationV2CoordinatorStateSchema.parse(input.state);
  const auth = requireFreshAuth(input.authReceipt, input.preparedAt);
  const task = currentTask(state);
  const publicTask = qualificationV2PublicTaskInputSchema.parse(input.publicTask);
  if (state.stopped || task.phase !== "ready_for_author" || task.room === null
      || task.roomProvisionControllerReceiptDigest === null
      || task.roomAuthorizedStorageStateDigest === null
      || state.controllerHarnessRuntimeProvenance === null
      || publicTask.taskId !== task.taskId || publicTask.publicTaskDigest !== task.publicTaskDigest
      || publicTask.benchmarkTaskDigest !== task.benchmarkCommitments.task
      || publicTask.publicPacketCommitment !== task.benchmarkCommitments.publicPacket
      || state.pendingAction !== null || state.releasedActionDigests.some((digest) => digest === task.authorReceipt?.actionDigest)) {
    throw new Error("QUALIFICATION_V2_AUTHOR_RELEASE_FORBIDDEN");
  }
  const action = buildAction({
    state,
    taskId: task.taskId,
    role: "author",
    roleOrdinal: 1,
    preparedAt: input.preparedAt,
    authReceiptDigest: auth.receiptSha256,
    inputEnvelopeDigest: hashCanonicalJson({
      publicTaskDigest: publicTask.publicTaskDigest,
      privateRoomInviteUrlDigest: hashCanonicalJson(task.room.privateRoomInviteUrl),
    }),
    prompt: authorPrompt(publicTask, task.room.privateRoomInviteUrl),
    reviewEvidenceSidecar: null,
  });
  return replaceCurrentTask(
    state,
    { ...task, phase: "author_action_prepared" },
    input.preparedAt,
    { pendingAction: action, pendingDispatchReceipt: null },
  );
}

export function prepareQualificationV2CaptureAction(input: Readonly<{
  state: unknown;
  request: unknown;
  preparedAt: string;
}>) {
  const state = qualificationV2CoordinatorStateSchema.parse(input.state);
  const task = currentTask(state);
  const request = qualificationV2CaptureRequestBasisSchema.parse(input.request);
  if (state.stopped || state.pendingAction !== null || task.phase !== "awaiting_author_evidence"
      || task.room === null || task.roomProvisionControllerReceiptDigest === null
      || task.roomAuthorizedStorageStateDigest === null || task.authorReceipt?.terminalStatus !== "completed"
      || task.authorReceipt.createdTaskId === null || request.at !== input.preparedAt) {
    throw new Error("QUALIFICATION_V2_CAPTURE_PREPARATION_FORBIDDEN");
  }
  const requestBindingDigest = hashCanonicalJson(request as unknown as JsonValue);
  if (task.captureAuthorization !== null) {
    if (task.captureReleaseJournal !== null || task.captureTerminalReceipt !== null
        || task.captureAuthorization.requestBindingDigest !== requestBindingDigest
        || canonicalJson(task.captureAuthorization.request) !== canonicalJson(request)) {
      throw new Error("QUALIFICATION_V2_CAPTURE_ALREADY_PREPARED");
    }
    return Object.freeze({
      state,
      captureAuthorization: task.captureAuthorization,
      materializedExistingAuthorization: true,
    });
  }
  const captureNonce = hashCanonicalJson({
    stateDigest: state.stateDigest,
    taskId: task.taskId,
    roomReceiptDigest: task.room.receiptDigest,
    provisionControllerReceiptDigest: task.roomProvisionControllerReceiptDigest,
    requestBindingDigest,
  });
  const captureAuthorization = sealQualificationV2CaptureAuthorization({
    schemaVersion: "exp-0001a-qualification-capture-authorization/v2",
    taskId: task.taskId,
    roomReceiptDigest: task.room.receiptDigest,
    provisionControllerReceiptDigest: task.roomProvisionControllerReceiptDigest,
    storageStateDigest: task.roomAuthorizedStorageStateDigest,
    captureNonce,
    request,
    requestBindingDigest,
    preparedAt: input.preparedAt,
  });
  const nextState = replaceCurrentTask(state, {
    ...task,
    captureAuthorization,
  }, input.preparedAt);
  return Object.freeze({
    state: nextState,
    captureAuthorization,
    materializedExistingAuthorization: false,
  });
}

/** Persisted immediately before the operator invokes the capture controller.
 * Once acknowledged, the action can never be invoked again. A process crash
 * with no controller terminal receipt must be recorded as indeterminate. */
export function acknowledgeQualificationV2CaptureDispatch(
  stateInput: unknown,
  invokedAt: string,
) {
  const state = qualificationV2CoordinatorStateSchema.parse(stateInput);
  const task = currentTask(state);
  if (state.stopped || task.phase !== "awaiting_author_evidence"
      || task.captureAuthorization === null || task.captureTerminalReceipt !== null) {
    throw new Error("QUALIFICATION_V2_CAPTURE_DISPATCH_FORBIDDEN");
  }
  let journal = task.captureReleaseJournal;
  let nextState = state;
  if (journal === null) {
    journal = sealQualificationV2CaptureReleaseJournal({
      schemaVersion: "exp-0001a-qualification-capture-release-journal/v2",
      captureActionDigest: task.captureAuthorization.actionDigest,
      captureNonce: task.captureAuthorization.captureNonce,
      requestBindingDigest: task.captureAuthorization.requestBindingDigest,
      invokedAt,
      invocationOrdinal: 1,
      retryPermitted: false,
    });
    nextState = replaceCurrentTask(state, { ...task, captureReleaseJournal: journal }, invokedAt);
  } else if (journal.invokedAt !== invokedAt) {
    throw new Error("QUALIFICATION_V2_CAPTURE_DISPATCH_ALREADY_ACKNOWLEDGED");
  }
  return Object.freeze({
    state: nextState,
    captureReleaseJournal: journal,
    controllerRequest: Object.freeze({
      ...task.captureAuthorization.request,
      captureAuthorization: task.captureAuthorization,
      captureReleaseJournal: journal,
    }),
    materializedExistingAcknowledgement: task.captureReleaseJournal !== null,
  });
}

export function retainQualificationV2CaptureTerminalReceipt(
  stateInput: unknown,
  terminalReceiptInput: unknown,
  updatedAt: string,
) {
  const state = qualificationV2CoordinatorStateSchema.parse(stateInput);
  const task = currentTask(state);
  const receipt = parseQualificationV2CaptureTerminalReceipt(terminalReceiptInput);
  if (state.stopped || task.phase !== "awaiting_author_evidence" || task.captureAuthorization === null
      || task.captureReleaseJournal === null
      || task.captureTerminalReceipt !== null || receipt.taskId !== task.taskId
      || receipt.captureActionDigest !== task.captureAuthorization.actionDigest
      || receipt.captureNonce !== task.captureAuthorization.captureNonce
      || receipt.requestBindingDigest !== task.captureAuthorization.requestBindingDigest
      || receipt.releaseJournalDigest !== task.captureReleaseJournal.journalDigest
      || receipt.outcome === "indeterminate") {
    throw new Error("QUALIFICATION_V2_CAPTURE_TERMINAL_UNEXPECTED");
  }
  if (receipt.outcome === "failed") {
    return replaceCurrentTask(state, {
      ...task,
      captureTerminalReceipt: receipt,
      phase: "blocked",
    }, updatedAt, { stopped: true, stopReason: "capture_failed" });
  }
  return replaceCurrentTask(state, { ...task, captureTerminalReceipt: receipt }, updatedAt);
}

export function recordQualificationV2CaptureIndeterminate(
  stateInput: unknown,
  retainedAt: string,
) {
  const state = qualificationV2CoordinatorStateSchema.parse(stateInput);
  const task = currentTask(state);
  if (state.stopped || task.phase !== "awaiting_author_evidence"
      || task.captureAuthorization === null || task.captureReleaseJournal === null
      || task.captureTerminalReceipt !== null) {
    throw new Error("QUALIFICATION_V2_CAPTURE_INDETERMINATE_UNEXPECTED");
  }
  const receipt = sealQualificationV2CaptureTerminalReceipt({
    schemaVersion: "exp-0001a-qualification-capture-terminal/v2",
    taskId: task.taskId,
    captureActionDigest: task.captureAuthorization.actionDigest,
    captureNonce: task.captureAuthorization.captureNonce,
    requestBindingDigest: task.captureAuthorization.requestBindingDigest,
    releaseJournalDigest: task.captureReleaseJournal.journalDigest,
    outcome: "indeterminate",
    captureControllerReceiptDigest: null,
    failureCode: "QUALIFICATION_V2_CAPTURE_INDETERMINATE",
    retainedAt,
  });
  return replaceCurrentTask(state, {
    ...task,
    captureTerminalReceipt: receipt,
    phase: "blocked",
  }, retainedAt, { stopped: true, stopReason: "capture_indeterminate" });
}

export function prepareQualificationV2ReviewAction(input: Readonly<{
  state: unknown;
  authReceipt: unknown;
  preparedAt: string;
  reviewEnvelope: unknown;
}>) {
  const state = qualificationV2CoordinatorStateSchema.parse(input.state);
  const auth = requireFreshAuth(input.authReceipt, input.preparedAt);
  const task = currentTask(state);
  const reviewEnvelope = qualificationV2BlindedReviewEnvelopeSchema.parse(input.reviewEnvelope);
  const publicTask = reviewEnvelope.publicTask;
  const frozenRubric = z.object({
    taskId: taskIdSchema,
    criteria: z.array(z.object({ criterionId: idSchema }).passthrough()).min(1),
  }).passthrough().parse(reviewEnvelope.frozenRubric);
  if (state.stopped || task.phase !== "ready_for_review" || task.authorEvidence === null || task.room === null
      || state.pendingAction !== null || task.primaryReviews.length > 2) {
    throw new Error("QUALIFICATION_V2_REVIEW_RELEASE_FORBIDDEN");
  }
  if (task.authorEvidence.sanitizedSemanticStateDigest !== reviewEnvelope.sanitizedSemanticStateDigest
      || task.authorEvidence.revisionMatchedPngDigest !== reviewEnvelope.evidenceSidecar.exactRevisionPngByteDigest
      || task.authorEvidence.finalAuthoritativeRoomRevision !== reviewEnvelope.evidenceSidecar.sourceRoomRevision
      || publicTask.taskId !== task.taskId || publicTask.publicTaskDigest !== task.publicTaskDigest
      || frozenRubric.taskId !== task.taskId
      || hashCanonicalJson(frozenRubric as unknown as JsonValue) !== task.benchmarkCommitments.rubric
      || canonicalJson(frozenRubric.criteria.map((criterion) => criterion.criterionId))
        !== canonicalJson(task.acceptanceCriterionIds)) {
    throw new Error("QUALIFICATION_V2_REVIEW_EVIDENCE_BINDING_INVALID");
  }
  const primaryDisagreed = task.primaryReviews.length === 2
    && task.primaryReviews[0].reviewDecision !== null
    && task.primaryReviews[1].reviewDecision !== null
    && task.primaryReviews[0].reviewDecision.artifactAccepted
      !== task.primaryReviews[1].reviewDecision.artifactAccepted;
  const role = task.primaryReviews.length < 2 ? "primary_reviewer" as const : "adjudicator" as const;
  if (role === "adjudicator" && (!primaryDisagreed || task.adjudication !== null)) {
    throw new Error("QUALIFICATION_V2_ADJUDICATION_NOT_REQUIRED");
  }
  if (findQualificationV2ExactInviteCodeLeaks({
    publicTask,
    frozenRubric,
    sanitizedSemanticState: reviewEnvelope.sanitizedSemanticState,
  }, task.room.privateRoomInviteUrl).length > 0) {
    throw new Error("QUALIFICATION_V2_REVIEW_EXACT_INVITE_CODE_LEAK");
  }
  const roleOrdinal = role === "primary_reviewer" ? (task.primaryReviews.length + 1) as 1 | 2 : 1;
  const envelope = {
    publicRequirement: {
      title: publicTask.title,
      brief: publicTask.brief,
      acceptanceCriteria: publicTask.acceptanceCriteria,
      initialState: publicTask.initialState,
      publicTaskPacket: publicTask.publicTaskPacket,
    },
    frozenRubric,
    sanitizedSemanticStateDigest: reviewEnvelope.sanitizedSemanticStateDigest,
    exactRevisionPngDigest: reviewEnvelope.evidenceSidecar.exactRevisionPngByteDigest,
    evidenceSidecarManifestDigest: reviewEnvelope.evidenceSidecar.manifestDigest,
    evidenceSidecarReceiptDigest: reviewEnvelope.evidenceSidecar.sidecarReceiptDigest,
  };
  const action = buildAction({
    state,
    taskId: task.taskId,
    role,
    roleOrdinal,
    preparedAt: input.preparedAt,
    authReceiptDigest: auth.receiptSha256,
    inputEnvelopeDigest: hashCanonicalJson(envelope as unknown as JsonValue),
    prompt: reviewerPrompt({
      publicRequirement: envelope.publicRequirement,
      frozenRubric,
      sanitizedSemanticState: reviewEnvelope.sanitizedSemanticState,
      exactRevisionPngUrl: reviewEnvelope.evidenceSidecar.exactRevisionPngUrl,
    }),
    reviewEvidenceSidecar: {
      exactRevisionPngUrl: reviewEnvelope.evidenceSidecar.exactRevisionPngUrl,
      manifest: reviewEnvelope.evidenceSidecar.manifest,
      manifestDigest: reviewEnvelope.evidenceSidecar.manifestDigest,
      sidecarReceiptDigest: reviewEnvelope.evidenceSidecar.sidecarReceiptDigest,
      oneSuccessfulReadRequired: true,
    },
  });
  const promptLeaks = findQualificationV2BlindedEvidenceLeaks(action.arguments.prompt);
  const exactInviteLeaks = findQualificationV2ExactInviteCodeLeaks(
    action.arguments.prompt,
    task.room.privateRoomInviteUrl,
  );
  if (promptLeaks.length > 0 || exactInviteLeaks.length > 0) {
    throw new Error("QUALIFICATION_V2_REVIEW_PROMPT_PRIVACY_INVALID");
  }
  return replaceCurrentTask(
    state,
    { ...task, phase: "review_action_prepared" },
    input.preparedAt,
    { pendingAction: action, pendingDispatchReceipt: null },
  );
}

/** Internal transition used only after the runner has durably recorded its
 * pre-invocation journal. Production CLI does not expose this transition. */
export function recordQualificationV2RunnerDispatch(
  stateInput: unknown,
  acknowledgedAt: string,
  releaseJournalDigest: string,
) {
  const state = qualificationV2CoordinatorStateSchema.parse(stateInput);
  const task = currentTask(state);
  const action = state.pendingAction;
  if (state.stopped || action === null || state.pendingDispatchReceipt !== null
      || state.releasedActionDigests.includes(action.actionDigest)) {
    throw new Error("QUALIFICATION_V2_ACTION_NOT_DISPATCHABLE");
  }
  const content = {
    schemaVersion: "exp-0001a-qualification-dispatch-receipt/v2" as const,
    actionDigest: action.actionDigest,
    releaseJournalDigest,
    acknowledgedAt,
    invocationPermittedExactlyOnce: true as const,
    externalToolInvokedByCoordinatorLibrary: true as const,
  };
  const receipt = qualificationV2DispatchReceiptSchema.parse({
    ...content,
    receiptDigest: hashCanonicalJson(content as unknown as JsonValue),
  });
  const phase = action.role === "author" ? "author_action_dispatched" as const : "review_action_dispatched" as const;
  return replaceCurrentTask(state, { ...task, phase }, acknowledgedAt, {
    pendingDispatchReceipt: receipt,
    releasedActionDigests: [...state.releasedActionDigests, action.actionDigest],
  });
}

function finishCurrentTask(
  state: QualificationV2CoordinatorState,
  task: z.infer<typeof taskStateSchema>,
  updatedAt: string,
) {
  const tasks = [...state.tasks] as [typeof task, typeof task, typeof task];
  tasks[state.currentTaskIndex] = { ...task, phase: "complete" };
  const nextIndex = state.currentTaskIndex + 1;
  const { stateDigest: _stateDigest, ...content } = state;
  void _stateDigest;
  return sealState({
    ...content,
    tasks,
    currentTaskIndex: nextIndex,
    updatedAt,
    pendingAction: null,
    pendingDispatchReceipt: null,
    stopped: nextIndex === tasks.length,
    stopReason: nextIndex === tasks.length ? "completed" : "none",
  });
}

export function ingestQualificationV2ExternalTaskReceipt(
  stateInput: unknown,
  receiptInput: unknown,
  updatedAt: string,
) {
  const state = qualificationV2CoordinatorStateSchema.parse(stateInput);
  const task = currentTask(state);
  const action = state.pendingAction;
  const dispatch = state.pendingDispatchReceipt;
  const receipt = qualificationV2ExternalTaskReceiptSchema.parse(receiptInput);
  if (state.stopped || action === null || dispatch === null
      || receipt.actionDigest !== action.actionDigest
      || receipt.dispatchReceiptDigest !== dispatch.receiptDigest
      || receipt.taskId !== task.taskId || receipt.role !== action.role
      || receipt.roleOrdinal !== action.roleOrdinal
      || state.retainedTaskReceiptDigests.includes(receipt.receiptDigest)) {
    throw new Error("QUALIFICATION_V2_TASK_RECEIPT_UNEXPECTED");
  }
  const retained = [...state.retainedTaskReceiptDigests, receipt.receiptDigest];
  if (action.role === "author") {
    if (receipt.terminalStatus === "usage_limit_interrupted" && receipt.createdTaskId === null) {
      // The subscription gate refused creation, so the fixed author assignment
      // is genuinely unstarted. Retain the exact interruption, consume only
      // the released action, and permit an explicit fresh-auth resume of the
      // same task/ordinal.
      return replaceCurrentTask(state, {
        ...task,
        phase: "ready_for_author",
        authorReceipt: null,
        usageLimitInterruptions: [...task.usageLimitInterruptions, receipt],
      }, updatedAt, {
        pendingAction: null,
        pendingDispatchReceipt: null,
        retainedTaskReceiptDigests: retained,
        stopped: true,
        stopReason: "usage_limit_interrupted",
      });
    }
    const nextTask = { ...task, authorReceipt: receipt };
    if (receipt.terminalStatus === "usage_limit_interrupted" || receipt.terminalStatus === "invalid_setup") {
      return replaceCurrentTask(state, {
        ...nextTask,
        phase: "blocked",
        usageLimitInterruptions: receipt.terminalStatus === "usage_limit_interrupted"
          ? [...task.usageLimitInterruptions, receipt]
          : task.usageLimitInterruptions,
      }, updatedAt, {
        pendingAction: null,
        pendingDispatchReceipt: null,
        retainedTaskReceiptDigests: retained,
        stopped: true,
        stopReason: receipt.terminalStatus,
      });
    }
    if (receipt.terminalStatus === "failed") {
      return finishCurrentTask(
        sealState({
          ...(() => { const { stateDigest: _, ...content } = state; void _; return content; })(),
          retainedTaskReceiptDigests: retained,
        }),
        nextTask,
        updatedAt,
      );
    }
    return replaceCurrentTask(state, { ...nextTask, phase: "awaiting_author_evidence" }, updatedAt, {
      pendingAction: null,
      pendingDispatchReceipt: null,
      retainedTaskReceiptDigests: retained,
    });
  }
  if (receipt.reviewDecision !== null
      && canonicalJson(Object.keys(receipt.reviewDecision.criterionPasses).sort())
        !== canonicalJson([...task.acceptanceCriterionIds].sort())) {
    throw new Error("QUALIFICATION_V2_REVIEW_CRITERIA_INCOMPLETE");
  }
  if (receipt.terminalStatus === "usage_limit_interrupted" && receipt.createdTaskId === null) {
    // The provider refused creation before a reviewer task existed. Retain the
    // interruption as evidence, but do not consume the reviewer ordinal. A
    // later explicit resume continues the same genuinely-unstarted assignment.
    return replaceCurrentTask(state, {
      ...task,
      phase: "ready_for_review",
      usageLimitInterruptions: [...task.usageLimitInterruptions, receipt],
    }, updatedAt, {
      pendingAction: null,
      pendingDispatchReceipt: null,
      retainedTaskReceiptDigests: retained,
      stopped: true,
      stopReason: "usage_limit_interrupted",
    });
  }
  if (receipt.terminalStatus !== "completed") {
    return replaceCurrentTask(state, {
      ...task,
      phase: "blocked",
      usageLimitInterruptions: receipt.terminalStatus === "usage_limit_interrupted"
        ? [...task.usageLimitInterruptions, receipt]
        : task.usageLimitInterruptions,
    }, updatedAt, {
      pendingAction: null,
      pendingDispatchReceipt: null,
      retainedTaskReceiptDigests: retained,
      stopped: true,
      stopReason: receipt.terminalStatus === "usage_limit_interrupted" ? "usage_limit_interrupted" : "invalid_setup",
    });
  }
  const nextTask = action.role === "primary_reviewer"
    ? { ...task, primaryReviews: [...task.primaryReviews, receipt] }
    : { ...task, adjudication: receipt };
  const reviewReadyState = replaceCurrentTask(state, { ...nextTask, phase: "ready_for_review" }, updatedAt, {
    pendingAction: null,
    pendingDispatchReceipt: null,
    retainedTaskReceiptDigests: retained,
  });
  if (action.role === "primary_reviewer" && nextTask.primaryReviews.length < 2) return reviewReadyState;
  if (action.role === "primary_reviewer") {
    const [left, right] = nextTask.primaryReviews;
    if (left.reviewDecision !== null && right.reviewDecision !== null
        && left.reviewDecision.artifactAccepted !== right.reviewDecision.artifactAccepted) return reviewReadyState;
  }
  return finishCurrentTask(reviewReadyState, nextTask, updatedAt);
}

export function resumeQualificationV2AfterUsageLimit(
  stateInput: unknown,
  updatedAt: string,
  authReceiptInput: unknown,
) {
  const state = qualificationV2CoordinatorStateSchema.parse(stateInput);
  requireFreshAuth(authReceiptInput, updatedAt);
  if (!state.stopped || state.stopReason !== "usage_limit_interrupted"
      || state.currentTaskIndex >= state.tasks.length) {
    throw new Error("QUALIFICATION_V2_NOT_RESUMABLE_AFTER_USAGE_LIMIT");
  }
  const task = currentTask(state);
  const last = task.usageLimitInterruptions.at(-1);
  const resumableAuthor = task.phase === "ready_for_author"
    && task.authorReceipt === null
    && last?.role === "author"
    && last.createdTaskId === null;
  const resumableReviewer = task.phase === "ready_for_review"
    && last !== undefined
    && last.role !== "author"
    && last.createdTaskId === null;
  if (!resumableAuthor && !resumableReviewer) {
    throw new Error("QUALIFICATION_V2_USAGE_LIMIT_ASSIGNMENT_ALREADY_BEGUN");
  }
  const { stateDigest: _stateDigest, ...content } = state;
  void _stateDigest;
  return sealState({
    ...content,
    updatedAt,
    stopped: false,
    stopReason: "none",
  });
}

export function retainQualificationV2AuthorEvidence(
  stateInput: unknown,
  evidenceInput: unknown,
  updatedAt: string,
) {
  const state = qualificationV2CoordinatorStateSchema.parse(stateInput);
  const task = currentTask(state);
  const evidence = qualificationV2AuthorEvidenceSchema.parse(evidenceInput);
  if (state.stopped || task.phase !== "awaiting_author_evidence" || task.authorReceipt === null
      || task.room === null || task.authorReceipt.createdTaskId === null
      || task.captureTerminalReceipt?.outcome !== "succeeded"
      || evidence.taskId !== task.taskId || evidence.authorTaskId !== task.authorReceipt.createdTaskId
      || evidence.roomId !== task.room.roomId
      || evidence.terminalResultDigest !== task.authorReceipt.terminalResultDigest) {
    throw new Error("QUALIFICATION_V2_AUTHOR_EVIDENCE_UNEXPECTED");
  }
  return replaceCurrentTask(state, { ...task, authorEvidence: evidence, phase: "ready_for_review" }, updatedAt);
}

const qualificationResultContentSchema = z.object({
  schemaVersion: z.literal("exp-0001a-model-role-qualification-result/v2"),
  protocolId: z.literal("EXP-0001A-MODEL-ROLE-QUALIFICATION-V2"),
  planDigest: digestSchema,
  planAuthoritySignatureDigest: digestSchema,
  productionBindingDigest: digestSchema,
  controllerHarnessRuntimeProvenanceDigest: digestSchema,
  terminalEvidenceAttestationDigest: digestSchema,
  terminalStateDigest: digestSchema,
  retainedEvidenceInventoryRoot: digestSchema,
  retainedEvidenceFileCount: z.number().int().positive(),
  completedAt: timestampSchema,
  authorPolicy: z.object({ model: z.literal("gpt-5.6-terra"), reasoningEffort: z.literal("medium") }).strict(),
  reviewerPolicy: z.object({ model: z.literal("gpt-5.6-sol"), reasoningEffort: z.literal("high") }).strict(),
  attempts: z.tuple([
    exp0001aModelRoleQualificationV2AttemptSchema,
    exp0001aModelRoleQualificationV2AttemptSchema,
    exp0001aModelRoleQualificationV2AttemptSchema,
  ]),
  retainedReceipts: z.tuple([
    z.object({ taskId: taskIdSchema, roomReceiptDigest: digestSchema.nullable(), roomProvisionControllerReceiptDigest: digestSchema.nullable(), roomAuthorizedStorageStateDigest: digestSchema.nullable(), captureAuthorizationDigest: digestSchema.nullable(), captureReleaseJournalDigest: digestSchema.nullable(), captureTerminalReceiptDigest: digestSchema.nullable(), authorTaskReceiptDigest: digestSchema.nullable(), reviewerTaskReceiptDigests: z.array(digestSchema).max(2), adjudicatorTaskReceiptDigest: digestSchema.nullable(), usageLimitInterruptionReceiptDigests: z.array(digestSchema).max(100) }).strict(),
    z.object({ taskId: taskIdSchema, roomReceiptDigest: digestSchema.nullable(), roomProvisionControllerReceiptDigest: digestSchema.nullable(), roomAuthorizedStorageStateDigest: digestSchema.nullable(), captureAuthorizationDigest: digestSchema.nullable(), captureReleaseJournalDigest: digestSchema.nullable(), captureTerminalReceiptDigest: digestSchema.nullable(), authorTaskReceiptDigest: digestSchema.nullable(), reviewerTaskReceiptDigests: z.array(digestSchema).max(2), adjudicatorTaskReceiptDigest: digestSchema.nullable(), usageLimitInterruptionReceiptDigests: z.array(digestSchema).max(100) }).strict(),
    z.object({ taskId: taskIdSchema, roomReceiptDigest: digestSchema.nullable(), roomProvisionControllerReceiptDigest: digestSchema.nullable(), roomAuthorizedStorageStateDigest: digestSchema.nullable(), captureAuthorizationDigest: digestSchema.nullable(), captureReleaseJournalDigest: digestSchema.nullable(), captureTerminalReceiptDigest: digestSchema.nullable(), authorTaskReceiptDigest: digestSchema.nullable(), reviewerTaskReceiptDigests: z.array(digestSchema).max(2), adjudicatorTaskReceiptDigest: digestSchema.nullable(), usageLimitInterruptionReceiptDigests: z.array(digestSchema).max(100) }).strict(),
  ]),
  metrics: z.tuple([
    z.object({ taskId: taskIdSchema, wallTimeMs: z.union([z.number().int().nonnegative(), z.literal("unobservable")]), webMcpCallCount: z.union([z.number().int().nonnegative(), z.literal("unobservable")]), webMcpFailureCount: z.union([z.number().int().nonnegative(), z.literal("unobservable")]), revisionInspectionCount: z.union([z.number().int().nonnegative(), z.literal("unobservable")]), subscriptionUsage: z.literal("unobservable"), exactTokens: z.literal("unobservable"), resolvedModelSnapshot: z.literal("unobservable"), usageLimitInterrupted: z.boolean() }).strict(),
    z.object({ taskId: taskIdSchema, wallTimeMs: z.union([z.number().int().nonnegative(), z.literal("unobservable")]), webMcpCallCount: z.union([z.number().int().nonnegative(), z.literal("unobservable")]), webMcpFailureCount: z.union([z.number().int().nonnegative(), z.literal("unobservable")]), revisionInspectionCount: z.union([z.number().int().nonnegative(), z.literal("unobservable")]), subscriptionUsage: z.literal("unobservable"), exactTokens: z.literal("unobservable"), resolvedModelSnapshot: z.literal("unobservable"), usageLimitInterrupted: z.boolean() }).strict(),
    z.object({ taskId: taskIdSchema, wallTimeMs: z.union([z.number().int().nonnegative(), z.literal("unobservable")]), webMcpCallCount: z.union([z.number().int().nonnegative(), z.literal("unobservable")]), webMcpFailureCount: z.union([z.number().int().nonnegative(), z.literal("unobservable")]), revisionInspectionCount: z.union([z.number().int().nonnegative(), z.literal("unobservable")]), subscriptionUsage: z.literal("unobservable"), exactTokens: z.literal("unobservable"), resolvedModelSnapshot: z.literal("unobservable"), usageLimitInterrupted: z.boolean() }).strict(),
  ]),
  gateDecision: z.object({
    decision: z.enum(["pass", "fail", "incomplete"]),
    compatibleTaskIds: z.array(taskIdSchema),
    failedTaskIds: z.array(taskIdSchema),
    incompleteTaskIds: z.array(taskIdSchema),
    diagnosticQuality: z.partialRecord(taskIdSchema, z.enum(["accepted", "rejected", "unobservable"])),
  }).strict(),
  aaExecutionStatus: z.enum(["eligible_for_successor_freeze", "blocked"]),
}).strict();

export const qualificationV2ResultSchema = qualificationResultContentSchema.extend({
  resultDigest: digestSchema,
}).strict().superRefine((result, context) => {
  const { resultDigest: _resultDigest, ...content } = result;
  void _resultDigest;
  if (hashCanonicalJson(content as unknown as JsonValue) !== result.resultDigest) {
    context.addIssue({ code: "custom", path: ["resultDigest"], message: "Qualification result digest is invalid." });
  }
  const decision = evaluateExp0001aModelRoleQualificationV2(result.attempts);
  if (canonicalJson(decision) !== canonicalJson(result.gateDecision)) {
    context.addIssue({ code: "custom", path: ["gateDecision"], message: "Stored decision differs from attempts." });
  }
  if ((decision.decision === "pass") !== (result.aaExecutionStatus === "eligible_for_successor_freeze")) {
    context.addIssue({ code: "custom", path: ["aaExecutionStatus"], message: "Release interpretation contradicts gate decision." });
  }
});

export type QualificationV2Result = z.infer<typeof qualificationV2ResultSchema>;

const qualificationV2ResultAttestationBindingSchema = z.object({
  attestedAt: timestampSchema,
  attestationDigest: digestSchema,
  terminalStateDigest: digestSchema,
  harnessRuntimeProvenanceDigest: digestSchema,
  evidenceInventoryRoot: digestSchema,
  evidenceFileCount: z.number().int().positive(),
}).strict();

export function qualificationV2ResultAttestationBinding(input: unknown) {
  const source = qualificationV2ResultAttestationBindingSchema.passthrough().parse(input);
  return Object.freeze(qualificationV2ResultAttestationBindingSchema.parse({
    attestedAt: source.attestedAt,
    attestationDigest: source.attestationDigest,
    terminalStateDigest: source.terminalStateDigest,
    harnessRuntimeProvenanceDigest: source.harnessRuntimeProvenanceDigest,
    evidenceInventoryRoot: source.evidenceInventoryRoot,
    evidenceFileCount: source.evidenceFileCount,
  }));
}

function qualityDecision(task: z.infer<typeof taskStateSchema>) {
  if (task.primaryReviews.length !== 2) return "unobservable" as const;
  const left = task.primaryReviews[0].reviewDecision?.artifactAccepted;
  const right = task.primaryReviews[1].reviewDecision?.artifactAccepted;
  const accepted = left === right ? left : task.adjudication?.reviewDecision?.artifactAccepted;
  return accepted === undefined ? "unobservable" as const : accepted ? "accepted" as const : "rejected" as const;
}

export function sealQualificationV2Result(
  stateInput: unknown,
  completedAt: string,
  attestationInput: Readonly<{
    attestedAt: string;
    attestationDigest: string;
    terminalStateDigest: string;
    harnessRuntimeProvenanceDigest: string;
    evidenceInventoryRoot: string;
    evidenceFileCount: number;
  }>,
): QualificationV2Result {
  const state = qualificationV2CoordinatorStateSchema.parse(stateInput);
  if (!state.stopped && state.currentTaskIndex !== 3) throw new Error("QUALIFICATION_V2_RESULT_NOT_TERMINAL");
  const attestation = qualificationV2ResultAttestationBinding(attestationInput);
  const harnessRuntimeProvenanceDigest = hashCanonicalJson(
    qualificationV2HarnessRuntimeProvenanceSchema.parse(state.controllerHarnessRuntimeProvenance) as unknown as JsonValue,
  );
  if (attestation.attestedAt !== completedAt
      || attestation.terminalStateDigest !== state.stateDigest
      || attestation.harnessRuntimeProvenanceDigest !== harnessRuntimeProvenanceDigest) {
    throw new Error("QUALIFICATION_V2_RESULT_ATTESTATION_BINDING_INVALID");
  }
  const attempts = state.tasks.map((task) => {
    const author = task.authorReceipt;
    const evidence = task.authorEvidence;
    const outcome = author?.terminalStatus ?? "invalid_setup";
    const validity = outcome === "invalid_setup" ? "invalid_setup" as const : "valid" as const;
    return exp0001aModelRoleQualificationV2AttemptSchema.parse({
      taskId: task.taskId,
      authorTaskId: author?.createdTaskId ?? `not-started-${task.taskId}`,
      requestedModel: EXP0001A_QUALIFICATION_V2_AUTHOR.model,
      requestedReasoningEffort: EXP0001A_QUALIFICATION_V2_AUTHOR.reasoningEffort,
      authorOutcome: outcome,
      qualificationValidity: validity,
      invalidReasonCode: validity === "invalid_setup" ? "INVALID_SETUP_OR_NOT_STARTED" : null,
      isolationVerified: author !== null && author.repositoryAccess === false && author.privateApiAccess === false,
      criticalBoundaryViolations: evidence?.criticalBoundaryViolations ?? [],
      evidence: {
        webMcpDiscovered: evidence?.webMcpDiscovered ?? false,
        successfulAuthoritativeMutationCount: evidence?.successfulAuthoritativeMutationCount ?? 0,
        visualInspectionCount: evidence?.visualInspectionCount ?? 0,
        finalAuthoritativeRoomRevision: evidence?.finalAuthoritativeRoomRevision ?? null,
        revisionMatchedPngDigest: evidence?.revisionMatchedPngDigest ?? null,
        sanitizedSemanticStateDigest: evidence?.sanitizedSemanticStateDigest ?? null,
        terminalResultDigest: author?.terminalResultDigest ?? null,
        evidenceRoot: evidence?.evidenceRoot ?? null,
      },
      blindedQualityDecision: qualityDecision(task),
    });
  }) as [
    z.infer<typeof exp0001aModelRoleQualificationV2AttemptSchema>,
    z.infer<typeof exp0001aModelRoleQualificationV2AttemptSchema>,
    z.infer<typeof exp0001aModelRoleQualificationV2AttemptSchema>,
  ];
  const decision = evaluateExp0001aModelRoleQualificationV2(attempts);
  const content = qualificationResultContentSchema.parse({
    schemaVersion: "exp-0001a-model-role-qualification-result/v2",
    protocolId: "EXP-0001A-MODEL-ROLE-QUALIFICATION-V2",
    planDigest: state.planDigest,
    planAuthoritySignatureDigest: hashCanonicalJson(state.planAuthoritySignature as unknown as JsonValue),
    productionBindingDigest: state.productionBinding.bindingDigest,
    controllerHarnessRuntimeProvenanceDigest: harnessRuntimeProvenanceDigest,
    terminalEvidenceAttestationDigest: attestation.attestationDigest,
    terminalStateDigest: attestation.terminalStateDigest,
    retainedEvidenceInventoryRoot: attestation.evidenceInventoryRoot,
    retainedEvidenceFileCount: attestation.evidenceFileCount,
    completedAt,
    authorPolicy: EXP0001A_QUALIFICATION_V2_AUTHOR,
    reviewerPolicy: { model: "gpt-5.6-sol", reasoningEffort: "high" },
    attempts,
    retainedReceipts: state.tasks.map((task) => ({
      taskId: task.taskId,
      roomReceiptDigest: task.room?.receiptDigest ?? null,
      roomProvisionControllerReceiptDigest: task.roomProvisionControllerReceiptDigest,
      roomAuthorizedStorageStateDigest: task.roomAuthorizedStorageStateDigest,
      captureAuthorizationDigest: task.captureAuthorization?.actionDigest ?? null,
      captureReleaseJournalDigest: task.captureReleaseJournal?.journalDigest ?? null,
      captureTerminalReceiptDigest: task.captureTerminalReceipt?.receiptDigest ?? null,
      authorTaskReceiptDigest: task.authorReceipt?.receiptDigest ?? null,
      reviewerTaskReceiptDigests: task.primaryReviews.map((review) => review.receiptDigest),
      adjudicatorTaskReceiptDigest: task.adjudication?.receiptDigest ?? null,
      usageLimitInterruptionReceiptDigests: task.usageLimitInterruptions.map((receipt) => receipt.receiptDigest),
    })),
    metrics: state.tasks.map((task) => ({
      taskId: task.taskId,
      wallTimeMs: task.authorReceipt?.wallTimeMs ?? "unobservable",
      webMcpCallCount: task.authorEvidence?.webMcpCallCount ?? "unobservable",
      webMcpFailureCount: task.authorEvidence?.webMcpFailureCount ?? "unobservable",
      revisionInspectionCount: task.authorEvidence?.visualInspectionCount ?? "unobservable",
      subscriptionUsage: "unobservable",
      exactTokens: "unobservable",
      resolvedModelSnapshot: "unobservable",
      usageLimitInterrupted: task.usageLimitInterruptions.length > 0,
    })),
    gateDecision: decision,
    aaExecutionStatus: decision.decision === "pass" ? "eligible_for_successor_freeze" : "blocked",
  });
  return Object.freeze(qualificationV2ResultSchema.parse({
    ...content,
    resultDigest: hashCanonicalJson(content as unknown as JsonValue),
  }));
}

export const signedQualificationV2ResultEnvelopeSchema = z.object({
  schemaVersion: z.literal("exp-0001a-model-role-qualification-signed-result/v2"),
  result: qualificationV2ResultSchema,
  authoritySignature: exp0001aQualificationV2AuthoritySignatureSchema,
  envelopeDigest: digestSchema,
}).strict().superRefine((envelope, context) => {
  try {
    verifyExp0001aQualificationV2AuthoritySignature({
      payload: envelope.result as unknown as JsonValue,
      signature: envelope.authoritySignature,
      purpose: "qualification_result",
      notBefore: envelope.result.completedAt,
    });
  } catch (error) {
    context.addIssue({ code: "custom", path: ["authoritySignature"], message: error instanceof Error ? error.message : "Result signature is invalid." });
  }
  const { envelopeDigest: _envelopeDigest, ...content } = envelope;
  void _envelopeDigest;
  if (hashCanonicalJson(content as unknown as JsonValue) !== envelope.envelopeDigest) {
    context.addIssue({ code: "custom", path: ["envelopeDigest"], message: "Signed result envelope digest is invalid." });
  }
});
