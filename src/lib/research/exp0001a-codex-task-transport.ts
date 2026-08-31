import { z } from "zod";
import { parse as parseJavaScript } from "acorn";

// @ts-expect-error the committed ESM auth preflight intentionally has no declaration file
import { assertCodexNativeExperimentAuthorized, runCodexAuthPreflight, verifyCodexAuthPreflightReceipt } from "../../../research/scripts/codex-auth-preflight.mjs";

import {
  CODEX_WEBMCP_SPIKE_MODEL,
  CODEX_WEBMCP_SPIKE_REASONING,
  computePrivateRoomAccessBinding,
  createCodexWebMcpPromptEnvelope,
  type CodexWebMcpSpikeFreshnessContext,
} from "./codex-webmcp-spike";
import { verifyExp0001aCodexSpikeRecoveryGate } from "./codex-webmcp-spike-recovery";
import {
  assertExp0001aAuthorVisibleInputUnmodified,
  verifyExp0001aAuthorProvisioningHandoff,
  verifyExp0001aRoomProvisioningReceipt,
} from "./exp0001a-attempt-provisioning";
import { renderPublicAuthorBrief } from "./benchmark-execution";
import {
  canonicalJson,
  hashCanonicalJson,
  sha256Digest,
  SHA256_DIGEST_PATTERN,
  type JsonValue,
} from "./provenance-crypto";

const digestSchema = z.string().regex(SHA256_DIGEST_PATTERN);
const timestampSchema = z.string().datetime({ offset: true });
const idSchema = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const roomIdSchema = z.string().regex(/^room_[A-Za-z0-9_-]{8,}$/);
const cursorSchema = z.string().trim().min(1).max(4_096);
const opaqueIdSchema = idSchema.refine(
  (value) => !/(?:^|[._:-])(?:a0|a1|baseline|candidate|condition|control|treatment)(?:$|[._:-])/i.test(value),
  "Private transport identifiers cannot encode a condition label.",
);

const jsonValueSchema = z.custom<JsonValue>((value) => {
  try {
    canonicalJson(value);
    return true;
  } catch {
    return false;
  }
}, "Expected a finite plain JSON value.");

export const EXP0001A_CODEX_TASK_TRANSPORT_VERSION = "exp-0001a-codex-task-transport/v1" as const;
export const EXP0001A_CODEX_TASK_MODEL = CODEX_WEBMCP_SPIKE_MODEL;
export const EXP0001A_CODEX_AUTH_MAX_AGE_MS = 5 * 60_000;
export const EXP0001A_CODEX_READ_THREAD_MAX_OUTPUT_CHARS_PER_ITEM = 20_000 as const;
export const EXP0001A_CODEX_READ_THREAD_TURN_LIMIT = 10 as const;
export const EXP0001A_CODEX_READ_THREAD_MAX_PAGES = 100 as const;
export const EXP0001A_FROZEN_REVIEW_CRITERIA_MAX = 3 as const;
/** Leaves one thousand characters of transport headroom below the live per-item cap. */
export const EXP0001A_CODEX_TERMINAL_RESULT_MAX_CHARS = 19_000 as const;
export const EXP0001A_BROWSER_SKILL_ID = "browser:control-in-app-browser" as const;
export const EXP0001A_BROWSER_SKILL_VERSION = "26.825.51511" as const;
/** SHA-256 of the frozen Browser skill file, independent of its host-resolved path. */
export const EXP0001A_BROWSER_SKILL_DIGEST = "sha256:c4febd12a39df39beaa9b33e629068fc32a57445065eb7f569b21f7f35b3cc93" as const;
/** Exact room-scoped author surface frozen in development-runner-profile-v1. */
export const EXP0001A_AUTHOR_ROOM_WEBMCP_TOOL_ALLOWLIST = Object.freeze([
  "get_canvas_capabilities",
  "read_room_state",
  "query_objects",
  "read_neighborhood",
  "find_diagrams",
  "read_diagram",
  "describe_diagram",
  "analyze_diagram_layout",
  "read_canvas_drafts",
  "inspect_canvas_scope",
  "render_canvas_preview",
  "focus_viewport",
  "apply_canvas_transaction",
  "create_diagram",
  "create_node",
  "create_shape",
  "create_text",
  "create_drawing",
  "create_path",
  "create_polygon",
  "draw_connection",
  "edit_diagram",
  "update_object",
  "move_objects",
  "delete_objects",
  "group_objects",
  "layout_objects",
  "finish_canvas_draft",
  "export_canvas_artifact",
  "export_canvas_png",
] as const);
export const EXP0001A_AUTHOR_ROOM_WEBMCP_TOOL_ALLOWLIST_DIGEST =
  "sha256:91c9f772fc8124b4eb0efa5a59bae16c877d0430a5864e478d6c8d078d718d80" as const;

export const exp0001aCodexTransportRoleSchema = z.enum([
  "author",
  "primary_reviewer",
  "adjudicator",
  "pairwise_visual_judge",
]);
export type Exp0001aCodexTransportRole = z.infer<typeof exp0001aCodexTransportRoleSchema>;

export const EXP0001A_CODEX_ROLE_SETTINGS = Object.freeze({
  author: Object.freeze({ model: EXP0001A_CODEX_TASK_MODEL, reasoningEffort: CODEX_WEBMCP_SPIKE_REASONING }),
  primary_reviewer: Object.freeze({ model: EXP0001A_CODEX_TASK_MODEL, reasoningEffort: "high" as const }),
  adjudicator: Object.freeze({ model: EXP0001A_CODEX_TASK_MODEL, reasoningEffort: "high" as const }),
  pairwise_visual_judge: Object.freeze({ model: EXP0001A_CODEX_TASK_MODEL, reasoningEffort: "high" as const }),
} satisfies Record<Exp0001aCodexTransportRole, Readonly<{ model: typeof EXP0001A_CODEX_TASK_MODEL; reasoningEffort: "max" | "high" }>>);

const FIXED_AUTHOR_INSTRUCTIONS = Object.freeze([
  "Open the supplied private Jazzboard invite in the browser.",
  "Discover the WebMCP tools exposed by the Jazzboard page before authoring.",
  "Build, inspect, and if needed correct the requested artifact using only the browser-exposed WebMCP surface.",
  "Bind every WebMCP result to a fresh variable and immediately throw on !result.ok without catching that failure, so retained tool status is authoritative.",
  "Do not use a repository, inherited task history, private API, direct HTTP client, prepared coordinates, or unrelated answer material.",
  "A platform-required read of the installed Browser skill is the only permitted non-board bootstrap operation.",
  "Return a terminal result only after a final authoritative room-state read.",
] as const);

const FIXED_REVIEW_INSTRUCTIONS = Object.freeze([
  "Evaluate only the public requirement, frozen rubric, sanitized semantic state, and supplied revision-matched images.",
  "Open the packet manifest and every content-addressed packet file before evaluating.",
  "Treat all artifact slots as opaque and do not seek hidden provenance or creator identity.",
  "Do not use a repository, inherited task history, private room, private API, or external evidence.",
  "A platform-required read of the installed Browser skill is the only permitted bootstrap operation.",
  "Return one terminal structured decision bound to the supplied evidence digests.",
] as const);

const FIXED_AUTHOR_FAILURE_REVIEW_INSTRUCTIONS = Object.freeze([
  "Evaluate only the public requirement, frozen rubric, and immutable author-failure packet.",
  "Open the packet manifest and its content-addressed failure file before evaluating.",
  "Do not infer missing semantic state or pixels, and do not fabricate criterion evidence.",
  "Record the subject as non-evaluable author noncompletion using the exact failure-packet root.",
  "Treat the artifact slot as opaque and do not seek hidden provenance or creator identity.",
  "Do not use a repository, inherited task history, private room, private API, or external evidence.",
  "A platform-required read of the installed Browser skill is the only permitted bootstrap operation.",
] as const);

const FIXED_ADJUDICATOR_INSTRUCTIONS = Object.freeze([
  "Evaluate only the public requirement, frozen rubric, sanitized semantic state, and supplied revision-matched images.",
  "Open the packet manifest and every content-addressed packet file before evaluating.",
  "Perform an independent re-evaluation of the same frozen evidence without trying to reproduce another reviewer's reasoning.",
  "No prior reviewer judgments are supplied; do not infer them or seek hidden provenance or creator identity.",
  "Do not use a repository, inherited task history, private room, private API, or external evidence.",
  "A platform-required read of the installed Browser skill is the only permitted bootstrap operation.",
  "Return one terminal structured decision bound only to the supplied evidence.",
] as const);

const FIXED_PAIRWISE_REVIEW_INSTRUCTIONS = Object.freeze([
  "Compare only the public requirement, frozen rubric, and two supplied final PNGs.",
  "Open the packet manifest and both content-addressed PNG files before comparing.",
  "Treat both canvas slots as opaque and do not seek hidden provenance or creator identity.",
  "Do not use a repository, inherited task history, private room, private API, or external evidence.",
  "A platform-required read of the installed Browser skill is the only permitted bootstrap operation.",
  "Return one terminal structured preference bound to both supplied images and the frozen rubric.",
] as const);

const FIXED_PAIRWISE_UNAVAILABLE_INSTRUCTIONS = Object.freeze([
  "Evaluate only the public requirement, frozen rubric, and immutable incomplete-pair packet.",
  "Open the packet manifest and its content-addressed failure file before responding.",
  "Do not infer or fabricate missing pixels for either canvas.",
  "Return the canonical unavailable result bound to the exact incomplete-pair root.",
  "Treat both canvas slots as opaque and do not seek hidden provenance or creator identity.",
  "Do not use a repository, inherited task history, private room, private API, or external evidence.",
  "A platform-required read of the installed Browser skill is the only permitted bootstrap operation.",
] as const);

const FORBIDDEN_REVIEW_KEY = /^(?:author(?:id|name|taskid|transcript)?|condition(?:id|label)?|treatment|baseline|candidate|pairedresult|private(?:room|api)|repository(?:path)?|sourcetaskid|forkedfromtaskid)$/i;
const FORBIDDEN_REVIEW_TEXT = /(?:https?:\/\/|\b(?:author transcript|condition label|paired result)\b|(?:^|[^A-Za-z0-9])A[01](?:$|[^A-Za-z0-9]))/i;
const POSIX_ABSOLUTE_PATH_TEXT = /(?:^|[\s"'`(])(\/[^\s"'`]+)/g;
const WINDOWS_ABSOLUTE_PATH_TEXT = /(?:^|[\s"'`(])[A-Za-z]:\\(?:[^\\\s"'`]+\\)+[^\\\s"'`]*/;
const PRIVATE_HOST_ROOT_SEGMENTS = new Set([
  "users", "volumes", "home", "root", "private", "tmp", "var", "opt", "mnt", "srv", "workspace", "workspaces",
]);
const RETIRED_API_CREDENTIAL_MARKER = ["OPENAI", "API", "KEY"].join("_");
const RETIRED_PROVIDER_API_HOST = ["api", "openai", "com"].join(".");

function containsForbiddenReviewText(value: string): boolean {
  const folded = value.toLowerCase();
  const containsHostPath = WINDOWS_ABSOLUTE_PATH_TEXT.test(value)
    || [...value.matchAll(POSIX_ABSOLUTE_PATH_TEXT)].some((match) => {
      const firstSegment = match[1]!.split("/").filter(Boolean)[0]?.toLowerCase();
      return firstSegment !== undefined && PRIVATE_HOST_ROOT_SEGMENTS.has(firstSegment);
    });
  return FORBIDDEN_REVIEW_TEXT.test(value)
    || containsHostPath
    || value.includes(RETIRED_API_CREDENTIAL_MARKER)
    || folded.includes(RETIRED_PROVIDER_API_HOST);
}

function cloneJson(value: unknown): JsonValue {
  return JSON.parse(canonicalJson(value)) as JsonValue;
}

type RetainedCodexAppCallResult = Readonly<{
  rawResult: JsonValue;
  rawResultDigest: string;
  isError: boolean;
  payload: JsonValue | null;
  payloadDigest: string | null;
}>;

/** Retains the exact CallToolResult wrapper and parses only its one JSON text block. */
function retainExactCodexAppCallResult(input: unknown): RetainedCodexAppCallResult {
  const rawResult = cloneJson(input);
  if (rawResult === null || Array.isArray(rawResult) || typeof rawResult !== "object") {
    throw new Error("CODEX_APP_RAW_RESULT_NOT_AN_OBJECT");
  }
  const envelope = rawResult as Record<string, JsonValue>;
  if (typeof envelope.isError !== "boolean" || !Array.isArray(envelope.content) || envelope.content.length !== 1) {
    throw new Error("CODEX_APP_RAW_RESULT_WRAPPER_INVALID");
  }
  const block = envelope.content[0];
  if (block === null || Array.isArray(block) || typeof block !== "object"
      || (block as Record<string, JsonValue>).type !== "text"
      || typeof (block as Record<string, JsonValue>).text !== "string") {
    throw new Error("CODEX_APP_RAW_RESULT_REQUIRES_ONE_TEXT_BLOCK");
  }
  const text = (block as Record<string, JsonValue>).text as string;
  let payload: JsonValue | null = null;
  try {
    payload = cloneJson(JSON.parse(text));
  } catch {
    if (!envelope.isError) throw new Error("CODEX_APP_SUCCESS_RESULT_TEXT_NOT_JSON");
  }
  return freezeDeep({
    rawResult,
    rawResultDigest: hashCanonicalJson(rawResult),
    isError: envelope.isError,
    payload,
    payloadDigest: payload === null ? null : hashCanonicalJson(payload),
  });
}

function exactJsonObject(value: JsonValue | null): Record<string, JsonValue> | null {
  return value !== null && !Array.isArray(value) && typeof value === "object"
    ? value as Record<string, JsonValue>
    : null;
}

function exactString(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value.trim() === value && value.length > 0 ? value : null;
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function collectSanitizationViolations(value: JsonValue, path = "$"): string[] {
  if (typeof value === "string") {
    return containsForbiddenReviewText(value) ? [`${path}:forbidden-text`] : [];
  }
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((child, index) => collectSanitizationViolations(child, `${path}/${index}`));
  }
  return Object.entries(value).flatMap(([key, child]) => [
    ...(FORBIDDEN_REVIEW_KEY.test(key.replaceAll(/[^A-Za-z0-9]/g, "")) ? [`${path}/${key}:forbidden-key`] : []),
    ...collectSanitizationViolations(child, `${path}/${key}`),
  ]);
}

function addSanitizationIssues(value: JsonValue, context: z.RefinementCtx, path: PropertyKey[]): void {
  const violations = collectSanitizationViolations(value);
  if (violations.length > 0) {
    context.addIssue({
      code: "custom",
      path,
      message: `Reviewer material contains prohibited context: ${violations.slice(0, 5).join(", ")}.`,
    });
  }
}

const loopbackArtifactOriginSchema = z.string().url().superRefine((value, context) => {
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port
      || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    context.addIssue({
      code: "custom",
      message: "Evidence delivery must use an exact credential-free http://127.0.0.1:PORT origin.",
    });
  }
});

const imageEvidenceSchema = z.object({
  slot: z.string().regex(/^image-[0-9]{2}$/),
  roomRevision: z.number().int().nonnegative(),
  final: z.boolean(),
  sha256: digestSchema,
  bytes: z.number().int().positive().max(10 * 1024 * 1024),
  width: z.number().int().positive().max(8_192),
  height: z.number().int().positive().max(8_192),
  mimeType: z.literal("image/png"),
  relativePath: z.string().regex(/^(?:(?:canvas-1|canvas-2)\/)?images\/[a-f0-9]{64}\.png$/),
}).strict().superRefine((image, context) => {
  const bareDigest = image.sha256.slice("sha256:".length);
  if (!image.relativePath.endsWith(`/${bareDigest}.png`)) {
    context.addIssue({ code: "custom", path: ["relativePath"], message: "Image path must be content addressed." });
  }
});

const artifactPacketRelativePathSchema = z.union([
  imageEvidenceSchema.shape.relativePath,
  z.string().regex(/^author-failure\/[a-f0-9]{64}\.json$/),
]);

const artifactPacketFileSchema = z.object({
  relativePath: artifactPacketRelativePathSchema,
  sha256: digestSchema,
  bytes: z.number().int().positive().max(10 * 1024 * 1024),
  mimeType: z.enum(["image/png", "application/json"]),
}).strict();

const artifactPacketSchema = z.object({
  kind: z.literal("read-only-loopback-artifact-packet"),
  origin: loopbackArtifactOriginSchema,
  manifestDigest: digestSchema,
  manifestUrl: z.string().url(),
  files: z.array(artifactPacketFileSchema).min(1).max(14),
  allowedMethods: z.tuple([z.literal("GET"), z.literal("HEAD")]),
  directoryListing: z.literal(false),
  writesAccepted: z.literal(false),
  lifetime: z.literal("single-task"),
}).strict().superRefine((packet, context) => {
  const paths = packet.files.map((file) => file.relativePath);
  if (new Set(paths).size !== paths.length || paths.some((path, index) => index > 0 && paths[index - 1]!.localeCompare(path) >= 0)) {
    context.addIssue({ code: "custom", path: ["files"], message: "Artifact packet files must be unique and sorted by path." });
  }
  const expectedDigest = hashCanonicalJson({
    schemaVersion: 1,
    kind: "canvas-review-evidence-packet/v1",
    files: packet.files,
  });
  if (expectedDigest !== packet.manifestDigest) {
    context.addIssue({ code: "custom", path: ["manifestDigest"], message: "Artifact packet manifest digest is invalid." });
  }
  const bare = packet.manifestDigest.slice("sha256:".length);
  const expectedUrl = new URL(`/canvas-evidence/${bare}/manifest.json`, packet.origin).href;
  if (packet.manifestUrl !== expectedUrl) {
    context.addIssue({ code: "custom", path: ["manifestUrl"], message: "Artifact packet URL is not the exact hash-addressed loopback manifest URL." });
  }
});

function createArtifactPacketFromFiles(
  origin: string,
  fileInputs: ReadonlyArray<z.input<typeof artifactPacketFileSchema> & Readonly<{ contentBase64?: string }>>,
): z.infer<typeof artifactPacketSchema> {
  const files = fileInputs.map((file) => artifactPacketFileSchema.parse({
    relativePath: file.relativePath,
    sha256: file.sha256,
    bytes: file.bytes,
    mimeType: file.mimeType,
  }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const manifestDigest = hashCanonicalJson({
    schemaVersion: 1,
    kind: "canvas-review-evidence-packet/v1",
    files,
  });
  const parsedOrigin = loopbackArtifactOriginSchema.parse(origin);
  return artifactPacketSchema.parse({
    kind: "read-only-loopback-artifact-packet",
    origin: parsedOrigin,
    manifestDigest,
    manifestUrl: new URL(`/canvas-evidence/${manifestDigest.slice("sha256:".length)}/manifest.json`, parsedOrigin).href,
    files,
    allowedMethods: ["GET", "HEAD"],
    directoryListing: false,
    writesAccepted: false,
    lifetime: "single-task",
  });
}

function addPacketBindingIssues(
  packet: z.infer<typeof artifactPacketSchema>,
  images: ReadonlyArray<z.infer<typeof imageEvidenceSchema>>,
  context: z.RefinementCtx,
): void {
  const expected = images.map(({ relativePath, sha256, bytes, mimeType }) => ({ relativePath, sha256, bytes, mimeType }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  if (canonicalJson(packet.files) !== canonicalJson(expected)) {
    context.addIssue({ code: "custom", path: ["artifactPacket", "files"], message: "Artifact packet contains missing, extra, or mismatched files." });
  }
}

const rubricEvidenceSchema = z.object({
  rubricId: opaqueIdSchema,
  criterionIds: z.array(opaqueIdSchema).min(1).max(EXP0001A_FROZEN_REVIEW_CRITERIA_MAX),
  allowedMechanismTags: z.array(opaqueIdSchema).max(256),
  sha256: digestSchema,
  content: jsonValueSchema,
}).strict().superRefine((rubric, context) => {
  if (hashCanonicalJson(rubric.content) !== rubric.sha256) {
    context.addIssue({ code: "custom", path: ["sha256"], message: "Frozen rubric digest is invalid." });
  }
  if (new Set(rubric.criterionIds).size !== rubric.criterionIds.length
      || new Set(rubric.allowedMechanismTags).size !== rubric.allowedMechanismTags.length) {
    context.addIssue({ code: "custom", message: "Frozen criterion IDs and mechanism tags must be unique." });
  }
  addSanitizationIssues(rubric.content, context, ["content"]);
});

const semanticStateEvidenceSchema = z.object({
  sha256: digestSchema,
  bytes: z.number().int().positive().max(64 * 1024),
  content: jsonValueSchema,
}).strict().superRefine((state, context) => {
  const bytes = Buffer.byteLength(canonicalJson(state.content), "utf8");
  if (bytes !== state.bytes) {
    context.addIssue({ code: "custom", path: ["bytes"], message: "Sanitized semantic-state byte count is invalid." });
  }
  if (hashCanonicalJson(state.content) !== state.sha256) {
    context.addIssue({ code: "custom", path: ["sha256"], message: "Sanitized semantic-state digest is invalid." });
  }
  addSanitizationIssues(state.content, context, ["content"]);
});

const reviewEvidenceSchema = z.object({
  publicRequirement: z.string().trim().min(20).max(16_000),
  rubric: rubricEvidenceSchema,
  semanticState: semanticStateEvidenceSchema,
  images: z.array(imageEvidenceSchema).min(1).max(7),
  evidenceRoot: digestSchema,
}).strict().superRefine((evidence, context) => {
  if (containsForbiddenReviewText(evidence.publicRequirement)) {
    context.addIssue({ code: "custom", path: ["publicRequirement"], message: "Public requirement contains prohibited reviewer context." });
  }
  if (evidence.images.some((image, index) => image.slot !== `image-${String(index + 1).padStart(2, "0")}`)) {
    context.addIssue({ code: "custom", path: ["images"], message: "Review images must be sequentially slotted." });
  }
  if (evidence.images.some((image, index) => index > 0 && image.roomRevision < evidence.images[index - 1]!.roomRevision)) {
    context.addIssue({ code: "custom", path: ["images"], message: "Review image revisions must be monotonic." });
  }
  const finalImages = evidence.images.filter((image) => image.final);
  if (finalImages.length !== 1 || finalImages[0] !== evidence.images.at(-1)) {
    context.addIssue({ code: "custom", path: ["images"], message: "Exactly the final image in the sequence must be marked final." });
  }
  const expectedRoot = hashCanonicalJson({
    publicRequirement: evidence.publicRequirement,
    rubricSha256: evidence.rubric.sha256,
    rubricCriterionIds: evidence.rubric.criterionIds,
    allowedMechanismTags: evidence.rubric.allowedMechanismTags,
    semanticStateSha256: evidence.semanticState.sha256,
    images: evidence.images.map(({ slot, roomRevision, final, sha256, bytes, width, height, relativePath }) => ({
      slot,
      roomRevision,
      final,
      sha256,
      bytes,
      width,
      height,
      relativePath,
    })),
  });
  if (expectedRoot !== evidence.evidenceRoot) {
    context.addIssue({ code: "custom", path: ["evidenceRoot"], message: "Reviewer evidence root is invalid." });
  }
});

const authorEnvelopeSchema = z.object({
  schemaVersion: z.literal(EXP0001A_CODEX_TASK_TRANSPORT_VERSION),
  kind: z.literal("author-task-envelope"),
  role: z.literal("author"),
  publicTaskBrief: z.string().trim().min(20).max(8_000),
  privateRoomUrl: z.string().url(),
  roomId: roomIdSchema,
  roomProvisioningReceiptDigest: digestSchema,
  provisioningRoomAccessBindingDigest: digestSchema,
  privateRoomAccessBindingDigest: digestSchema,
  provisioningBinding: z.object({
    assignmentId: idSchema,
    attemptId: idSchema,
    plannedIndex: z.number().int().nonnegative().max(47),
    planDigest: digestSchema,
    attemptPlanDigest: digestSchema,
    publicAuthorPacketDigest: digestSchema,
    handoffDigest: digestSchema,
    authorReleaseAt: timestampSchema,
    coordinatorPresenceExpiredBeforeRelease: z.literal(true),
  }).strict(),
  instructions: z.tuple(FIXED_AUTHOR_INSTRUCTIONS.map((instruction) => z.literal(instruction)) as [
    z.ZodLiteral<typeof FIXED_AUTHOR_INSTRUCTIONS[0]>,
    z.ZodLiteral<typeof FIXED_AUTHOR_INSTRUCTIONS[1]>,
    z.ZodLiteral<typeof FIXED_AUTHOR_INSTRUCTIONS[2]>,
    z.ZodLiteral<typeof FIXED_AUTHOR_INSTRUCTIONS[3]>,
    z.ZodLiteral<typeof FIXED_AUTHOR_INSTRUCTIONS[4]>,
    z.ZodLiteral<typeof FIXED_AUTHOR_INSTRUCTIONS[5]>,
    z.ZodLiteral<typeof FIXED_AUTHOR_INSTRUCTIONS[6]>,
  ]),
}).strict().superRefine((envelope, context) => {
  try {
    createCodexWebMcpPromptEnvelope({
      publicBrief: envelope.publicTaskBrief,
      privateRoomUrl: envelope.privateRoomUrl,
    });
    const expected = computePrivateRoomAccessBinding({
      privateRoomUrl: envelope.privateRoomUrl,
      roomId: envelope.roomId,
    });
    if (expected !== envelope.privateRoomAccessBindingDigest) {
      context.addIssue({ code: "custom", path: ["privateRoomAccessBindingDigest"], message: "Private room binding is invalid." });
    }
    if (envelope.provisioningRoomAccessBindingDigest !== envelope.privateRoomAccessBindingDigest) {
      context.addIssue({ code: "custom", path: ["provisioningRoomAccessBindingDigest"], message: "Provisioning and task room bindings differ." });
    }
  } catch (error) {
    context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Author envelope is invalid." });
  }
});

const successfulPrimaryReviewerEnvelopeSchema = z.object({
  schemaVersion: z.literal(EXP0001A_CODEX_TASK_TRANSPORT_VERSION),
  kind: z.literal("primary-reviewer-task-envelope"),
  role: z.literal("primary_reviewer"),
  evidence: reviewEvidenceSchema,
  artifactPacket: artifactPacketSchema,
  instructions: z.tuple(FIXED_REVIEW_INSTRUCTIONS.map((instruction) => z.literal(instruction)) as [
    z.ZodLiteral<typeof FIXED_REVIEW_INSTRUCTIONS[0]>,
    z.ZodLiteral<typeof FIXED_REVIEW_INSTRUCTIONS[1]>,
    z.ZodLiteral<typeof FIXED_REVIEW_INSTRUCTIONS[2]>,
    z.ZodLiteral<typeof FIXED_REVIEW_INSTRUCTIONS[3]>,
    z.ZodLiteral<typeof FIXED_REVIEW_INSTRUCTIONS[4]>,
    z.ZodLiteral<typeof FIXED_REVIEW_INSTRUCTIONS[5]>,
  ]),
}).strict().superRefine((envelope, context) => addPacketBindingIssues(envelope.artifactPacket, envelope.evidence.images, context));

const authorFailurePacketContentSchema = z.object({
  schemaVersion: z.literal("exp-0001a-author-failure-review-packet/v1"),
  kind: z.literal("author-terminal-failure-packet"),
  terminalOutcome: z.enum([
    "needs_attention",
    "usage_limit_interrupted",
    "infra_failure",
    "policy_violation",
    "non_evaluable",
  ]),
  taskBegun: z.boolean(),
  lifecycleState: z.literal("terminal"),
  authorPlanDigest: digestSchema,
  authorLifecycleDigest: digestSchema,
  authorReadReceiptDigest: digestSchema,
  traceDecision: z.enum(["pass", "policy_violation", "non_evaluable"]).nullable(),
  reviewerDisposition: z.literal("non_evaluable_author_noncompletion"),
}).strict();

export const exp0001aAuthorFailureReviewPacketSchema = authorFailurePacketContentSchema.extend({
  packetDigest: digestSchema,
}).strict().superRefine((packet, context) => {
  const { packetDigest: _packetDigest, ...content } = packet;
  void _packetDigest;
  if (hashCanonicalJson(content) !== packet.packetDigest) {
    context.addIssue({ code: "custom", path: ["packetDigest"], message: "Author-failure review packet digest is invalid." });
  }
});
export type Exp0001aAuthorFailureReviewPacket = z.infer<typeof exp0001aAuthorFailureReviewPacketSchema>;

const failedPrimaryReviewerEnvelopeSchema = z.object({
  schemaVersion: z.literal(EXP0001A_CODEX_TASK_TRANSPORT_VERSION),
  kind: z.literal("primary-reviewer-author-failure-task-envelope"),
  role: z.literal("primary_reviewer"),
  publicRequirement: z.string().trim().min(20).max(16_000),
  rubric: rubricEvidenceSchema,
  authorFailurePacket: exp0001aAuthorFailureReviewPacketSchema,
  failureEvidenceRoot: digestSchema,
  artifactPacket: artifactPacketSchema,
  instructions: z.tuple(FIXED_AUTHOR_FAILURE_REVIEW_INSTRUCTIONS.map((instruction) => z.literal(instruction)) as [
    z.ZodLiteral<typeof FIXED_AUTHOR_FAILURE_REVIEW_INSTRUCTIONS[0]>,
    z.ZodLiteral<typeof FIXED_AUTHOR_FAILURE_REVIEW_INSTRUCTIONS[1]>,
    z.ZodLiteral<typeof FIXED_AUTHOR_FAILURE_REVIEW_INSTRUCTIONS[2]>,
    z.ZodLiteral<typeof FIXED_AUTHOR_FAILURE_REVIEW_INSTRUCTIONS[3]>,
    z.ZodLiteral<typeof FIXED_AUTHOR_FAILURE_REVIEW_INSTRUCTIONS[4]>,
    z.ZodLiteral<typeof FIXED_AUTHOR_FAILURE_REVIEW_INSTRUCTIONS[5]>,
    z.ZodLiteral<typeof FIXED_AUTHOR_FAILURE_REVIEW_INSTRUCTIONS[6]>,
  ]),
}).strict().superRefine((envelope, context) => {
  if (containsForbiddenReviewText(envelope.publicRequirement)) {
    context.addIssue({ code: "custom", path: ["publicRequirement"], message: "Public requirement contains prohibited reviewer context." });
  }
  const expectedRoot = hashCanonicalJson({
    publicRequirement: envelope.publicRequirement,
    rubricSha256: envelope.rubric.sha256,
    authorFailurePacketDigest: envelope.authorFailurePacket.packetDigest,
  });
  const packetBytes = Buffer.from(canonicalJson(envelope.authorFailurePacket), "utf8");
  const expectedFile = {
    relativePath: `author-failure/${sha256Digest(packetBytes).slice("sha256:".length)}.json`,
    sha256: sha256Digest(packetBytes),
    bytes: packetBytes.byteLength,
    mimeType: "application/json" as const,
  };
  if (envelope.failureEvidenceRoot !== expectedRoot
      || envelope.artifactPacket.files.length !== 1
      || canonicalJson(envelope.artifactPacket.files[0]) !== canonicalJson(expectedFile)) {
    context.addIssue({ code: "custom", path: ["failureEvidenceRoot"], message: "Failure reviewer envelope is not bound to its immutable packet." });
  }
});

const primaryReviewerEnvelopeSchema = z.union([
  successfulPrimaryReviewerEnvelopeSchema,
  failedPrimaryReviewerEnvelopeSchema,
]);

const retainedArtifactSourceFileSchema = artifactPacketFileSchema.extend({
  contentBase64: z.string().min(1).max(14 * 1024 * 1024),
}).strict().superRefine((file, context) => {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(Buffer.from(file.contentBase64, "base64"));
  } catch {
    context.addIssue({ code: "custom", path: ["contentBase64"], message: "Retained packet source bytes are not base64." });
    return;
  }
  if (Buffer.from(bytes).toString("base64") !== file.contentBase64
      || bytes.byteLength !== file.bytes || sha256Digest(bytes) !== file.sha256) {
    context.addIssue({ code: "custom", path: ["contentBase64"], message: "Retained packet source bytes do not match their content address." });
  }
});

function retainedArtifactFileMetadata(file: z.infer<typeof retainedArtifactSourceFileSchema>): z.infer<typeof artifactPacketFileSchema> {
  return artifactPacketFileSchema.parse({
    relativePath: file.relativePath,
    sha256: file.sha256,
    bytes: file.bytes,
    mimeType: file.mimeType,
  });
}

const successfulPrimaryReviewSubjectContentSchema = z.object({
  schemaVersion: z.literal("exp-0001a-primary-review-subject/v1"),
  kind: z.literal("primary-review-success-subject"),
  evidence: reviewEvidenceSchema,
  authorPlanDigest: digestSchema,
  authorLifecycleDigest: digestSchema,
  authorFinalEvidenceRoot: digestSchema,
  files: z.tuple([retainedArtifactSourceFileSchema]),
}).strict();
const failedPrimaryReviewSubjectContentSchema = z.object({
  schemaVersion: z.literal("exp-0001a-primary-review-subject/v1"),
  kind: z.literal("primary-review-author-failure-subject"),
  publicRequirement: z.string().trim().min(20).max(16_000),
  rubric: rubricEvidenceSchema,
  authorFailurePacket: exp0001aAuthorFailureReviewPacketSchema,
  failureEvidenceRoot: digestSchema,
  files: z.tuple([retainedArtifactSourceFileSchema]),
}).strict();

export const exp0001aPrimaryReviewSubjectSchema = z.union([
  successfulPrimaryReviewSubjectContentSchema.extend({ subjectDigest: digestSchema }).strict(),
  failedPrimaryReviewSubjectContentSchema.extend({ subjectDigest: digestSchema }).strict(),
]).superRefine((subject, context) => {
  const { subjectDigest: _subjectDigest, ...content } = subject;
  void _subjectDigest;
  if (hashCanonicalJson(content) !== subject.subjectDigest) {
    context.addIssue({ code: "custom", path: ["subjectDigest"], message: "Stable primary-review subject digest is invalid." });
  }
});
export type Exp0001aPrimaryReviewSubject = z.infer<typeof exp0001aPrimaryReviewSubjectSchema>;

const retainedScoredPrimaryReviewProjectionSchema = z.object({
  slot: z.enum(["primary-review-1", "primary-review-2"]),
  projectionKind: z.literal("scored-primary-review"),
  result: jsonValueSchema,
  resultDigest: digestSchema,
  modelTerminalResultDigest: digestSchema,
  terminalArtifactRoot: digestSchema,
  readReceiptDigest: digestSchema,
  retainedTaskBindingDigest: digestSchema,
}).strict().superRefine((review, context) => {
  if (hashCanonicalJson(review.result) !== review.resultDigest) {
    context.addIssue({ code: "custom", path: ["resultDigest"], message: "Retained primary result digest is invalid." });
  }
  addSanitizationIssues(review.result, context, ["result"]);
});

const canonicalFailedPrimaryResultSchema = z.object({
  schemaVersion: z.literal("canonical-primary-review-failure/v1"),
  role: z.literal("primary_reviewer"),
  accepted: z.literal(false),
  primaryFailureClass: z.literal("FAIL_EVALUATOR_SCORER"),
  failureDisposition: z.literal("canonical_failed_false"),
  subjectEvidenceRoot: digestSchema,
  terminalOutcome: z.enum(["needs_attention", "usage_limit_interrupted", "infra_failure", "policy_violation", "non_evaluable"]),
  traceDecision: z.enum(["pass", "policy_violation", "non_evaluable"]).nullable(),
}).strict();

const retainedFailedPrimaryReviewProjectionSchema = z.object({
  slot: z.enum(["primary-review-1", "primary-review-2"]),
  projectionKind: z.literal("canonical-failed-primary-review"),
  result: canonicalFailedPrimaryResultSchema,
  resultDigest: digestSchema,
  modelTerminalResultDigest: digestSchema.nullable(),
  terminalArtifactRoot: z.null(),
  readReceiptDigest: digestSchema,
  retainedTaskBindingDigest: digestSchema,
}).strict().superRefine((review, context) => {
  if (hashCanonicalJson(review.result) !== review.resultDigest) {
    context.addIssue({ code: "custom", path: ["resultDigest"], message: "Canonical failed-primary result digest is invalid." });
  }
});

const retainedPrimaryReviewProjectionSchema = z.union([
  retainedScoredPrimaryReviewProjectionSchema,
  retainedFailedPrimaryReviewProjectionSchema,
]);

const adjudicatorEnvelopeSchema = z.object({
  schemaVersion: z.literal(EXP0001A_CODEX_TASK_TRANSPORT_VERSION),
  kind: z.literal("adjudicator-task-envelope"),
  role: z.literal("adjudicator"),
  evidence: reviewEvidenceSchema,
  primaryReviews: z.tuple([retainedPrimaryReviewProjectionSchema, retainedPrimaryReviewProjectionSchema]),
  primaryReviewRoot: digestSchema,
  adjudicationSubjectRoot: digestSchema,
  artifactPacket: artifactPacketSchema,
  instructions: z.tuple(FIXED_ADJUDICATOR_INSTRUCTIONS.map((instruction) => z.literal(instruction)) as [
    z.ZodLiteral<typeof FIXED_ADJUDICATOR_INSTRUCTIONS[0]>,
    z.ZodLiteral<typeof FIXED_ADJUDICATOR_INSTRUCTIONS[1]>,
    z.ZodLiteral<typeof FIXED_ADJUDICATOR_INSTRUCTIONS[2]>,
    z.ZodLiteral<typeof FIXED_ADJUDICATOR_INSTRUCTIONS[3]>,
    z.ZodLiteral<typeof FIXED_ADJUDICATOR_INSTRUCTIONS[4]>,
    z.ZodLiteral<typeof FIXED_ADJUDICATOR_INSTRUCTIONS[5]>,
    z.ZodLiteral<typeof FIXED_ADJUDICATOR_INSTRUCTIONS[6]>,
  ]),
}).strict().superRefine((envelope, context) => {
  addPacketBindingIssues(envelope.artifactPacket, envelope.evidence.images, context);
  if (envelope.primaryReviews[0].slot !== "primary-review-1" || envelope.primaryReviews[1].slot !== "primary-review-2") {
    context.addIssue({ code: "custom", path: ["primaryReviews"], message: "Primary decisions must use the fixed two-slot order." });
  }
  const expectedPrimaryRoot = hashCanonicalJson(envelope.primaryReviews);
  if (envelope.primaryReviewRoot !== expectedPrimaryRoot
      || envelope.adjudicationSubjectRoot !== hashCanonicalJson({
        evidenceRoot: envelope.evidence.evidenceRoot,
        primaryReviewRoot: expectedPrimaryRoot,
      })) {
    context.addIssue({ code: "custom", path: ["adjudicationSubjectRoot"], message: "Adjudication subject root is invalid." });
  }
});

const adjudicationReviewSubjectContentSchema = z.object({
  schemaVersion: z.literal("exp-0001a-adjudication-review-subject/v1"),
  kind: z.literal("adjudication-review-subject"),
  evidence: reviewEvidenceSchema,
  primaryReviews: z.tuple([retainedPrimaryReviewProjectionSchema, retainedPrimaryReviewProjectionSchema]),
  primaryReviewRoot: digestSchema,
  adjudicationSubjectRoot: digestSchema,
  sourcePrimarySubjectDigest: digestSchema,
  files: z.tuple([retainedArtifactSourceFileSchema]),
}).strict().superRefine((subject, context) => {
  const expectedPrimaryRoot = hashCanonicalJson(subject.primaryReviews);
  const expectedSubjectRoot = hashCanonicalJson({
    evidenceRoot: subject.evidence.evidenceRoot,
    primaryReviewRoot: expectedPrimaryRoot,
  });
  const expectedFiles = subject.evidence.images.map(({ relativePath, sha256, bytes, mimeType }) => ({
    relativePath,
    sha256,
    bytes,
    mimeType,
  }));
  const decisions = subject.primaryReviews.map((review) => {
    if (review.projectionKind === "canonical-failed-primary-review") {
      if (review.result.subjectEvidenceRoot !== subject.evidence.evidenceRoot) return null;
      return false;
    }
    const parsed = blindedReviewTerminalJsonSchema.extend({ role: z.literal("primary_reviewer") }).strict()
      .safeParse(review.result);
    return parsed.success ? parsed.data.accepted : null;
  });
  if (subject.primaryReviews[0].slot !== "primary-review-1"
      || subject.primaryReviews[1].slot !== "primary-review-2"
      || subject.primaryReviews[0].retainedTaskBindingDigest === subject.primaryReviews[1].retainedTaskBindingDigest
      || decisions.includes(null) || decisions[0] === decisions[1]
      || subject.primaryReviewRoot !== expectedPrimaryRoot
      || subject.adjudicationSubjectRoot !== expectedSubjectRoot
      || canonicalJson(subject.files.map(retainedArtifactFileMetadata))
        !== canonicalJson(expectedFiles)) {
    context.addIssue({ code: "custom", path: ["adjudicationSubjectRoot"], message: "Stable adjudication subject is not bound to one exact primary disagreement and retained artifact." });
  }
});

export const exp0001aAdjudicationReviewSubjectSchema = adjudicationReviewSubjectContentSchema.extend({
  subjectDigest: digestSchema,
}).strict().superRefine((subject, context) => {
  const { subjectDigest: _subjectDigest, ...content } = subject;
  void _subjectDigest;
  if (hashCanonicalJson(content) !== subject.subjectDigest) {
    context.addIssue({ code: "custom", path: ["subjectDigest"], message: "Stable adjudication-review subject digest is invalid." });
  }
});
export type Exp0001aAdjudicationReviewSubject = z.infer<typeof exp0001aAdjudicationReviewSubjectSchema>;

const pairwiseSideSchema = z.object({
  slot: z.enum(["canvas-1", "canvas-2"]),
  finalImage: imageEvidenceSchema,
  sideRoot: digestSchema,
}).strict().superRefine((side, context) => {
  if (!side.finalImage.final) {
    context.addIssue({ code: "custom", path: ["finalImage", "final"], message: "Pairwise judges receive final images only." });
  }
  const expected = hashCanonicalJson({
    slot: side.slot,
    finalImage: {
      roomRevision: side.finalImage.roomRevision,
      sha256: side.finalImage.sha256,
      bytes: side.finalImage.bytes,
      width: side.finalImage.width,
      height: side.finalImage.height,
      relativePath: side.finalImage.relativePath,
    },
  });
  if (expected !== side.sideRoot) {
    context.addIssue({ code: "custom", path: ["sideRoot"], message: "Pairwise side root is invalid." });
  }
});

const successfulPairwiseVisualJudgeEnvelopeSchema = z.object({
  schemaVersion: z.literal(EXP0001A_CODEX_TASK_TRANSPORT_VERSION),
  kind: z.literal("pairwise-visual-judge-task-envelope"),
  role: z.literal("pairwise_visual_judge"),
  publicRequirement: z.string().trim().min(20).max(16_000),
  rubric: rubricEvidenceSchema,
  sides: z.tuple([pairwiseSideSchema, pairwiseSideSchema]),
  artifactPacket: artifactPacketSchema,
  pairRoot: digestSchema,
  instructions: z.tuple(FIXED_PAIRWISE_REVIEW_INSTRUCTIONS.map((instruction) => z.literal(instruction)) as [
    z.ZodLiteral<typeof FIXED_PAIRWISE_REVIEW_INSTRUCTIONS[0]>,
    z.ZodLiteral<typeof FIXED_PAIRWISE_REVIEW_INSTRUCTIONS[1]>,
    z.ZodLiteral<typeof FIXED_PAIRWISE_REVIEW_INSTRUCTIONS[2]>,
    z.ZodLiteral<typeof FIXED_PAIRWISE_REVIEW_INSTRUCTIONS[3]>,
    z.ZodLiteral<typeof FIXED_PAIRWISE_REVIEW_INSTRUCTIONS[4]>,
    z.ZodLiteral<typeof FIXED_PAIRWISE_REVIEW_INSTRUCTIONS[5]>,
  ]),
}).strict().superRefine((envelope, context) => {
  if (containsForbiddenReviewText(envelope.publicRequirement)) {
    context.addIssue({ code: "custom", path: ["publicRequirement"], message: "Public requirement contains prohibited pairwise context." });
  }
  if (envelope.sides[0].slot !== "canvas-1" || envelope.sides[1].slot !== "canvas-2") {
    context.addIssue({ code: "custom", path: ["sides"], message: "Pairwise sides must use fixed opaque presentation slots." });
  }
  if (envelope.sides[0].sideRoot === envelope.sides[1].sideRoot) {
    context.addIssue({ code: "custom", path: ["sides"], message: "Pairwise sides must be distinct artifacts." });
  }
  const expected = hashCanonicalJson(envelope.sides.map(({ slot, sideRoot }) => ({ slot, sideRoot })));
  if (expected !== envelope.pairRoot) {
    context.addIssue({ code: "custom", path: ["pairRoot"], message: "Pairwise evidence root is invalid." });
  }
  addPacketBindingIssues(envelope.artifactPacket, envelope.sides.map((side) => side.finalImage), context);
});

const pairwiseUnavailablePacketContentSchema = z.object({
  schemaVersion: z.literal("exp-0001a-pairwise-unavailable-packet/v1"),
  kind: z.literal("pairwise-incomplete-author-evidence"),
  sides: z.tuple([
    z.object({ slot: z.literal("canvas-1"), availability: z.enum(["available", "unavailable"]), sourceEvidenceRoot: digestSchema }).strict(),
    z.object({ slot: z.literal("canvas-2"), availability: z.enum(["available", "unavailable"]), sourceEvidenceRoot: digestSchema }).strict(),
  ]),
  disposition: z.literal("pairwise_unavailable_without_fabricated_pixels"),
}).strict().superRefine((packet, context) => {
  if (packet.sides.every((side) => side.availability === "available")) {
    context.addIssue({ code: "custom", path: ["sides"], message: "Unavailable pair packet requires at least one incomplete author." });
  }
});
export const exp0001aPairwiseUnavailablePacketSchema = pairwiseUnavailablePacketContentSchema.extend({
  packetDigest: digestSchema,
}).strict().superRefine((packet, context) => {
  const { packetDigest: _packetDigest, ...content } = packet;
  void _packetDigest;
  if (hashCanonicalJson(content) !== packet.packetDigest) {
    context.addIssue({ code: "custom", path: ["packetDigest"], message: "Pairwise unavailable packet digest is invalid." });
  }
});
export type Exp0001aPairwiseUnavailablePacket = z.infer<typeof exp0001aPairwiseUnavailablePacketSchema>;

const unavailablePairwiseVisualJudgeEnvelopeSchema = z.object({
  schemaVersion: z.literal(EXP0001A_CODEX_TASK_TRANSPORT_VERSION),
  kind: z.literal("pairwise-visual-unavailable-task-envelope"),
  role: z.literal("pairwise_visual_judge"),
  publicRequirement: z.string().trim().min(20).max(16_000),
  rubric: rubricEvidenceSchema,
  unavailablePacket: exp0001aPairwiseUnavailablePacketSchema,
  pairRoot: digestSchema,
  artifactPacket: artifactPacketSchema,
  instructions: z.tuple(FIXED_PAIRWISE_UNAVAILABLE_INSTRUCTIONS.map((instruction) => z.literal(instruction)) as [
    z.ZodLiteral<typeof FIXED_PAIRWISE_UNAVAILABLE_INSTRUCTIONS[0]>,
    z.ZodLiteral<typeof FIXED_PAIRWISE_UNAVAILABLE_INSTRUCTIONS[1]>,
    z.ZodLiteral<typeof FIXED_PAIRWISE_UNAVAILABLE_INSTRUCTIONS[2]>,
    z.ZodLiteral<typeof FIXED_PAIRWISE_UNAVAILABLE_INSTRUCTIONS[3]>,
    z.ZodLiteral<typeof FIXED_PAIRWISE_UNAVAILABLE_INSTRUCTIONS[4]>,
    z.ZodLiteral<typeof FIXED_PAIRWISE_UNAVAILABLE_INSTRUCTIONS[5]>,
    z.ZodLiteral<typeof FIXED_PAIRWISE_UNAVAILABLE_INSTRUCTIONS[6]>,
  ]),
}).strict().superRefine((envelope, context) => {
  if (containsForbiddenReviewText(envelope.publicRequirement)) {
    context.addIssue({ code: "custom", path: ["publicRequirement"], message: "Public requirement contains prohibited pairwise context." });
  }
  const expectedRoot = hashCanonicalJson({
    publicRequirement: envelope.publicRequirement,
    rubricSha256: envelope.rubric.sha256,
    unavailablePacketDigest: envelope.unavailablePacket.packetDigest,
  });
  const packetBytes = Buffer.from(canonicalJson(envelope.unavailablePacket), "utf8");
  const expectedFile = {
    relativePath: `author-failure/${sha256Digest(packetBytes).slice("sha256:".length)}.json`,
    sha256: sha256Digest(packetBytes),
    bytes: packetBytes.byteLength,
    mimeType: "application/json" as const,
  };
  if (envelope.pairRoot !== expectedRoot || envelope.artifactPacket.files.length !== 1
      || canonicalJson(envelope.artifactPacket.files[0]) !== canonicalJson(expectedFile)) {
    context.addIssue({ code: "custom", path: ["pairRoot"], message: "Unavailable pairwise envelope is not bound to its canonical failure packet." });
  }
});

const pairwiseVisualJudgeEnvelopeSchema = z.union([
  successfulPairwiseVisualJudgeEnvelopeSchema,
  unavailablePairwiseVisualJudgeEnvelopeSchema,
]);

const pairwiseSourceBindingSchema = z.object({
  slot: z.enum(["canvas-1", "canvas-2"]),
  availability: z.enum(["available", "unavailable"]),
  authorPlanDigest: digestSchema,
  authorLifecycleDigest: digestSchema,
  sourceEvidenceRoot: digestSchema,
  primarySubjectDigest: digestSchema,
}).strict();

const successfulPairwiseReviewSubjectContentSchema = z.object({
  schemaVersion: z.literal("exp-0001a-pairwise-review-subject/v1"),
  kind: z.literal("pairwise-review-success-subject"),
  publicRequirement: z.string().trim().min(20).max(16_000),
  rubric: rubricEvidenceSchema,
  sides: z.tuple([pairwiseSideSchema, pairwiseSideSchema]),
  sourceBindings: z.tuple([pairwiseSourceBindingSchema, pairwiseSourceBindingSchema]),
  files: z.tuple([retainedArtifactSourceFileSchema, retainedArtifactSourceFileSchema]),
  pairRoot: digestSchema,
}).strict().superRefine((subject, context) => {
  const expectedRoot = hashCanonicalJson(subject.sides.map(({ slot, sideRoot }) => ({ slot, sideRoot })));
  if (subject.sides[0].slot !== "canvas-1" || subject.sides[1].slot !== "canvas-2"
      || subject.sourceBindings[0].slot !== "canvas-1" || subject.sourceBindings[1].slot !== "canvas-2"
      || subject.sourceBindings.some((binding) => binding.availability !== "available")
      || subject.pairRoot !== expectedRoot) {
    context.addIssue({ code: "custom", path: ["pairRoot"], message: "Stable pairwise subject bindings are invalid." });
  }
  const expectedFiles = subject.sides.map((side) => ({
    relativePath: side.finalImage.relativePath,
    sha256: side.finalImage.sha256,
    bytes: side.finalImage.bytes,
    mimeType: side.finalImage.mimeType,
  }));
  if (canonicalJson(subject.files.map(retainedArtifactFileMetadata))
      !== canonicalJson(expectedFiles)) {
    context.addIssue({ code: "custom", path: ["files"], message: "Stable pairwise PNG bytes are not bound to both sides." });
  }
});

const unavailablePairwiseReviewSubjectContentSchema = z.object({
  schemaVersion: z.literal("exp-0001a-pairwise-review-subject/v1"),
  kind: z.literal("pairwise-review-unavailable-subject"),
  publicRequirement: z.string().trim().min(20).max(16_000),
  rubric: rubricEvidenceSchema,
  unavailablePacket: exp0001aPairwiseUnavailablePacketSchema,
  sourceBindings: z.tuple([pairwiseSourceBindingSchema, pairwiseSourceBindingSchema]),
  files: z.tuple([retainedArtifactSourceFileSchema]),
  pairRoot: digestSchema,
}).strict().superRefine((subject, context) => {
  const expectedRoot = hashCanonicalJson({
    publicRequirement: subject.publicRequirement,
    rubricSha256: subject.rubric.sha256,
    unavailablePacketDigest: subject.unavailablePacket.packetDigest,
  });
  const packetBytes = Buffer.from(canonicalJson(subject.unavailablePacket), "utf8");
  const expectedFile = {
    relativePath: `author-failure/${sha256Digest(packetBytes).slice("sha256:".length)}.json`,
    sha256: sha256Digest(packetBytes),
    bytes: packetBytes.byteLength,
    mimeType: "application/json" as const,
  };
  if (subject.sourceBindings[0].slot !== "canvas-1" || subject.sourceBindings[1].slot !== "canvas-2"
      || subject.sourceBindings.some((binding, index) => (
        binding.availability !== subject.unavailablePacket.sides[index]!.availability
        || binding.sourceEvidenceRoot !== subject.unavailablePacket.sides[index]!.sourceEvidenceRoot
      ))
      || subject.pairRoot !== expectedRoot
      || canonicalJson(subject.files.map(retainedArtifactFileMetadata))
        !== canonicalJson([expectedFile])) {
    context.addIssue({ code: "custom", path: ["pairRoot"], message: "Stable unavailable-pair subject binding is invalid." });
  }
});

export const exp0001aPairwiseReviewSubjectSchema = z.union([
  successfulPairwiseReviewSubjectContentSchema.extend({ subjectDigest: digestSchema }).strict(),
  unavailablePairwiseReviewSubjectContentSchema.extend({ subjectDigest: digestSchema }).strict(),
]).superRefine((subject, context) => {
  const { subjectDigest: _subjectDigest, ...content } = subject;
  void _subjectDigest;
  if (hashCanonicalJson(content) !== subject.subjectDigest) {
    context.addIssue({ code: "custom", path: ["subjectDigest"], message: "Stable pairwise-review subject digest is invalid." });
  }
  if (subject.sourceBindings[0].authorPlanDigest === subject.sourceBindings[1].authorPlanDigest
      || subject.sourceBindings[0].authorLifecycleDigest === subject.sourceBindings[1].authorLifecycleDigest
      || subject.sourceBindings[0].primarySubjectDigest === subject.sourceBindings[1].primarySubjectDigest) {
    context.addIssue({ code: "custom", path: ["sourceBindings"], message: "Pairwise sides must derive from two distinct retained author tasks." });
  }
});
export type Exp0001aPairwiseReviewSubject = z.infer<typeof exp0001aPairwiseReviewSubjectSchema>;

export const exp0001aCodexTaskEnvelopeSchema = z.union([
  authorEnvelopeSchema,
  primaryReviewerEnvelopeSchema,
  adjudicatorEnvelopeSchema,
  pairwiseVisualJudgeEnvelopeSchema,
]);
export type Exp0001aCodexTaskEnvelope = z.infer<typeof exp0001aCodexTaskEnvelopeSchema>;

function packetForEnvelope(envelope: Exp0001aCodexTaskEnvelope): z.infer<typeof artifactPacketSchema> | null {
  return envelope.role === "author" ? null : envelope.artifactPacket;
}

const artifactPacketReadyReceiptContentSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("codex-review-artifact-packet-ready-receipt"),
  observedAt: timestampSchema,
  envelopeDigest: digestSchema,
  origin: loopbackArtifactOriginSchema,
  manifestUrl: z.string().url(),
  manifestDigest: digestSchema,
  servedFileCount: z.number().int().positive().max(14),
  servedFileRoot: digestSchema,
  unexpectedFileCount: z.literal(0),
  probes: z.object({
    getManifest: z.literal("succeeded"),
    headManifest: z.literal("succeeded"),
    getEveryFile: z.literal("digest_verified"),
    post: z.literal("rejected"),
    put: z.literal("rejected"),
    delete: z.literal("rejected"),
    directoryListing: z.literal("rejected"),
  }).strict(),
  probeEvidenceDigest: digestSchema,
}).strict();

export const exp0001aCodexArtifactPacketReadyReceiptSchema = artifactPacketReadyReceiptContentSchema.extend({
  receiptDigest: digestSchema,
}).strict().superRefine((receipt, context) => {
  const { receiptDigest: _receiptDigest, ...content } = receipt;
  void _receiptDigest;
  if (hashCanonicalJson(content) !== receipt.receiptDigest) {
    context.addIssue({ code: "custom", path: ["receiptDigest"], message: "Artifact packet readiness receipt digest is invalid." });
  }
});
export type Exp0001aCodexArtifactPacketReadyReceipt = z.infer<typeof exp0001aCodexArtifactPacketReadyReceiptSchema>;

export async function probeExp0001aCodexArtifactPacket(input: {
  envelope: Exclude<Exp0001aCodexTaskEnvelope, { role: "author" }>;
  now?: () => string;
}): Promise<Exp0001aCodexArtifactPacketReadyReceipt> {
  const envelope = exp0001aCodexTaskEnvelopeSchema.parse(input.envelope);
  const packet = packetForEnvelope(envelope);
  if (packet === null) throw new Error("AUTHOR_TASK_HAS_NO_REVIEW_ARTIFACT_PACKET");
  const requestEvidence: Array<{
    method: string;
    path: string;
    status: number;
    responseDigest: string | null;
  }> = [];
  const request = async (url: string, method: string) => {
    const parsed = new URL(url);
    if (parsed.origin !== new URL(packet.origin).origin) throw new Error("ARTIFACT_PACKET_PROBE_ORIGIN_ESCAPE");
    const response = await fetch(url, { method, redirect: "manual", cache: "no-store" });
    const body = method === "HEAD" ? new Uint8Array() : new Uint8Array(await response.arrayBuffer());
    requestEvidence.push({
      method,
      path: parsed.pathname,
      status: response.status,
      responseDigest: body.byteLength === 0 ? null : sha256Digest(body),
    });
    return { response, body };
  };
  const manifestRead = await request(packet.manifestUrl, "GET");
  if (manifestRead.response.status !== 200) throw new Error("ARTIFACT_PACKET_MANIFEST_GET_FAILED");
  let manifest: unknown;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestRead.body));
  } catch {
    throw new Error("ARTIFACT_PACKET_MANIFEST_NOT_JSON");
  }
  const expectedManifest = {
    schemaVersion: 1,
    kind: "canvas-review-evidence-packet/v1",
    files: packet.files,
  };
  if (canonicalJson(manifest) !== canonicalJson(expectedManifest)
      || hashCanonicalJson(manifest) !== packet.manifestDigest) {
    throw new Error("ARTIFACT_PACKET_MANIFEST_CONTENT_MISMATCH");
  }
  const manifestHead = await request(packet.manifestUrl, "HEAD");
  if (manifestHead.response.status !== 200) throw new Error("ARTIFACT_PACKET_MANIFEST_HEAD_FAILED");
  const rootUrl = new URL("./", packet.manifestUrl);
  for (const file of packet.files) {
    const fileRead = await request(new URL(file.relativePath, rootUrl).href, "GET");
    if (fileRead.response.status !== 200 || fileRead.body.byteLength !== file.bytes
        || sha256Digest(fileRead.body) !== file.sha256) {
      throw new Error(`ARTIFACT_PACKET_FILE_VERIFICATION_FAILED:${file.relativePath}`);
    }
  }
  for (const method of ["POST", "PUT", "DELETE"] as const) {
    const writeProbe = await request(packet.manifestUrl, method);
    if (writeProbe.response.status >= 200 && writeProbe.response.status < 300) {
      throw new Error(`ARTIFACT_PACKET_WRITE_METHOD_ACCEPTED:${method}`);
    }
  }
  const directoryProbe = await request(rootUrl.href, "GET");
  if (directoryProbe.response.status >= 200 && directoryProbe.response.status < 300) {
    throw new Error("ARTIFACT_PACKET_DIRECTORY_LISTING_AVAILABLE");
  }
  const observedAt = (input.now ?? (() => new Date().toISOString()))();
  const probeEvidenceDigest = hashCanonicalJson({
    algorithm: "loopback-read-only-packet-probe/v1",
    manifestDigest: packet.manifestDigest,
    requests: requestEvidence,
  });
  const content = artifactPacketReadyReceiptContentSchema.parse({
    schemaVersion: 1,
    kind: "codex-review-artifact-packet-ready-receipt",
    observedAt,
    envelopeDigest: hashCanonicalJson(envelope),
    origin: packet.origin,
    manifestUrl: packet.manifestUrl,
    manifestDigest: packet.manifestDigest,
    servedFileCount: packet.files.length,
    servedFileRoot: hashCanonicalJson(packet.files),
    unexpectedFileCount: 0,
    probes: {
      getManifest: "succeeded",
      headManifest: "succeeded",
      getEveryFile: "digest_verified",
      post: "rejected",
      put: "rejected",
      delete: "rejected",
      directoryListing: "rejected",
    },
    probeEvidenceDigest,
  });
  return freezeDeep(exp0001aCodexArtifactPacketReadyReceiptSchema.parse({
    ...content,
    receiptDigest: hashCanonicalJson(content),
  }));
}

function createVerifiedExp0001aAuthorTaskEnvelope(input: {
  publicTaskBrief: string;
  privateRoomUrl: string;
  roomId: string;
  roomProvisioningReceiptDigest: string;
  provisioningRoomAccessBindingDigest: string;
  provisioningBinding: z.input<typeof authorEnvelopeSchema>["provisioningBinding"];
}): Extract<Exp0001aCodexTaskEnvelope, { role: "author" }> {
  const privateRoomAccessBindingDigest = computePrivateRoomAccessBinding(input);
  return freezeDeep(authorEnvelopeSchema.parse({
    schemaVersion: EXP0001A_CODEX_TASK_TRANSPORT_VERSION,
    kind: "author-task-envelope",
    role: "author",
    ...input,
    privateRoomAccessBindingDigest,
    instructions: FIXED_AUTHOR_INSTRUCTIONS,
  }));
}

/**
 * Canonical room-provisioning → isolated author-task boundary. The provisioning
 * binding commits roomId+roomCode+invite; the task binding independently
 * commits the exact author-visible invite+roomId. Both are retained privately.
 */
export function createExp0001aAuthorTaskEnvelopeFromProvisioningHandoff(
  handoffInput: unknown,
  roomProvisioningReceiptInput: unknown,
): Extract<Exp0001aCodexTaskEnvelope, { role: "author" }> {
  const handoff = verifyExp0001aAuthorProvisioningHandoff(handoffInput);
  const roomReceipt = verifyExp0001aRoomProvisioningReceipt(roomProvisioningReceiptInput);
  assertExp0001aAuthorVisibleInputUnmodified(handoff.authorVisible, handoff);
  if (hashCanonicalJson(handoff.authorVisible.publicTaskPacket) !== handoff.trustedBinding.publicAuthorPacketDigest
      || handoff.authorVisible.renderedPublicBrief !== renderPublicAuthorBrief(handoff.authorVisible.publicTaskPacket)) {
    throw new Error("AUTHOR_PROVISIONING_PUBLIC_PACKET_BINDING_INVALID");
  }
  if (roomReceipt.receiptDigest !== handoff.trustedBinding.roomReceiptDigest
      || roomReceipt.assignmentId !== handoff.trustedBinding.assignmentId
      || roomReceipt.attemptId !== handoff.trustedBinding.attemptId
      || roomReceipt.plannedIndex !== handoff.trustedBinding.plannedIndex
      || roomReceipt.planDigest !== handoff.trustedBinding.planDigest
      || roomReceipt.attemptPlanDigest !== handoff.trustedBinding.attemptPlanDigest
      || roomReceipt.room.roomId !== handoff.trustedBinding.roomId
      || roomReceipt.room.inviteUrl !== handoff.authorVisible.privateRoomInviteUrl
      || roomReceipt.room.accessBindingDigest !== handoff.trustedBinding.roomAccessBindingDigest
      || Date.parse(handoff.trustedBinding.authorReleaseAt) < Date.parse(roomReceipt.coordinatorPresence.authorReleaseNotBefore)) {
    throw new Error("AUTHOR_PROVISIONING_HANDOFF_AND_RETAINED_ROOM_RECEIPT_DIFFER");
  }
  return createVerifiedExp0001aAuthorTaskEnvelope({
    publicTaskBrief: handoff.authorVisible.renderedPublicBrief,
    privateRoomUrl: handoff.authorVisible.privateRoomInviteUrl,
    roomId: handoff.trustedBinding.roomId,
    roomProvisioningReceiptDigest: handoff.trustedBinding.roomReceiptDigest,
    provisioningRoomAccessBindingDigest: handoff.trustedBinding.roomAccessBindingDigest,
    provisioningBinding: {
      assignmentId: handoff.trustedBinding.assignmentId,
      attemptId: handoff.trustedBinding.attemptId,
      plannedIndex: handoff.trustedBinding.plannedIndex,
      planDigest: handoff.trustedBinding.planDigest,
      attemptPlanDigest: handoff.trustedBinding.attemptPlanDigest,
      publicAuthorPacketDigest: handoff.trustedBinding.publicAuthorPacketDigest,
      handoffDigest: handoff.handoffDigest,
      authorReleaseAt: handoff.trustedBinding.authorReleaseAt,
      coordinatorPresenceExpiredBeforeRelease: handoff.trustedBinding.coordinatorPresenceExpiredBeforeRelease,
    },
  });
}

export type Exp0001aReviewEvidenceInput = Readonly<{
  publicRequirement: string;
  rubric: Readonly<{
    rubricId: string;
    criterionIds: readonly string[];
    allowedMechanismTags: readonly string[];
    content: JsonValue;
  }>;
  /** Exact retained author task whose coordinator-derived final evidence is reviewed. */
  authorPlan: Exp0001aCodexTaskTransportPlan;
  authorLifecycle: Exp0001aCodexTaskLifecycle;
  artifactPacketOrigin: string;
}>;

export type Exp0001aPrimaryReviewSubjectInput = Omit<Exp0001aReviewEvidenceInput, "artifactPacketOrigin">;

type Exp0001aReviewEvidenceContentInput = Readonly<{
  publicRequirement: string;
  rubric: Exp0001aReviewEvidenceInput["rubric"];
  semanticState: JsonValue;
  images: ReadonlyArray<Omit<z.input<typeof imageEvidenceSchema>, "relativePath">>;
}>;

function createReviewEvidence(
  input: Exp0001aReviewEvidenceContentInput,
  pathPrefix = "",
): z.infer<typeof reviewEvidenceSchema> {
  const rubricContent = cloneJson(input.rubric.content);
  const stateContent = cloneJson(input.semanticState);
  const images = input.images.map((image) => ({
    ...image,
    relativePath: `${pathPrefix}images/${image.sha256.slice("sha256:".length)}.png`,
  }));
  const rubric = {
    rubricId: input.rubric.rubricId,
    criterionIds: [...input.rubric.criterionIds],
    allowedMechanismTags: [...input.rubric.allowedMechanismTags],
    content: rubricContent,
    sha256: hashCanonicalJson(rubricContent),
  };
  const semanticState = {
    content: stateContent,
    bytes: Buffer.byteLength(canonicalJson(stateContent), "utf8"),
    sha256: hashCanonicalJson(stateContent),
  };
  const evidenceRoot = hashCanonicalJson({
    publicRequirement: input.publicRequirement,
    rubricSha256: rubric.sha256,
    rubricCriterionIds: rubric.criterionIds,
    allowedMechanismTags: rubric.allowedMechanismTags,
    semanticStateSha256: semanticState.sha256,
    images: images.map(({ slot, roomRevision, final, sha256, bytes, width, height, relativePath }) => ({
      slot,
      roomRevision,
      final,
      sha256,
      bytes,
      width,
      height,
      relativePath,
    })),
  });
  return reviewEvidenceSchema.parse({
    publicRequirement: input.publicRequirement,
    rubric,
    semanticState,
    images,
    evidenceRoot,
  });
}

export function createExp0001aPrimaryReviewSubject(
  input: Exp0001aPrimaryReviewSubjectInput,
): Exp0001aPrimaryReviewSubject {
  const authorPlan = exp0001aCodexTaskTransportPlanSchema.parse(input.authorPlan);
  const authorLifecycle = exp0001aCodexTaskLifecycleSchema.parse(input.authorLifecycle);
  if (authorLifecycle.terminalOutcome !== "succeeded") {
    if (authorPlan.role !== "author" || authorPlan.envelope.role !== "author"
        || authorLifecycle.planDigest !== authorPlan.planDigest
        || authorLifecycle.transportId !== authorPlan.transportId
        || authorLifecycle.state !== "terminal" || authorLifecycle.terminalOutcome === null
        || authorLifecycle.readReceipt === null || authorLifecycle.readReceipt.terminalArtifact !== null) {
      throw new Error("AUTHOR_FAILURE_REVIEW_REQUIRES_EXACT_TERMINAL_FAILED_AUTHOR_LIFECYCLE");
    }
    const rubricContent = cloneJson(input.rubric.content);
    const rubric = rubricEvidenceSchema.parse({
      rubricId: input.rubric.rubricId,
      criterionIds: [...input.rubric.criterionIds],
      allowedMechanismTags: [...input.rubric.allowedMechanismTags],
      content: rubricContent,
      sha256: hashCanonicalJson(rubricContent),
    });
    const packetContent = authorFailurePacketContentSchema.parse({
      schemaVersion: "exp-0001a-author-failure-review-packet/v1",
      kind: "author-terminal-failure-packet",
      terminalOutcome: authorLifecycle.terminalOutcome,
      taskBegun: authorLifecycle.taskBegun,
      lifecycleState: "terminal",
      authorPlanDigest: authorPlan.planDigest,
      authorLifecycleDigest: authorLifecycle.lifecycleDigest,
      authorReadReceiptDigest: authorLifecycle.readReceipt.receiptDigest,
      traceDecision: authorLifecycle.readReceipt.tracePolicyReceipt?.decision ?? null,
      reviewerDisposition: "non_evaluable_author_noncompletion",
    });
    const authorFailurePacket = exp0001aAuthorFailureReviewPacketSchema.parse({
      ...packetContent,
      packetDigest: hashCanonicalJson(packetContent),
    });
    const packetBytes = Buffer.from(canonicalJson(authorFailurePacket), "utf8");
    const packetDigest = sha256Digest(packetBytes);
    const fileMetadata = artifactPacketFileSchema.parse({
      relativePath: `author-failure/${packetDigest.slice("sha256:".length)}.json`,
      sha256: packetDigest,
      bytes: packetBytes.byteLength,
      mimeType: "application/json",
    });
    const content = failedPrimaryReviewSubjectContentSchema.parse({
      schemaVersion: "exp-0001a-primary-review-subject/v1",
      kind: "primary-review-author-failure-subject",
      publicRequirement: input.publicRequirement,
      rubric,
      authorFailurePacket,
      failureEvidenceRoot: hashCanonicalJson({
        publicRequirement: input.publicRequirement,
        rubricSha256: rubric.sha256,
        authorFailurePacketDigest: authorFailurePacket.packetDigest,
      }),
      files: [{ ...fileMetadata, contentBase64: packetBytes.toString("base64") }],
    });
    return freezeDeep(exp0001aPrimaryReviewSubjectSchema.parse({ ...content, subjectDigest: hashCanonicalJson(content) }));
  }
  const retained = deriveExp0001aFinalOnlyReviewEvidence({
    plan: authorPlan,
    lifecycle: authorLifecycle,
  });
  const evidence = createReviewEvidence({
    publicRequirement: input.publicRequirement,
    rubric: input.rubric,
    semanticState: retained.semanticState.content,
    images: [{
      slot: "image-01",
      roomRevision: retained.finalImage.roomRevision,
      final: true,
      sha256: retained.finalImage.sha256,
      bytes: retained.finalImage.bytes,
      width: retained.finalImage.width,
      height: retained.finalImage.height,
      mimeType: "image/png",
    }],
  });
  const imageBytes = Buffer.from(retained.finalImage.pngBytesBase64, "base64");
  const file = retainedArtifactSourceFileSchema.parse({
    relativePath: evidence.images[0]!.relativePath,
    sha256: evidence.images[0]!.sha256,
    bytes: evidence.images[0]!.bytes,
    mimeType: evidence.images[0]!.mimeType,
    contentBase64: imageBytes.toString("base64"),
  });
  const content = successfulPrimaryReviewSubjectContentSchema.parse({
    schemaVersion: "exp-0001a-primary-review-subject/v1",
    kind: "primary-review-success-subject",
    evidence,
    authorPlanDigest: authorPlan.planDigest,
    authorLifecycleDigest: authorLifecycle.lifecycleDigest,
    authorFinalEvidenceRoot: retained.evidenceRoot,
    files: [file],
  });
  return freezeDeep(exp0001aPrimaryReviewSubjectSchema.parse({ ...content, subjectDigest: hashCanonicalJson(content) }));
}

export function createExp0001aPrimaryReviewerTaskEnvelopeFromSubject(input: {
  subject: Exp0001aPrimaryReviewSubject;
  artifactPacketOrigin: string;
}): Extract<Exp0001aCodexTaskEnvelope, { role: "primary_reviewer" }> {
  const subject = exp0001aPrimaryReviewSubjectSchema.parse(input.subject);
  const artifactPacket = createArtifactPacketFromFiles(input.artifactPacketOrigin, subject.files);
  if (subject.kind === "primary-review-author-failure-subject") {
    return freezeDeep(failedPrimaryReviewerEnvelopeSchema.parse({
      schemaVersion: EXP0001A_CODEX_TASK_TRANSPORT_VERSION,
      kind: "primary-reviewer-author-failure-task-envelope",
      role: "primary_reviewer",
      publicRequirement: subject.publicRequirement,
      rubric: subject.rubric,
      authorFailurePacket: subject.authorFailurePacket,
      failureEvidenceRoot: subject.failureEvidenceRoot,
      artifactPacket,
      instructions: FIXED_AUTHOR_FAILURE_REVIEW_INSTRUCTIONS,
    }));
  }
  return freezeDeep(successfulPrimaryReviewerEnvelopeSchema.parse({
    schemaVersion: EXP0001A_CODEX_TASK_TRANSPORT_VERSION,
    kind: "primary-reviewer-task-envelope",
    role: "primary_reviewer",
    evidence: subject.evidence,
    artifactPacket,
    instructions: FIXED_REVIEW_INSTRUCTIONS,
  }));
}

/** Compatibility wrapper; production catalogs should retain the stable subject and attach a fresh origin only at task preparation. */
export function createExp0001aPrimaryReviewerTaskEnvelope(
  input: Exp0001aReviewEvidenceInput,
): Extract<Exp0001aCodexTaskEnvelope, { role: "primary_reviewer" }> {
  const { artifactPacketOrigin, ...subjectInput } = input;
  return createExp0001aPrimaryReviewerTaskEnvelopeFromSubject({
    subject: createExp0001aPrimaryReviewSubject(subjectInput),
    artifactPacketOrigin,
  });
}

/** Exact byte payloads for the loopback packet server; all bytes are re-bound to the sealed envelope. */
export function materializeExp0001aPrimaryReviewerArtifactPacket(input: {
  envelope: Extract<Exp0001aCodexTaskEnvelope, { role: "primary_reviewer" }>;
  authorPlan: Exp0001aCodexTaskTransportPlan;
  authorLifecycle: Exp0001aCodexTaskLifecycle;
}): Readonly<{
  manifest: JsonValue;
  files: readonly Readonly<{ relativePath: string; sha256: string; bytes: number; mimeType: "image/png" | "application/json"; contentBase64: string }>[];
}> {
  const envelope = primaryReviewerEnvelopeSchema.parse(input.envelope);
  let contents: readonly Readonly<{ relativePath: string; bytes: Uint8Array }>[];
  if (envelope.kind === "primary-reviewer-task-envelope") {
    const retained = deriveExp0001aFinalOnlyReviewEvidence({ plan: input.authorPlan, lifecycle: input.authorLifecycle });
    const file = envelope.artifactPacket.files[0];
    if (file === undefined || envelope.artifactPacket.files.length !== 1
        || file.sha256 !== retained.finalImage.sha256 || file.bytes !== retained.finalImage.bytes
        || file.mimeType !== "image/png") {
      throw new Error("PRIMARY_REVIEW_PACKET_FINAL_IMAGE_BINDING_INVALID");
    }
    contents = [{ relativePath: file.relativePath, bytes: new Uint8Array(Buffer.from(retained.finalImage.pngBytesBase64, "base64")) }];
  } else {
    const plan = exp0001aCodexTaskTransportPlanSchema.parse(input.authorPlan);
    const lifecycle = exp0001aCodexTaskLifecycleSchema.parse(input.authorLifecycle);
    if (plan.planDigest !== envelope.authorFailurePacket.authorPlanDigest
        || lifecycle.lifecycleDigest !== envelope.authorFailurePacket.authorLifecycleDigest
        || lifecycle.readReceipt?.receiptDigest !== envelope.authorFailurePacket.authorReadReceiptDigest) {
      throw new Error("PRIMARY_FAILURE_PACKET_AUTHOR_LIFECYCLE_BINDING_INVALID");
    }
    const file = envelope.artifactPacket.files[0];
    contents = [{ relativePath: file!.relativePath, bytes: new Uint8Array(Buffer.from(canonicalJson(envelope.authorFailurePacket), "utf8")) }];
  }
  const payloadFiles = contents.map((content) => {
    const metadata = envelope.artifactPacket.files.find((file) => file.relativePath === content.relativePath);
    if (metadata === undefined || sha256Digest(content.bytes) !== metadata.sha256 || content.bytes.byteLength !== metadata.bytes) {
      throw new Error("PRIMARY_REVIEW_PACKET_RETAINED_BYTES_MISMATCH");
    }
    return freezeDeep({ ...metadata, contentBase64: Buffer.from(content.bytes).toString("base64") });
  });
  return freezeDeep({
    manifest: cloneJson({ schemaVersion: 1, kind: "canvas-review-evidence-packet/v1", files: envelope.artifactPacket.files }),
    files: payloadFiles,
  });
}

export function materializeExp0001aPrimaryReviewSubjectArtifactPacket(input: {
  subject: Exp0001aPrimaryReviewSubject;
  envelope: Extract<Exp0001aCodexTaskEnvelope, { role: "primary_reviewer" }>;
}): Readonly<{
  subjectDigest: string;
  manifest: JsonValue;
  files: readonly z.infer<typeof retainedArtifactSourceFileSchema>[];
}> {
  const subject = exp0001aPrimaryReviewSubjectSchema.parse(input.subject);
  const envelope = primaryReviewerEnvelopeSchema.parse(input.envelope);
  const expectedKind = subject.kind === "primary-review-success-subject"
    ? "primary-reviewer-task-envelope"
    : "primary-reviewer-author-failure-task-envelope";
  const subjectRoot = subject.kind === "primary-review-success-subject"
    ? subject.evidence.evidenceRoot
    : subject.failureEvidenceRoot;
  const envelopeRoot = envelope.kind === "primary-reviewer-task-envelope"
    ? envelope.evidence.evidenceRoot
    : envelope.failureEvidenceRoot;
  const expectedFiles = subject.files.map(retainedArtifactFileMetadata);
  if (envelope.kind !== expectedKind || envelopeRoot !== subjectRoot
      || canonicalJson(envelope.artifactPacket.files) !== canonicalJson(expectedFiles)) {
    throw new Error("PRIMARY_REVIEW_TASK_PACKET_NOT_BOUND_TO_STABLE_SUBJECT");
  }
  return freezeDeep({
    subjectDigest: subject.subjectDigest,
    manifest: cloneJson({ schemaVersion: 1, kind: "canvas-review-evidence-packet/v1", files: envelope.artifactPacket.files }),
    files: subject.files,
  });
}

export type Exp0001aRetainedPrimaryPair = readonly [
  Readonly<{ slot: "primary-review-1"; plan: Exp0001aCodexTaskTransportPlan; lifecycle: Exp0001aCodexTaskLifecycle }>,
  Readonly<{ slot: "primary-review-2"; plan: Exp0001aCodexTaskTransportPlan; lifecycle: Exp0001aCodexTaskLifecycle }>,
];

export type Exp0001aAdjudicatorEvidenceInput = Readonly<{
  /** The already-sealed blinded subject used by both retained primary tasks. */
  primaryEvidenceEnvelope: Extract<Exp0001aCodexTaskEnvelope, { role: "primary_reviewer" }>;
  primaryReviews: Exp0001aRetainedPrimaryPair;
}> | Readonly<{
  /** Stable, origin-free subject; a fresh packet origin is attached only for this adjudicator task. */
  primarySubject: Exp0001aPrimaryReviewSubject;
  artifactPacketOrigin: string;
  primaryReviews: Exp0001aRetainedPrimaryPair;
}>;

export function createExp0001aAdjudicatorTaskEnvelope(
  input: Exp0001aAdjudicatorEvidenceInput,
): Extract<Exp0001aCodexTaskEnvelope, { role: "adjudicator" }> {
  const stableInput = "primarySubject" in input;
  const stableSubject = stableInput ? exp0001aPrimaryReviewSubjectSchema.parse(input.primarySubject) : null;
  if (stableSubject !== null && stableSubject.kind !== "primary-review-success-subject") {
    throw new Error("ADJUDICATOR_REQUIRES_A_SUCCESSFUL_AUTHOR_SUBJECT");
  }
  const primaryEvidenceEnvelope = stableInput
    ? null
    : successfulPrimaryReviewerEnvelopeSchema.parse(input.primaryEvidenceEnvelope);
  const evidence = stableSubject?.evidence ?? primaryEvidenceEnvelope!.evidence;
  const adjudicatorArtifactPacket = "primarySubject" in input
    ? createArtifactPacketFromFiles(input.artifactPacketOrigin, stableSubject!.files)
    : primaryEvidenceEnvelope!.artifactPacket;
  const acceptedPrimaryDecisions: boolean[] = [];
  const primaryReviews = input.primaryReviews.map((primary) => {
    const plan = exp0001aCodexTaskTransportPlanSchema.parse(primary.plan);
    const lifecycle = exp0001aCodexTaskLifecycleSchema.parse(primary.lifecycle);
    const receipt = lifecycle.readReceipt;
    if (plan.role !== "primary_reviewer" || plan.envelope.role !== "primary_reviewer"
        || plan.envelope.kind !== "primary-reviewer-task-envelope"
        || plan.envelope.evidence.evidenceRoot !== evidence.evidenceRoot
        || lifecycle.planDigest !== plan.planDigest || lifecycle.role !== "primary_reviewer"
        || lifecycle.state !== "terminal" || lifecycle.terminalOutcome === null
        || lifecycle.codexTaskId === null || receipt === null) {
      throw new Error("ADJUDICATOR_PRIMARY_REVIEW_NOT_EXACT_RETAINED_TERMINAL");
    }
    const retainedTaskBindingDigest = hashCanonicalJson({
      planDigest: plan.planDigest,
      lifecycleDigest: lifecycle.lifecycleDigest,
      codexTaskId: lifecycle.codexTaskId,
      readReceiptDigest: receipt.receiptDigest,
    });
    if (lifecycle.terminalOutcome !== "succeeded") {
      if (receipt.terminalArtifact !== null || receipt.terminalJson !== null) {
        throw new Error("ADJUDICATOR_FAILED_PRIMARY_CANNOT_RETAIN_SCORED_RESULT");
      }
      const result = canonicalFailedPrimaryResultSchema.parse({
        schemaVersion: "canonical-primary-review-failure/v1",
        role: "primary_reviewer",
        accepted: false,
        primaryFailureClass: "FAIL_EVALUATOR_SCORER",
        failureDisposition: "canonical_failed_false",
        subjectEvidenceRoot: evidence.evidenceRoot,
        terminalOutcome: lifecycle.terminalOutcome,
        traceDecision: receipt.tracePolicyReceipt?.decision ?? null,
      });
      acceptedPrimaryDecisions.push(false);
      return retainedPrimaryReviewProjectionSchema.parse({
        slot: primary.slot,
        projectionKind: "canonical-failed-primary-review",
        result,
        resultDigest: hashCanonicalJson(result),
        modelTerminalResultDigest: receipt.terminalResultDigest,
        terminalArtifactRoot: null,
        readReceiptDigest: receipt.receiptDigest,
        retainedTaskBindingDigest,
      });
    }
    if (receipt.outcome !== "retained" || receipt.terminalJson === null || receipt.tracePolicyReceipt?.decision !== "pass"
        || receipt.terminalArtifact?.kind !== "primary-review-result"
        || receipt.terminalArtifact.codexTaskId !== lifecycle.codexTaskId
        || receipt.terminalArtifact.subjectEvidenceRoot !== evidence.evidenceRoot
        || receipt.terminalArtifact.modelTerminalResultDigest !== receipt.terminalResultDigest) {
      throw new Error("ADJUDICATOR_PRIMARY_REVIEW_NOT_EXACT_RETAINED_SUCCESS");
    }
    const result = blindedReviewTerminalJsonSchema.extend({ role: z.literal("primary_reviewer") }).strict()
      .parse(validateExp0001aCodexTerminalJson(plan, receipt.terminalJson));
    acceptedPrimaryDecisions.push(result.accepted);
    const resultDigest = hashCanonicalJson(result);
    if (resultDigest !== receipt.terminalArtifact.resultDigest) {
      throw new Error("ADJUDICATOR_PRIMARY_REVIEW_RESULT_DIGEST_MISMATCH");
    }
    return retainedPrimaryReviewProjectionSchema.parse({
      slot: primary.slot,
      projectionKind: "scored-primary-review",
      result,
      resultDigest,
      modelTerminalResultDigest: receipt.terminalResultDigest,
      terminalArtifactRoot: receipt.terminalArtifact.artifactRoot,
      readReceiptDigest: receipt.receiptDigest,
      retainedTaskBindingDigest,
    });
  }) as [z.infer<typeof retainedPrimaryReviewProjectionSchema>, z.infer<typeof retainedPrimaryReviewProjectionSchema>];
  const first = input.primaryReviews[0];
  const second = input.primaryReviews[1];
  if (first.slot !== "primary-review-1" || second.slot !== "primary-review-2"
      || first.plan.transportId === second.plan.transportId
      || first.lifecycle.codexTaskId === second.lifecycle.codexTaskId
      || canonicalJson(first.plan.privateBinding.subjectArtifactIds) !== canonicalJson(second.plan.privateBinding.subjectArtifactIds)
      || acceptedPrimaryDecisions[0] === acceptedPrimaryDecisions[1]) {
    throw new Error("ADJUDICATOR_REQUIRES_DISTINCT_DISAGREEING_PRIMARY_TASKS_FOR_ONE_SUBJECT");
  }
  const primaryReviewRoot = hashCanonicalJson(primaryReviews);
  return freezeDeep(adjudicatorEnvelopeSchema.parse({
    schemaVersion: EXP0001A_CODEX_TASK_TRANSPORT_VERSION,
    kind: "adjudicator-task-envelope",
    role: "adjudicator",
    evidence,
    primaryReviews,
    primaryReviewRoot,
    adjudicationSubjectRoot: hashCanonicalJson({ evidenceRoot: evidence.evidenceRoot, primaryReviewRoot }),
    artifactPacket: adjudicatorArtifactPacket,
    instructions: FIXED_ADJUDICATOR_INSTRUCTIONS,
  }));
}

export function createExp0001aAdjudicationReviewSubject(input: {
  primarySubject: Exp0001aPrimaryReviewSubject;
  primaryReviews: Exp0001aRetainedPrimaryPair;
}): Exp0001aAdjudicationReviewSubject {
  const primarySubject = exp0001aPrimaryReviewSubjectSchema.parse(input.primarySubject);
  if (primarySubject.kind !== "primary-review-success-subject") {
    throw new Error("ADJUDICATION_REQUIRES_A_SUCCESSFUL_AUTHOR_SUBJECT");
  }
  // Reuse the lifecycle-derived projection path. The synthetic loopback origin
  // is deliberately discarded; it never enters the stable subject or journal.
  const derived = createExp0001aAdjudicatorTaskEnvelope({
    primarySubject,
    artifactPacketOrigin: "http://127.0.0.1:1/",
    primaryReviews: input.primaryReviews,
  });
  const content = adjudicationReviewSubjectContentSchema.parse({
    schemaVersion: "exp-0001a-adjudication-review-subject/v1",
    kind: "adjudication-review-subject",
    evidence: derived.evidence,
    primaryReviews: derived.primaryReviews,
    primaryReviewRoot: derived.primaryReviewRoot,
    adjudicationSubjectRoot: derived.adjudicationSubjectRoot,
    sourcePrimarySubjectDigest: primarySubject.subjectDigest,
    files: primarySubject.files,
  });
  return freezeDeep(exp0001aAdjudicationReviewSubjectSchema.parse({
    ...content,
    subjectDigest: hashCanonicalJson(content),
  }));
}

export function createExp0001aAdjudicatorTaskEnvelopeFromSubject(input: {
  subject: Exp0001aAdjudicationReviewSubject;
  artifactPacketOrigin: string;
}): Extract<Exp0001aCodexTaskEnvelope, { role: "adjudicator" }> {
  const subject = exp0001aAdjudicationReviewSubjectSchema.parse(input.subject);
  return freezeDeep(adjudicatorEnvelopeSchema.parse({
    schemaVersion: EXP0001A_CODEX_TASK_TRANSPORT_VERSION,
    kind: "adjudicator-task-envelope",
    role: "adjudicator",
    evidence: subject.evidence,
    primaryReviews: subject.primaryReviews,
    primaryReviewRoot: subject.primaryReviewRoot,
    adjudicationSubjectRoot: subject.adjudicationSubjectRoot,
    artifactPacket: createArtifactPacketFromFiles(input.artifactPacketOrigin, subject.files),
    instructions: FIXED_ADJUDICATOR_INSTRUCTIONS,
  }));
}

export function materializeExp0001aAdjudicationReviewSubjectArtifactPacket(input: {
  subject: Exp0001aAdjudicationReviewSubject;
  envelope: Extract<Exp0001aCodexTaskEnvelope, { role: "adjudicator" }>;
}): Readonly<{
  subjectDigest: string;
  manifest: JsonValue;
  files: readonly z.infer<typeof retainedArtifactSourceFileSchema>[];
}> {
  const subject = exp0001aAdjudicationReviewSubjectSchema.parse(input.subject);
  const envelope = adjudicatorEnvelopeSchema.parse(input.envelope);
  const expectedFiles = subject.files.map(retainedArtifactFileMetadata);
  if (envelope.adjudicationSubjectRoot !== subject.adjudicationSubjectRoot
      || envelope.primaryReviewRoot !== subject.primaryReviewRoot
      || canonicalJson(envelope.artifactPacket.files) !== canonicalJson(expectedFiles)) {
    throw new Error("ADJUDICATION_TASK_PACKET_NOT_BOUND_TO_STABLE_SUBJECT");
  }
  return freezeDeep({
    subjectDigest: subject.subjectDigest,
    manifest: cloneJson({ schemaVersion: 1, kind: "canvas-review-evidence-packet/v1", files: envelope.artifactPacket.files }),
    files: subject.files,
  });
}

export type Exp0001aPairwiseReviewSubjectInput = Readonly<{
  publicRequirement: string;
  rubric: Exp0001aReviewEvidenceInput["rubric"];
  sides: readonly [
    Readonly<{ authorPlan: Exp0001aCodexTaskTransportPlan; authorLifecycle: Exp0001aCodexTaskLifecycle }>,
    Readonly<{ authorPlan: Exp0001aCodexTaskTransportPlan; authorLifecycle: Exp0001aCodexTaskLifecycle }>,
  ];
}>;

function createPairwiseSourceBinding(
  subject: Exp0001aPrimaryReviewSubject,
  slot: "canvas-1" | "canvas-2",
): z.infer<typeof pairwiseSourceBindingSchema> {
  if (subject.kind === "primary-review-success-subject") {
    return pairwiseSourceBindingSchema.parse({
      slot,
      availability: "available",
      authorPlanDigest: subject.authorPlanDigest,
      authorLifecycleDigest: subject.authorLifecycleDigest,
      sourceEvidenceRoot: subject.authorFinalEvidenceRoot,
      primarySubjectDigest: subject.subjectDigest,
    });
  }
  return pairwiseSourceBindingSchema.parse({
    slot,
    availability: "unavailable",
    authorPlanDigest: subject.authorFailurePacket.authorPlanDigest,
    authorLifecycleDigest: subject.authorFailurePacket.authorLifecycleDigest,
    sourceEvidenceRoot: subject.failureEvidenceRoot,
    primarySubjectDigest: subject.subjectDigest,
  });
}

/**
 * Creates the origin-free, byte-retaining pairwise subject from two exact author
 * lifecycles. Callers cannot supply image metadata or bytes.
 */
export function createExp0001aPairwiseReviewSubject(
  input: Exp0001aPairwiseReviewSubjectInput,
): Exp0001aPairwiseReviewSubject {
  const primarySubjects = input.sides.map((side) => createExp0001aPrimaryReviewSubject({
    publicRequirement: input.publicRequirement,
    rubric: input.rubric,
    authorPlan: side.authorPlan,
    authorLifecycle: side.authorLifecycle,
  })) as [Exp0001aPrimaryReviewSubject, Exp0001aPrimaryReviewSubject];
  const sourceBindings = primarySubjects.map((subject, index) => createPairwiseSourceBinding(
    subject,
    index === 0 ? "canvas-1" : "canvas-2",
  )) as [z.infer<typeof pairwiseSourceBindingSchema>, z.infer<typeof pairwiseSourceBindingSchema>];
  const rubric = primarySubjects[0].kind === "primary-review-success-subject"
    ? primarySubjects[0].evidence.rubric
    : primarySubjects[0].rubric;
  const secondRubric = primarySubjects[1].kind === "primary-review-success-subject"
    ? primarySubjects[1].evidence.rubric
    : primarySubjects[1].rubric;
  if (canonicalJson(rubric) !== canonicalJson(secondRubric)) {
    throw new Error("PAIRWISE_SIDES_DO_NOT_SHARE_ONE_FROZEN_RUBRIC");
  }

  if (primarySubjects.every((subject) => subject.kind === "primary-review-success-subject")) {
    const successfulSubjects = primarySubjects as [
      Extract<Exp0001aPrimaryReviewSubject, { kind: "primary-review-success-subject" }>,
      Extract<Exp0001aPrimaryReviewSubject, { kind: "primary-review-success-subject" }>,
    ];
    const sides = successfulSubjects.map((subject, index) => {
      const slot = index === 0 ? "canvas-1" as const : "canvas-2" as const;
      const sourceImage = subject.evidence.images[0]!;
      const finalImage = imageEvidenceSchema.parse({
        ...sourceImage,
        slot: "image-01",
        final: true,
        relativePath: `${slot}/images/${sourceImage.sha256.slice("sha256:".length)}.png`,
      });
      return pairwiseSideSchema.parse({
        slot,
        finalImage,
        sideRoot: hashCanonicalJson({
          slot,
          finalImage: {
            roomRevision: finalImage.roomRevision,
            sha256: finalImage.sha256,
            bytes: finalImage.bytes,
            width: finalImage.width,
            height: finalImage.height,
            relativePath: finalImage.relativePath,
          },
        }),
      });
    }) as [z.infer<typeof pairwiseSideSchema>, z.infer<typeof pairwiseSideSchema>];
    const files = successfulSubjects.map((subject, index) => {
      const sourceFile = subject.files[0]!;
      return retainedArtifactSourceFileSchema.parse({
        ...sourceFile,
        relativePath: sides[index]!.finalImage.relativePath,
      });
    }) as [z.infer<typeof retainedArtifactSourceFileSchema>, z.infer<typeof retainedArtifactSourceFileSchema>];
    const content = successfulPairwiseReviewSubjectContentSchema.parse({
      schemaVersion: "exp-0001a-pairwise-review-subject/v1",
      kind: "pairwise-review-success-subject",
      publicRequirement: input.publicRequirement,
      rubric,
      sides,
      sourceBindings,
      files,
      pairRoot: hashCanonicalJson(sides.map(({ slot, sideRoot }) => ({ slot, sideRoot }))),
    });
    return freezeDeep(exp0001aPairwiseReviewSubjectSchema.parse({
      ...content,
      subjectDigest: hashCanonicalJson(content),
    }));
  }

  const unavailablePacketContent = pairwiseUnavailablePacketContentSchema.parse({
    schemaVersion: "exp-0001a-pairwise-unavailable-packet/v1",
    kind: "pairwise-incomplete-author-evidence",
    sides: sourceBindings.map((binding) => ({
      slot: binding.slot,
      availability: binding.availability,
      sourceEvidenceRoot: binding.sourceEvidenceRoot,
    })),
    disposition: "pairwise_unavailable_without_fabricated_pixels",
  });
  const unavailablePacket = exp0001aPairwiseUnavailablePacketSchema.parse({
    ...unavailablePacketContent,
    packetDigest: hashCanonicalJson(unavailablePacketContent),
  });
  const packetBytes = Buffer.from(canonicalJson(unavailablePacket), "utf8");
  const file = retainedArtifactSourceFileSchema.parse({
    relativePath: `author-failure/${sha256Digest(packetBytes).slice("sha256:".length)}.json`,
    sha256: sha256Digest(packetBytes),
    bytes: packetBytes.byteLength,
    mimeType: "application/json",
    contentBase64: packetBytes.toString("base64"),
  });
  const content = unavailablePairwiseReviewSubjectContentSchema.parse({
    schemaVersion: "exp-0001a-pairwise-review-subject/v1",
    kind: "pairwise-review-unavailable-subject",
    publicRequirement: input.publicRequirement,
    rubric,
    unavailablePacket,
    sourceBindings,
    files: [file],
    pairRoot: hashCanonicalJson({
      publicRequirement: input.publicRequirement,
      rubricSha256: rubric.sha256,
      unavailablePacketDigest: unavailablePacket.packetDigest,
    }),
  });
  return freezeDeep(exp0001aPairwiseReviewSubjectSchema.parse({
    ...content,
    subjectDigest: hashCanonicalJson(content),
  }));
}

export function createExp0001aPairwiseVisualJudgeTaskEnvelopeFromSubject(input: {
  subject: Exp0001aPairwiseReviewSubject;
  artifactPacketOrigin: string;
}): Extract<Exp0001aCodexTaskEnvelope, { role: "pairwise_visual_judge" }> {
  const subject = exp0001aPairwiseReviewSubjectSchema.parse(input.subject);
  const artifactPacket = createArtifactPacketFromFiles(input.artifactPacketOrigin, subject.files);
  if (subject.kind === "pairwise-review-unavailable-subject") {
    return freezeDeep(unavailablePairwiseVisualJudgeEnvelopeSchema.parse({
      schemaVersion: EXP0001A_CODEX_TASK_TRANSPORT_VERSION,
      kind: "pairwise-visual-unavailable-task-envelope",
      role: "pairwise_visual_judge",
      publicRequirement: subject.publicRequirement,
      rubric: subject.rubric,
      unavailablePacket: subject.unavailablePacket,
      pairRoot: subject.pairRoot,
      artifactPacket,
      instructions: FIXED_PAIRWISE_UNAVAILABLE_INSTRUCTIONS,
    }));
  }
  return freezeDeep(successfulPairwiseVisualJudgeEnvelopeSchema.parse({
    schemaVersion: EXP0001A_CODEX_TASK_TRANSPORT_VERSION,
    kind: "pairwise-visual-judge-task-envelope",
    role: "pairwise_visual_judge",
    publicRequirement: subject.publicRequirement,
    rubric: subject.rubric,
    sides: subject.sides,
    artifactPacket,
    pairRoot: subject.pairRoot,
    instructions: FIXED_PAIRWISE_REVIEW_INSTRUCTIONS,
  }));
}

/** Compatibility wrapper that still derives every byte from retained author lifecycles. */
export function createExp0001aPairwiseVisualJudgeTaskEnvelope(
  input: Exp0001aPairwiseReviewSubjectInput & Readonly<{ artifactPacketOrigin: string }>,
): Extract<Exp0001aCodexTaskEnvelope, { role: "pairwise_visual_judge" }> {
  const { artifactPacketOrigin, ...subjectInput } = input;
  return createExp0001aPairwiseVisualJudgeTaskEnvelopeFromSubject({
    subject: createExp0001aPairwiseReviewSubject(subjectInput),
    artifactPacketOrigin,
  });
}

export function materializeExp0001aPairwiseReviewSubjectArtifactPacket(input: {
  subject: Exp0001aPairwiseReviewSubject;
  envelope: Extract<Exp0001aCodexTaskEnvelope, { role: "pairwise_visual_judge" }>;
}): Readonly<{
  subjectDigest: string;
  manifest: JsonValue;
  files: readonly z.infer<typeof retainedArtifactSourceFileSchema>[];
}> {
  const subject = exp0001aPairwiseReviewSubjectSchema.parse(input.subject);
  const envelope = pairwiseVisualJudgeEnvelopeSchema.parse(input.envelope);
  const expectedKind = subject.kind === "pairwise-review-success-subject"
    ? "pairwise-visual-judge-task-envelope"
    : "pairwise-visual-unavailable-task-envelope";
  const expectedFiles = subject.files.map(retainedArtifactFileMetadata);
  if (envelope.kind !== expectedKind || envelope.pairRoot !== subject.pairRoot
      || canonicalJson(envelope.artifactPacket.files) !== canonicalJson(expectedFiles)) {
    throw new Error("PAIRWISE_TASK_PACKET_NOT_BOUND_TO_STABLE_SUBJECT");
  }
  return freezeDeep({
    subjectDigest: subject.subjectDigest,
    manifest: cloneJson({ schemaVersion: 1, kind: "canvas-review-evidence-packet/v1", files: envelope.artifactPacket.files }),
    files: subject.files,
  });
}

function renderImageEvidence(images: ReadonlyArray<z.infer<typeof imageEvidenceSchema>>): string[] {
  return images.flatMap((image) => [
    `- ${image.slot}: ${image.relativePath}, room revision ${image.roomRevision}${image.final ? " (final)" : ""}, SHA-256 ${image.sha256}`,
  ]);
}

function renderReviewEvidence(evidence: z.infer<typeof reviewEvidenceSchema>): string[] {
  return [
    "Public requirement:",
    evidence.publicRequirement,
    "",
    `Frozen rubric (${evidence.rubric.rubricId}, ${evidence.rubric.sha256}):`,
    canonicalJson(evidence.rubric.content),
    "",
    `Sanitized semantic state (${evidence.semanticState.sha256}):`,
    canonicalJson(evidence.semanticState.content),
    "",
    "Revision-matched PNG evidence:",
    ...renderImageEvidence(evidence.images),
    "",
    `Evidence root: ${evidence.evidenceRoot}`,
  ];
}

const failureClassSchema = z.enum([
  "SUCCESS",
  "FAIL_PROTOCOL_VIOLATION",
  "FAIL_PRIVACY_INTEGRITY",
  "FAIL_EVALUATOR_SCORER",
  "FAIL_INFRASTRUCTURE",
  "FAIL_WEBMCP_TOOLING",
  "FAIL_TRANSACTION_REVISION_LEASE",
  "FAIL_TEMPORAL_PRESENTATION",
  "FAIL_AUTHOR_NONCOMPLETION",
  "FAIL_SEMANTIC",
  "FAIL_GEOMETRY_VISUAL",
  "FAIL_INSPECTION_CORRECTION",
]);

const blindedReviewTerminalJsonSchema = z.object({
  schemaVersion: z.literal("blinded-canvas-review-result/v1"),
  role: z.enum(["primary_reviewer", "adjudicator"]),
  evidenceCoverage: z.object({
    semanticState: z.literal(true),
    imageSlots: z.array(z.string().regex(/^image-[0-9]{2}$/)).min(1).max(7),
  }).strict(),
  criteria: z.array(z.object({
    criterionId: opaqueIdSchema,
    decision: z.enum(["pass", "fail", "indeterminate"]),
    evidenceRefs: z.array(z.string().min(1).max(240)).min(2).max(32),
    rationale: z.string().trim().min(1).max(1_500),
  }).strict()).min(1).max(EXP0001A_FROZEN_REVIEW_CRITERIA_MAX),
  accepted: z.boolean(),
  primaryFailureClass: failureClassSchema,
  mechanismTags: z.array(z.object({
    tag: opaqueIdSchema,
    evidenceRefs: z.array(z.string().min(1).max(240)).min(1).max(32),
  }).strict()).max(256),
  revisionAssessment: z.object({
    revisions: z.array(z.object({
      imageSlot: z.string().regex(/^image-[0-9]{2}$/),
      roomRevision: z.number().int().nonnegative(),
      usable: z.boolean(),
      findings: z.array(z.string().trim().min(1).max(500)).max(64),
    }).strict()).min(1).max(7),
    finalImageSlot: z.string().regex(/^image-[0-9]{2}$/),
  }).strict(),
  rationale: z.string().trim().min(1).max(2_000),
}).strict();

const blindedAuthorFailureTerminalJsonSchema = z.object({
  schemaVersion: z.literal("blinded-author-failure-review-result/v1"),
  role: z.literal("primary_reviewer"),
  status: z.literal("non_evaluable"),
  failureEvidenceRoot: digestSchema,
  primaryFailureClass: z.literal("FAIL_AUTHOR_NONCOMPLETION"),
  rationale: z.string().trim().min(1).max(2_000),
}).strict();

const pairwiseTerminalJsonSchema = z.object({
  schemaVersion: z.literal("blinded-canvas-pairwise-result/v1"),
  role: z.literal("pairwise_visual_judge"),
  preference: z.enum(["canvas-1", "canvas-2", "tie"]),
  evidenceRefs: z.array(z.enum(["canvas-1:image-01", "canvas-2:image-01", "frozen_rubric"])).min(3).max(3),
  rationale: z.string().trim().min(1).max(2_000),
}).strict();

const pairwiseUnavailableTerminalJsonSchema = z.object({
  schemaVersion: z.literal("blinded-canvas-pairwise-unavailable-result/v1"),
  role: z.literal("pairwise_visual_judge"),
  status: z.literal("non_evaluable"),
  preference: z.literal("unavailable"),
  pairRoot: digestSchema,
  primaryFailureClass: z.literal("FAIL_AUTHOR_NONCOMPLETION"),
  rationale: z.string().trim().min(1).max(2_000),
}).strict();

const authorTerminalJsonSchema = z.object({
  schemaVersion: z.literal("jazzboard-canvas-terminal-result/v1"),
  actor: z.literal("canvas_worker"),
  status: z.literal("completed"),
  artifactSummary: z.string().trim().min(1).max(2_000),
  finalAuthoritativeRead: z.object({
    roomRevision: z.number().int().positive(),
    objectCount: z.number().int().positive(),
  }).strict(),
  webMcpToolsUsed: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).min(2).max(256),
}).strict();

export const exp0001aCodexTerminalJsonSchema = z.union([
  authorTerminalJsonSchema,
  blindedReviewTerminalJsonSchema,
  blindedAuthorFailureTerminalJsonSchema,
  pairwiseTerminalJsonSchema,
  pairwiseUnavailableTerminalJsonSchema,
]).superRefine((result, context) => {
  if (canonicalJson(result as unknown as JsonValue).length > EXP0001A_CODEX_TERMINAL_RESULT_MAX_CHARS) {
    context.addIssue({
      code: "custom",
      message: "Terminal JSON exceeds the frozen lossless Codex read-thread capacity.",
    });
  }
});
export type Exp0001aCodexTerminalJson = z.infer<typeof exp0001aCodexTerminalJsonSchema>;

function renderableResponseSchema(schema: z.ZodType): JsonValue {
  const generated = z.toJSONSchema(schema) as Record<string, unknown>;
  const { $schema: _dialectUrl, ...portableSchema } = generated;
  void _dialectUrl;
  return cloneJson(portableSchema);
}

const RESPONSE_JSON_SCHEMAS = Object.freeze({
  author: renderableResponseSchema(authorTerminalJsonSchema),
  primary_reviewer: renderableResponseSchema(blindedReviewTerminalJsonSchema.extend({ role: z.literal("primary_reviewer") }).strict()),
  primary_reviewer_author_failure: renderableResponseSchema(blindedAuthorFailureTerminalJsonSchema),
  adjudicator: renderableResponseSchema(blindedReviewTerminalJsonSchema.extend({ role: z.literal("adjudicator") }).strict()),
  pairwise_visual_judge: renderableResponseSchema(pairwiseTerminalJsonSchema),
  pairwise_visual_unavailable: renderableResponseSchema(pairwiseUnavailableTerminalJsonSchema),
});

function renderResponseContract(
  role: Exp0001aCodexTransportRole,
  authorFailure = false,
  pairwiseUnavailable = false,
): string[] {
  const schema = role === "primary_reviewer" && authorFailure
    ? RESPONSE_JSON_SCHEMAS.primary_reviewer_author_failure
    : role === "pairwise_visual_judge" && pairwiseUnavailable
      ? RESPONSE_JSON_SCHEMAS.pairwise_visual_unavailable
    : RESPONSE_JSON_SCHEMAS[role];
  return [
    "Terminal response contract:",
    "- Return JSON only. Narrative outside the JSON is forbidden.",
    `- The JSON must strictly match this frozen JSON Schema: ${canonicalJson(schema)}`,
    "- Missing, extra, malformed, or unbound fields make the task non-accepted.",
  ];
}

export function renderExp0001aCodexTaskPrompt(envelopeInput: unknown): string {
  const envelope = exp0001aCodexTaskEnvelopeSchema.parse(envelopeInput);
  if (envelope.role === "author") {
    return [
      "Canvas task",
      "",
      "Public task brief:",
      envelope.publicTaskBrief,
      "",
      "Private Jazzboard invite:",
      envelope.privateRoomUrl,
      "",
      "Fixed operating contract:",
      ...envelope.instructions.map((instruction) => `- ${instruction}`),
      "",
      ...renderResponseContract(envelope.role),
    ].join("\n");
  }
  if (envelope.role === "primary_reviewer") {
    if (envelope.kind === "primary-reviewer-author-failure-task-envelope") {
      return [
        "Blinded author-failure review",
        "",
        "Public requirement:",
        envelope.publicRequirement,
        "",
        `Frozen rubric (${envelope.rubric.rubricId}, ${envelope.rubric.sha256}):`,
        canonicalJson(envelope.rubric.content),
        "",
        `Immutable author-failure packet (${envelope.authorFailurePacket.packetDigest}):`,
        canonicalJson(envelope.authorFailurePacket),
        `Failure evidence root: ${envelope.failureEvidenceRoot}`,
        `Read-only failure packet (GET/HEAD only, manifest ${envelope.artifactPacket.manifestDigest}):`,
        envelope.artifactPacket.manifestUrl,
        "",
        "Fixed operating contract:",
        ...envelope.instructions.map((instruction) => `- ${instruction}`),
        "",
        ...renderResponseContract(envelope.role, true),
      ].join("\n");
    }
    return [
      "Blinded evidence review",
      "",
      ...renderReviewEvidence(envelope.evidence),
      "",
      `Read-only evidence packet (GET/HEAD only, manifest ${envelope.artifactPacket.manifestDigest}):`,
      envelope.artifactPacket.manifestUrl,
      "",
      "Fixed operating contract:",
      ...envelope.instructions.map((instruction) => `- ${instruction}`),
      "",
      ...renderResponseContract(envelope.role),
    ].join("\n");
  }
  if (envelope.role === "adjudicator") {
    // The coordinator retains `primaryReviews`, `primaryReviewRoot`, and the
    // derived adjudication binding in the private transport plan. None of
    // those primary decisions or their digests cross the create_thread prompt
    // boundary: the fresh adjudicator sees the same blinded evidence surface
    // as a primary reviewer and produces an independent judgment.
    return [
      "Independent blinded evidence review",
      "",
      ...renderReviewEvidence(envelope.evidence),
      "",
      `Read-only evidence packet (GET/HEAD only, manifest ${envelope.artifactPacket.manifestDigest}):`,
      envelope.artifactPacket.manifestUrl,
      "",
      "Fixed operating contract:",
      ...envelope.instructions.map((instruction) => `- ${instruction}`),
      "",
      ...renderResponseContract(envelope.role),
    ].join("\n");
  }
  if (envelope.kind === "pairwise-visual-unavailable-task-envelope") {
    return [
      "Blinded unavailable visual comparison",
      "",
      "Public requirement:",
      envelope.publicRequirement,
      "",
      `Frozen rubric (${envelope.rubric.rubricId}, ${envelope.rubric.sha256}):`,
      canonicalJson(envelope.rubric.content),
      "",
      `Immutable incomplete-pair packet (${envelope.unavailablePacket.packetDigest}):`,
      canonicalJson(envelope.unavailablePacket),
      `Pair evidence root: ${envelope.pairRoot}`,
      `Read-only failure packet (GET/HEAD only, manifest ${envelope.artifactPacket.manifestDigest}):`,
      envelope.artifactPacket.manifestUrl,
      "",
      "Fixed operating contract:",
      ...envelope.instructions.map((instruction) => `- ${instruction}`),
      "",
      ...renderResponseContract(envelope.role, false, true),
    ].join("\n");
  }
  return [
    "Blinded visual comparison",
    "",
    "Public requirement:",
    envelope.publicRequirement,
    "",
    `Frozen rubric (${envelope.rubric.rubricId}, ${envelope.rubric.sha256}):`,
    canonicalJson(envelope.rubric.content),
    "",
    ...envelope.sides.flatMap((side) => [
      `${side.slot} (${side.sideRoot}):`,
      ...renderImageEvidence([side.finalImage]),
      "",
    ]),
    `Pair evidence root: ${envelope.pairRoot}`,
    `Read-only evidence packet (GET/HEAD only, manifest ${envelope.artifactPacket.manifestDigest}):`,
    envelope.artifactPacket.manifestUrl,
    "",
    "Fixed operating contract:",
    ...envelope.instructions.map((instruction) => `- ${instruction}`),
    "",
    ...renderResponseContract(envelope.role),
  ].join("\n");
}

function allowedReviewEvidenceRefs(evidence: z.infer<typeof reviewEvidenceSchema>): Set<string> {
  return new Set([
    "semantic_state",
    ...evidence.images.map((image) => image.slot),
    ...evidence.rubric.criterionIds.map((criterionId) => `rubric:${criterionId}`),
  ]);
}

export function validateExp0001aCodexTerminalJson(
  planInput: Exp0001aCodexTaskTransportPlan,
  rawJson: unknown,
): Exp0001aCodexTerminalJson {
  const plan = exp0001aCodexTaskTransportPlanSchema.parse(planInput);
  if (plan.role === "author") {
    return freezeDeep(exp0001aCodexTerminalJsonSchema.parse(authorTerminalJsonSchema.parse(rawJson)));
  }
  if (plan.role === "pairwise_visual_judge") {
    if (plan.envelope.role !== "pairwise_visual_judge") {
      throw new Error("PAIRWISE_TERMINAL_ENVELOPE_ROLE_MISMATCH");
    }
    if (plan.envelope.kind === "pairwise-visual-unavailable-task-envelope") {
      const result = pairwiseUnavailableTerminalJsonSchema.parse(rawJson);
      if (result.pairRoot !== plan.envelope.pairRoot) {
        throw new Error("PAIRWISE_UNAVAILABLE_TERMINAL_SUBJECT_ROOT_MISMATCH");
      }
      return freezeDeep(exp0001aCodexTerminalJsonSchema.parse(result));
    }
    const result = pairwiseTerminalJsonSchema.parse(rawJson);
    const expectedRefs = ["canvas-1:image-01", "canvas-2:image-01", "frozen_rubric"];
    if (!exactStringSet(result.evidenceRefs, expectedRefs)) throw new Error("PAIRWISE_TERMINAL_EVIDENCE_REFS_INCOMPLETE");
    return freezeDeep(exp0001aCodexTerminalJsonSchema.parse(result));
  }
  if (plan.role === "primary_reviewer" && plan.envelope.role === "primary_reviewer"
      && plan.envelope.kind === "primary-reviewer-author-failure-task-envelope") {
    const result = blindedAuthorFailureTerminalJsonSchema.parse(rawJson);
    if (result.failureEvidenceRoot !== plan.envelope.failureEvidenceRoot) {
      throw new Error("AUTHOR_FAILURE_REVIEW_TERMINAL_SUBJECT_ROOT_MISMATCH");
    }
    return freezeDeep(exp0001aCodexTerminalJsonSchema.parse(result));
  }
  const result = blindedReviewTerminalJsonSchema.parse(rawJson);
  if (result.role !== plan.role
      || (plan.envelope.role === "primary_reviewer" && plan.envelope.kind !== "primary-reviewer-task-envelope")
      || (plan.envelope.role !== "primary_reviewer" && plan.envelope.role !== "adjudicator")) {
    throw new Error("BLINDED_REVIEW_TERMINAL_ROLE_MISMATCH");
  }
  const evidence = plan.envelope.evidence;
  const expectedImageSlots = evidence.images.map((image) => image.slot);
  if (!exactStringSet(result.evidenceCoverage.imageSlots, expectedImageSlots)) {
    throw new Error("BLINDED_REVIEW_IMAGE_COVERAGE_INCOMPLETE");
  }
  const criterionIds = evidence.rubric.criterionIds;
  if (result.criteria.length !== criterionIds.length
      || new Set(result.criteria.map((criterion) => criterion.criterionId)).size !== criterionIds.length
      || criterionIds.some((criterionId) => !result.criteria.some((criterion) => criterion.criterionId === criterionId))) {
    throw new Error("BLINDED_REVIEW_CRITERION_COVERAGE_INCOMPLETE");
  }
  const allowedRefs = allowedReviewEvidenceRefs(evidence);
  for (const criterion of result.criteria) {
    if (!criterion.evidenceRefs.includes(`rubric:${criterion.criterionId}`)
        || !criterion.evidenceRefs.some((reference) => reference === "semantic_state" || /^image-[0-9]{2}$/.test(reference))
        || criterion.evidenceRefs.some((reference) => !allowedRefs.has(reference))) {
      throw new Error("BLINDED_REVIEW_CRITERION_EVIDENCE_INVALID");
    }
  }
  if (result.mechanismTags.some((entry) => !evidence.rubric.allowedMechanismTags.includes(entry.tag)
      || entry.evidenceRefs.some((reference) => !allowedRefs.has(reference)))) {
    throw new Error("BLINDED_REVIEW_MECHANISM_TAG_INVALID");
  }
  const expectedImages = evidence.images.map((image) => ({ imageSlot: image.slot, roomRevision: image.roomRevision }));
  if (result.revisionAssessment.revisions.length !== expectedImages.length
      || expectedImages.some((expected) => !result.revisionAssessment.revisions.some((actual) => (
        actual.imageSlot === expected.imageSlot && actual.roomRevision === expected.roomRevision
      )))
      || result.revisionAssessment.finalImageSlot !== evidence.images.at(-1)!.slot) {
    throw new Error("BLINDED_REVIEW_REVISION_ASSESSMENT_INVALID");
  }
  const accepted = result.criteria.every((criterion) => criterion.decision === "pass");
  if (result.accepted !== accepted || (result.primaryFailureClass === "SUCCESS") !== accepted) {
    throw new Error("BLINDED_REVIEW_ACCEPTANCE_RECONCILIATION_INVALID");
  }
  return freezeDeep(exp0001aCodexTerminalJsonSchema.parse(result));
}

const privateBindingSchema = z.object({
  classification: z.literal("restricted-private-experiment-evidence"),
  assignmentId: idSchema,
  attemptId: idSchema,
  subjectArtifactIds: z.array(idSchema).max(2),
  bindingDigest: digestSchema,
}).strict();

const createThreadCommandContentSchema = z.object({
  schemaVersion: z.literal(1),
  toolName: z.literal("mcp__codex_app__create_thread"),
  transportId: opaqueIdSchema,
  issuedAt: timestampSchema,
  arguments: z.object({
    prompt: z.string().min(20).max(40 * 1024 * 1024),
    title: z.string().min(1).max(120),
    target: z.object({
      type: z.literal("projectless"),
      directoryName: z.string().regex(/^(?:canvas-task|evidence-review|visual-review)-[a-f0-9]{16}$/),
    }).strict(),
    model: z.literal(EXP0001A_CODEX_TASK_MODEL),
    thinking: z.enum(["high", "max"]),
  }).strict(),
  isolation: z.object({
    sourceThreadId: z.null(),
    forkedFromThreadId: z.null(),
    projectId: z.null(),
    sharedHistory: z.literal(false),
    repositoryAccess: z.literal(false),
    privateApiAccess: z.literal(false),
    preparedCoordinates: z.literal(false),
    evaluatorContext: z.literal(false),
  }).strict(),
}).strict();

export const exp0001aCodexCreateThreadCommandSchema = createThreadCommandContentSchema.extend({
  commandDigest: digestSchema,
}).strict().superRefine((command, context) => {
  const { commandDigest: _commandDigest, ...content } = command;
  void _commandDigest;
  if (hashCanonicalJson(content) !== command.commandDigest) {
    context.addIssue({ code: "custom", path: ["commandDigest"], message: "create_thread command digest is invalid." });
  }
});
export type Exp0001aCodexCreateThreadCommand = z.infer<typeof exp0001aCodexCreateThreadCommandSchema>;

const transportPlanContentSchema = z.object({
  schemaVersion: z.literal(EXP0001A_CODEX_TASK_TRANSPORT_VERSION),
  kind: z.literal("codex-isolated-task-plan"),
  protocolId: z.literal("EXP-0001A"),
  transportId: opaqueIdSchema,
  role: exp0001aCodexTransportRoleSchema,
  preparedAt: timestampSchema,
  model: z.literal(EXP0001A_CODEX_TASK_MODEL),
  reasoningEffort: z.enum(["high", "max"]),
  settingsFrozen: z.literal(true),
  spikePrerequisite: z.object({
    gateDigest: digestSchema,
    evidenceDigest: digestSchema,
    gateEvaluatedAt: timestampSchema,
    verified: z.literal(true),
  }).strict(),
  authPreflight: z.object({
    checkedAt: timestampSchema,
    receiptDigest: digestSchema,
    authenticationMethod: z.literal("chatgpt"),
    decision: z.literal("allow"),
    maxAgeMs: z.literal(EXP0001A_CODEX_AUTH_MAX_AGE_MS),
  }).strict(),
  envelope: exp0001aCodexTaskEnvelopeSchema,
  envelopeDigest: digestSchema,
  promptDigest: digestSchema,
  privateBinding: privateBindingSchema,
  artifactPacketReadyReceipt: exp0001aCodexArtifactPacketReadyReceiptSchema.nullable(),
  createThreadCommand: exp0001aCodexCreateThreadCommandSchema,
}).strict().superRefine((plan, context) => {
  if (plan.role !== plan.envelope.role) {
    context.addIssue({ code: "custom", path: ["envelope", "role"], message: "Envelope role does not match task role." });
  }
  const expectedSettings = EXP0001A_CODEX_ROLE_SETTINGS[plan.role];
  if (plan.model !== expectedSettings.model || plan.reasoningEffort !== expectedSettings.reasoningEffort
      || plan.createThreadCommand.arguments.model !== expectedSettings.model
      || plan.createThreadCommand.arguments.thinking !== expectedSettings.reasoningEffort) {
    context.addIssue({ code: "custom", path: ["reasoningEffort"], message: "Task settings do not match the frozen role-specific model/reasoning policy." });
  }
  const authAgeMs = Date.parse(plan.preparedAt) - Date.parse(plan.authPreflight.checkedAt);
  if (authAgeMs < 0 || authAgeMs > plan.authPreflight.maxAgeMs) {
    context.addIssue({ code: "custom", path: ["authPreflight", "checkedAt"], message: "ChatGPT auth preflight is stale or postdates plan preparation." });
  }
  if (hashCanonicalJson(plan.envelope) !== plan.envelopeDigest) {
    context.addIssue({ code: "custom", path: ["envelopeDigest"], message: "Envelope digest is invalid." });
  }
  const prompt = renderExp0001aCodexTaskPrompt(plan.envelope);
  if (hashCanonicalJson(prompt) !== plan.promptDigest || prompt !== plan.createThreadCommand.arguments.prompt) {
    context.addIssue({ code: "custom", path: ["promptDigest"], message: "Task prompt is not bound to the envelope and create_thread command." });
  }
  const expectedBinding = hashCanonicalJson({
    assignmentId: plan.privateBinding.assignmentId,
    attemptId: plan.privateBinding.attemptId,
    subjectArtifactIds: plan.privateBinding.subjectArtifactIds,
    envelopeDigest: plan.envelopeDigest,
  });
  if (expectedBinding !== plan.privateBinding.bindingDigest) {
    context.addIssue({ code: "custom", path: ["privateBinding", "bindingDigest"], message: "Private assignment binding is invalid." });
  }
  const expectedSubjects = plan.role === "author" ? 0 : plan.role === "pairwise_visual_judge" ? 2 : 1;
  if (plan.privateBinding.subjectArtifactIds.length !== expectedSubjects) {
    context.addIssue({ code: "custom", path: ["privateBinding", "subjectArtifactIds"], message: "Role has an invalid private subject count." });
  }
  const promptForbiddenValues = [
    plan.privateBinding.assignmentId,
    plan.privateBinding.attemptId,
    ...plan.privateBinding.subjectArtifactIds,
  ];
  if (promptForbiddenValues.some((value) => prompt.includes(value))) {
    context.addIssue({ code: "custom", path: ["createThreadCommand", "arguments", "prompt"], message: "Task prompt leaks a restricted coordinator binding." });
  }
  if (plan.envelope.role === "author" && prompt.includes(plan.envelope.roomId)) {
    context.addIssue({ code: "custom", path: ["createThreadCommand", "arguments", "prompt"], message: "Author prompt must carry only the invite, not the authoritative room ID." });
  }
  if (plan.envelope.role === "author") {
    if (plan.privateBinding.assignmentId !== plan.envelope.provisioningBinding.assignmentId
        || plan.privateBinding.attemptId !== plan.envelope.provisioningBinding.attemptId) {
      context.addIssue({ code: "custom", path: ["privateBinding"], message: "Author task does not bind the exact provisioned assignment and attempt." });
    }
  }
  const packet = packetForEnvelope(plan.envelope);
  const packetReceipt = plan.artifactPacketReadyReceipt;
  if (packet === null && packetReceipt !== null) {
    context.addIssue({ code: "custom", path: ["artifactPacketReadyReceipt"], message: "Author tasks cannot carry reviewer evidence packets." });
  } else if (packet !== null) {
    if (packetReceipt === null
        || packetReceipt.envelopeDigest !== plan.envelopeDigest
        || packetReceipt.origin !== packet.origin
        || packetReceipt.manifestUrl !== packet.manifestUrl
        || packetReceipt.manifestDigest !== packet.manifestDigest
        || packetReceipt.servedFileCount !== packet.files.length
        || packetReceipt.servedFileRoot !== hashCanonicalJson(packet.files)) {
      context.addIssue({ code: "custom", path: ["artifactPacketReadyReceipt"], message: "Reviewer task lacks an exact verified read-only evidence-packet receipt." });
    } else if (Date.parse(packetReceipt.observedAt) > Date.parse(plan.preparedAt)) {
      context.addIssue({ code: "custom", path: ["artifactPacketReadyReceipt", "observedAt"], message: "Evidence packet must be ready before task preparation." });
    }
  }
});

export const exp0001aCodexTaskTransportPlanSchema = transportPlanContentSchema.extend({ planDigest: digestSchema }).strict()
  .superRefine((plan, context) => {
    const { planDigest: _planDigest, ...content } = plan;
    void _planDigest;
    if (hashCanonicalJson(content) !== plan.planDigest) {
      context.addIssue({ code: "custom", path: ["planDigest"], message: "Transport plan digest is invalid." });
    }
  });
export type Exp0001aCodexTaskTransportPlan = z.infer<typeof exp0001aCodexTaskTransportPlanSchema>;

function sealCreateThreadCommand(content: z.infer<typeof createThreadCommandContentSchema>): Exp0001aCodexCreateThreadCommand {
  return exp0001aCodexCreateThreadCommandSchema.parse({ ...content, commandDigest: hashCanonicalJson(content) });
}

export function prepareExp0001aCodexTaskTransport(input: {
  transportId: string;
  preparedAt: string;
  assignmentId: string;
  attemptId: string;
  subjectArtifactIds: readonly string[];
  envelope: Exp0001aCodexTaskEnvelope;
  authorProvisioning?: Readonly<{
    handoff: unknown;
    roomProvisioningReceipt: unknown;
  }>;
  artifactPacketReadyReceipt?: Exp0001aCodexArtifactPacketReadyReceipt | null;
  authPreflightReceipt: unknown;
  spikeGate: unknown;
  spikeEvidence: unknown;
  freshness?: CodexWebMcpSpikeFreshnessContext;
}): Exp0001aCodexTaskTransportPlan {
  const gate = verifyExp0001aCodexSpikeRecoveryGate(input.spikeGate);
  if (hashCanonicalJson(input.spikeEvidence as JsonValue) !== gate.evidenceDigest) {
    throw new Error("EXP0001A_SPIKE_EVIDENCE_DIFFERS_FROM_SIGNED_RECOVERY_GATE");
  }
  const authReceipt = assertCodexNativeExperimentAuthorized(
    verifyCodexAuthPreflightReceipt(input.authPreflightReceipt),
  );
  const suppliedEnvelope = exp0001aCodexTaskEnvelopeSchema.parse(input.envelope);
  let parsedEnvelope: Exp0001aCodexTaskEnvelope;
  if (suppliedEnvelope.role === "author") {
    if (input.authorProvisioning === undefined) {
      throw new Error("AUTHOR_TRANSPORT_REQUIRES_CANONICAL_PROVISIONING_EVIDENCE");
    }
    const independentlyVerifiedEnvelope = createExp0001aAuthorTaskEnvelopeFromProvisioningHandoff(
      input.authorProvisioning.handoff,
      input.authorProvisioning.roomProvisioningReceipt,
    );
    if (hashCanonicalJson(independentlyVerifiedEnvelope) !== hashCanonicalJson(suppliedEnvelope)) {
      throw new Error("AUTHOR_ENVELOPE_DIFFERS_FROM_CANONICAL_PROVISIONING_EVIDENCE");
    }
    parsedEnvelope = independentlyVerifiedEnvelope;
  } else {
    if (input.authorProvisioning !== undefined) {
      throw new Error("REVIEW_TRANSPORT_CANNOT_RECEIVE_AUTHOR_PROVISIONING_EVIDENCE");
    }
    parsedEnvelope = suppliedEnvelope;
  }
  const roleSettings = EXP0001A_CODEX_ROLE_SETTINGS[parsedEnvelope.role];
  const artifactPacketReadyReceipt = input.artifactPacketReadyReceipt == null
    ? null
    : exp0001aCodexArtifactPacketReadyReceiptSchema.parse(input.artifactPacketReadyReceipt);
  const prompt = renderExp0001aCodexTaskPrompt(parsedEnvelope);
  const envelopeDigest = hashCanonicalJson(parsedEnvelope);
  const privateBinding = privateBindingSchema.parse({
    classification: "restricted-private-experiment-evidence",
    assignmentId: input.assignmentId,
    attemptId: input.attemptId,
    subjectArtifactIds: [...input.subjectArtifactIds],
    bindingDigest: hashCanonicalJson({
      assignmentId: input.assignmentId,
      attemptId: input.attemptId,
      subjectArtifactIds: input.subjectArtifactIds,
      envelopeDigest,
    }),
  });
  const directorySuffix = hashCanonicalJson({ transportId: input.transportId }).slice(-16);
  const visibleTaskClass = parsedEnvelope.role === "author"
    ? { title: "Canvas task", directory: "canvas-task" }
    : parsedEnvelope.role === "pairwise_visual_judge"
      ? { title: "Visual comparison", directory: "visual-review" }
      : { title: "Evidence review", directory: "evidence-review" };
  const createThreadCommand = sealCreateThreadCommand({
    schemaVersion: 1,
    toolName: "mcp__codex_app__create_thread",
    transportId: input.transportId,
    issuedAt: input.preparedAt,
    arguments: {
      prompt,
      title: `${visibleTaskClass.title} [tx-${directorySuffix}]`,
      target: { type: "projectless", directoryName: `${visibleTaskClass.directory}-${directorySuffix}` },
      model: roleSettings.model,
      thinking: roleSettings.reasoningEffort,
    },
    isolation: {
      sourceThreadId: null,
      forkedFromThreadId: null,
      projectId: null,
      sharedHistory: false,
      repositoryAccess: false,
      privateApiAccess: false,
      preparedCoordinates: false,
      evaluatorContext: false,
    },
  });
  const content = transportPlanContentSchema.parse({
    schemaVersion: EXP0001A_CODEX_TASK_TRANSPORT_VERSION,
    kind: "codex-isolated-task-plan",
    protocolId: "EXP-0001A",
    transportId: input.transportId,
    role: parsedEnvelope.role,
    preparedAt: input.preparedAt,
    model: roleSettings.model,
    reasoningEffort: roleSettings.reasoningEffort,
    settingsFrozen: true,
    spikePrerequisite: {
      gateDigest: gate.gateDigest,
      evidenceDigest: gate.evidenceDigest,
      gateEvaluatedAt: gate.evaluatedAt,
      verified: true,
    },
    authPreflight: {
      checkedAt: authReceipt.checkedAt,
      receiptDigest: authReceipt.receiptSha256,
      authenticationMethod: "chatgpt",
      decision: "allow",
      maxAgeMs: EXP0001A_CODEX_AUTH_MAX_AGE_MS,
    },
    envelope: parsedEnvelope,
    envelopeDigest,
    promptDigest: hashCanonicalJson(prompt),
    privateBinding,
    artifactPacketReadyReceipt,
    createThreadCommand,
  });
  return freezeDeep(exp0001aCodexTaskTransportPlanSchema.parse({ ...content, planDigest: hashCanonicalJson(content) }));
}

/** Production task preparation obtains its ChatGPT-only authority directly
 * from the committed `codex login status` preflight. Callers cannot inject a
 * retained or self-authored authentication classification into this boundary.
 * The lower-level constructor remains available to isolated unit fixtures but
 * is intentionally not re-exported by the active runtime composition. */
export async function prepareExp0001aCodexTaskTransportWithFreshAuth(
  input: Omit<Parameters<typeof prepareExp0001aCodexTaskTransport>[0], "authPreflightReceipt">,
): Promise<Exp0001aCodexTaskTransportPlan> {
  const authPreflightReceipt = assertCodexNativeExperimentAuthorized(
    verifyCodexAuthPreflightReceipt(await runCodexAuthPreflight()),
  );
  return prepareExp0001aCodexTaskTransport({ ...input, authPreflightReceipt });
}

type DerivedCreateThreadResult = Readonly<{
  outcome: "ready" | "usage_limit" | "uncertain_after_release";
  threadId: string | null;
  hostId: string | null;
  failureCode: string | null;
}>;

function deriveCreateThreadResult(retained: RetainedCodexAppCallResult): DerivedCreateThreadResult {
  const payload = exactJsonObject(retained.payload);
  const threadId = payload === null ? null : exactString(payload.threadId);
  const hostId = payload === null ? null : exactString(payload.hostId);
  const clientThreadId = payload === null ? null : exactString(payload.clientThreadId);
  if (!retained.isError && threadId !== null && hostId !== null && clientThreadId === null) {
    return { outcome: "ready", threadId, hostId, failureCode: null };
  }
  const error = payload === null ? null : exactJsonObject(payload.error);
  const usageLimitCode = error === null ? null : exactString(error.code);
  const authoritativeUsageLimit = retained.isError
    && threadId === null
    && clientThreadId === null
    && payload?.taskCreated === false
    && usageLimitCode !== null
    && ["usage_limit", "subscription_usage_limit", "subscription_limit", "codex_usage_limit"]
      .includes(usageLimitCode.toLowerCase());
  if (authoritativeUsageLimit) {
    return { outcome: "usage_limit", threadId: null, hostId: null, failureCode: "codex_usage_limit" };
  }
  return {
    outcome: "uncertain_after_release",
    threadId: null,
    hostId: null,
    failureCode: usageLimitCode !== null
      && ["usage_limit", "subscription_usage_limit", "subscription_limit", "codex_usage_limit"]
        .includes(usageLimitCode.toLowerCase())
      ? "codex_usage_limit_creation_ambiguous"
      : clientThreadId === null ? "create_result_not_authoritative" : "create_setup_pending",
  };
}

const createThreadReceiptContentSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("codex-create-thread-receipt"),
  transportId: opaqueIdSchema,
  commandDigest: digestSchema,
  observedAt: timestampSchema,
  releaseInvocationReceiptDigest: digestSchema,
  outcome: z.enum(["ready", "usage_limit", "uncertain_after_release"]),
  codexTaskId: idSchema.nullable(),
  threadId: idSchema.nullable(),
  hostId: idSchema.nullable(),
  rawResult: jsonValueSchema,
  rawResultDigest: digestSchema,
  payloadDigest: digestSchema.nullable(),
  failureCode: idSchema.nullable(),
}).strict().superRefine((receipt, context) => {
  let retained: RetainedCodexAppCallResult | null = null;
  try {
    retained = retainExactCodexAppCallResult(receipt.rawResult);
  } catch (error) {
    context.addIssue({ code: "custom", path: ["rawResult"], message: error instanceof Error ? error.message : "Raw create result is invalid." });
  }
  if (retained !== null) {
    const derived = deriveCreateThreadResult(retained);
    if (receipt.rawResultDigest !== retained.rawResultDigest || receipt.payloadDigest !== retained.payloadDigest
        || receipt.outcome !== derived.outcome || receipt.threadId !== derived.threadId
        || receipt.hostId !== derived.hostId || receipt.failureCode !== derived.failureCode) {
      context.addIssue({ code: "custom", path: ["rawResultDigest"], message: "Create receipt fields are not derived from the exact retained Codex-app result." });
    }
  }
  if (receipt.outcome === "ready") {
    if (receipt.codexTaskId === null || receipt.threadId === null || receipt.hostId === null
      || receipt.codexTaskId !== receipt.threadId || receipt.failureCode !== null) {
      context.addIssue({ code: "custom", message: "A ready projectless task requires matching Codex task/thread IDs, a host, and no failure." });
    }
  } else if (receipt.codexTaskId !== null || receipt.threadId !== null || receipt.hostId !== null || receipt.failureCode === null) {
    context.addIssue({ code: "custom", message: "A non-ready create cannot claim a Codex task identity." });
  }
});

export const exp0001aCodexCreateThreadReceiptSchema = createThreadReceiptContentSchema.extend({ receiptDigest: digestSchema }).strict()
  .superRefine((receipt, context) => {
    const { receiptDigest: _receiptDigest, ...content } = receipt;
    void _receiptDigest;
    if (hashCanonicalJson(content) !== receipt.receiptDigest) {
      context.addIssue({ code: "custom", path: ["receiptDigest"], message: "create_thread receipt digest is invalid." });
    }
  });
export type Exp0001aCodexCreateThreadReceipt = z.infer<typeof exp0001aCodexCreateThreadReceiptSchema>;

const releaseInvocationReceiptContentSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("codex-create-thread-release-invoked-receipt"),
  transportId: opaqueIdSchema,
  planDigest: digestSchema,
  commandDigest: digestSchema,
  invokedAt: timestampSchema,
  authCheckedAt: timestampSchema,
  mustInvokeBy: timestampSchema,
  authPreflightReceiptDigest: digestSchema,
  authAgeMsAtRelease: z.number().int().nonnegative().max(EXP0001A_CODEX_AUTH_MAX_AGE_MS),
  authenticationMethod: z.literal("chatgpt"),
  uniqueTaskTitle: z.string().min(1).max(120),
  journalEvidenceDigest: digestSchema,
  promptMayHaveBeenReleased: z.literal(true),
}).strict().superRefine((receipt, context) => {
  if (Date.parse(receipt.mustInvokeBy) !== Date.parse(receipt.authCheckedAt) + EXP0001A_CODEX_AUTH_MAX_AGE_MS
      || Date.parse(receipt.invokedAt) < Date.parse(receipt.authCheckedAt)
      || Date.parse(receipt.invokedAt) > Date.parse(receipt.mustInvokeBy)) {
    context.addIssue({
      code: "custom",
      path: ["mustInvokeBy"],
      message: "Create release must occur inside the exact fresh-auth validity interval.",
    });
  }
});

export const exp0001aCodexReleaseInvocationReceiptSchema = releaseInvocationReceiptContentSchema.extend({
  receiptDigest: digestSchema,
}).strict().superRefine((receipt, context) => {
  const { receiptDigest: _receiptDigest, ...content } = receipt;
  void _receiptDigest;
  if (hashCanonicalJson(content) !== receipt.receiptDigest) {
    context.addIssue({ code: "custom", path: ["receiptDigest"], message: "create_thread release invocation receipt digest is invalid." });
  }
});
export type Exp0001aCodexReleaseInvocationReceipt = z.infer<typeof exp0001aCodexReleaseInvocationReceiptSchema>;

export async function recordExp0001aCreateThreadReleaseInvoked(input: {
  plan: Exp0001aCodexTaskTransportPlan;
  journalEvidenceDigest: string;
}): Promise<Exp0001aCodexReleaseInvocationReceipt> {
  const plan = exp0001aCodexTaskTransportPlanSchema.parse(input.plan);
  const authReceipt = assertCodexNativeExperimentAuthorized(
    verifyCodexAuthPreflightReceipt(await runCodexAuthPreflight()),
  );
  // `checkedAt` is stamped by the preflight only after its subprocess has
  // completed. The release clock is sampled afterward so an auth observation
  // can never be backdated to subprocess start.
  const invokedAt = new Date().toISOString();
  if (Date.parse(invokedAt) < Date.parse(plan.preparedAt)) throw new Error("CODEX_RELEASE_INVOCATION_PRECEDES_PLAN");
  if (plan.envelope.role === "author"
      && Date.parse(invokedAt) < Date.parse(plan.envelope.provisioningBinding.authorReleaseAt)) {
    throw new Error("COORDINATOR_PRESENCE_NOT_EXPIRED_AT_ACTUAL_CODEX_RELEASE");
  }
  const authAgeMsAtRelease = Date.parse(invokedAt) - Date.parse(authReceipt.checkedAt);
  if (authAgeMsAtRelease < 0 || authAgeMsAtRelease > EXP0001A_CODEX_AUTH_MAX_AGE_MS) {
    throw new Error("CODEX_CHATGPT_AUTH_PREFLIGHT_STALE_AT_RELEASE");
  }
  const content = releaseInvocationReceiptContentSchema.parse({
    schemaVersion: 1,
    kind: "codex-create-thread-release-invoked-receipt",
    transportId: plan.transportId,
    planDigest: plan.planDigest,
    commandDigest: plan.createThreadCommand.commandDigest,
    invokedAt,
    authCheckedAt: authReceipt.checkedAt,
    mustInvokeBy: new Date(Date.parse(authReceipt.checkedAt) + EXP0001A_CODEX_AUTH_MAX_AGE_MS).toISOString(),
    authPreflightReceiptDigest: authReceipt.receiptSha256,
    authAgeMsAtRelease,
    authenticationMethod: "chatgpt",
    uniqueTaskTitle: plan.createThreadCommand.arguments.title,
    journalEvidenceDigest: input.journalEvidenceDigest,
    promptMayHaveBeenReleased: true,
  });
  return freezeDeep(exp0001aCodexReleaseInvocationReceiptSchema.parse({
    ...content,
    receiptDigest: hashCanonicalJson(content),
  }));
}

const waitThreadsCommandContentSchema = z.object({
  schemaVersion: z.literal(1),
  toolName: z.literal("mcp__codex_app__wait_threads"),
  transportId: opaqueIdSchema,
  issuedAt: timestampSchema,
  arguments: z.object({
    targets: z.tuple([z.object({
      threadId: idSchema,
      hostId: idSchema,
      afterCursor: cursorSchema.optional(),
    }).strict()]),
    timeoutMs: z.number().int().min(1_000).max(120_000),
  }).strict(),
}).strict();

export const exp0001aCodexWaitThreadsCommandSchema = waitThreadsCommandContentSchema.extend({ commandDigest: digestSchema }).strict()
  .superRefine((command, context) => {
    const { commandDigest: _commandDigest, ...content } = command;
    void _commandDigest;
    if (hashCanonicalJson(content) !== command.commandDigest) {
      context.addIssue({ code: "custom", path: ["commandDigest"], message: "wait_threads command digest is invalid." });
    }
  });
export type Exp0001aCodexWaitThreadsCommand = z.infer<typeof exp0001aCodexWaitThreadsCommandSchema>;

type DerivedWaitThreadsResult = Readonly<{
  outcome: "timeout" | "completed" | "needs_attention" | "usage_limit" | "failed";
  cursor: string;
  terminalResultDigest: string | null;
  terminalCompletedAt: string | null;
  failureCode: string | null;
}>;

function deriveWaitThreadsResult(
  retained: RetainedCodexAppCallResult,
  target: Readonly<{ threadId: string; hostId: string }>,
): DerivedWaitThreadsResult {
  if (retained.isError) throw new Error("CODEX_WAIT_THREADS_RESULT_IS_ERROR");
  const payload = exactJsonObject(retained.payload);
  if (payload === null || typeof payload.timedOut !== "boolean" || !Array.isArray(payload.polls)
      || payload.polls.length !== 1) {
    throw new Error("CODEX_WAIT_THREADS_PAYLOAD_SHAPE_INVALID");
  }
  const poll = exactJsonObject(payload.polls[0]!);
  const thread = poll === null ? null : exactJsonObject(poll.thread);
  const latestTurn = poll === null ? null : exactJsonObject(poll.latestTurn);
  const cursor = poll === null ? null : exactString(poll.cursor);
  if (poll === null || thread === null || cursor === null
      || exactString(thread.id) !== target.threadId || exactString(thread.hostId) !== target.hostId) {
    throw new Error("CODEX_WAIT_THREADS_POLL_NOT_BOUND_TO_TARGET");
  }
  if (payload.timedOut) {
    if (payload.wake !== null) throw new Error("CODEX_WAIT_THREADS_TIMEOUT_HAS_WAKE");
    return { outcome: "timeout", cursor, terminalResultDigest: null, terminalCompletedAt: null, failureCode: null };
  }
  const wake = exactJsonObject(payload.wake);
  if (wake === null || exactString(wake.threadId) !== target.threadId || exactString(wake.hostId) !== target.hostId
      || latestTurn === null) {
    throw new Error("CODEX_WAIT_THREADS_WAKE_NOT_BOUND_TO_TARGET");
  }
  const latestTurnStatus = exactString(latestTurn.status);
  const completedAtSeconds = typeof latestTurn.completedAt === "number" && Number.isFinite(latestTurn.completedAt)
    ? latestTurn.completedAt
    : null;
  const terminalCompletedAt = completedAtSeconds === null ? null : new Date(completedAtSeconds * 1_000).toISOString();
  if (wake.reason === "turnCompleted" && latestTurnStatus === "completed" && latestTurn.error === null
      && terminalCompletedAt !== null) {
    const message = exactJsonObject(poll.latestAssistantMessage);
    const terminalText = message === null ? null : exactString(message.text);
    if (message === null || message.phase !== "final_answer" || terminalText === null) {
      throw new Error("CODEX_WAIT_THREADS_COMPLETION_FINAL_TEXT_MISSING");
    }
    return {
      outcome: "completed",
      cursor,
      terminalResultDigest: sha256Digest(Buffer.from(terminalText, "utf8")),
      terminalCompletedAt,
      failureCode: null,
    };
  }
  if (wake.reason === "needsAttention" || latestTurnStatus === "needsAttention") {
    return { outcome: "needs_attention", cursor, terminalResultDigest: null, terminalCompletedAt, failureCode: "codex_needs_attention" };
  }
  if (latestTurnStatus === "failed") {
    const errorText = canonicalJson(latestTurn.error).toLowerCase();
    const usageLimit = /(?:subscription[_ -]?usage|usage[_ -]?limit)/.test(errorText);
    return {
      outcome: usageLimit ? "usage_limit" : "failed",
      cursor,
      terminalResultDigest: null,
      terminalCompletedAt,
      failureCode: usageLimit ? "codex_usage_limit" : "codex_turn_failed",
    };
  }
  throw new Error("CODEX_WAIT_THREADS_TERMINAL_STATUS_UNRECOGNIZED");
}

const waitThreadsReceiptContentSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("codex-wait-threads-receipt"),
  transportId: opaqueIdSchema,
  commandDigest: digestSchema,
  observedAt: timestampSchema,
  codexTaskId: idSchema,
  hostId: idSchema,
  outcome: z.enum(["timeout", "completed", "needs_attention", "usage_limit", "failed"]),
  cursor: cursorSchema.nullable(),
  terminalResultDigest: digestSchema.nullable(),
  terminalCompletedAt: timestampSchema.nullable(),
  rawResult: jsonValueSchema,
  rawResultDigest: digestSchema,
  payloadDigest: digestSchema,
  failureCode: idSchema.nullable(),
}).strict().superRefine((receipt, context) => {
  try {
    const retained = retainExactCodexAppCallResult(receipt.rawResult);
    const derived = deriveWaitThreadsResult(retained, { threadId: receipt.codexTaskId, hostId: receipt.hostId });
    if (receipt.rawResultDigest !== retained.rawResultDigest || receipt.payloadDigest !== retained.payloadDigest
        || receipt.outcome !== derived.outcome || receipt.cursor !== derived.cursor
        || receipt.terminalResultDigest !== derived.terminalResultDigest
        || receipt.terminalCompletedAt !== derived.terminalCompletedAt || receipt.failureCode !== derived.failureCode) {
      context.addIssue({ code: "custom", path: ["rawResultDigest"], message: "Wait receipt is not derived from the exact retained wait_threads result." });
    }
  } catch (error) {
    context.addIssue({ code: "custom", path: ["rawResult"], message: error instanceof Error ? error.message : "Raw wait_threads result is invalid." });
  }
  if (receipt.outcome === "timeout" && (receipt.cursor === null || receipt.terminalResultDigest !== null || receipt.failureCode !== null)) {
    context.addIssue({ code: "custom", message: "A timeout requires a resumable cursor and no terminal result or failure." });
  }
  if (receipt.outcome === "completed" && (receipt.terminalResultDigest === null || receipt.terminalCompletedAt === null || receipt.failureCode !== null)) {
    context.addIssue({ code: "custom", message: "A completed wait requires a terminal result digest and no failure." });
  }
  if ((receipt.outcome === "needs_attention" || receipt.outcome === "usage_limit" || receipt.outcome === "failed")
      && (receipt.failureCode === null || receipt.terminalResultDigest !== null)) {
    context.addIssue({ code: "custom", message: "A non-completion terminal wait observation requires a failure code." });
  }
});

export const exp0001aCodexWaitThreadsReceiptSchema = waitThreadsReceiptContentSchema.extend({ receiptDigest: digestSchema }).strict()
  .superRefine((receipt, context) => {
    const { receiptDigest: _receiptDigest, ...content } = receipt;
    void _receiptDigest;
    if (hashCanonicalJson(content) !== receipt.receiptDigest) {
      context.addIssue({ code: "custom", path: ["receiptDigest"], message: "wait_threads receipt digest is invalid." });
    }
  });
export type Exp0001aCodexWaitThreadsReceipt = z.infer<typeof exp0001aCodexWaitThreadsReceiptSchema>;

const readThreadCommandContentSchema = z.object({
  schemaVersion: z.literal(1),
  toolName: z.literal("mcp__codex_app__read_thread"),
  transportId: opaqueIdSchema,
  issuedAt: timestampSchema,
  arguments: z.object({
    threadId: idSchema,
    hostId: idSchema,
    cursor: cursorSchema.optional(),
    includeOutputs: z.literal(false),
    maxOutputCharsPerItem: z.literal(EXP0001A_CODEX_READ_THREAD_MAX_OUTPUT_CHARS_PER_ITEM),
    turnLimit: z.literal(EXP0001A_CODEX_READ_THREAD_TURN_LIMIT),
  }).strict(),
}).strict();

export const exp0001aCodexReadThreadCommandSchema = readThreadCommandContentSchema.extend({ commandDigest: digestSchema }).strict()
  .superRefine((command, context) => {
    const { commandDigest: _commandDigest, ...content } = command;
    void _commandDigest;
    if (hashCanonicalJson(content) !== command.commandDigest) {
      context.addIssue({ code: "custom", path: ["commandDigest"], message: "read_thread command digest is invalid." });
    }
  });
export type Exp0001aCodexReadThreadCommand = z.infer<typeof exp0001aCodexReadThreadCommandSchema>;

const listThreadsReconciliationCommandContentSchema = z.object({
  schemaVersion: z.literal(1),
  toolName: z.literal("mcp__codex_app__list_threads"),
  transportId: opaqueIdSchema,
  issuedAt: timestampSchema,
  expectedUniqueTaskTitle: z.string().min(1).max(120),
  arguments: z.object({ limit: z.literal(100) }).strict(),
}).strict();

export const exp0001aCodexListThreadsReconciliationCommandSchema = listThreadsReconciliationCommandContentSchema.extend({
  commandDigest: digestSchema,
}).strict().superRefine((command, context) => {
  const { commandDigest: _commandDigest, ...content } = command;
  void _commandDigest;
  if (hashCanonicalJson(content) !== command.commandDigest) {
    context.addIssue({ code: "custom", path: ["commandDigest"], message: "list_threads reconciliation command digest is invalid." });
  }
});
export type Exp0001aCodexListThreadsReconciliationCommand = z.infer<typeof exp0001aCodexListThreadsReconciliationCommandSchema>;

const reconciliationMatchSchema = z.object({
  threadId: idSchema,
  hostId: idSchema,
  exactTitle: z.string().min(1).max(120),
}).strict();

function deriveReconciliationMatches(
  retained: RetainedCodexAppCallResult,
  expectedUniqueTaskTitle: string,
): z.infer<typeof reconciliationMatchSchema>[] {
  if (retained.isError) throw new Error("CODEX_LIST_THREADS_RESULT_IS_ERROR");
  const payload = exactJsonObject(retained.payload);
  if (payload === null || !Array.isArray(payload.pinnedThreads) || !Array.isArray(payload.threads)) {
    throw new Error("CODEX_LIST_THREADS_PAYLOAD_SHAPE_INVALID");
  }
  const matches: z.infer<typeof reconciliationMatchSchema>[] = [];
  for (const value of [...payload.pinnedThreads, ...payload.threads]) {
    const entry = exactJsonObject(value);
    if (entry === null || entry.kind !== "codex" || entry.title !== expectedUniqueTaskTitle) continue;
    const threadId = exactString(entry.id);
    const hostId = exactString(entry.hostId);
    if (threadId === null || hostId === null) throw new Error("CODEX_LIST_THREADS_EXACT_TITLE_MATCH_IDENTITY_INVALID");
    matches.push(reconciliationMatchSchema.parse({ threadId, hostId, exactTitle: expectedUniqueTaskTitle }));
  }
  if (new Set(matches.map((match) => `${match.hostId}:${match.threadId}`)).size !== matches.length) {
    throw new Error("CODEX_LIST_THREADS_EXACT_TITLE_MATCH_DUPLICATED");
  }
  return matches.sort((left, right) => `${left.hostId}:${left.threadId}`.localeCompare(`${right.hostId}:${right.threadId}`));
}

const createReconciliationReceiptContentSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("codex-create-thread-reconciliation-receipt"),
  transportId: opaqueIdSchema,
  commandDigest: digestSchema,
  observedAt: timestampSchema,
  expectedUniqueTaskTitle: z.string().min(1).max(120),
  outcome: z.enum(["ready", "not_found_yet", "ambiguous"]),
  matches: z.array(reconciliationMatchSchema).max(100),
  rawResult: jsonValueSchema,
  rawResultDigest: digestSchema,
  payloadDigest: digestSchema,
}).strict().superRefine((receipt, context) => {
  const expectedCount = receipt.outcome === "ready" ? 1 : receipt.outcome === "not_found_yet" ? 0 : 2;
  if ((receipt.outcome === "ambiguous" && receipt.matches.length < expectedCount)
      || (receipt.outcome !== "ambiguous" && receipt.matches.length !== expectedCount)) {
    context.addIssue({ code: "custom", path: ["matches"], message: "Reconciliation outcome does not match the number of exact-title tasks." });
  }
  try {
    const retained = retainExactCodexAppCallResult(receipt.rawResult);
    const matches = deriveReconciliationMatches(retained, receipt.expectedUniqueTaskTitle);
    const outcome = matches.length === 0 ? "not_found_yet" : matches.length === 1 ? "ready" : "ambiguous";
    if (receipt.rawResultDigest !== retained.rawResultDigest || receipt.payloadDigest !== retained.payloadDigest
        || receipt.outcome !== outcome || canonicalJson(receipt.matches) !== canonicalJson(matches)) {
      context.addIssue({ code: "custom", path: ["rawResultDigest"], message: "Reconciliation receipt is not derived from the exact retained list_threads result." });
    }
  } catch (error) {
    context.addIssue({ code: "custom", path: ["rawResult"], message: error instanceof Error ? error.message : "Raw list_threads result is invalid." });
  }
});

export const exp0001aCodexCreateReconciliationReceiptSchema = createReconciliationReceiptContentSchema.extend({
  receiptDigest: digestSchema,
}).strict().superRefine((receipt, context) => {
  const { receiptDigest: _receiptDigest, ...content } = receipt;
  void _receiptDigest;
  if (hashCanonicalJson(content) !== receipt.receiptDigest) {
    context.addIssue({ code: "custom", path: ["receiptDigest"], message: "create_thread reconciliation receipt digest is invalid." });
  }
});
export type Exp0001aCodexCreateReconciliationReceipt = z.infer<typeof exp0001aCodexCreateReconciliationReceiptSchema>;

const authorFinalEvidenceCommandContentSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("coordinator-author-final-evidence-command"),
  toolName: z.literal("exp0001a_browser_webmcp_evidence_batch"),
  transportId: opaqueIdSchema,
  authorPlanDigest: digestSchema,
  codexTaskId: idSchema,
  issuedAt: timestampSchema,
  afterWaitReceiptDigest: digestSchema,
  arguments: z.object({
    privateRoomUrl: z.string().url(),
    roomId: roomIdSchema,
    privateRoomAccessBindingDigest: digestSchema,
    operations: z.tuple([
      z.object({ sequence: z.literal(0), toolName: z.literal("inspect_canvas_scope"), input: z.object({ scope: z.object({ kind: z.literal("room") }).strict() }).strict() }).strict(),
      z.object({ sequence: z.literal(1), toolName: z.literal("export_canvas_png"), input: z.object({}).strict(), retainImageContent: z.literal(true) }).strict(),
      z.object({ sequence: z.literal(2), toolName: z.literal("read_room_state"), input: z.object({}).strict() }).strict(),
    ]),
  }).strict(),
}).strict();

export const exp0001aAuthorFinalEvidenceCommandSchema = authorFinalEvidenceCommandContentSchema.extend({
  commandDigest: digestSchema,
}).strict().superRefine((command, context) => {
  const { commandDigest: _commandDigest, ...content } = command;
  void _commandDigest;
  let roomBinding: string | null = null;
  try {
    roomBinding = computePrivateRoomAccessBinding({
      privateRoomUrl: command.arguments.privateRoomUrl,
      roomId: command.arguments.roomId,
    });
  } catch {
    roomBinding = null;
  }
  if (hashCanonicalJson(content) !== command.commandDigest
      || roomBinding !== command.arguments.privateRoomAccessBindingDigest) {
    context.addIssue({ code: "custom", path: ["commandDigest"], message: "Post-author evidence command digest or private-room binding is invalid." });
  }
});
export type Exp0001aAuthorFinalEvidenceCommand = z.infer<typeof exp0001aAuthorFinalEvidenceCommandSchema>;

const finiteCoordinateSchema = z.number().finite().min(-10_000_000).max(10_000_000);
const canvasPointProjectionSchema = z.object({
  x: finiteCoordinateSchema,
  y: finiteCoordinateSchema,
}).passthrough();
const canvasObjectProjectionBaseShape = {
  id: idSchema,
  semanticName: z.string().max(500).nullable().optional(),
  semanticRole: z.string().max(500).nullable().optional(),
  x: finiteCoordinateSchema,
  y: finiteCoordinateSchema,
  width: z.number().finite().positive().max(10_000_000),
  height: z.number().finite().positive().max(10_000_000),
  rotation: z.number().finite().min(-360_000).max(360_000),
  zIndex: z.number().int().min(-1_000_000).max(1_000_000),
  revision: z.number().int().positive(),
  groupId: idSchema.nullable(),
  diagramIds: z.array(idSchema).max(1_000),
} as const;
const canvasObjectProjectionSchema = z.discriminatedUnion("kind", [
  z.object({
    ...canvasObjectProjectionBaseShape,
    kind: z.literal("text"),
    content: z.string().max(100_000),
    color: z.string().max(200),
    size: z.enum(["s", "m", "l", "xl"]),
    align: z.enum(["start", "middle", "end"]),
  }).passthrough(),
  z.object({
    ...canvasObjectProjectionBaseShape,
    kind: z.literal("shape"),
    shape: z.enum(["rectangle", "ellipse", "diamond"]),
    nodeType: z.enum(["service", "component", "requirement", "decision", "open_question"]).nullable(),
    nodeMetadata: z.object({
      kind: z.enum(["decision", "open_question"]),
      status: z.string().min(1).max(100),
      resolution: z.string().max(10_000).nullable(),
    }).passthrough().nullable().optional(),
    label: z.string().max(100_000),
    fill: z.string().max(200),
    stroke: z.string().max(200),
  }).passthrough(),
  z.object({
    ...canvasObjectProjectionBaseShape,
    kind: z.literal("connector"),
    start: canvasPointProjectionSchema.extend({
      objectId: idSchema.nullable(),
      normalizedAnchor: canvasPointProjectionSchema.nullable().optional(),
      isPrecise: z.boolean().nullable().optional(),
      isExact: z.boolean().nullable().optional(),
      snap: z.enum(["center", "edge-point", "edge", "none"]).nullable().optional(),
    }).passthrough(),
    end: canvasPointProjectionSchema.extend({
      objectId: idSchema.nullable(),
      normalizedAnchor: canvasPointProjectionSchema.nullable().optional(),
      isPrecise: z.boolean().nullable().optional(),
      isExact: z.boolean().nullable().optional(),
      snap: z.enum(["center", "edge-point", "edge", "none"]).nullable().optional(),
    }).passthrough(),
    routing: z.object({
      mode: z.enum(["auto", "straight", "curved", "elbow"]),
      kind: z.enum(["straight", "curved", "elbow"]),
      bend: z.number().finite(),
      elbowMidPoint: z.number().finite(),
      labelPosition: z.number().finite(),
      labelPositionSource: z.enum(["generated", "authored"]).optional(),
    }).passthrough().optional(),
    direction: z.enum(["none", "end", "both"]),
    label: z.string().max(100_000),
    color: z.string().max(200),
  }).passthrough(),
  z.object({
    ...canvasObjectProjectionBaseShape,
    kind: z.literal("image"),
    alt: z.string().max(10_000),
    mimeType: z.string().max(200),
    locked: z.boolean(),
  }).passthrough(),
  z.object({
    ...canvasObjectProjectionBaseShape,
    kind: z.literal("draw"),
    points: z.array(canvasPointProjectionSchema).max(100_000),
    color: z.string().max(200),
    size: z.enum(["s", "m", "l"]),
  }).passthrough(),
  z.object({
    ...canvasObjectProjectionBaseShape,
    kind: z.literal("path"),
    start: canvasPointProjectionSchema,
    segments: z.array(z.union([
      z.object({ kind: z.literal("line"), to: canvasPointProjectionSchema }).passthrough(),
      z.object({ kind: z.literal("quadratic"), control: canvasPointProjectionSchema, to: canvasPointProjectionSchema }).passthrough(),
      z.object({ kind: z.literal("cubic"), control1: canvasPointProjectionSchema, control2: canvasPointProjectionSchema, to: canvasPointProjectionSchema }).passthrough(),
    ])).max(100_000),
    closed: z.boolean(),
    fill: z.string().max(200),
    stroke: z.string().max(200),
    strokeWidth: z.number().finite().nonnegative().max(100_000),
    opacity: z.number().finite().min(0).max(1),
    lineCap: z.enum(["butt", "round", "square"]),
    lineJoin: z.enum(["miter", "round", "bevel"]),
    fillRule: z.enum(["nonzero", "evenodd"]),
  }).passthrough(),
]);
const diagramProjectionSchema = z.object({
  id: idSchema,
  title: z.string().max(10_000),
  description: z.string().max(100_000),
  diagramType: z.enum(["architecture", "flow", "hierarchy", "system_context", "process", "custom"]),
  category: z.string().max(1_000).nullable(),
  tags: z.array(z.string().max(1_000)).max(1_000),
  memberObjectIds: z.array(idSchema).max(10_000),
  connectorIds: z.array(idSchema).max(10_000),
  bounds: z.object({
    x: finiteCoordinateSchema,
    y: finiteCoordinateSchema,
    width: z.number().finite().nonnegative().max(10_000_000),
    height: z.number().finite().nonnegative().max(10_000_000),
  }).passthrough(),
  revision: z.number().int().positive(),
}).passthrough();

const rawAuthorRoomReadResultSchema = z.object({
  ok: z.literal(true),
  tool: z.literal("read_room_state"),
  data: z.object({
    room: z.object({
      id: roomIdSchema,
      roomRevision: z.number().int().positive(),
    }).passthrough(),
    objects: z.array(canvasObjectProjectionSchema).min(1).max(10_000),
    diagrams: z.array(diagramProjectionSchema).max(10_000),
  }).passthrough(),
}).strict();

const rawAuthorInspectionResultSchema = z.object({
  ok: z.literal(true),
  tool: z.literal("inspect_canvas_scope"),
  data: z.object({
    sourceRevisions: z.object({ roomRevision: z.number().int().positive() }).passthrough(),
  }).passthrough(),
}).strict();

const rawAuthorPngExportResultSchema = z.object({
  ok: z.literal(true),
  tool: z.literal("export_canvas_png"),
  data: z.object({
    mimeType: z.literal("image/png"),
    width: z.number().int().positive().max(8_192),
    height: z.number().int().positive().max(8_192),
    byteLength: z.number().int().positive().max(10 * 1024 * 1024),
    sourceRevisions: z.object({ roomRevision: z.number().int().positive() }).passthrough(),
    persistedByJazzboard: z.literal(false),
  }).passthrough(),
}).strict();

export type Exp0001aAuthorFinalEvidenceResultInput = Readonly<{
  inspectionCallResult: unknown;
  pngExportCallResult: unknown;
  roomReadCallResult: unknown;
}>;

type RetainedWebMcpCallResult = Readonly<{
  rawCallResult: JsonValue;
  rawCallResultDigest: string;
  rawToolResult: JsonValue;
  rawToolResultDigest: string;
  imagePngBase64: string | null;
}>;

function retainExactWebMcpCallResult(input: unknown, imageRequired: boolean): RetainedWebMcpCallResult {
  const rawCallResult = cloneJson(input);
  const envelope = jsonObject(rawCallResult);
  if (envelope === null || envelope.isError !== false || !Array.isArray(envelope.content)
      || Object.keys(envelope).some((key) => !["content", "isError", "_meta"].includes(key))) {
    throw new Error("AUTHOR_FINAL_WEBMCP_CALL_RESULT_WRAPPER_INVALID");
  }
  const expectedLength = imageRequired ? 2 : 1;
  if (envelope.content.length !== expectedLength) throw new Error("AUTHOR_FINAL_WEBMCP_CALL_RESULT_CONTENT_COUNT_INVALID");
  const textBlock = jsonObject(envelope.content[0] as JsonValue);
  if (textBlock === null || textBlock.type !== "text" || typeof textBlock.text !== "string") {
    throw new Error("AUTHOR_FINAL_WEBMCP_CALL_RESULT_TEXT_BLOCK_INVALID");
  }
  let rawToolResult: JsonValue;
  try {
    rawToolResult = cloneJson(JSON.parse(textBlock.text));
  } catch {
    throw new Error("AUTHOR_FINAL_WEBMCP_CALL_RESULT_TEXT_NOT_JSON");
  }
  let imagePngBase64: string | null = null;
  if (imageRequired) {
    const imageBlock = jsonObject(envelope.content[1] as JsonValue);
    if (imageBlock === null || imageBlock.type !== "image" || imageBlock.mimeType !== "image/png"
        || typeof imageBlock.data !== "string") {
      throw new Error("AUTHOR_FINAL_WEBMCP_EXPORT_IMAGE_BLOCK_INVALID");
    }
    imagePngBase64 = imageBlock.data;
  }
  return freezeDeep({
    rawCallResult,
    rawCallResultDigest: hashCanonicalJson(rawCallResult),
    rawToolResult,
    rawToolResultDigest: hashCanonicalJson(rawToolResult),
    imagePngBase64,
  });
}

const authorFinalRoomReadReceiptContentSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("coordinator-authoritative-room-read-receipt"),
  evidenceSource: z.literal("coordinator-issued-exact-browser-webmcp-call-results"),
  authorPlanDigest: digestSchema,
  transportId: opaqueIdSchema,
  codexTaskId: idSchema,
  command: exp0001aAuthorFinalEvidenceCommandSchema,
  roomId: roomIdSchema,
  privateRoomAccessBindingDigest: digestSchema,
  observedAt: timestampSchema,
  toolName: z.literal("read_room_state"),
  roomRevision: z.number().int().positive(),
  objectCount: z.number().int().positive(),
  semanticStateDigest: digestSchema,
  canvasImageDigest: digestSchema,
  canvasImageBytes: z.number().int().positive().max(10 * 1024 * 1024),
  canvasImageWidth: z.number().int().positive().max(8_192),
  canvasImageHeight: z.number().int().positive().max(8_192),
  canvasImagePngBase64: z.string().min(1).max(14 * 1024 * 1024),
  readResultDigest: digestSchema,
  inspectionResultDigest: digestSchema,
  pngExportResultDigest: digestSchema,
  rawRoomReadCallResultDigest: digestSchema,
  rawInspectionCallResultDigest: digestSchema,
  rawPngExportCallResultDigest: digestSchema,
  rawRoomReadCallResult: jsonValueSchema,
  rawInspectionCallResult: jsonValueSchema,
  rawPngExportCallResult: jsonValueSchema,
  rawRoomReadResult: jsonValueSchema,
  rawInspectionResult: jsonValueSchema,
  rawPngExportResult: jsonValueSchema,
  retainedEvidenceDigest: digestSchema,
}).strict();

export const exp0001aAuthorFinalRoomReadReceiptSchema = authorFinalRoomReadReceiptContentSchema.extend({
  receiptDigest: digestSchema,
}).strict().superRefine((receipt, context) => {
  const { receiptDigest: _receiptDigest, ...content } = receipt;
  void _receiptDigest;
  let inspectedPng: ReturnType<typeof inspectExactPng> | null = null;
  try {
    inspectedPng = inspectExactPng(receipt.canvasImagePngBase64);
  } catch {
    context.addIssue({ code: "custom", path: ["canvasImagePngBase64"], message: "Retained final PNG bytes are invalid." });
  }
  let exactRoomRead: RetainedWebMcpCallResult | null = null;
  let exactInspection: RetainedWebMcpCallResult | null = null;
  let exactPngExport: RetainedWebMcpCallResult | null = null;
  let parsedRoomRead: z.infer<typeof rawAuthorRoomReadResultSchema> | null = null;
  let parsedInspection: z.infer<typeof rawAuthorInspectionResultSchema> | null = null;
  let parsedPngExport: z.infer<typeof rawAuthorPngExportResultSchema> | null = null;
  try {
    exactRoomRead = retainExactWebMcpCallResult(receipt.rawRoomReadCallResult, false);
    exactInspection = retainExactWebMcpCallResult(receipt.rawInspectionCallResult, false);
    exactPngExport = retainExactWebMcpCallResult(receipt.rawPngExportCallResult, true);
    parsedRoomRead = rawAuthorRoomReadResultSchema.parse(exactRoomRead.rawToolResult);
    parsedInspection = rawAuthorInspectionResultSchema.parse(exactInspection.rawToolResult);
    parsedPngExport = rawAuthorPngExportResultSchema.parse(exactPngExport.rawToolResult);
  } catch (error) {
    context.addIssue({ code: "custom", path: ["rawRoomReadCallResult"], message: error instanceof Error ? error.message : "Retained WebMCP CallToolResult is invalid." });
  }
  if (hashCanonicalJson(content) !== receipt.receiptDigest
      || receipt.command.authorPlanDigest !== receipt.authorPlanDigest
      || receipt.command.transportId !== receipt.transportId
      || receipt.command.codexTaskId !== receipt.codexTaskId
      || receipt.command.arguments.roomId !== receipt.roomId
      || receipt.command.arguments.privateRoomAccessBindingDigest !== receipt.privateRoomAccessBindingDigest
      || Date.parse(receipt.observedAt) < Date.parse(receipt.command.issuedAt)
      || hashCanonicalJson(receipt.rawRoomReadResult) !== receipt.readResultDigest
      || hashCanonicalJson(receipt.rawInspectionResult) !== receipt.inspectionResultDigest
      || hashCanonicalJson(receipt.rawPngExportResult) !== receipt.pngExportResultDigest
      || (exactRoomRead !== null && (exactRoomRead.rawCallResultDigest !== receipt.rawRoomReadCallResultDigest
        || exactRoomRead.rawToolResultDigest !== receipt.readResultDigest
        || canonicalJson(exactRoomRead.rawToolResult) !== canonicalJson(receipt.rawRoomReadResult)))
      || (exactInspection !== null && (exactInspection.rawCallResultDigest !== receipt.rawInspectionCallResultDigest
        || exactInspection.rawToolResultDigest !== receipt.inspectionResultDigest
        || canonicalJson(exactInspection.rawToolResult) !== canonicalJson(receipt.rawInspectionResult)))
      || (exactPngExport !== null && (exactPngExport.rawCallResultDigest !== receipt.rawPngExportCallResultDigest
        || exactPngExport.rawToolResultDigest !== receipt.pngExportResultDigest
        || canonicalJson(exactPngExport.rawToolResult) !== canonicalJson(receipt.rawPngExportResult)
        || exactPngExport.imagePngBase64 !== receipt.canvasImagePngBase64))
      || (parsedRoomRead !== null && (parsedRoomRead.data.room.id !== receipt.roomId
        || parsedRoomRead.data.room.roomRevision !== receipt.roomRevision
        || parsedRoomRead.data.objects.length !== receipt.objectCount
        || deriveAuthorReviewerSemanticState(parsedRoomRead).sha256 !== receipt.semanticStateDigest))
      || (parsedInspection !== null && parsedInspection.data.sourceRevisions.roomRevision !== receipt.roomRevision)
      || (parsedPngExport !== null && (parsedPngExport.data.sourceRevisions.roomRevision !== receipt.roomRevision
        || parsedPngExport.data.byteLength !== receipt.canvasImageBytes
        || parsedPngExport.data.width !== receipt.canvasImageWidth
        || parsedPngExport.data.height !== receipt.canvasImageHeight))
      || (inspectedPng !== null && (sha256Digest(inspectedPng.bytes) !== receipt.canvasImageDigest
        || inspectedPng.bytes.byteLength !== receipt.canvasImageBytes
        || inspectedPng.width !== receipt.canvasImageWidth
        || inspectedPng.height !== receipt.canvasImageHeight))
      || receipt.retainedEvidenceDigest !== hashCanonicalJson({
        commandDigest: receipt.command.commandDigest,
        rawRoomReadCallResultDigest: receipt.rawRoomReadCallResultDigest,
        rawInspectionCallResultDigest: receipt.rawInspectionCallResultDigest,
        rawPngExportCallResultDigest: receipt.rawPngExportCallResultDigest,
        roomReadResultDigest: receipt.readResultDigest,
        inspectionResultDigest: receipt.inspectionResultDigest,
        pngExportResultDigest: receipt.pngExportResultDigest,
        canvasImageDigest: receipt.canvasImageDigest,
        canvasImageBytes: receipt.canvasImageBytes,
        canvasImageWidth: receipt.canvasImageWidth,
        canvasImageHeight: receipt.canvasImageHeight,
      })) {
    context.addIssue({ code: "custom", path: ["receiptDigest"], message: "Authoritative final room-read receipt digest is invalid." });
  }
});
export type Exp0001aAuthorFinalRoomReadReceipt = z.infer<typeof exp0001aAuthorFinalRoomReadReceiptSchema>;

const authorFinalReviewEvidenceContentSchema = z.object({
  schemaVersion: z.literal("exp-0001a-author-final-review-evidence/v1"),
  kind: z.literal("coordinator-derived-final-only-review-evidence"),
  evidenceMode: z.literal("final-only"),
  sourceFinalRoomReadReceiptDigest: digestSchema,
  sourceRetainedEvidenceDigest: digestSchema,
  roomRevision: z.number().int().positive(),
  semanticState: semanticStateEvidenceSchema,
  finalImage: z.object({
    slot: z.literal("image-01"),
    roomRevision: z.number().int().positive(),
    final: z.literal(true),
    sha256: digestSchema,
    bytes: z.number().int().positive().max(10 * 1024 * 1024),
    width: z.number().int().positive().max(8_192),
    height: z.number().int().positive().max(8_192),
    mimeType: z.literal("image/png"),
    pngBytesBase64: z.string().min(1).max(14 * 1024 * 1024),
  }).strict(),
}).strict();

export const exp0001aAuthorFinalReviewEvidenceSchema = authorFinalReviewEvidenceContentSchema.extend({
  evidenceRoot: digestSchema,
}).strict().superRefine((evidence, context) => {
  const { evidenceRoot: _evidenceRoot, ...content } = evidence;
  void _evidenceRoot;
  let inspectedPng: ReturnType<typeof inspectExactPng> | null = null;
  try {
    inspectedPng = inspectExactPng(evidence.finalImage.pngBytesBase64);
  } catch {
    context.addIssue({ code: "custom", path: ["finalImage", "pngBytesBase64"], message: "Final review PNG bytes are invalid." });
  }
  if (hashCanonicalJson(content) !== evidence.evidenceRoot
      || evidence.finalImage.roomRevision !== evidence.roomRevision
      || (inspectedPng !== null && (sha256Digest(inspectedPng.bytes) !== evidence.finalImage.sha256
        || inspectedPng.bytes.byteLength !== evidence.finalImage.bytes
        || inspectedPng.width !== evidence.finalImage.width
        || inspectedPng.height !== evidence.finalImage.height))) {
    context.addIssue({ code: "custom", path: ["evidenceRoot"], message: "Final-only author review evidence is invalid." });
  }
});
export type Exp0001aAuthorFinalReviewEvidence = z.infer<typeof exp0001aAuthorFinalReviewEvidenceSchema>;

function crc32(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb8_8320 & -(crc & 1));
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function inspectExactPng(base64: string): { bytes: Uint8Array; width: number; height: number } {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
    throw new Error("AUTHOR_FINAL_PNG_BASE64_NOT_CANONICAL");
  }
  const bytes = new Uint8Array(Buffer.from(base64, "base64"));
  if (bytes.byteLength === 0 || bytes.byteLength > 10 * 1024 * 1024
      || Buffer.from(bytes).toString("base64") !== base64
      || Buffer.from(bytes.subarray(0, 8)).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error("AUTHOR_FINAL_PNG_BYTES_INVALID");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let sawHeader = false;
  let sawImageData = false;
  let sawEnd = false;
  while (offset < bytes.byteLength) {
    if (offset + 12 > bytes.byteLength) throw new Error("AUTHOR_FINAL_PNG_CHUNK_TRUNCATED");
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, bytes.byteLength - offset);
    const length = view.getUint32(0);
    if (length > bytes.byteLength - offset - 12) throw new Error("AUTHOR_FINAL_PNG_CHUNK_LENGTH_INVALID");
    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    const type = Buffer.from(typeBytes).toString("ascii");
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const claimedCrc = new DataView(bytes.buffer, bytes.byteOffset + offset + 8 + length, 4).getUint32(0);
    const crcInput = new Uint8Array(typeBytes.byteLength + data.byteLength);
    crcInput.set(typeBytes);
    crcInput.set(data, typeBytes.byteLength);
    if (crc32(crcInput) !== claimedCrc) throw new Error("AUTHOR_FINAL_PNG_CHUNK_CRC_INVALID");
    if (!sawHeader) {
      if (type !== "IHDR" || length !== 13) throw new Error("AUTHOR_FINAL_PNG_IHDR_MISSING");
      const header = new DataView(data.buffer, data.byteOffset, data.byteLength);
      width = header.getUint32(0);
      height = header.getUint32(4);
      if (width < 1 || height < 1 || width > 8_192 || height > 8_192
          || data[10] !== 0 || data[11] !== 0 || (data[12] !== 0 && data[12] !== 1)) {
        throw new Error("AUTHOR_FINAL_PNG_IHDR_INVALID");
      }
      sawHeader = true;
    }
    if (type === "IDAT") sawImageData = true;
    if (type === "IEND") {
      if (length !== 0 || offset + 12 !== bytes.byteLength) throw new Error("AUTHOR_FINAL_PNG_IEND_INVALID");
      sawEnd = true;
    }
    offset += length + 12;
  }
  if (!sawHeader || !sawImageData || !sawEnd) throw new Error("AUTHOR_FINAL_PNG_STRUCTURE_INCOMPLETE");
  return { bytes, width, height };
}

function projectCanvasPoint(point: z.infer<typeof canvasPointProjectionSchema>): JsonValue {
  return { x: point.x, y: point.y };
}

type ProjectableCanvasEndpoint = Extract<z.infer<typeof canvasObjectProjectionSchema>, { kind: "connector" }>["start"];

function projectCanvasEndpoint(value: ProjectableCanvasEndpoint): JsonValue {
  return {
    x: value.x,
    y: value.y,
    objectId: value.objectId,
    normalizedAnchor: value.normalizedAnchor == null ? null : projectCanvasPoint(value.normalizedAnchor),
    isPrecise: value.isPrecise ?? null,
    isExact: value.isExact ?? null,
    snap: value.snap ?? null,
  };
}

type ProjectablePathSegment = Extract<z.infer<typeof canvasObjectProjectionSchema>, { kind: "path" }>["segments"][number];

function projectPathSegmentForReview(segment: ProjectablePathSegment): JsonValue {
  if (segment.kind === "line") return { kind: segment.kind, to: projectCanvasPoint(segment.to) };
  if (segment.kind === "quadratic") {
    return { kind: segment.kind, control: projectCanvasPoint(segment.control), to: projectCanvasPoint(segment.to) };
  }
  return {
    kind: segment.kind,
    control1: projectCanvasPoint(segment.control1),
    control2: projectCanvasPoint(segment.control2),
    to: projectCanvasPoint(segment.to),
  };
}

function projectCanvasObjectForReview(object: z.infer<typeof canvasObjectProjectionSchema>): JsonValue {
  const base = {
    id: object.id,
    kind: object.kind,
    semanticName: object.semanticName ?? null,
    semanticRole: object.semanticRole ?? null,
    x: object.x,
    y: object.y,
    width: object.width,
    height: object.height,
    rotation: object.rotation,
    zIndex: object.zIndex,
    revision: object.revision,
    groupId: object.groupId,
    diagramIds: [...object.diagramIds].sort(),
  };
  switch (object.kind) {
    case "text":
      return { ...base, content: object.content, color: object.color, size: object.size, align: object.align };
    case "shape":
      return {
        ...base,
        shape: object.shape,
        nodeType: object.nodeType,
        nodeMetadata: object.nodeMetadata == null ? null : {
          kind: object.nodeMetadata.kind,
          status: object.nodeMetadata.status,
          resolution: object.nodeMetadata.resolution,
        },
        label: object.label,
        fill: object.fill,
        stroke: object.stroke,
      };
    case "connector":
      return {
        ...base,
        start: projectCanvasEndpoint(object.start),
        end: projectCanvasEndpoint(object.end),
        routing: object.routing == null ? null : {
          mode: object.routing.mode,
          kind: object.routing.kind,
          bend: object.routing.bend,
          elbowMidPoint: object.routing.elbowMidPoint,
          labelPosition: object.routing.labelPosition,
          labelPositionSource: object.routing.labelPositionSource ?? null,
        },
        direction: object.direction,
        label: object.label,
        color: object.color,
      };
    case "image":
      return { ...base, alt: object.alt, mimeType: object.mimeType, locked: object.locked };
    case "draw":
      return { ...base, points: object.points.map(projectCanvasPoint), color: object.color, size: object.size };
    case "path":
      return {
        ...base,
        start: projectCanvasPoint(object.start),
        segments: object.segments.map(projectPathSegmentForReview),
        closed: object.closed,
        fill: object.fill,
        stroke: object.stroke,
        strokeWidth: object.strokeWidth,
        opacity: object.opacity,
        lineCap: object.lineCap,
        lineJoin: object.lineJoin,
        fillRule: object.fillRule,
      };
  }
}

function projectDiagramForReview(diagram: z.infer<typeof diagramProjectionSchema>): JsonValue {
  return {
    id: diagram.id,
    title: diagram.title,
    description: diagram.description,
    diagramType: diagram.diagramType,
    category: diagram.category,
    tags: [...diagram.tags],
    memberObjectIds: [...diagram.memberObjectIds],
    connectorIds: [...diagram.connectorIds],
    bounds: {
      x: diagram.bounds.x,
      y: diagram.bounds.y,
      width: diagram.bounds.width,
      height: diagram.bounds.height,
    },
    revision: diagram.revision,
  };
}

function deriveAuthorReviewerSemanticState(
  rawRoomRead: z.infer<typeof rawAuthorRoomReadResultSchema>,
): z.infer<typeof semanticStateEvidenceSchema> {
  // This is a positive, schema-versioned projection. The full authoritative
  // room read remains private in its receipt; only evaluator-required semantic,
  // geometry, relation, content, and style fields cross the reviewer boundary.
  const content = cloneJson({
    schemaVersion: "exp-0001a-author-review-semantic-state/v2",
    roomRevision: rawRoomRead.data.room.roomRevision,
    objects: rawRoomRead.data.objects.map(projectCanvasObjectForReview),
    diagrams: rawRoomRead.data.diagrams.map(projectDiagramForReview),
  });
  return semanticStateEvidenceSchema.parse({
    content,
    bytes: Buffer.byteLength(canonicalJson(content), "utf8"),
    sha256: hashCanonicalJson(content),
  });
}

function createAuthorFinalReviewEvidence(
  receiptInput: Exp0001aAuthorFinalRoomReadReceipt,
): Exp0001aAuthorFinalReviewEvidence {
  const receipt = exp0001aAuthorFinalRoomReadReceiptSchema.parse(receiptInput);
  const rawRoomRead = rawAuthorRoomReadResultSchema.parse(receipt.rawRoomReadResult);
  const semanticState = deriveAuthorReviewerSemanticState(rawRoomRead);
  const content = authorFinalReviewEvidenceContentSchema.parse({
    schemaVersion: "exp-0001a-author-final-review-evidence/v1",
    kind: "coordinator-derived-final-only-review-evidence",
    evidenceMode: "final-only",
    sourceFinalRoomReadReceiptDigest: receipt.receiptDigest,
    sourceRetainedEvidenceDigest: receipt.retainedEvidenceDigest,
    roomRevision: receipt.roomRevision,
    semanticState,
    finalImage: {
      slot: "image-01",
      roomRevision: receipt.roomRevision,
      final: true,
      sha256: receipt.canvasImageDigest,
      bytes: receipt.canvasImageBytes,
      width: receipt.canvasImageWidth,
      height: receipt.canvasImageHeight,
      mimeType: "image/png",
      pngBytesBase64: receipt.canvasImagePngBase64,
    },
  });
  return freezeDeep(exp0001aAuthorFinalReviewEvidenceSchema.parse({
    ...content,
    evidenceRoot: hashCanonicalJson(content),
  }));
}

export function issueExp0001aAuthorFinalEvidenceCommand(input: {
  plan: Exp0001aCodexTaskTransportPlan;
  lifecycle: Exp0001aCodexTaskLifecycle;
  issuedAt: string;
}): Exp0001aAuthorFinalEvidenceCommand {
  const plan = exp0001aCodexTaskTransportPlanSchema.parse(input.plan);
  const lifecycle = exp0001aCodexTaskLifecycleSchema.parse(input.lifecycle);
  const waitReceipt = lifecycle.waitReceipts.at(-1);
  if (plan.role !== "author" || plan.envelope.role !== "author" || lifecycle.planDigest !== plan.planDigest
      || lifecycle.transportId !== plan.transportId || lifecycle.state !== "awaiting_terminal_read"
      || lifecycle.codexTaskId === null || waitReceipt?.outcome !== "completed") {
    throw new Error("AUTHOR_FINAL_EVIDENCE_COMMAND_REQUIRES_COMPLETED_BOUND_AUTHOR_TASK");
  }
  if (Date.parse(input.issuedAt) < Date.parse(waitReceipt.observedAt)) {
    throw new Error("AUTHOR_FINAL_EVIDENCE_COMMAND_PRECEDES_TERMINAL_WAIT");
  }
  const content = authorFinalEvidenceCommandContentSchema.parse({
    schemaVersion: 1,
    kind: "coordinator-author-final-evidence-command",
    toolName: "exp0001a_browser_webmcp_evidence_batch",
    transportId: plan.transportId,
    authorPlanDigest: plan.planDigest,
    codexTaskId: lifecycle.codexTaskId,
    issuedAt: input.issuedAt,
    afterWaitReceiptDigest: waitReceipt.receiptDigest,
    arguments: {
      privateRoomUrl: plan.envelope.privateRoomUrl,
      roomId: plan.envelope.roomId,
      privateRoomAccessBindingDigest: plan.envelope.privateRoomAccessBindingDigest,
      operations: [
        { sequence: 0, toolName: "inspect_canvas_scope", input: { scope: { kind: "room" } } },
        { sequence: 1, toolName: "export_canvas_png", input: {}, retainImageContent: true },
        { sequence: 2, toolName: "read_room_state", input: {} },
      ],
    },
  });
  return freezeDeep(exp0001aAuthorFinalEvidenceCommandSchema.parse({
    ...content,
    commandDigest: hashCanonicalJson(content),
  }));
}

export function recordExp0001aAuthorFinalEvidenceResult(input: {
  plan: Exp0001aCodexTaskTransportPlan;
  lifecycle: Exp0001aCodexTaskLifecycle;
  command: Exp0001aAuthorFinalEvidenceCommand;
  observedAt: string;
  rawResult: Exp0001aAuthorFinalEvidenceResultInput;
}): Exp0001aAuthorFinalRoomReadReceipt {
  const plan = exp0001aCodexTaskTransportPlanSchema.parse(input.plan);
  const lifecycle = exp0001aCodexTaskLifecycleSchema.parse(input.lifecycle);
  const command = exp0001aAuthorFinalEvidenceCommandSchema.parse(input.command);
  const waitReceipt = lifecycle.waitReceipts.at(-1);
  if (plan.role !== "author" || plan.envelope.role !== "author" || lifecycle.planDigest !== plan.planDigest
      || lifecycle.transportId !== plan.transportId || lifecycle.state !== "awaiting_terminal_read"
      || lifecycle.codexTaskId === null || waitReceipt?.outcome !== "completed"
      || command.transportId !== plan.transportId || command.authorPlanDigest !== plan.planDigest
      || command.codexTaskId !== lifecycle.codexTaskId || command.afterWaitReceiptDigest !== waitReceipt.receiptDigest
      || command.arguments.privateRoomUrl !== plan.envelope.privateRoomUrl
      || command.arguments.roomId !== plan.envelope.roomId
      || command.arguments.privateRoomAccessBindingDigest !== plan.envelope.privateRoomAccessBindingDigest) {
    throw new Error("AUTHOR_FINAL_EVIDENCE_COMMAND_NOT_BOUND_TO_AUTHOR_LIFECYCLE");
  }
  if (Date.parse(input.observedAt) < Date.parse(command.issuedAt)) {
    throw new Error("AUTHOR_FINAL_EVIDENCE_RESULT_PRECEDES_COMMAND");
  }
  const retainedInspection = retainExactWebMcpCallResult(input.rawResult.inspectionCallResult, false);
  const retainedPngExport = retainExactWebMcpCallResult(input.rawResult.pngExportCallResult, true);
  const retainedRoomRead = retainExactWebMcpCallResult(input.rawResult.roomReadCallResult, false);
  const rawRoomRead = rawAuthorRoomReadResultSchema.parse(retainedRoomRead.rawToolResult);
  const rawInspection = rawAuthorInspectionResultSchema.parse(retainedInspection.rawToolResult);
  const rawPngExport = rawAuthorPngExportResultSchema.parse(retainedPngExport.rawToolResult);
  if (retainedPngExport.imagePngBase64 === null) throw new Error("AUTHOR_FINAL_EXPORT_IMAGE_CONTENT_MISSING");
  const png = inspectExactPng(retainedPngExport.imagePngBase64);
  const roomRevision = rawRoomRead.data.room.roomRevision;
  if (rawRoomRead.data.room.id !== plan.envelope.roomId
      || rawInspection.data.sourceRevisions.roomRevision !== roomRevision
      || rawPngExport.data.sourceRevisions.roomRevision !== roomRevision
      || rawPngExport.data.byteLength !== png.bytes.byteLength
      || rawPngExport.data.width !== png.width || rawPngExport.data.height !== png.height) {
    throw new Error("AUTHOR_FINAL_RAW_ROOM_INSPECTION_AND_PNG_REVISION_BINDING_INVALID");
  }
  const readResultDigest = retainedRoomRead.rawToolResultDigest;
  const inspectionResultDigest = retainedInspection.rawToolResultDigest;
  const pngExportResultDigest = retainedPngExport.rawToolResultDigest;
  const canvasImageDigest = sha256Digest(png.bytes);
  const reviewerSemanticState = deriveAuthorReviewerSemanticState(rawRoomRead);
  const retainedEvidenceDigest = hashCanonicalJson({
    commandDigest: command.commandDigest,
    rawRoomReadCallResultDigest: retainedRoomRead.rawCallResultDigest,
    rawInspectionCallResultDigest: retainedInspection.rawCallResultDigest,
    rawPngExportCallResultDigest: retainedPngExport.rawCallResultDigest,
    roomReadResultDigest: readResultDigest,
    inspectionResultDigest,
    pngExportResultDigest,
    canvasImageDigest,
    canvasImageBytes: png.bytes.byteLength,
    canvasImageWidth: png.width,
    canvasImageHeight: png.height,
  });
  const content = authorFinalRoomReadReceiptContentSchema.parse({
    schemaVersion: 1,
    kind: "coordinator-authoritative-room-read-receipt",
    evidenceSource: "coordinator-issued-exact-browser-webmcp-call-results",
    authorPlanDigest: plan.planDigest,
    transportId: plan.transportId,
    codexTaskId: lifecycle.codexTaskId,
    command,
    roomId: plan.envelope.roomId,
    privateRoomAccessBindingDigest: plan.envelope.privateRoomAccessBindingDigest,
    observedAt: input.observedAt,
    toolName: "read_room_state",
    roomRevision,
    objectCount: rawRoomRead.data.objects.length,
    semanticStateDigest: reviewerSemanticState.sha256,
    canvasImageDigest,
    canvasImageBytes: png.bytes.byteLength,
    canvasImageWidth: png.width,
    canvasImageHeight: png.height,
    canvasImagePngBase64: retainedPngExport.imagePngBase64,
    readResultDigest,
    inspectionResultDigest,
    pngExportResultDigest,
    rawRoomReadCallResultDigest: retainedRoomRead.rawCallResultDigest,
    rawInspectionCallResultDigest: retainedInspection.rawCallResultDigest,
    rawPngExportCallResultDigest: retainedPngExport.rawCallResultDigest,
    rawRoomReadCallResult: retainedRoomRead.rawCallResult,
    rawInspectionCallResult: retainedInspection.rawCallResult,
    rawPngExportCallResult: retainedPngExport.rawCallResult,
    rawRoomReadResult: rawRoomRead,
    rawInspectionResult: rawInspection,
    rawPngExportResult: rawPngExport,
    retainedEvidenceDigest,
  });
  return freezeDeep(exp0001aAuthorFinalRoomReadReceiptSchema.parse({
    ...content,
    receiptDigest: hashCanonicalJson(content),
  }));
}

const authorTerminalArtifactSchema = z.object({
  kind: z.literal("author-artifact-result"),
  evidenceSource: z.literal("independent-coordinator"),
  codexTaskId: idSchema,
  roomId: roomIdSchema,
  roomProvisioningReceiptDigest: digestSchema,
  privateRoomAccessBindingDigest: digestSchema,
  authoritativeRoomRevision: z.number().int().positive(),
  authoritativeObjectCount: z.number().int().positive(),
  observedWebMcpToolNames: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).min(2).max(256),
  finalAuthoritativeReadReceiptDigest: digestSchema,
  taskTraceObservationEvidenceDigest: digestSchema,
  finalAuthoritativeReadResultDigest: digestSchema,
  modelTerminalResultDigest: digestSchema,
  modelTerminalJsonDigest: digestSchema,
  semanticStateDigest: digestSchema,
  canvasImageDigest: digestSchema,
  webMcpTraceDigest: digestSchema,
  artifactRoot: digestSchema,
}).strict().superRefine((artifact, context) => {
  if (new Set(artifact.observedWebMcpToolNames).size !== artifact.observedWebMcpToolNames.length
      || [...artifact.observedWebMcpToolNames].sort().some((value, index) => value !== artifact.observedWebMcpToolNames[index])) {
    context.addIssue({ code: "custom", path: ["observedWebMcpToolNames"], message: "Observed WebMCP tools must be unique and sorted." });
  }
  const expected = hashCanonicalJson({
    evidenceSource: artifact.evidenceSource,
    codexTaskId: artifact.codexTaskId,
    roomId: artifact.roomId,
    roomProvisioningReceiptDigest: artifact.roomProvisioningReceiptDigest,
    privateRoomAccessBindingDigest: artifact.privateRoomAccessBindingDigest,
    authoritativeRoomRevision: artifact.authoritativeRoomRevision,
    authoritativeObjectCount: artifact.authoritativeObjectCount,
    observedWebMcpToolNames: artifact.observedWebMcpToolNames,
    finalAuthoritativeReadReceiptDigest: artifact.finalAuthoritativeReadReceiptDigest,
    taskTraceObservationEvidenceDigest: artifact.taskTraceObservationEvidenceDigest,
    finalAuthoritativeReadResultDigest: artifact.finalAuthoritativeReadResultDigest,
    modelTerminalResultDigest: artifact.modelTerminalResultDigest,
    modelTerminalJsonDigest: artifact.modelTerminalJsonDigest,
    semanticStateDigest: artifact.semanticStateDigest,
    canvasImageDigest: artifact.canvasImageDigest,
    webMcpTraceDigest: artifact.webMcpTraceDigest,
  });
  if (artifact.artifactRoot !== expected) {
    context.addIssue({ code: "custom", path: ["artifactRoot"], message: "Independent author artifact root is invalid." });
  }
});

const reviewTerminalArtifactSchema = z.object({
  kind: z.enum(["primary-review-result", "adjudication-result", "pairwise-visual-result"]),
  evidenceSource: z.literal("independent-coordinator"),
  codexTaskId: idSchema,
  subjectEvidenceRoot: digestSchema,
  modelTerminalResultDigest: digestSchema,
  resultDigest: digestSchema,
  artifactRoot: digestSchema,
}).strict().superRefine((artifact, context) => {
  const expected = hashCanonicalJson({
    kind: artifact.kind,
    evidenceSource: artifact.evidenceSource,
    codexTaskId: artifact.codexTaskId,
    subjectEvidenceRoot: artifact.subjectEvidenceRoot,
    modelTerminalResultDigest: artifact.modelTerminalResultDigest,
    resultDigest: artifact.resultDigest,
  });
  if (artifact.artifactRoot !== expected) {
    context.addIssue({ code: "custom", path: ["artifactRoot"], message: "Independent review artifact root is invalid." });
  }
});

export const exp0001aCodexTerminalArtifactSchema = z.union([
  authorTerminalArtifactSchema,
  reviewTerminalArtifactSchema,
]);
export type Exp0001aCodexTerminalArtifact = z.infer<typeof exp0001aCodexTerminalArtifactSchema>;

export function createExp0001aIndependentAuthorArtifact(input: {
  plan: Exp0001aCodexTaskTransportPlan;
  lifecycle: Exp0001aCodexTaskLifecycle;
  modelTerminalResultDigest: string;
  modelTerminalJson: JsonValue;
  finalAuthoritativeRoomReadReceipt: Exp0001aAuthorFinalRoomReadReceipt;
  taskTraceObservation: Exp0001aCodexTaskTraceObservation;
}): Extract<Exp0001aCodexTerminalArtifact, { kind: "author-artifact-result" }> {
  const plan = exp0001aCodexTaskTransportPlanSchema.parse(input.plan);
  const lifecycle = exp0001aCodexTaskLifecycleSchema.parse(input.lifecycle);
  if (plan.role !== "author" || plan.envelope.role !== "author" || lifecycle.planDigest !== plan.planDigest
      || lifecycle.codexTaskId === null) throw new Error("AUTHOR_ARTIFACT_COORDINATOR_BINDING_INVALID");
  const terminalJson = authorTerminalJsonSchema.parse(input.modelTerminalJson);
  const roomRead = exp0001aAuthorFinalRoomReadReceiptSchema.parse(input.finalAuthoritativeRoomReadReceipt);
  const trace = exp0001aCodexTaskTraceObservationSchema.parse(input.taskTraceObservation);
  if (roomRead.roomId !== plan.envelope.roomId
      || roomRead.privateRoomAccessBindingDigest !== plan.envelope.privateRoomAccessBindingDigest
      || roomRead.authorPlanDigest !== plan.planDigest
      || roomRead.transportId !== plan.transportId
      || roomRead.codexTaskId !== lifecycle.codexTaskId
      || trace.codexTaskId !== lifecycle.codexTaskId
      || trace.completeness !== "complete-retained-trace"
      || trace.webMcpToolNames === "unobservable") {
    throw new Error("AUTHOR_TERMINAL_INDEPENDENT_EVIDENCE_BINDING_INVALID");
  }
  if (terminalJson.finalAuthoritativeRead.roomRevision !== roomRead.roomRevision
      || terminalJson.finalAuthoritativeRead.objectCount !== roomRead.objectCount) {
    throw new Error("AUTHOR_TERMINAL_CLAIM_AND_AUTHORITATIVE_STATE_DIFFER");
  }
  if (!exactStringSet(terminalJson.webMcpToolsUsed, trace.webMcpToolNames)) {
    throw new Error("AUTHOR_TERMINAL_TOOL_CLAIM_AND_RETAINED_TRACE_DIFFER");
  }
  const content = {
    evidenceSource: "independent-coordinator" as const,
    codexTaskId: lifecycle.codexTaskId,
    roomId: plan.envelope.roomId,
    roomProvisioningReceiptDigest: plan.envelope.roomProvisioningReceiptDigest,
    privateRoomAccessBindingDigest: plan.envelope.privateRoomAccessBindingDigest,
    authoritativeRoomRevision: roomRead.roomRevision,
    authoritativeObjectCount: roomRead.objectCount,
    observedWebMcpToolNames: [...trace.webMcpToolNames].sort(),
    finalAuthoritativeReadReceiptDigest: roomRead.receiptDigest,
    taskTraceObservationEvidenceDigest: trace.observationEvidenceDigest,
    finalAuthoritativeReadResultDigest: roomRead.readResultDigest,
    modelTerminalResultDigest: input.modelTerminalResultDigest,
    modelTerminalJsonDigest: hashCanonicalJson(terminalJson),
    semanticStateDigest: roomRead.semanticStateDigest,
    canvasImageDigest: roomRead.canvasImageDigest,
    webMcpTraceDigest: trace.taskTraceDigest,
  };
  return freezeDeep(authorTerminalArtifactSchema.parse({
    kind: "author-artifact-result",
    ...content,
    artifactRoot: hashCanonicalJson(content),
  }));
}

export function createExp0001aIndependentReviewArtifact(input: {
  plan: Exp0001aCodexTaskTransportPlan;
  lifecycle: Exp0001aCodexTaskLifecycle;
  modelTerminalResultDigest: string;
  result: JsonValue;
}): Extract<Exp0001aCodexTerminalArtifact, { kind: "primary-review-result" | "adjudication-result" | "pairwise-visual-result" }> {
  const plan = exp0001aCodexTaskTransportPlanSchema.parse(input.plan);
  const lifecycle = exp0001aCodexTaskLifecycleSchema.parse(input.lifecycle);
  if (plan.role === "author" || lifecycle.planDigest !== plan.planDigest || lifecycle.codexTaskId === null) {
    throw new Error("REVIEW_ARTIFACT_COORDINATOR_BINDING_INVALID");
  }
  const result = validateExp0001aCodexTerminalJson(plan, input.result);
  const kind = plan.role === "primary_reviewer"
    ? "primary-review-result" as const
    : plan.role === "adjudicator"
      ? "adjudication-result" as const
      : "pairwise-visual-result" as const;
  const content = {
    kind,
    evidenceSource: "independent-coordinator" as const,
    codexTaskId: lifecycle.codexTaskId,
    subjectEvidenceRoot: expectedSubjectRoot(plan),
    modelTerminalResultDigest: input.modelTerminalResultDigest,
    resultDigest: hashCanonicalJson(result),
  };
  return freezeDeep(reviewTerminalArtifactSchema.parse({ ...content, artifactRoot: hashCanonicalJson(content) }));
}

const observableCountSchema = z.union([z.number().int().nonnegative(), z.literal("unobservable")]);
const observedOriginSchema = z.string().url().superRefine((value, context) => {
  const url = new URL(value);
  if (url.origin !== value || url.username || url.password || url.search || url.hash) {
    context.addIssue({ code: "custom", message: "Trace origins must be exact credential-free origins." });
  }
});

export const exp0001aCodexTaskTraceObservationSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("codex-retained-task-trace-observation"),
  codexTaskId: idSchema,
  capturedAt: timestampSchema,
  completeness: z.enum(["complete-retained-trace", "truncated-or-unobservable"]),
  taskTraceDigest: digestSchema,
  platformBootstrap: z.object({
    skillId: z.union([z.literal(EXP0001A_BROWSER_SKILL_ID), z.literal("unobservable")]),
    skillVersion: z.union([z.literal(EXP0001A_BROWSER_SKILL_VERSION), z.literal("unobservable")]),
    skillDigest: z.union([z.literal(EXP0001A_BROWSER_SKILL_DIGEST), z.literal("unobservable")]),
    resolvedSkillPathDigest: z.union([digestSchema, z.literal("unobservable")]),
    skillReadCount: observableCountSchema,
  }).strict(),
  commandExecutionCount: observableCountSchema,
  otherCommandExecutionCount: observableCountSchema,
  filesystemReadCount: observableCountSchema,
  filesystemWriteCount: observableCountSchema,
  repositoryReadCount: observableCountSchema,
  privateApiRequestCount: observableCountSchema,
  directHttpRequestCount: observableCountSchema,
  preexistingBrowserContextUsed: z.union([z.boolean(), z.literal("unobservable")]),
  browserOrigins: z.union([z.array(observedOriginSchema).max(16), z.literal("unobservable")]),
  jazzboardBrowserNavigationCount: observableCountSchema,
  jazzboardRoomIdsAccessed: z.union([z.array(roomIdSchema).max(16), z.literal("unobservable")]),
  jazzboardRoomAccessBindingDigests: z.union([z.array(digestSchema).max(16), z.literal("unobservable")]),
  jazzboardInviteUrlDigests: z.union([z.array(digestSchema).max(16), z.literal("unobservable")]),
  webMcpCallCount: observableCountSchema,
  webMcpFailureCount: observableCountSchema,
  webMcpToolNames: z.union([
    z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).max(256),
    z.literal("unobservable"),
  ]),
  webMcpOrigins: z.union([z.array(observedOriginSchema).max(16), z.literal("unobservable")]),
  openedArtifactPacketManifestDigest: z.union([digestSchema, z.null(), z.literal("unobservable")]),
  openedArtifactPacketFileDigests: z.union([z.array(digestSchema).max(14), z.null(), z.literal("unobservable")]),
  observationEvidenceDigest: digestSchema,
}).strict();
export type Exp0001aCodexTaskTraceObservation = z.infer<typeof exp0001aCodexTaskTraceObservationSchema>;

const tracePolicyReceiptContentSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("codex-task-trace-policy-receipt"),
  transportId: opaqueIdSchema,
  codexTaskId: idSchema,
  role: exp0001aCodexTransportRoleSchema,
  evaluatedAt: timestampSchema,
  taskTraceDigest: digestSchema,
  observationEvidenceDigest: digestSchema,
  decision: z.enum(["pass", "policy_violation", "non_evaluable"]),
  reasons: z.array(idSchema).min(1).max(100),
  allowedBrowserOrigins: z.array(observedOriginSchema).max(2),
  allowedWebMcpOrigins: z.array(observedOriginSchema).max(1),
  authorRoomWebMcpToolAllowlistDigest: z.literal(EXP0001A_AUTHOR_ROOM_WEBMCP_TOOL_ALLOWLIST_DIGEST).nullable(),
  artifactPacketManifestDigest: digestSchema.nullable(),
}).strict();

export const exp0001aCodexTaskTracePolicyReceiptSchema = tracePolicyReceiptContentSchema.extend({
  receiptDigest: digestSchema,
}).strict().superRefine((receipt, context) => {
  const { receiptDigest: _receiptDigest, ...content } = receipt;
  void _receiptDigest;
  if (hashCanonicalJson(content) !== receipt.receiptDigest) {
    context.addIssue({ code: "custom", path: ["receiptDigest"], message: "Task trace policy receipt digest is invalid." });
  }
});
export type Exp0001aCodexTaskTracePolicyReceipt = z.infer<typeof exp0001aCodexTaskTracePolicyReceiptSchema>;

function valuesUnobservable(observation: Exp0001aCodexTaskTraceObservation): boolean {
  const scalarCounts = [
    observation.platformBootstrap.skillReadCount,
    observation.commandExecutionCount,
    observation.otherCommandExecutionCount,
    observation.filesystemReadCount,
    observation.filesystemWriteCount,
    observation.repositoryReadCount,
    observation.privateApiRequestCount,
    observation.directHttpRequestCount,
    observation.jazzboardBrowserNavigationCount,
    observation.webMcpCallCount,
    observation.webMcpFailureCount,
  ];
  return observation.completeness !== "complete-retained-trace"
    || observation.platformBootstrap.skillId === "unobservable"
    || observation.platformBootstrap.skillVersion === "unobservable"
    || observation.platformBootstrap.skillDigest === "unobservable"
    || observation.platformBootstrap.resolvedSkillPathDigest === "unobservable"
    || scalarCounts.some((value) => value === "unobservable")
    || observation.preexistingBrowserContextUsed === "unobservable"
    || observation.browserOrigins === "unobservable"
    || observation.jazzboardRoomIdsAccessed === "unobservable"
    || observation.jazzboardRoomAccessBindingDigests === "unobservable"
    || observation.jazzboardInviteUrlDigests === "unobservable"
    || observation.webMcpToolNames === "unobservable"
    || observation.webMcpOrigins === "unobservable"
    || observation.openedArtifactPacketManifestDigest === "unobservable"
    || observation.openedArtifactPacketFileDigests === "unobservable";
}

function exactStringSet(values: readonly string[], expected: readonly string[]): boolean {
  return values.length === expected.length && [...values].sort().every((value, index) => value === [...expected].sort()[index]);
}

export function evaluateExp0001aCodexTaskTracePolicy(input: {
  plan: Exp0001aCodexTaskTransportPlan;
  lifecycle: Exp0001aCodexTaskLifecycle;
  evaluatedAt: string;
  observation: Exp0001aCodexTaskTraceObservation;
}): Exp0001aCodexTaskTracePolicyReceipt {
  const plan = exp0001aCodexTaskTransportPlanSchema.parse(input.plan);
  const lifecycle = exp0001aCodexTaskLifecycleSchema.parse(input.lifecycle);
  const observation = exp0001aCodexTaskTraceObservationSchema.parse(input.observation);
  if (lifecycle.planDigest !== plan.planDigest || lifecycle.codexTaskId === null
      || observation.codexTaskId !== lifecycle.codexTaskId) {
    throw new Error("TASK_TRACE_OBSERVATION_NOT_BOUND_TO_CODEX_TASK");
  }
  const packet = packetForEnvelope(plan.envelope);
  const allowedBrowserOrigins = plan.role === "author"
    ? ["https://www.jazzboard.xyz"]
    : [new URL(packet!.origin).origin];
  const allowedWebMcpOrigins = plan.role === "author" ? ["https://www.jazzboard.xyz"] : [];
  const reasons: string[] = [];
  if (hashCanonicalJson(EXP0001A_AUTHOR_ROOM_WEBMCP_TOOL_ALLOWLIST) !== EXP0001A_AUTHOR_ROOM_WEBMCP_TOOL_ALLOWLIST_DIGEST) {
    throw new Error("FROZEN_AUTHOR_WEBMCP_TOOL_ALLOWLIST_DIGEST_MISMATCH");
  }
  if (valuesUnobservable(observation)) {
    reasons.push("TASK_TRACE_INCOMPLETE_OR_UNOBSERVABLE");
  } else {
    if (observation.platformBootstrap.skillId !== EXP0001A_BROWSER_SKILL_ID
        || observation.platformBootstrap.skillVersion !== EXP0001A_BROWSER_SKILL_VERSION
        || observation.platformBootstrap.skillDigest !== EXP0001A_BROWSER_SKILL_DIGEST
        || observation.platformBootstrap.skillReadCount !== 1
        || observation.commandExecutionCount !== 1
        || observation.otherCommandExecutionCount !== 0
        || observation.filesystemReadCount !== 1
        || observation.filesystemWriteCount !== 0
        || observation.repositoryReadCount !== 0
        || observation.privateApiRequestCount !== 0
        || observation.directHttpRequestCount !== 0) {
      reasons.push("TASK_TRACE_NON_BROWSER_BOOTSTRAP_OR_FORBIDDEN_ACCESS");
    }
    const browserOrigins = observation.browserOrigins as string[];
    const roomIdsAccessed = observation.jazzboardRoomIdsAccessed as string[];
    const roomBindingsAccessed = observation.jazzboardRoomAccessBindingDigests as string[];
    const inviteDigestsOpened = observation.jazzboardInviteUrlDigests as string[];
    const webMcpToolNames = observation.webMcpToolNames as string[];
    const webMcpOrigins = observation.webMcpOrigins as string[];
    const openedPacketFileDigests = observation.openedArtifactPacketFileDigests as string[] | null;
    if (new Set(webMcpToolNames).size !== webMcpToolNames.length
        || [...webMcpToolNames].sort().some((value, index) => value !== webMcpToolNames[index])) {
      reasons.push("TASK_TRACE_WEBMCP_TOOL_NAMES_NOT_UNIQUE_SORTED");
    }
    if (!exactStringSet(browserOrigins, allowedBrowserOrigins)) reasons.push("TASK_TRACE_BROWSER_ORIGIN_NOT_ALLOWLISTED");
    if (!exactStringSet(webMcpOrigins, allowedWebMcpOrigins)) reasons.push("TASK_TRACE_WEBMCP_ORIGIN_NOT_ALLOWLISTED");
    if (plan.role === "author") {
      const authorEnvelope = plan.envelope as Extract<Exp0001aCodexTaskEnvelope, { role: "author" }>;
      if (typeof observation.webMcpCallCount !== "number" || observation.webMcpCallCount < 2
          || observation.webMcpFailureCount !== 0
          || webMcpToolNames.length < 2
          || typeof observation.jazzboardBrowserNavigationCount !== "number" || observation.jazzboardBrowserNavigationCount < 1
          || observation.openedArtifactPacketManifestDigest !== null || openedPacketFileDigests !== null) {
        reasons.push("AUTHOR_TRACE_MISSING_WEBMCP_OR_CONTAINS_REVIEW_PACKET");
      }
      const authorAllowlist = new Set<string>(["join_room", ...EXP0001A_AUTHOR_ROOM_WEBMCP_TOOL_ALLOWLIST]);
      if (webMcpToolNames.some((toolName) => !authorAllowlist.has(toolName))) {
        reasons.push("AUTHOR_TRACE_WEBMCP_TOOL_NOT_IN_FROZEN_ALLOWLIST");
      }
      if (observation.preexistingBrowserContextUsed !== false
          || !exactStringSet(roomIdsAccessed, [authorEnvelope.roomId])
          || !exactStringSet(roomBindingsAccessed, [authorEnvelope.privateRoomAccessBindingDigest])
          || !exactStringSet(inviteDigestsOpened, [hashCanonicalJson(authorEnvelope.privateRoomUrl)])) {
        reasons.push("AUTHOR_TRACE_ACCESSED_UNBOUND_ROOM_OR_SHARED_BROWSER_CONTEXT");
      }
    } else if (observation.webMcpCallCount !== 0 || observation.webMcpFailureCount !== 0 || webMcpToolNames.length !== 0
        || observation.jazzboardBrowserNavigationCount !== 0
        || observation.preexistingBrowserContextUsed !== false
        || roomIdsAccessed.length !== 0 || roomBindingsAccessed.length !== 0 || inviteDigestsOpened.length !== 0
        || observation.openedArtifactPacketManifestDigest !== packet!.manifestDigest
        || openedPacketFileDigests === null
        || !exactStringSet(openedPacketFileDigests, packet!.files.map((file) => file.sha256))) {
      reasons.push("REVIEW_TRACE_ACCESSED_JAZZBOARD_OR_WRONG_EVIDENCE_PACKET");
    }
  }
  const decision = reasons.length === 0
    ? "pass" as const
    : reasons.includes("TASK_TRACE_INCOMPLETE_OR_UNOBSERVABLE")
      ? "non_evaluable" as const
      : "policy_violation" as const;
  const content = tracePolicyReceiptContentSchema.parse({
    schemaVersion: 1,
    kind: "codex-task-trace-policy-receipt",
    transportId: plan.transportId,
    codexTaskId: lifecycle.codexTaskId,
    role: plan.role,
    evaluatedAt: input.evaluatedAt,
    taskTraceDigest: observation.taskTraceDigest,
    observationEvidenceDigest: observation.observationEvidenceDigest,
    decision,
    reasons: reasons.length === 0 ? ["COMPLETE_TASK_TRACE_SATISFIES_ROLE_ALLOWLIST"] : reasons,
    allowedBrowserOrigins,
    allowedWebMcpOrigins,
    authorRoomWebMcpToolAllowlistDigest: plan.role === "author" ? EXP0001A_AUTHOR_ROOM_WEBMCP_TOOL_ALLOWLIST_DIGEST : null,
    artifactPacketManifestDigest: packet?.manifestDigest ?? null,
  });
  return freezeDeep(exp0001aCodexTaskTracePolicyReceiptSchema.parse({
    ...content,
    receiptDigest: hashCanonicalJson(content),
  }));
}

const rawReadThreadPageSchema = z.object({
  schemaVersion: z.literal(1),
  thread: z.object({
    id: idSchema,
    hostId: idSchema,
  }).passthrough(),
  page: z.object({
    order: z.literal("newest_first"),
    limit: z.literal(EXP0001A_CODEX_READ_THREAD_TURN_LIMIT),
    nextCursor: cursorSchema.nullable(),
    hasMore: z.boolean(),
  }).passthrough(),
  turns: z.array(z.object({
    id: idSchema,
    status: z.string().min(1).max(100),
    items: z.array(jsonValueSchema).max(100_000),
  }).passthrough()).max(EXP0001A_CODEX_READ_THREAD_TURN_LIMIT),
}).passthrough().superRefine((page, context) => {
  if (page.page.hasMore !== (page.page.nextCursor !== null)) {
    context.addIssue({ code: "custom", path: ["page"], message: "Read-thread pagination cursor and hasMore flag disagree." });
  }
});

const readThreadPageReceiptContentSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("codex-read-thread-page-receipt"),
  transportId: opaqueIdSchema,
  commandDigest: digestSchema,
  observedAt: timestampSchema,
  codexTaskId: idSchema,
  pageIndex: z.number().int().nonnegative().max(EXP0001A_CODEX_READ_THREAD_MAX_PAGES - 1),
  requestedCursor: cursorSchema.nullable(),
  nextCursor: cursorSchema.nullable(),
  hasMore: z.boolean(),
  callOutcome: z.enum(["success", "error", "malformed"]),
  rawCallResultDigest: digestSchema,
  rawCallResult: jsonValueSchema,
  rawResultDigest: digestSchema.nullable(),
  rawResult: jsonValueSchema.nullable(),
  agentFinalMessageCount: z.number().int().nonnegative().max(EXP0001A_CODEX_READ_THREAD_TURN_LIMIT),
  transportTruncationDetected: z.boolean(),
}).strict();

export const exp0001aCodexReadThreadPageReceiptSchema = readThreadPageReceiptContentSchema.extend({
  receiptDigest: digestSchema,
}).strict().superRefine((receipt, context) => {
  const { receiptDigest: _receiptDigest, ...content } = receipt;
  void _receiptDigest;
  if (hashCanonicalJson(content) !== receipt.receiptDigest
      || hashCanonicalJson(receipt.rawCallResult) !== receipt.rawCallResultDigest
      || (receipt.rawResult === null ? receipt.rawResultDigest !== null : hashCanonicalJson(receipt.rawResult) !== receipt.rawResultDigest)
      || receipt.hasMore !== (receipt.nextCursor !== null)) {
    context.addIssue({ code: "custom", path: ["receiptDigest"], message: "read_thread page receipt binding is invalid." });
  }
  if (receipt.callOutcome === "malformed") {
    if (receipt.hasMore || receipt.nextCursor !== null || receipt.agentFinalMessageCount !== 0
        || receipt.transportTruncationDetected) {
      context.addIssue({ code: "custom", path: ["callOutcome"], message: "A malformed read_thread result cannot assert parsed page metadata." });
    }
    return;
  }
  try {
    const retained = retainExactCodexAppCallResult(receipt.rawCallResult);
    const successful = !retained.isError && retained.payload !== null;
    if (retained.rawResultDigest !== receipt.rawCallResultDigest
        || receipt.callOutcome !== (successful ? "success" : "error")
        || (successful && (retained.payloadDigest !== receipt.rawResultDigest
          || canonicalJson(retained.payload) !== canonicalJson(receipt.rawResult)))
        || (!successful && (receipt.rawResult !== null || receipt.rawResultDigest !== null
          || receipt.hasMore || receipt.nextCursor !== null || receipt.agentFinalMessageCount !== 0))) {
      context.addIssue({ code: "custom", path: ["rawCallResult"], message: "Raw read_thread page is not the exact successful Codex-app payload." });
    }
  } catch (error) {
    context.addIssue({ code: "custom", path: ["rawCallResult"], message: error instanceof Error ? error.message : "Raw read_thread CallToolResult is invalid." });
  }
});
export type Exp0001aCodexReadThreadPageReceipt = z.infer<typeof exp0001aCodexReadThreadPageReceiptSchema>;

const readThreadReceiptContentSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("codex-read-thread-receipt"),
  transportId: opaqueIdSchema,
  commandDigest: digestSchema,
  observedAt: timestampSchema,
  codexTaskId: idSchema,
  outcome: z.enum(["retained", "unavailable"]),
  terminalResultDigest: digestSchema.nullable(),
  terminalJson: jsonValueSchema.nullable(),
  taskTraceDigest: digestSchema.nullable(),
  taskTraceObservation: exp0001aCodexTaskTraceObservationSchema.nullable(),
  tracePolicyReceipt: exp0001aCodexTaskTracePolicyReceiptSchema.nullable(),
  terminalArtifact: exp0001aCodexTerminalArtifactSchema.nullable(),
  authorFinalRoomReadReceipt: exp0001aAuthorFinalRoomReadReceiptSchema.nullable(),
  authorFinalEvidence: exp0001aAuthorFinalReviewEvidenceSchema.nullable(),
  retainedPageCount: z.number().int().positive().max(EXP0001A_CODEX_READ_THREAD_MAX_PAGES),
  pageReceiptRoot: digestSchema,
  cursorExhausted: z.boolean(),
  transportTruncationDetected: z.boolean(),
  evidenceDigest: digestSchema,
  failureCode: idSchema.nullable(),
}).strict().superRefine((receipt, context) => {
  const rawAuthorEvidence = receipt.authorFinalRoomReadReceipt;
  const projectedAuthorEvidence = receipt.authorFinalEvidence;
  const hasExactlyBoundAuthorEvidence = rawAuthorEvidence !== null && projectedAuthorEvidence !== null
    && projectedAuthorEvidence.sourceFinalRoomReadReceiptDigest === rawAuthorEvidence.receiptDigest
    && projectedAuthorEvidence.sourceRetainedEvidenceDigest === rawAuthorEvidence.retainedEvidenceDigest
    && projectedAuthorEvidence.roomRevision === rawAuthorEvidence.roomRevision
    && projectedAuthorEvidence.semanticState.sha256 === rawAuthorEvidence.semanticStateDigest
    && projectedAuthorEvidence.finalImage.sha256 === rawAuthorEvidence.canvasImageDigest
    && projectedAuthorEvidence.finalImage.bytes === rawAuthorEvidence.canvasImageBytes
    && projectedAuthorEvidence.finalImage.width === rawAuthorEvidence.canvasImageWidth
    && projectedAuthorEvidence.finalImage.height === rawAuthorEvidence.canvasImageHeight
    && projectedAuthorEvidence.finalImage.pngBytesBase64 === rawAuthorEvidence.canvasImagePngBase64;
  if ((rawAuthorEvidence === null) !== (projectedAuthorEvidence === null)
      || (rawAuthorEvidence !== null && !hasExactlyBoundAuthorEvidence)) {
    context.addIssue({ code: "custom", path: ["authorFinalEvidence"], message: "Retained author evidence must be one exact raw/projected pair." });
  }
  if (receipt.evidenceDigest !== receipt.pageReceiptRoot) {
    context.addIssue({ code: "custom", path: ["evidenceDigest"], message: "Read evidence must equal the retained page receipt root." });
  }
  if (receipt.outcome === "retained") {
    if (receipt.taskTraceDigest === null || receipt.taskTraceObservation === null || receipt.tracePolicyReceipt === null
        || receipt.taskTraceObservation.taskTraceDigest !== receipt.taskTraceDigest
        || receipt.taskTraceObservation.observationEvidenceDigest !== receipt.pageReceiptRoot
        || receipt.tracePolicyReceipt.taskTraceDigest !== receipt.taskTraceDigest
        || receipt.tracePolicyReceipt.observationEvidenceDigest !== receipt.pageReceiptRoot
        || receipt.transportTruncationDetected || !receipt.cursorExhausted) {
      context.addIssue({ code: "custom", message: "A retained read requires a complete bound task trace." });
    }
    if ((receipt.terminalArtifact === null) !== (receipt.terminalJson === null)) {
      context.addIssue({ code: "custom", path: ["terminalJson"], message: "A retained accepted artifact and exact terminal JSON must be stored together." });
    } else if (receipt.terminalArtifact !== null && receipt.terminalJson !== null) {
      if (receipt.terminalResultDigest === null) {
        context.addIssue({ code: "custom", path: ["terminalResultDigest"], message: "An accepted terminal artifact requires exact retained terminal text." });
      }
      const digest = hashCanonicalJson(receipt.terminalJson);
      if ((receipt.terminalArtifact.kind === "author-artifact-result" && receipt.terminalArtifact.modelTerminalJsonDigest !== digest)
          || (receipt.terminalArtifact.kind !== "author-artifact-result" && receipt.terminalArtifact.resultDigest !== digest)) {
        context.addIssue({ code: "custom", path: ["terminalJson"], message: "Retained terminal JSON is not bound to its independent artifact." });
      }
    }
    if (receipt.terminalArtifact?.kind === "author-artifact-result") {
      const raw = receipt.authorFinalRoomReadReceipt;
      const review = receipt.authorFinalEvidence;
      if (raw === null || review === null
          || raw.receiptDigest !== receipt.terminalArtifact.finalAuthoritativeReadReceiptDigest
          || raw.semanticStateDigest !== receipt.terminalArtifact.semanticStateDigest
          || raw.canvasImageDigest !== receipt.terminalArtifact.canvasImageDigest
          || !hasExactlyBoundAuthorEvidence) {
        context.addIssue({ code: "custom", path: ["authorFinalEvidence"], message: "Author final review evidence is not bound to retained raw coordinator evidence." });
      }
    } else if (receipt.terminalArtifact !== null && receipt.authorFinalRoomReadReceipt !== null) {
      context.addIssue({ code: "custom", path: ["authorFinalEvidence"], message: "A non-author artifact cannot retain author room evidence." });
    }
    if ((receipt.terminalArtifact === null) !== (receipt.failureCode !== null)) {
      context.addIssue({ code: "custom", path: ["failureCode"], message: "A retained read must record either one accepted artifact or one canonical evaluation failure." });
    }
  } else if (receipt.terminalResultDigest !== null || receipt.terminalJson !== null || receipt.taskTraceDigest !== null
      || receipt.taskTraceObservation !== null || receipt.tracePolicyReceipt !== null
      || receipt.terminalArtifact !== null || receipt.failureCode === null) {
    context.addIssue({ code: "custom", message: "An unavailable read may retain only its failure evidence." });
  }
});

export const exp0001aCodexReadThreadReceiptSchema = readThreadReceiptContentSchema.extend({ receiptDigest: digestSchema }).strict()
  .superRefine((receipt, context) => {
    const { receiptDigest: _receiptDigest, ...content } = receipt;
    void _receiptDigest;
    if (hashCanonicalJson(content) !== receipt.receiptDigest) {
      context.addIssue({ code: "custom", path: ["receiptDigest"], message: "read_thread receipt digest is invalid." });
    }
  });
export type Exp0001aCodexReadThreadReceipt = z.infer<typeof exp0001aCodexReadThreadReceiptSchema>;

export const exp0001aCodexTransportStateSchema = z.enum([
  "not_started_usage_limited",
  "not_started_failed",
  "creation_uncertain",
  "running",
  "awaiting_terminal_read",
  "terminal",
]);

const lifecycleContentSchema = z.object({
  schemaVersion: z.literal(EXP0001A_CODEX_TASK_TRANSPORT_VERSION),
  kind: z.literal("codex-isolated-task-lifecycle"),
  planDigest: digestSchema,
  transportId: opaqueIdSchema,
  role: exp0001aCodexTransportRoleSchema,
  state: exp0001aCodexTransportStateSchema,
  taskBegun: z.boolean(),
  codexTaskId: idSchema.nullable(),
  threadId: idSchema.nullable(),
  hostId: idSchema.nullable(),
  latestCursor: cursorSchema.nullable(),
  latestReadCursor: cursorSchema.nullable(),
  releaseInvocationReceipt: exp0001aCodexReleaseInvocationReceiptSchema,
  createReceipt: exp0001aCodexCreateThreadReceiptSchema,
  reconciliationReceipts: z.array(exp0001aCodexCreateReconciliationReceiptSchema).max(1_000),
  waitReceipts: z.array(exp0001aCodexWaitThreadsReceiptSchema).max(10_000),
  readPageReceipts: z.array(exp0001aCodexReadThreadPageReceiptSchema).max(EXP0001A_CODEX_READ_THREAD_MAX_PAGES),
  readReceipt: exp0001aCodexReadThreadReceiptSchema.nullable(),
  terminalOutcome: z.enum([
    "succeeded",
    "needs_attention",
    "usage_limit_interrupted",
    "infra_failure",
    "policy_violation",
    "non_evaluable",
  ]).nullable(),
}).strict().superRefine((record, context) => {
  const taskIdentityComplete = record.codexTaskId !== null && record.threadId !== null && record.hostId !== null;
  const uncertainIdentity = record.state === "creation_uncertain" && record.taskBegun
    && record.codexTaskId === null && record.threadId === null && record.hostId === null;
  if ((!uncertainIdentity && record.taskBegun !== taskIdentityComplete)
      || (record.codexTaskId !== null && record.codexTaskId !== record.threadId)) {
    context.addIssue({ code: "custom", message: "Lifecycle task-begun state and task identity are inconsistent." });
  }
  if ((record.state === "not_started_usage_limited" || record.state === "not_started_failed")
      && (record.taskBegun || record.reconciliationReceipts.length > 0 || record.waitReceipts.length > 0
        || record.readPageReceipts.length > 0 || record.readReceipt !== null || record.terminalOutcome !== null)) {
    context.addIssue({ code: "custom", message: "A pre-creation stop must remain genuinely unstarted." });
  }
  if (record.state === "creation_uncertain" && (!record.taskBegun || !uncertainIdentity
      || record.createReceipt.outcome !== "uncertain_after_release" || record.waitReceipts.length > 0
      || record.readPageReceipts.length > 0 || record.readReceipt !== null || record.terminalOutcome !== null)) {
    context.addIssue({ code: "custom", message: "An uncertain create is a begun retained assignment without a reusable task identity." });
  }
  if (record.state === "running" && (!record.taskBegun || record.readPageReceipts.length > 0
      || record.latestReadCursor !== null || record.readReceipt !== null || record.terminalOutcome !== null)) {
    context.addIssue({ code: "custom", message: "A running task must be begun and cannot have a terminal read." });
  }
  if (record.state === "awaiting_terminal_read" && (!record.taskBegun || record.waitReceipts.at(-1)?.outcome === "timeout"
      || record.readReceipt !== null || record.terminalOutcome !== null)) {
    context.addIssue({ code: "custom", message: "A task awaiting terminal read requires a non-timeout wait result." });
  }
  if (record.state === "terminal" && (!record.taskBegun || record.readReceipt === null || record.terminalOutcome === null)) {
    context.addIssue({ code: "custom", message: "A terminal task requires a retained read receipt and terminal outcome." });
  }
  if (record.waitReceipts.some((receipt) => receipt.codexTaskId !== record.codexTaskId)
      || record.readPageReceipts.some((receipt) => receipt.codexTaskId !== record.codexTaskId)
      || (record.readReceipt !== null && record.readReceipt.codexTaskId !== record.codexTaskId)) {
    context.addIssue({ code: "custom", message: "All lifecycle receipts must bind to the same Codex task." });
  }
  record.readPageReceipts.forEach((receipt, index) => {
    const prior = record.readPageReceipts[index - 1];
    if (receipt.pageIndex !== index
        || receipt.requestedCursor !== (prior?.nextCursor ?? null)) {
      context.addIssue({ code: "custom", path: ["readPageReceipts", index], message: "Read-thread pages are not one exact cursor chain." });
    }
  });
  const lastReadPage = record.readPageReceipts.at(-1);
  if (record.state === "awaiting_terminal_read" && lastReadPage !== undefined
      && (!lastReadPage.hasMore || record.latestReadCursor !== lastReadPage.nextCursor)) {
    context.addIssue({ code: "custom", message: "An awaiting paginated read must retain the exact non-exhausted next cursor." });
  }
  if (record.state === "terminal" && lastReadPage === undefined) {
    context.addIssue({ code: "custom", message: "A terminal read requires at least one retained raw page." });
  }
  if (record.releaseInvocationReceipt.receiptDigest !== record.createReceipt.releaseInvocationReceiptDigest) {
    context.addIssue({ code: "custom", message: "Create result is not bound to the journaled release invocation." });
  }
});

export const exp0001aCodexTaskLifecycleSchema = lifecycleContentSchema.extend({ lifecycleDigest: digestSchema }).strict()
  .superRefine((record, context) => {
    const { lifecycleDigest: _lifecycleDigest, ...content } = record;
    void _lifecycleDigest;
    if (hashCanonicalJson(content) !== record.lifecycleDigest) {
      context.addIssue({ code: "custom", path: ["lifecycleDigest"], message: "Lifecycle digest is invalid." });
    }
  });
export type Exp0001aCodexTaskLifecycle = z.infer<typeof exp0001aCodexTaskLifecycleSchema>;

/**
 * Resolves the only reviewer-visible author state from an exact retained,
 * successful author lifecycle. No semantic JSON or image metadata is accepted
 * from the caller.
 */
export function deriveExp0001aFinalOnlyReviewEvidence(input: {
  plan: Exp0001aCodexTaskTransportPlan;
  lifecycle: Exp0001aCodexTaskLifecycle;
}): Exp0001aAuthorFinalReviewEvidence {
  const plan = exp0001aCodexTaskTransportPlanSchema.parse(input.plan);
  const lifecycle = exp0001aCodexTaskLifecycleSchema.parse(input.lifecycle);
  const receipt = lifecycle.readReceipt;
  if (plan.role !== "author" || plan.envelope.role !== "author"
      || lifecycle.planDigest !== plan.planDigest || lifecycle.transportId !== plan.transportId
      || lifecycle.state !== "terminal" || lifecycle.terminalOutcome !== "succeeded"
      || lifecycle.codexTaskId === null || receipt === null || receipt.outcome !== "retained"
      || receipt.tracePolicyReceipt?.decision !== "pass"
      || receipt.terminalArtifact?.kind !== "author-artifact-result"
      || receipt.terminalArtifact.codexTaskId !== lifecycle.codexTaskId
      || receipt.authorFinalRoomReadReceipt === null || receipt.authorFinalEvidence === null) {
    throw new Error("FINAL_ONLY_REVIEW_EVIDENCE_REQUIRES_EXACT_RETAINED_AUTHOR_SUCCESS");
  }
  const raw = exp0001aAuthorFinalRoomReadReceiptSchema.parse(receipt.authorFinalRoomReadReceipt);
  const evidence = exp0001aAuthorFinalReviewEvidenceSchema.parse(receipt.authorFinalEvidence);
  if (raw.roomId !== plan.envelope.roomId
      || raw.privateRoomAccessBindingDigest !== plan.envelope.privateRoomAccessBindingDigest
      || raw.receiptDigest !== receipt.terminalArtifact.finalAuthoritativeReadReceiptDigest
      || evidence.sourceFinalRoomReadReceiptDigest !== raw.receiptDigest
      || evidence.sourceRetainedEvidenceDigest !== raw.retainedEvidenceDigest
      || evidence.semanticState.sha256 !== receipt.terminalArtifact.semanticStateDigest
      || evidence.finalImage.sha256 !== receipt.terminalArtifact.canvasImageDigest) {
    throw new Error("FINAL_ONLY_REVIEW_EVIDENCE_AUTHOR_LIFECYCLE_BINDING_INVALID");
  }
  return freezeDeep(evidence);
}

function sealLifecycle(contentInput: z.input<typeof lifecycleContentSchema>): Exp0001aCodexTaskLifecycle {
  const content = lifecycleContentSchema.parse(contentInput);
  return freezeDeep(exp0001aCodexTaskLifecycleSchema.parse({ ...content, lifecycleDigest: hashCanonicalJson(content) }));
}

function sealReceipt<T extends Record<string, unknown>>(schema: z.ZodType<T>, content: Omit<T, "receiptDigest">): T {
  return schema.parse({ ...content, receiptDigest: hashCanonicalJson(content) });
}

export function recordExp0001aCreateThreadResult(input: {
  plan: Exp0001aCodexTaskTransportPlan;
  releaseInvocationReceipt: Exp0001aCodexReleaseInvocationReceipt;
  observedAt: string;
  rawResult: unknown;
  priorCodexTaskIds?: ReadonlySet<string>;
}): Exp0001aCodexTaskLifecycle {
  const plan = exp0001aCodexTaskTransportPlanSchema.parse(input.plan);
  const releaseInvocationReceipt = exp0001aCodexReleaseInvocationReceiptSchema.parse(input.releaseInvocationReceipt);
  if (releaseInvocationReceipt.planDigest !== plan.planDigest
      || releaseInvocationReceipt.transportId !== plan.transportId
      || releaseInvocationReceipt.commandDigest !== plan.createThreadCommand.commandDigest) {
    throw new Error("CODEX_RELEASE_INVOCATION_NOT_BOUND_TO_PLAN");
  }
  if (Date.parse(input.observedAt) < Date.parse(releaseInvocationReceipt.invokedAt)) {
    throw new Error("CODEX_CREATE_RECEIPT_PRECEDES_COMMAND");
  }
  if (Date.parse(input.observedAt) > Date.parse(releaseInvocationReceipt.mustInvokeBy)) {
    // The batch boundary runs a fresh auth preflight when it prepares and
    // acknowledges the external create dispatch, and again before ingestion.
    // Refusing late ingestion prevents a locally minted release receipt from
    // authorizing an arbitrarily delayed create under a different auth state.
    throw new Error("CODEX_CREATE_RESULT_OUTSIDE_FRESH_AUTH_RELEASE_WINDOW");
  }
  const retainedResult = retainExactCodexAppCallResult(input.rawResult);
  const outcome = deriveCreateThreadResult(retainedResult);
  if (outcome.outcome === "ready" && input.priorCodexTaskIds?.has(outcome.threadId!)) {
    throw new Error("CODEX_TASK_ID_NOT_FRESH");
  }
  const taskIdentity = outcome.outcome === "ready"
    ? { codexTaskId: outcome.threadId, threadId: outcome.threadId, hostId: outcome.hostId }
    : { codexTaskId: null, threadId: null, hostId: null };
  const ready = taskIdentity.codexTaskId !== null;
  const receiptContent = createThreadReceiptContentSchema.parse({
    schemaVersion: 1,
    kind: "codex-create-thread-receipt",
    transportId: plan.transportId,
    commandDigest: plan.createThreadCommand.commandDigest,
    observedAt: input.observedAt,
    releaseInvocationReceiptDigest: releaseInvocationReceipt.receiptDigest,
    outcome: outcome.outcome,
    ...taskIdentity,
    rawResult: retainedResult.rawResult,
    rawResultDigest: retainedResult.rawResultDigest,
    payloadDigest: retainedResult.payloadDigest,
    failureCode: outcome.failureCode,
  });
  const createReceipt = sealReceipt(exp0001aCodexCreateThreadReceiptSchema, receiptContent as Omit<Exp0001aCodexCreateThreadReceipt, "receiptDigest">);
  return sealLifecycle({
    schemaVersion: EXP0001A_CODEX_TASK_TRANSPORT_VERSION,
    kind: "codex-isolated-task-lifecycle",
    planDigest: plan.planDigest,
    transportId: plan.transportId,
    role: plan.role,
    state: ready ? "running" : outcome.outcome === "usage_limit" ? "not_started_usage_limited" : "creation_uncertain",
    taskBegun: outcome.outcome !== "usage_limit",
    ...taskIdentity,
    latestCursor: null,
    latestReadCursor: null,
    releaseInvocationReceipt,
    createReceipt,
    reconciliationReceipts: [],
    waitReceipts: [],
    readPageReceipts: [],
    readReceipt: null,
    terminalOutcome: null,
  });
}

export function issueExp0001aCreateReconciliationCommand(input: {
  plan: Exp0001aCodexTaskTransportPlan;
  lifecycle: Exp0001aCodexTaskLifecycle;
  issuedAt: string;
}): Exp0001aCodexListThreadsReconciliationCommand {
  const plan = exp0001aCodexTaskTransportPlanSchema.parse(input.plan);
  const lifecycle = exp0001aCodexTaskLifecycleSchema.parse(input.lifecycle);
  if (lifecycle.planDigest !== plan.planDigest || lifecycle.state !== "creation_uncertain") {
    throw new Error("CODEX_CREATE_NOT_UNCERTAIN");
  }
  const lastObservedAt = lifecycle.reconciliationReceipts.at(-1)?.observedAt ?? lifecycle.createReceipt.observedAt;
  if (Date.parse(input.issuedAt) < Date.parse(lastObservedAt)) throw new Error("CODEX_RECONCILIATION_PRECEDES_PRIOR_RECEIPT");
  const content = listThreadsReconciliationCommandContentSchema.parse({
    schemaVersion: 1,
    toolName: "mcp__codex_app__list_threads",
    transportId: plan.transportId,
    issuedAt: input.issuedAt,
    expectedUniqueTaskTitle: plan.createThreadCommand.arguments.title,
    arguments: { limit: 100 },
  });
  return freezeDeep(exp0001aCodexListThreadsReconciliationCommandSchema.parse({
    ...content,
    commandDigest: hashCanonicalJson(content),
  }));
}

export function recordExp0001aCreateReconciliationResult(input: {
  plan: Exp0001aCodexTaskTransportPlan;
  lifecycle: Exp0001aCodexTaskLifecycle;
  command: Exp0001aCodexListThreadsReconciliationCommand;
  observedAt: string;
  rawResult: unknown;
  priorCodexTaskIds?: ReadonlySet<string>;
}): Exp0001aCodexTaskLifecycle {
  const plan = exp0001aCodexTaskTransportPlanSchema.parse(input.plan);
  const record = exp0001aCodexTaskLifecycleSchema.parse(input.lifecycle);
  const command = exp0001aCodexListThreadsReconciliationCommandSchema.parse(input.command);
  if (record.planDigest !== plan.planDigest || record.state !== "creation_uncertain"
      || command.transportId !== record.transportId
      || command.expectedUniqueTaskTitle !== plan.createThreadCommand.arguments.title) {
    throw new Error("CODEX_RECONCILIATION_NOT_BOUND_TO_UNCERTAIN_CREATE");
  }
  if (record.reconciliationReceipts.some((receipt) => receipt.commandDigest === command.commandDigest)) {
    throw new Error("CODEX_RECONCILIATION_COMMAND_ALREADY_RECORDED");
  }
  if (Date.parse(input.observedAt) < Date.parse(command.issuedAt)) throw new Error("CODEX_RECONCILIATION_RECEIPT_PRECEDES_COMMAND");
  const retainedResult = retainExactCodexAppCallResult(input.rawResult);
  const matches = deriveReconciliationMatches(retainedResult, command.expectedUniqueTaskTitle);
  const outcome = matches.length === 0 ? "not_found_yet" as const : matches.length === 1 ? "ready" as const : "ambiguous" as const;
  if (outcome === "ready" && input.priorCodexTaskIds?.has(matches[0]!.threadId)) throw new Error("CODEX_TASK_ID_NOT_FRESH");
  const content = createReconciliationReceiptContentSchema.parse({
    schemaVersion: 1,
    kind: "codex-create-thread-reconciliation-receipt",
    transportId: record.transportId,
    commandDigest: command.commandDigest,
    observedAt: input.observedAt,
    expectedUniqueTaskTitle: command.expectedUniqueTaskTitle,
    outcome,
    matches,
    rawResult: retainedResult.rawResult,
    rawResultDigest: retainedResult.rawResultDigest,
    payloadDigest: retainedResult.payloadDigest,
  });
  const receipt = exp0001aCodexCreateReconciliationReceiptSchema.parse({
    ...content,
    receiptDigest: hashCanonicalJson(content),
  });
  const readyMatch = outcome === "ready" ? matches[0]! : null;
  const { lifecycleDigest: _lifecycleDigest, ...recordContent } = record;
  void _lifecycleDigest;
  return sealLifecycle({
    ...recordContent,
    state: readyMatch === null ? "creation_uncertain" : "running",
    codexTaskId: readyMatch?.threadId ?? null,
    threadId: readyMatch?.threadId ?? null,
    hostId: readyMatch?.hostId ?? null,
    reconciliationReceipts: [...record.reconciliationReceipts, receipt],
  });
}

export function issueExp0001aWaitThreadsCommand(input: {
  lifecycle: Exp0001aCodexTaskLifecycle;
  issuedAt: string;
  timeoutMs?: number;
}): Exp0001aCodexWaitThreadsCommand {
  const record = exp0001aCodexTaskLifecycleSchema.parse(input.lifecycle);
  if (record.state !== "running" || record.threadId === null || record.hostId === null) {
    throw new Error("CODEX_TASK_NOT_WAITABLE");
  }
  const lastObservedAt = record.waitReceipts.at(-1)?.observedAt ?? record.createReceipt.observedAt;
  if (Date.parse(input.issuedAt) < Date.parse(lastObservedAt)) throw new Error("CODEX_WAIT_COMMAND_PRECEDES_PRIOR_RECEIPT");
  const target = {
    threadId: record.threadId,
    hostId: record.hostId,
    ...(record.latestCursor === null ? {} : { afterCursor: record.latestCursor }),
  };
  const content = waitThreadsCommandContentSchema.parse({
    schemaVersion: 1,
    toolName: "mcp__codex_app__wait_threads",
    transportId: record.transportId,
    issuedAt: input.issuedAt,
    arguments: { targets: [target], timeoutMs: input.timeoutMs ?? 120_000 },
  });
  return freezeDeep(exp0001aCodexWaitThreadsCommandSchema.parse({ ...content, commandDigest: hashCanonicalJson(content) }));
}

export function recordExp0001aWaitThreadsResult(input: {
  lifecycle: Exp0001aCodexTaskLifecycle;
  command: Exp0001aCodexWaitThreadsCommand;
  observedAt: string;
  rawResult: unknown;
}): Exp0001aCodexTaskLifecycle {
  const record = exp0001aCodexTaskLifecycleSchema.parse(input.lifecycle);
  const command = exp0001aCodexWaitThreadsCommandSchema.parse(input.command);
  if (record.state !== "running" || record.codexTaskId === null || record.threadId === null || record.hostId === null) {
    throw new Error("CODEX_TASK_NOT_WAITABLE");
  }
  if (Date.parse(input.observedAt) < Date.parse(command.issuedAt)) throw new Error("CODEX_WAIT_RECEIPT_PRECEDES_COMMAND");
  if (record.waitReceipts.some((receipt) => receipt.commandDigest === command.commandDigest)) {
    throw new Error("CODEX_WAIT_COMMAND_ALREADY_RECORDED");
  }
  const target = command.arguments.targets[0];
  if (command.transportId !== record.transportId || target.threadId !== record.threadId || target.hostId !== record.hostId
      || (target.afterCursor ?? null) !== record.latestCursor) {
    throw new Error("CODEX_WAIT_COMMAND_NOT_BOUND_TO_CURRENT_LIFECYCLE");
  }
  const retainedResult = retainExactCodexAppCallResult(input.rawResult);
  const outcome = deriveWaitThreadsResult(retainedResult, target);
  if (outcome.terminalCompletedAt !== null && Date.parse(input.observedAt) < Date.parse(outcome.terminalCompletedAt)) {
    throw new Error("CODEX_WAIT_RECEIPT_PRECEDES_AUTHORITATIVE_TERMINAL_COMPLETION");
  }
  const receiptContent = waitThreadsReceiptContentSchema.parse({
    schemaVersion: 1,
    kind: "codex-wait-threads-receipt",
    transportId: record.transportId,
    commandDigest: command.commandDigest,
    observedAt: input.observedAt,
    codexTaskId: record.codexTaskId,
    hostId: record.hostId,
    outcome: outcome.outcome,
    cursor: outcome.cursor,
    terminalResultDigest: outcome.terminalResultDigest,
    terminalCompletedAt: outcome.terminalCompletedAt,
    rawResult: retainedResult.rawResult,
    rawResultDigest: retainedResult.rawResultDigest,
    payloadDigest: retainedResult.payloadDigest,
    failureCode: outcome.failureCode,
  });
  const receipt = sealReceipt(exp0001aCodexWaitThreadsReceiptSchema, receiptContent as Omit<Exp0001aCodexWaitThreadsReceipt, "receiptDigest">);
  const timedOut = outcome.outcome === "timeout";
  const { lifecycleDigest: _lifecycleDigest, ...recordContent } = record;
  void _lifecycleDigest;
  return sealLifecycle({
    ...recordContent,
    state: timedOut ? "running" : "awaiting_terminal_read",
    latestCursor: outcome.cursor,
    waitReceipts: [...record.waitReceipts, receipt],
  });
}

export function issueExp0001aReadThreadCommand(input: {
  lifecycle: Exp0001aCodexTaskLifecycle;
  issuedAt: string;
}): Exp0001aCodexReadThreadCommand {
  const record = exp0001aCodexTaskLifecycleSchema.parse(input.lifecycle);
  if (record.state !== "awaiting_terminal_read" || record.threadId === null || record.hostId === null) {
    throw new Error("CODEX_TASK_NOT_READY_FOR_TERMINAL_READ");
  }
  const priorPage = record.readPageReceipts.at(-1);
  if (record.readPageReceipts.length >= EXP0001A_CODEX_READ_THREAD_MAX_PAGES) {
    throw new Error("CODEX_READ_THREAD_PAGE_LIMIT_EXCEEDED");
  }
  if (priorPage !== undefined && !priorPage.hasMore) {
    throw new Error("CODEX_READ_THREAD_CURSOR_ALREADY_EXHAUSTED");
  }
  const lastWait = record.waitReceipts.at(-1);
  const lastReadObservation = priorPage?.observedAt ?? lastWait?.observedAt;
  if (lastWait === undefined || lastReadObservation === undefined
      || Date.parse(input.issuedAt) < Date.parse(lastReadObservation)) {
    throw new Error("CODEX_READ_COMMAND_PRECEDES_TERMINAL_WAIT_RECEIPT");
  }
  const content = readThreadCommandContentSchema.parse({
    schemaVersion: 1,
    toolName: "mcp__codex_app__read_thread",
    transportId: record.transportId,
    issuedAt: input.issuedAt,
    arguments: {
      threadId: record.threadId,
      hostId: record.hostId,
      ...(record.latestReadCursor === null ? {} : { cursor: record.latestReadCursor }),
      includeOutputs: false,
      maxOutputCharsPerItem: EXP0001A_CODEX_READ_THREAD_MAX_OUTPUT_CHARS_PER_ITEM,
      turnLimit: EXP0001A_CODEX_READ_THREAD_TURN_LIMIT,
    },
  });
  return freezeDeep(exp0001aCodexReadThreadCommandSchema.parse({ ...content, commandDigest: hashCanonicalJson(content) }));
}

function expectedSubjectRoot(plan: Exp0001aCodexTaskTransportPlan): string {
  switch (plan.envelope.role) {
    case "primary_reviewer":
      return plan.envelope.kind === "primary-reviewer-task-envelope"
        ? plan.envelope.evidence.evidenceRoot
        : plan.envelope.failureEvidenceRoot;
    case "adjudicator":
      return plan.envelope.adjudicationSubjectRoot;
    case "pairwise_visual_judge":
      return plan.envelope.pairRoot;
    case "author":
      throw new Error("Author tasks do not have a reviewer subject root.");
  }
}

function verifyTerminalArtifactBinding(plan: Exp0001aCodexTaskTransportPlan, artifact: Exp0001aCodexTerminalArtifact): void {
  if (plan.role === "author") {
    if (artifact.kind !== "author-artifact-result" || plan.envelope.role !== "author"
        || artifact.roomId !== plan.envelope.roomId
        || artifact.roomProvisioningReceiptDigest !== plan.envelope.roomProvisioningReceiptDigest
        || artifact.privateRoomAccessBindingDigest !== plan.envelope.privateRoomAccessBindingDigest) {
      throw new Error("AUTHOR_TERMINAL_ARTIFACT_NOT_BOUND_TO_PRIVATE_ROOM");
    }
    return;
  }
  if (artifact.kind === "author-artifact-result" || artifact.subjectEvidenceRoot !== expectedSubjectRoot(plan)) {
    throw new Error("REVIEW_TERMINAL_ARTIFACT_NOT_BOUND_TO_SUBJECT_EVIDENCE");
  }
  const expectedKind = plan.role === "primary_reviewer"
    ? "primary-review-result"
    : plan.role === "adjudicator"
      ? "adjudication-result"
      : "pairwise-visual-result";
  if (artifact.kind !== expectedKind) throw new Error("REVIEW_TERMINAL_ARTIFACT_ROLE_MISMATCH");
}

function jsonObject(value: JsonValue): Record<string, JsonValue> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : null;
}

function outputMetadataTruncated(item: JsonValue): boolean {
  const object = jsonObject(item);
  if (object === null) return false;
  const text = typeof object.text === "string" ? object.text : null;
  if (object.type === "agentMessage"
      && (object.truncated === true
        || (typeof object.originalChars === "number" && text !== null && object.originalChars > text.length)
        || (text !== null && text.length >= EXP0001A_CODEX_READ_THREAD_MAX_OUTPUT_CHARS_PER_ITEM))) {
    return true;
  }
  for (const key of ["output", "result"]) {
    const output = jsonObject(object[key] as JsonValue);
    if (output !== null && (output.truncated === true
        || (typeof output.originalChars === "number" && typeof output.text === "string"
          && output.originalChars > output.text.length))) {
      return true;
    }
  }
  return false;
}

function finalAgentMessages(pages: readonly Exp0001aCodexReadThreadPageReceipt[]): string[] {
  return pages.flatMap((receipt) => {
    const page = rawReadThreadPageSchema.parse(receipt.rawResult);
    return page.turns.flatMap((turn) => turn.items.flatMap((item) => {
      const object = jsonObject(item);
      return object?.type === "agentMessage" && object.phase === "final_answer" && typeof object.text === "string"
        ? [object.text]
        : [];
    }));
  });
}

function readPageReceiptRoot(pages: readonly Exp0001aCodexReadThreadPageReceipt[]): string {
  return hashCanonicalJson({
    schemaVersion: 1,
    kind: "codex-read-thread-page-receipt-root",
    pageReceiptDigests: pages.map((page) => page.receiptDigest),
  });
}

type AcornNode = Readonly<{ type: string; [key: string]: unknown }>;

function acornNode(value: unknown): AcornNode | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
      && typeof (value as { type?: unknown }).type === "string"
    ? value as AcornNode
    : null;
}

function walkJavaScriptAst(node: AcornNode, visit: (candidate: AcornNode) => void): void {
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "start" || key === "end" || key === "loc") continue;
    const child = acornNode(value);
    if (child !== null) {
      walkJavaScriptAst(child, visit);
    } else if (Array.isArray(value)) {
      for (const candidate of value) {
        const arrayChild = acornNode(candidate);
        if (arrayChild !== null) walkJavaScriptAst(arrayChild, visit);
      }
    }
  }
}

function staticString(nodeInput: unknown): string | null {
  const node = acornNode(nodeInput);
  return node?.type === "Literal" && typeof node.value === "string" ? node.value : null;
}

function identifierName(nodeInput: unknown): string | null {
  const node = acornNode(nodeInput);
  return node?.type === "Identifier" && typeof node.name === "string" ? node.name : null;
}

function unwrappedExpression(nodeInput: unknown): AcornNode | null {
  const node = acornNode(nodeInput);
  return node?.type === "AwaitExpression" ? acornNode(node.argument) : node;
}

function memberPropertyName(nodeInput: unknown): string | null {
  const node = acornNode(nodeInput);
  if (node?.type !== "MemberExpression") return null;
  if (node.computed === true) return staticString(node.property);
  return identifierName(node.property);
}

function memberObjectIdentifier(nodeInput: unknown): string | null {
  const node = acornNode(nodeInput);
  return node?.type === "MemberExpression" ? identifierName(node.object) : null;
}

function memberChainBaseIdentifier(nodeInput: unknown, intermediateProperty: string): string | null {
  const node = acornNode(nodeInput);
  if (node?.type !== "MemberExpression") return null;
  const object = acornNode(node.object);
  return object?.type === "MemberExpression" && memberPropertyName(object) === intermediateProperty
    ? identifierName(object.object)
    : null;
}

function objectPatternLocalIdentifier(nodeInput: unknown, propertyName: string): AcornNode | null {
  const node = acornNode(nodeInput);
  if (node?.type !== "ObjectPattern" || !Array.isArray(node.properties)) return null;
  for (const propertyInput of node.properties) {
    const property = acornNode(propertyInput);
    if (property?.type !== "Property" || property.computed === true || property.kind !== "init") continue;
    const key = identifierName(property.key) ?? staticString(property.key);
    if (key === propertyName) {
      const value = acornNode(property.value);
      return value?.type === "Identifier" ? value : null;
    }
  }
  return null;
}

function bindingIdentifierNodes(nodeInput: unknown): AcornNode[] {
  const node = acornNode(nodeInput);
  if (node === null) return [];
  if (node.type === "Identifier") return [node];
  if (node.type === "RestElement") return bindingIdentifierNodes(node.argument);
  if (node.type === "AssignmentPattern") return bindingIdentifierNodes(node.left);
  if (node.type === "ArrayPattern") {
    return Array.isArray(node.elements)
      ? node.elements.flatMap((element) => bindingIdentifierNodes(element))
      : [];
  }
  if (node.type === "ObjectPattern") {
    if (!Array.isArray(node.properties)) return [];
    return node.properties.flatMap((propertyInput) => {
      const property = acornNode(propertyInput);
      if (property?.type === "Property") return bindingIdentifierNodes(property.value);
      if (property?.type === "RestElement") return bindingIdentifierNodes(property.argument);
      return [];
    });
  }
  return [];
}

function memberRootIdentifierNode(nodeInput: unknown): AcornNode | null {
  let node = acornNode(nodeInput);
  while (node?.type === "MemberExpression") node = acornNode(node.object);
  return node?.type === "Identifier" ? node : null;
}

function memberRootIdentifier(nodeInput: unknown): string | null {
  return identifierName(memberRootIdentifierNode(nodeInput));
}

function mutationTargetRootIdentifiers(nodeInput: unknown): string[] {
  const node = acornNode(nodeInput);
  if (node === null) return [];
  if (node.type === "Identifier") return identifierName(node) === null ? [] : [identifierName(node)!];
  if (node.type === "MemberExpression") {
    const root = memberRootIdentifier(node);
    return root === null ? [] : [root];
  }
  if (node.type === "RestElement") return mutationTargetRootIdentifiers(node.argument);
  if (node.type === "AssignmentPattern") return mutationTargetRootIdentifiers(node.left);
  if (node.type === "ArrayPattern") {
    return Array.isArray(node.elements)
      ? node.elements.flatMap((element) => mutationTargetRootIdentifiers(element))
      : [];
  }
  if (node.type === "ObjectPattern") {
    if (!Array.isArray(node.properties)) return [];
    return node.properties.flatMap((propertyInput) => {
      const property = acornNode(propertyInput);
      if (property?.type === "Property") return mutationTargetRootIdentifiers(property.value);
      if (property?.type === "RestElement") return mutationTargetRootIdentifiers(property.argument);
      return [];
    });
  }
  return [];
}

function staticObjectStringProperty(nodeInput: unknown, key: string): string | null | undefined {
  const node = acornNode(nodeInput);
  if (node?.type !== "ObjectExpression" || !Array.isArray(node.properties)) return null;
  for (const propertyInput of node.properties) {
    const property = acornNode(propertyInput);
    if (property?.type !== "Property" || property.computed === true || property.kind !== "init") continue;
    const propertyName = identifierName(property.key) ?? staticString(property.key);
    if (propertyName === key) return staticString(property.value);
  }
  return undefined;
}

function isTabsMember(nodeInput: unknown): boolean {
  const node = acornNode(nodeInput);
  return node?.type === "MemberExpression" && memberPropertyName(node) === "tabs";
}

function parseExactBrowserSkillRead(command: string): string | null {
  const wrapper = /^\/bin\/zsh -lc (["'])([^\n]*)\1$/.exec(command);
  if (wrapper === null) return null;
  const inner = wrapper[2]!;
  const read = /^sed -n (["'])1,([0-9]{3,4})p\1 (["']?)(\/[^\s"'`;$|&()<>]+)\3$/.exec(inner);
  if (read === null || Number(read[2]) < 150) return null;
  const path = read[4]!;
  return path.endsWith(`/browser/${EXP0001A_BROWSER_SKILL_VERSION}/skills/control-in-app-browser/SKILL.md`)
    ? path
    : null;
}

function isExactBrowserClientBootstrapPath(path: string): boolean {
  return path.endsWith(`/browser/${EXP0001A_BROWSER_SKILL_VERSION}/scripts/browser-client.mjs`);
}

function chronologicalReadItems(pages: readonly Exp0001aCodexReadThreadPageReceipt[]): JsonValue[] {
  return [...pages].reverse().flatMap((receipt) => {
    const page = rawReadThreadPageSchema.parse(receipt.rawResult);
    return [...page.turns].reverse().flatMap((turn) => turn.items);
  });
}

/**
 * Derives the complete task-access trace solely from retained read_thread page
 * bytes. This is deliberately static and fail-closed: computed tool names,
 * computed navigation URLs, hidden JavaScript evaluation, or unknown tool
 * surfaces make the task non-evaluable instead of becoming caller assertions.
 */
export function deriveExp0001aCodexTaskTraceObservation(input: {
  plan: Exp0001aCodexTaskTransportPlan;
  lifecycle: Exp0001aCodexTaskLifecycle;
  pages: readonly Exp0001aCodexReadThreadPageReceipt[];
  capturedAt: string;
}): Exp0001aCodexTaskTraceObservation {
  const plan = exp0001aCodexTaskTransportPlanSchema.parse(input.plan);
  const lifecycle = exp0001aCodexTaskLifecycleSchema.parse(input.lifecycle);
  const pages = input.pages.map((page) => exp0001aCodexReadThreadPageReceiptSchema.parse(page));
  const pageRoot = readPageReceiptRoot(pages);
  if (lifecycle.planDigest !== plan.planDigest || lifecycle.codexTaskId === null || pages.length === 0
      || pages.some((page, index) => page.transportId !== lifecycle.transportId || page.codexTaskId !== lifecycle.codexTaskId
        || page.pageIndex !== index || page.transportTruncationDetected)
      || pages.at(-1)?.hasMore !== false) {
    throw new Error("TASK_TRACE_REQUIRES_COMPLETE_BOUND_READ_THREAD_PAGES");
  }

  const packet = packetForEnvelope(plan.envelope);
  const allowedOrigin = plan.role === "author" ? "https://www.jazzboard.xyz" : new URL(packet!.origin).origin;
  const allowedBootstrapUrls = new Set(plan.role === "author"
    ? [allowedOrigin, `${allowedOrigin}/`]
    : [allowedOrigin, packet!.origin]);
  const allowedNavigationUrls = plan.role === "author"
    ? new Set([plan.envelope.role === "author" ? plan.envelope.privateRoomUrl : ""])
    : new Set([
      packet!.manifestUrl,
      ...packet!.files.map((file) => new URL(file.relativePath, new URL("./", packet!.manifestUrl)).href),
    ]);
  const packetFileDigestByUrl = new Map(plan.role === "author" ? [] : packet!.files.map((file) => [
    new URL(file.relativePath, new URL("./", packet!.manifestUrl)).href,
    file.sha256,
  ]));
  const exactInviteCode = plan.envelope.role === "author"
    ? /^#join=([A-Za-z0-9-]+)$/.exec(new URL(plan.envelope.privateRoomUrl).hash)?.[1] ?? null
    : null;
  const items = chronologicalReadItems(pages);
  const traceProjection: JsonValue[] = [];
  const codeEntries: Array<{ code: string; status: string; id: string }> = [];
  const browserSetupVariables = new Set<string>();
  const browserAgentVariables = new Set<string>();
  const browserVariables = new Set<string>();
  const tabVariables = new Set<string>();
  const webMcpVariables = new Set<string>();
  const toolVariables = new Set<string>();
  const browserOrigins = new Set<string>();
  const toolNames: string[] = [];
  const unknownReasons = new Set<string>();
  const trustedCapabilityBindingByName = new Map<string, AcornNode>();
  const registerTrustedCapabilityBinding = (
    variables: Set<string>,
    name: string,
    binding: AcornNode,
  ): void => {
    const existing = trustedCapabilityBindingByName.get(name);
    if (existing !== undefined && existing !== binding) {
      unknownReasons.add("TRUSTED_BROWSER_CAPABILITY_BINDING_REDECLARED_OR_SHADOWED");
    } else {
      trustedCapabilityBindingByName.set(name, binding);
    }
    variables.add(name);
  };
  let commandExecutionCount = 0;
  let otherCommandExecutionCount = 0;
  let filesystemReadCount = 0;
  let filesystemWriteCount = 0;
  let repositoryReadCount = 0;
  const privateApiRequestCount = 0;
  let directHttpRequestCount = 0;
  let skillReadCount = 0;
  let resolvedSkillPath: string | null = null;
  let bootstrapImportCount = 0;
  let freshTabCount = 0;
  let preexistingBrowserContextUsed = false;
  let jazzboardBrowserNavigationCount = 0;
  let exactInviteOpened = false;
  let exactPacketManifestOpened = false;
  // Track exact packet file URLs, not only content digests. Two distinct
  // blinded sides may legitimately contain byte-identical PNGs; collapsing
  // their hashes into a Set would falsely report that one side was never
  // opened (or let one path be opened twice to stand in for both sides).
  const openedPacketFileUrls = new Set<string>();
  let webMcpFailureCount = 0;

  for (const item of items) {
    const object = jsonObject(item);
    if (object === null || typeof object.type !== "string") {
      unknownReasons.add("TASK_TRACE_ITEM_SHAPE_UNOBSERVABLE");
      continue;
    }
    if (object.type === "commandExecution") {
      commandExecutionCount += 1;
      const command = typeof object.command === "string" ? object.command : null;
      const status = typeof object.status === "string" ? object.status : null;
      const exitCode = typeof object.exitCode === "number" ? object.exitCode : null;
      traceProjection.push({
        type: object.type,
        id: typeof object.id === "string" ? object.id : null,
        command,
        cwd: typeof object.cwd === "string" ? object.cwd : null,
        status,
        exitCode,
      });
      const skillPath = command === null ? null : parseExactBrowserSkillRead(command);
      if (skillPath !== null && status === "completed" && exitCode === 0 && skillReadCount === 0) {
        skillReadCount = 1;
        filesystemReadCount += 1;
        resolvedSkillPath = skillPath;
      } else {
        otherCommandExecutionCount += 1;
        if (command === null || status === null || exitCode === null) unknownReasons.add("COMMAND_EXECUTION_METADATA_UNOBSERVABLE");
        if (command !== null && /(?:^|\s)(?:curl|wget|nc|ssh)\b|https?:\/\//i.test(command)) directHttpRequestCount += 1;
        if (command !== null && /(?:^|[\s/])(?:\.git|src|package\.json|PRODUCT-SPEC\.md)(?:[\s/]|$)/i.test(command)) repositoryReadCount += 1;
        if (command !== null && /(?:^|\s)(?:>|>>|tee|touch|mkdir|cp|mv|rm)\b/.test(command)) filesystemWriteCount += 1;
      }
      continue;
    }
    if (object.type === "mcpToolCall") {
      const server = typeof object.server === "string" ? object.server : null;
      const tool = typeof object.tool === "string" ? object.tool : null;
      const status = typeof object.status === "string" ? object.status : null;
      const args = jsonObject(object.arguments as JsonValue);
      const code = args !== null && typeof args.code === "string" ? args.code : null;
      traceProjection.push({
        type: object.type,
        id: typeof object.id === "string" ? object.id : null,
        server,
        tool,
        arguments: args,
        status,
      });
      if (server !== "node_repl" || tool !== "js" || code === null || status === null) {
        otherCommandExecutionCount += 1;
        if (server === null || tool === null || code === null || status === null) unknownReasons.add("MCP_TOOL_METADATA_UNOBSERVABLE");
      } else {
        codeEntries.push({ code, status, id: typeof object.id === "string" ? object.id : "unidentified" });
      }
      continue;
    }
    if (["reasoning", "agentMessage", "userMessage", "functionCallOutput"].includes(object.type)) continue;
    if (["webSearch", "imageView", "imageGeneration", "collabAgentToolCall", "subAgentActivity"].includes(object.type)) {
      otherCommandExecutionCount += 1;
      traceProjection.push({ type: object.type, id: typeof object.id === "string" ? object.id : null });
      continue;
    }
    unknownReasons.add("UNKNOWN_READ_THREAD_ITEM_TYPE");
    traceProjection.push({ type: object.type, id: typeof object.id === "string" ? object.id : null });
  }

  const parsedEntries: Array<{ root: AcornNode; status: string }> = [];
  for (const entry of codeEntries) {
    try {
      const root = parseJavaScript(entry.code, {
        ecmaVersion: "latest",
        sourceType: "module",
        allowAwaitOutsideFunction: true,
      }) as unknown as AcornNode;
      parsedEntries.push({ root, status: entry.status });
      walkJavaScriptAst(root, (node) => {
        if (node.type !== "VariableDeclarator") return;
        const variable = identifierName(node.id);
        const init = unwrappedExpression(node.init);
        const importedSetupBinding = objectPatternLocalIdentifier(node.id, "setupBrowserRuntime");
        const importedSetup = identifierName(importedSetupBinding);
        if (importedSetup !== null && init?.type === "ImportExpression"
            && isExactBrowserClientBootstrapPath(staticString(init.source) ?? "")) {
          registerTrustedCapabilityBinding(browserSetupVariables, importedSetup, importedSetupBinding!);
          return;
        }
        if (variable === null || init === null) return;
        const variableBinding = acornNode(node.id)!;
        if (init.type === "Identifier") {
          const source = identifierName(init);
          if (source !== null && [browserSetupVariables, browserAgentVariables, browserVariables, tabVariables, webMcpVariables, toolVariables]
            .some((variables) => variables.has(source))) {
            unknownReasons.add("ALIASED_BROWSER_CAPABILITY_UNOBSERVABLE");
          }
          return;
        }
        if (init.type === "MemberExpression") {
          const property = memberPropertyName(init);
          if (["browsers", "tabs", "capabilities", "goto", "getForUrl", "new", "fetchTools", "call"]
            .includes(property ?? "")) {
            unknownReasons.add("ALIASED_BROWSER_CAPABILITY_MEMBER_UNOBSERVABLE");
          }
          return;
        }
        if (init.type !== "CallExpression") return;
        const callee = unwrappedExpression(init.callee);
        const direct = identifierName(callee);
        const member = memberPropertyName(callee);
        if (direct !== null && browserSetupVariables.has(direct) && (init.arguments as unknown[]).length === 0) {
          registerTrustedCapabilityBinding(browserAgentVariables, variable, variableBinding);
          return;
        }
        if (member === "getForUrl"
            && browserAgentVariables.has(memberChainBaseIdentifier(callee, "browsers") ?? "")) {
          registerTrustedCapabilityBinding(browserVariables, variable, variableBinding);
          return;
        }
        if (member === "new" && browserVariables.has(memberChainBaseIdentifier(callee, "tabs") ?? "")) {
          registerTrustedCapabilityBinding(tabVariables, variable, variableBinding);
          return;
        }
        if (member === "get" && tabVariables.has(memberChainBaseIdentifier(callee, "capabilities") ?? "")
            && staticString((init.arguments as unknown[])[0]) === "webmcp") {
          registerTrustedCapabilityBinding(webMcpVariables, variable, variableBinding);
          return;
        }
        if (member === "fetchTools" && webMcpVariables.has(memberObjectIdentifier(callee) ?? "")) {
          registerTrustedCapabilityBinding(toolVariables, variable, variableBinding);
          return;
        }
        if (["getForUrl", "new", "fetchTools"].includes(member ?? "")) {
          unknownReasons.add("BROWSER_CAPABILITY_LINEAGE_UNOBSERVABLE");
        }
      });
    } catch {
      unknownReasons.add("NODE_REPL_JAVASCRIPT_PARSE_FAILED");
    }
  }

  const trustedCapabilityNames = new Set(trustedCapabilityBindingByName.keys());
  const allBindingIdentifierNodes = new WeakSet<object>();
  const nonReferenceIdentifierNodes = new WeakSet<object>();
  const approvedTrustedCapabilityReferenceNodes = new WeakSet<object>();
  for (const { root } of parsedEntries) {
    walkJavaScriptAst(root, (node) => {
      const bindingPatterns: unknown[] = [];
      if (node.type === "VariableDeclarator") bindingPatterns.push(node.id);
      if (["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type)) {
        if (node.type !== "ArrowFunctionExpression") bindingPatterns.push(node.id);
        if (Array.isArray(node.params)) bindingPatterns.push(...node.params);
      }
      if (["ClassDeclaration", "ClassExpression"].includes(node.type)) bindingPatterns.push(node.id);
      if (node.type === "CatchClause") bindingPatterns.push(node.param);
      if (["ImportSpecifier", "ImportDefaultSpecifier", "ImportNamespaceSpecifier"].includes(node.type)) {
        bindingPatterns.push(node.local);
      }
      for (const identifier of bindingPatterns.flatMap((pattern) => bindingIdentifierNodes(pattern))) {
        allBindingIdentifierNodes.add(identifier);
        const name = identifierName(identifier);
        if (name !== null && trustedCapabilityNames.has(name)
            && trustedCapabilityBindingByName.get(name) !== identifier) {
          unknownReasons.add("TRUSTED_BROWSER_CAPABILITY_BINDING_REDECLARED_OR_SHADOWED");
        }
      }

      if (node.type === "MemberExpression" && node.computed !== true) {
        const property = acornNode(node.property);
        if (property !== null) nonReferenceIdentifierNodes.add(property);
      }
      if (["Property", "MethodDefinition", "PropertyDefinition"].includes(node.type)
          && node.computed !== true) {
        const key = acornNode(node.key);
        if (key !== null) nonReferenceIdentifierNodes.add(key);
      }
      if (node.type === "LabeledStatement" || node.type === "BreakStatement" || node.type === "ContinueStatement") {
        const label = acornNode(node.label);
        if (label !== null) nonReferenceIdentifierNodes.add(label);
      }

      const mutationTargets: unknown[] = [];
      if (node.type === "AssignmentExpression") mutationTargets.push(node.left);
      if (node.type === "UpdateExpression") mutationTargets.push(node.argument);
      if (["ForInStatement", "ForOfStatement"].includes(node.type)
          && acornNode(node.left)?.type !== "VariableDeclaration") mutationTargets.push(node.left);
      for (const targetInput of mutationTargets) {
        if (mutationTargetRootIdentifiers(targetInput).some((name) => trustedCapabilityNames.has(name))) {
          unknownReasons.add("TRUSTED_BROWSER_CAPABILITY_BINDING_MUTATED");
        }
      }
      if (node.type === "UnaryExpression" && node.operator === "delete") {
        const rootName = memberRootIdentifier(node.argument);
        if (rootName !== null && trustedCapabilityNames.has(rootName)) {
          unknownReasons.add("TRUSTED_BROWSER_CAPABILITY_BINDING_MUTATED");
        }
      }
    });
  }

  for (const { root, status } of parsedEntries) {
    let entryWebMcpCalls = 0;
    const guardedResultVariables = new Set<string>();
    const callResultVariableByStart = new Map<number, string>();
    walkJavaScriptAst(root, (node) => {
      if (node.type === "Identifier" && typeof node.name === "string"
          && ["global", "globalThis", "window", "process", "require", "module", "eval", "Function", "fetch", "XMLHttpRequest", "WebSocket", "Reflect"]
            .includes(node.name)) {
        unknownReasons.add("FORBIDDEN_OR_REFLECTIVE_RUNTIME_CAPABILITY_REFERENCE");
      }
      if (node.type === "ThisExpression") {
        // Top-level `this` in the retained Node runtime is the global object,
        // including its fetch/WebSocket capabilities. Treat every use as an
        // unobservable global-capability access so aliases cannot launder it.
        unknownReasons.add("FORBIDDEN_OR_REFLECTIVE_RUNTIME_CAPABILITY_REFERENCE");
      }
      if (node.type === "MemberExpression"
          && ["fetch", "evaluate", "evaluateHandle"].includes(memberPropertyName(node) ?? "")) {
        // Member acquisition can be aliased before invocation
        // (`const f = this.fetch`, `const e = tab.playwright.evaluate`). The
        // later call then has an innocuous local identifier, so the capability
        // access itself must fail closed.
        unknownReasons.add("REFLECTIVE_OR_ALIASED_CAPABILITY_CALL_UNOBSERVABLE");
      }
      if (node.type === "MemberExpression"
          && ["user", "history", "openTabs", "claimTab"].includes(memberPropertyName(node) ?? "")) {
        // These Browser client surfaces expose prior navigation or tabs from
        // outside the fresh projectless task. Access alone violates the sealed
        // no-shared-history boundary, even when the method is later aliased.
        preexistingBrowserContextUsed = true;
        unknownReasons.add("PREEXISTING_BROWSER_CONTEXT_ACCESS_UNOBSERVABLE");
      }
      if (node.type === "MemberExpression" && memberPropertyName(node) === "constructor") {
        // Constructor-chain recovery (for example
        // `[].filter.constructor("return fetch")`) is equivalent to dynamic
        // Function access even when neither `Function` nor `fetch` appears as
        // a direct executable callee.
        unknownReasons.add("DYNAMIC_JAVASCRIPT_EXECUTION_UNOBSERVABLE");
      }
      if (node.type === "Literal" && typeof node.value === "string"
          && /^(?:node:)?(?:child_process|fs|fs\/promises|http|https|net|tls|dns|dgram|worker_threads|vm)$/.test(node.value)) {
        unknownReasons.add("FORBIDDEN_NODE_CAPABILITY_LITERAL");
      }
      if (node.type === "VariableDeclarator") {
        const variable = identifierName(node.id);
        const init = unwrappedExpression(node.init);
        const sourceIdentifier = identifierName(init);
        if (variable === null && sourceIdentifier !== null
            && [browserAgentVariables, browserVariables, tabVariables, webMcpVariables, toolVariables]
              .some((variables) => variables.has(sourceIdentifier))) {
          unknownReasons.add("DESTRUCTURED_BROWSER_CAPABILITY_UNOBSERVABLE");
        }
        if (variable !== null && init?.type === "CallExpression"
            && memberPropertyName(init.callee) === "call"
            && toolVariables.has(memberObjectIdentifier(init.callee) ?? "")
            && typeof init.start === "number") {
          callResultVariableByStart.set(init.start, variable);
        }
      }
      if (node.type !== "IfStatement") return;
      const test = acornNode(node.test);
      const guardedMember = test?.type === "UnaryExpression" && test.operator === "!"
        ? acornNode(test.argument)
        : null;
      const guardedVariable = guardedMember?.type === "MemberExpression" && memberPropertyName(guardedMember) === "ok"
        ? identifierName(guardedMember.object)
        : null;
      const consequent = acornNode(node.consequent);
      const throws = consequent?.type === "ThrowStatement"
        || (consequent?.type === "BlockStatement" && Array.isArray(consequent.body)
          && consequent.body.some((statement) => acornNode(statement)?.type === "ThrowStatement"));
      if (guardedVariable !== null && throws) guardedResultVariables.add(guardedVariable);
    });
    walkJavaScriptAst(root, (node) => {
      if (node.type === "TryStatement") {
        let hiddenCall = false;
        const block = acornNode(node.block);
        if (block !== null) walkJavaScriptAst(block, (candidate) => {
          if (candidate.type === "CallExpression" && memberPropertyName(candidate.callee) === "call"
              && toolVariables.has(memberObjectIdentifier(candidate.callee) ?? "")) hiddenCall = true;
        });
        if (hiddenCall) unknownReasons.add("WEBMCP_RESULT_HIDDEN_BY_TRY_CATCH");
      }
      if (node.type === "ImportDeclaration" || node.type === "ExportAllDeclaration" || node.type === "ExportNamedDeclaration") {
        otherCommandExecutionCount += 1;
        filesystemReadCount += 1;
        repositoryReadCount += 1;
        return;
      }
      if (node.type === "ImportExpression") {
        const source = staticString(node.source);
        if (source !== null && isExactBrowserClientBootstrapPath(source) && bootstrapImportCount === 0) {
          bootstrapImportCount += 1;
        } else if (source === null) {
          unknownReasons.add("COMPUTED_DYNAMIC_IMPORT_UNOBSERVABLE");
        } else {
          otherCommandExecutionCount += 1;
          filesystemReadCount += 1;
          repositoryReadCount += 1;
        }
        return;
      }
      if (node.type === "NewExpression") {
        const constructor = identifierName(node.callee);
        if (constructor === "Function" || constructor === "XMLHttpRequest" || constructor === "WebSocket") {
          otherCommandExecutionCount += 1;
          directHttpRequestCount += constructor === "Function" ? 0 : 1;
          if (constructor === "Function") unknownReasons.add("DYNAMIC_JAVASCRIPT_EXECUTION_UNOBSERVABLE");
        } else if (constructor !== "Error") {
          // The frozen trace needs only `new Error(...)` for fail-fast WebMCP
          // guards. Every other constructor—including a locally aliased
          // WebSocket/Function—has unobservable capability lineage.
          unknownReasons.add("INDIRECT_OR_UNKNOWN_CONSTRUCTOR_UNOBSERVABLE");
        }
        return;
      }
      if (node.type === "TaggedTemplateExpression") {
        unknownReasons.add("INDIRECT_OR_UNKNOWN_CALL_CALLEE_UNOBSERVABLE");
        return;
      }
      if (node.type !== "CallExpression") return;
      const callee = unwrappedExpression(node.callee);
      if (callee === null || !["Identifier", "MemberExpression"].includes(callee.type)) {
        // Sequence expressions (`(0, fetch)(...)`), optional chains, returned
        // functions, and IIFEs can all conceal a network or reflective
        // capability. A complete trace therefore requires a statically named
        // direct or member call; every other executable callee fails closed.
        unknownReasons.add("INDIRECT_OR_UNKNOWN_CALL_CALLEE_UNOBSERVABLE");
        return;
      }
      const directName = identifierName(callee);
      if (directName !== null) {
        if (directName === "eval" || directName === "Function") {
          unknownReasons.add("DYNAMIC_JAVASCRIPT_EXECUTION_UNOBSERVABLE");
          return;
        }
        if (directName === "fetch") {
          directHttpRequestCount += 1;
          return;
        }
        if (directName === "require") {
          otherCommandExecutionCount += 1;
          filesystemReadCount += 1;
          repositoryReadCount += 1;
          return;
        }
        if (browserSetupVariables.has(directName)
            && Array.isArray(node.arguments) && node.arguments.length === 0) {
          approvedTrustedCapabilityReferenceNodes.add(callee);
          return;
        }
        // The complete trace has one approved direct call: the exact imported
        // setupBrowserRuntime binding. All other direct identifiers can be
        // capability aliases and therefore fail closed.
        unknownReasons.add("INDIRECT_OR_UNKNOWN_CALL_CALLEE_UNOBSERVABLE");
        return;
      }
      const memberNode = acornNode(callee);
      if (memberNode?.type === "MemberExpression" && memberNode.computed === true) {
        unknownReasons.add("COMPUTED_CAPABILITY_MEMBER_UNOBSERVABLE");
        return;
      }
      const memberName = memberPropertyName(callee);
      if (memberName === null) {
        unknownReasons.add("INDIRECT_OR_UNKNOWN_CALL_CALLEE_UNOBSERVABLE");
        return;
      }
      const memberObject = memberNode?.type === "MemberExpression" ? memberNode.object : null;
      const memberObjectName = identifierName(memberObject);
      let approvedMemberCall = false;
      const approveMemberCall = (): void => {
        approvedMemberCall = true;
        const rootIdentifier = memberRootIdentifierNode(callee);
        if (rootIdentifier !== null && trustedCapabilityNames.has(identifierName(rootIdentifier) ?? "")) {
          approvedTrustedCapabilityReferenceNodes.add(rootIdentifier);
        }
      };
      if (memberObjectName === "Reflect") {
        unknownReasons.add("REFLECTIVE_CAPABILITY_ACCESS_UNOBSERVABLE");
      }
      if (["bind", "apply"].includes(memberName)
          || memberName === "constructor"
          || (memberObjectName === "Object" && ["getOwnPropertyDescriptor", "getOwnPropertyDescriptors", "getPrototypeOf", "setPrototypeOf", "defineProperty", "defineProperties"]
            .includes(memberName))) {
        unknownReasons.add("REFLECTIVE_OR_ALIASED_CAPABILITY_CALL_UNOBSERVABLE");
      }
      if (memberObjectName === "process" && memberName === "getBuiltinModule") {
        otherCommandExecutionCount += 1;
        filesystemReadCount += 1;
        repositoryReadCount += 1;
        unknownReasons.add("PROCESS_BUILTIN_MODULE_ACCESS_FORBIDDEN");
      }
      // Node exposes fetch through `global`, `globalThis`, and top-level
      // `this`; aliases can also hide the receiver. No approved Browser/WebMCP
      // lineage uses a member literally named `fetch`, so every `.fetch(...)`
      // call is conservatively counted as direct HTTP.
      if (memberName === "fetch") {
        directHttpRequestCount += 1;
      }
      if (memberName === "evaluate" || memberName === "evaluateHandle") {
        unknownReasons.add("BROWSER_IN_PAGE_JAVASCRIPT_UNOBSERVABLE");
      }
      if (["request", "requestUrl", "open"].includes(memberName)
          && ["http", "https", "axios", "XMLHttpRequest"].includes(identifierName(memberObject) ?? "")) {
        directHttpRequestCount += 1;
      }
      if (memberName === "new" && isTabsMember(memberObject)) {
        approveMemberCall();
        const args = Array.isArray(node.arguments) ? node.arguments : [];
        const browserVariable = memberChainBaseIdentifier(callee, "tabs");
        if (args.length === 0 && browserVariable !== null && browserVariables.has(browserVariable)) freshTabCount += 1;
        else unknownReasons.add("TAB_CREATION_LINEAGE_OR_ARGUMENTS_UNOBSERVABLE");
      }
      if (["selected", "list"].includes(memberName) && isTabsMember(memberObject)) {
        approveMemberCall();
        const browserVariable = memberChainBaseIdentifier(callee, "tabs");
        if (browserVariable === null || !browserVariables.has(browserVariable)) {
          unknownReasons.add("BROWSER_CONTEXT_LINEAGE_UNOBSERVABLE");
        }
        preexistingBrowserContextUsed = true;
      }
      if (memberName === "availableTabs" || memberName === "markHandoff") {
        approveMemberCall();
        preexistingBrowserContextUsed = true;
      }
      if (memberName === "getForUrl") {
        approveMemberCall();
        const agentVariable = memberChainBaseIdentifier(callee, "browsers");
        if (agentVariable === null || !browserAgentVariables.has(agentVariable)) {
          unknownReasons.add("BROWSER_GET_FOR_URL_LINEAGE_UNOBSERVABLE");
        }
      }
      if (memberName === "get" && memberChainBaseIdentifier(callee, "capabilities") !== null) {
        approveMemberCall();
        const tabVariable = memberChainBaseIdentifier(callee, "capabilities");
        const args = Array.isArray(node.arguments) ? node.arguments : [];
        if (tabVariable === null || !tabVariables.has(tabVariable) || staticString(args[0]) !== "webmcp") {
          unknownReasons.add("WEBMCP_CAPABILITY_DISCOVERY_LINEAGE_OR_ARGUMENTS_UNOBSERVABLE");
        }
        if (plan.role !== "author") otherCommandExecutionCount += 1;
      }
      if (memberName === "fetchTools") {
        approveMemberCall();
        if (!webMcpVariables.has(memberObjectName ?? "")) {
          unknownReasons.add("WEBMCP_DISCOVERY_LINEAGE_UNOBSERVABLE");
        }
        if (plan.role !== "author") otherCommandExecutionCount += 1;
      }
      if (memberName === "goto" || memberName === "getForUrl") {
        approveMemberCall();
        const args = Array.isArray(node.arguments) ? node.arguments : [];
        const url = staticString(args[0]);
        if (url === null) {
          unknownReasons.add("COMPUTED_BROWSER_URL_UNOBSERVABLE");
          return;
        }
        let parsedUrl: URL;
        try {
          parsedUrl = new URL(url);
        } catch {
          unknownReasons.add("INVALID_BROWSER_URL_UNOBSERVABLE");
          return;
        }
        browserOrigins.add(parsedUrl.origin);
        if (memberName === "goto" && !tabVariables.has(memberObjectName ?? "")) {
          unknownReasons.add("BROWSER_NAVIGATION_LINEAGE_UNOBSERVABLE");
        }
        if (memberName === "getForUrl" && !allowedBootstrapUrls.has(url)) {
          directHttpRequestCount += 1;
        }
        if (memberName === "goto") {
          if (!allowedNavigationUrls.has(url)) directHttpRequestCount += 1;
          if (parsedUrl.origin === "https://www.jazzboard.xyz") jazzboardBrowserNavigationCount += 1;
          if (plan.role === "author" && plan.envelope.role === "author" && url === plan.envelope.privateRoomUrl) exactInviteOpened = true;
          if (plan.role !== "author" && url === packet!.manifestUrl) exactPacketManifestOpened = true;
          const packetFileDigest = packetFileDigestByUrl.get(url);
          if (packetFileDigest !== undefined) openedPacketFileUrls.add(url);
        }
      }
      if (memberName === "call" && toolVariables.has(memberObjectIdentifier(callee) ?? "")) {
        approveMemberCall();
        const args = Array.isArray(node.arguments) ? node.arguments : [];
        const toolName = staticString(args[0]);
        if (toolName === null) {
          unknownReasons.add("COMPUTED_WEBMCP_TOOL_NAME_UNOBSERVABLE");
        } else if (!/^[a-z][a-z0-9_]*$/.test(toolName)) {
          unknownReasons.add("INVALID_WEBMCP_TOOL_NAME_UNOBSERVABLE");
        } else {
          toolNames.push(toolName);
          entryWebMcpCalls += 1;
          const resultVariable = typeof node.start === "number" ? callResultVariableByStart.get(node.start) : undefined;
          if (resultVariable === undefined || !guardedResultVariables.has(resultVariable)) {
            unknownReasons.add("WEBMCP_RESULT_STATUS_UNOBSERVABLE_WITHOUT_FAIL_FAST_GUARD");
          }
          if (toolName === "join_room") {
            const code = staticObjectStringProperty(args[1], "code");
            const role = staticObjectStringProperty(args[1], "role");
            if (plan.role !== "author" || exactInviteCode === null || code !== exactInviteCode
                || (role !== undefined && role !== "participant")) {
              unknownReasons.add("JOIN_ROOM_ARGUMENTS_NOT_EXACT_STATIC_INVITE");
            }
          }
        }
      } else if (memberName === "call") {
        unknownReasons.add("UNBOUND_DOT_CALL_UNOBSERVABLE");
      }
      if (!approvedMemberCall) {
        unknownReasons.add("INDIRECT_OR_UNKNOWN_CALL_CALLEE_UNOBSERVABLE");
      }
    });
    if (status === "failed") {
      webMcpFailureCount += entryWebMcpCalls;
      if (entryWebMcpCalls > 0) unknownReasons.add("WEBMCP_CALL_FAILURE_IDENTITY_UNOBSERVABLE");
    }
    else if (status !== "completed") unknownReasons.add("NODE_REPL_STATUS_UNOBSERVABLE");
  }

  for (const { root } of parsedEntries) {
    walkJavaScriptAst(root, (node) => {
      if (node.type !== "Identifier" || typeof node.name !== "string"
          || !trustedCapabilityNames.has(node.name)
          || allBindingIdentifierNodes.has(node)
          || nonReferenceIdentifierNodes.has(node)
          || approvedTrustedCapabilityReferenceNodes.has(node)) return;
      // Every use of a trusted Browser/WebMCP capability must be the exact
      // root identifier of an approved call. This rejects aggregate aliases,
      // closure capture, argument escape, and other capability laundering
      // without trying to emulate JavaScript's full runtime object graph.
      unknownReasons.add("TRUSTED_BROWSER_CAPABILITY_REFERENCE_ESCAPED_APPROVED_CALL");
    });
  }

  if (bootstrapImportCount !== 1 || freshTabCount !== 1) {
    unknownReasons.add("BROWSER_BOOTSTRAP_OR_FRESH_TAB_NOT_EXACTLY_OBSERVED");
  }
  const taskTraceDigest = hashCanonicalJson({
    schemaVersion: 1,
    kind: "codex-read-thread-derived-task-trace/v1",
    pageReceiptRoot: pageRoot,
    traceProjection,
  });
  if (unknownReasons.size > 0) {
    return freezeDeep(exp0001aCodexTaskTraceObservationSchema.parse({
      schemaVersion: 1,
      kind: "codex-retained-task-trace-observation",
      codexTaskId: lifecycle.codexTaskId,
      capturedAt: input.capturedAt,
      completeness: "truncated-or-unobservable",
      taskTraceDigest,
      platformBootstrap: {
        skillId: "unobservable",
        skillVersion: "unobservable",
        skillDigest: "unobservable",
        resolvedSkillPathDigest: "unobservable",
        skillReadCount: "unobservable",
      },
      commandExecutionCount: "unobservable",
      otherCommandExecutionCount: "unobservable",
      filesystemReadCount: "unobservable",
      filesystemWriteCount: "unobservable",
      repositoryReadCount: "unobservable",
      privateApiRequestCount: "unobservable",
      directHttpRequestCount: "unobservable",
      preexistingBrowserContextUsed: "unobservable",
      browserOrigins: "unobservable",
      jazzboardBrowserNavigationCount: "unobservable",
      jazzboardRoomIdsAccessed: "unobservable",
      jazzboardRoomAccessBindingDigests: "unobservable",
      jazzboardInviteUrlDigests: "unobservable",
      webMcpCallCount: "unobservable",
      webMcpFailureCount: "unobservable",
      webMcpToolNames: "unobservable",
      webMcpOrigins: "unobservable",
      openedArtifactPacketManifestDigest: "unobservable",
      openedArtifactPacketFileDigests: "unobservable",
      observationEvidenceDigest: pageRoot,
    }));
  }

  const uniqueToolNames = [...new Set(toolNames)].sort();
  const webMcpOrigins = toolNames.length === 0 ? [] : browserOrigins.size === 1 ? [...browserOrigins] : [];
  return freezeDeep(exp0001aCodexTaskTraceObservationSchema.parse({
    schemaVersion: 1,
    kind: "codex-retained-task-trace-observation",
    codexTaskId: lifecycle.codexTaskId,
    capturedAt: input.capturedAt,
    completeness: "complete-retained-trace",
    taskTraceDigest,
    platformBootstrap: {
      skillId: EXP0001A_BROWSER_SKILL_ID,
      skillVersion: EXP0001A_BROWSER_SKILL_VERSION,
      skillDigest: EXP0001A_BROWSER_SKILL_DIGEST,
      resolvedSkillPathDigest: resolvedSkillPath === null ? "unobservable" : hashCanonicalJson(resolvedSkillPath),
      skillReadCount,
    },
    commandExecutionCount,
    otherCommandExecutionCount,
    filesystemReadCount,
    filesystemWriteCount,
    repositoryReadCount,
    privateApiRequestCount,
    directHttpRequestCount,
    preexistingBrowserContextUsed: preexistingBrowserContextUsed || freshTabCount !== 1,
    browserOrigins: [...browserOrigins].sort(),
    jazzboardBrowserNavigationCount,
    jazzboardRoomIdsAccessed: plan.role === "author" && exactInviteOpened && plan.envelope.role === "author" ? [plan.envelope.roomId] : [],
    jazzboardRoomAccessBindingDigests: plan.role === "author" && exactInviteOpened && plan.envelope.role === "author"
      ? [plan.envelope.privateRoomAccessBindingDigest]
      : [],
    jazzboardInviteUrlDigests: plan.role === "author" && exactInviteOpened && plan.envelope.role === "author"
      ? [hashCanonicalJson(plan.envelope.privateRoomUrl)]
      : [],
    webMcpCallCount: toolNames.length,
    webMcpFailureCount,
    webMcpToolNames: uniqueToolNames,
    webMcpOrigins: webMcpOrigins.sort(),
    openedArtifactPacketManifestDigest: plan.role === "author" ? null : exactPacketManifestOpened ? packet!.manifestDigest : null,
    openedArtifactPacketFileDigests: plan.role === "author" ? null : packet!.files
      .filter((file) => openedPacketFileUrls.has(new URL(file.relativePath, new URL("./", packet!.manifestUrl)).href))
      .map((file) => file.sha256)
      .sort(),
    observationEvidenceDigest: pageRoot,
  }));
}

function terminalizeExp0001aReadFailure(input: {
  lifecycle: Exp0001aCodexTaskLifecycle;
  command: Exp0001aCodexReadThreadCommand;
  observedAt: string;
  pages: readonly Exp0001aCodexReadThreadPageReceipt[];
  failureCode: string;
  cursorExhausted: boolean;
  transportTruncationDetected: boolean;
  authorFinalRoomReadReceipt?: Exp0001aAuthorFinalRoomReadReceipt | null;
  authorFinalEvidence?: Exp0001aAuthorFinalReviewEvidence | null;
}): Exp0001aCodexTaskLifecycle {
  const pageReceiptRoot = readPageReceiptRoot(input.pages);
  const content = readThreadReceiptContentSchema.parse({
    schemaVersion: 1,
    kind: "codex-read-thread-receipt",
    transportId: input.lifecycle.transportId,
    commandDigest: input.command.commandDigest,
    observedAt: input.observedAt,
    codexTaskId: input.lifecycle.codexTaskId,
    outcome: "unavailable",
    terminalResultDigest: null,
    terminalJson: null,
    taskTraceDigest: null,
    taskTraceObservation: null,
    tracePolicyReceipt: null,
    terminalArtifact: null,
    authorFinalRoomReadReceipt: input.authorFinalRoomReadReceipt ?? null,
    authorFinalEvidence: input.authorFinalEvidence ?? null,
    retainedPageCount: input.pages.length,
    pageReceiptRoot,
    cursorExhausted: input.cursorExhausted,
    transportTruncationDetected: input.transportTruncationDetected,
    evidenceDigest: pageReceiptRoot,
    failureCode: input.failureCode,
  });
  const receipt = sealReceipt(
    exp0001aCodexReadThreadReceiptSchema,
    content as Omit<Exp0001aCodexReadThreadReceipt, "receiptDigest">,
  );
  const { lifecycleDigest: _lifecycleDigest, ...lifecycleContent } = input.lifecycle;
  void _lifecycleDigest;
  return sealLifecycle({
    ...lifecycleContent,
    state: "terminal",
    latestReadCursor: null,
    readPageReceipts: [...input.pages],
    readReceipt: receipt,
    terminalOutcome: "non_evaluable",
  });
}

function retainMalformedExp0001aReadPage(input: {
  lifecycle: Exp0001aCodexTaskLifecycle;
  command: Exp0001aCodexReadThreadCommand;
  observedAt: string;
  rawCallResult: JsonValue;
  rawResult: JsonValue | null;
}): Exp0001aCodexReadThreadPageReceipt {
  const content = readThreadPageReceiptContentSchema.parse({
    schemaVersion: 1,
    kind: "codex-read-thread-page-receipt",
    transportId: input.lifecycle.transportId,
    commandDigest: input.command.commandDigest,
    observedAt: input.observedAt,
    codexTaskId: input.lifecycle.codexTaskId,
    pageIndex: input.lifecycle.readPageReceipts.length,
    requestedCursor: input.command.arguments.cursor ?? null,
    nextCursor: null,
    hasMore: false,
    callOutcome: "malformed",
    rawCallResultDigest: hashCanonicalJson(input.rawCallResult),
    rawCallResult: input.rawCallResult,
    rawResultDigest: input.rawResult === null ? null : hashCanonicalJson(input.rawResult),
    rawResult: input.rawResult,
    agentFinalMessageCount: 0,
    transportTruncationDetected: false,
  });
  return sealReceipt(
    exp0001aCodexReadThreadPageReceiptSchema,
    content as Omit<Exp0001aCodexReadThreadPageReceipt, "receiptDigest">,
  );
}

function retainBoundAuthorEvidenceForTerminalRead(input: {
  plan: Exp0001aCodexTaskTransportPlan;
  lifecycle: Exp0001aCodexTaskLifecycle;
  waitReceipt: Exp0001aCodexWaitThreadsReceipt;
  readObservedAt: string;
  receipt: Exp0001aAuthorFinalRoomReadReceipt | null;
}): Readonly<{
  raw: Exp0001aAuthorFinalRoomReadReceipt;
  projected: Exp0001aAuthorFinalReviewEvidence;
}> | null {
  if (input.receipt === null) return null;
  if (input.plan.role !== "author" || input.plan.envelope.role !== "author") {
    throw new Error("REVIEW_TASK_CANNOT_RECEIVE_AUTHOR_ROOM_EVIDENCE");
  }
  if (input.lifecycle.codexTaskId === null || input.waitReceipt.outcome !== "completed") {
    throw new Error("NONCOMPLETED_AUTHOR_TASK_CANNOT_RETAIN_AUTHOR_ROOM_EVIDENCE");
  }
  const raw = exp0001aAuthorFinalRoomReadReceiptSchema.parse(input.receipt);
  if (raw.authorPlanDigest !== input.plan.planDigest
      || raw.transportId !== input.plan.transportId
      || raw.codexTaskId !== input.lifecycle.codexTaskId
      || raw.command.afterWaitReceiptDigest !== input.waitReceipt.receiptDigest
      || raw.roomId !== input.plan.envelope.roomId
      || raw.privateRoomAccessBindingDigest !== input.plan.envelope.privateRoomAccessBindingDigest) {
    throw new Error("AUTHOR_FINAL_EVIDENCE_RECEIPT_NOT_BOUND_TO_TERMINAL_TASK");
  }
  const finalEvidenceAt = Date.parse(raw.observedAt);
  if (finalEvidenceAt < Date.parse(input.waitReceipt.observedAt)
      || finalEvidenceAt > Date.parse(input.readObservedAt)) {
    throw new Error("AUTHOR_FINAL_EVIDENCE_OUTSIDE_COMPLETION_AND_READ_WINDOW");
  }
  return freezeDeep({ raw, projected: createAuthorFinalReviewEvidence(raw) });
}

export function recordExp0001aReadThreadResult(input: {
  plan: Exp0001aCodexTaskTransportPlan;
  lifecycle: Exp0001aCodexTaskLifecycle;
  command: Exp0001aCodexReadThreadCommand;
  observedAt: string;
  rawResult: unknown;
  finalAuthoritativeEvidenceReceipt: Exp0001aAuthorFinalRoomReadReceipt | null;
}): Exp0001aCodexTaskLifecycle {
  const plan = exp0001aCodexTaskTransportPlanSchema.parse(input.plan);
  const record = exp0001aCodexTaskLifecycleSchema.parse(input.lifecycle);
  const command = exp0001aCodexReadThreadCommandSchema.parse(input.command);
  if (record.planDigest !== plan.planDigest || record.state !== "awaiting_terminal_read"
      || record.codexTaskId === null || record.threadId === null || record.hostId === null) {
    throw new Error("CODEX_TASK_NOT_READY_FOR_TERMINAL_READ");
  }
  if (Date.parse(input.observedAt) < Date.parse(command.issuedAt)) throw new Error("CODEX_READ_RECEIPT_PRECEDES_COMMAND");
  if (record.readPageReceipts.some((receipt) => receipt.commandDigest === command.commandDigest)) {
    throw new Error("CODEX_READ_THREAD_PAGE_COMMAND_ALREADY_RECORDED");
  }
  if (command.transportId !== record.transportId || command.arguments.threadId !== record.threadId
      || command.arguments.hostId !== record.hostId
      || (command.arguments.cursor ?? null) !== record.latestReadCursor) {
    throw new Error("CODEX_READ_COMMAND_NOT_BOUND_TO_CURRENT_LIFECYCLE");
  }
  const waitOutcome = record.waitReceipts.at(-1);
  if (waitOutcome === undefined || waitOutcome.outcome === "timeout") throw new Error("TERMINAL_WAIT_RECEIPT_MISSING");
  const retainedAuthorEvidence = retainBoundAuthorEvidenceForTerminalRead({
    plan,
    lifecycle: record,
    waitReceipt: waitOutcome,
    readObservedAt: input.observedAt,
    receipt: input.finalAuthoritativeEvidenceReceipt,
  });
  const retainedAuthorEvidenceFields = {
    authorFinalRoomReadReceipt: retainedAuthorEvidence?.raw ?? null,
    authorFinalEvidence: retainedAuthorEvidence?.projected ?? null,
  };
  let retainedCallResult: RetainedCodexAppCallResult;
  try {
    retainedCallResult = retainExactCodexAppCallResult(input.rawResult);
  } catch {
    const rawCallResult = cloneJson(input.rawResult);
    const page = retainMalformedExp0001aReadPage({
      lifecycle: record,
      command,
      observedAt: input.observedAt,
      rawCallResult,
      rawResult: null,
    });
    return terminalizeExp0001aReadFailure({
      lifecycle: record,
      command,
      observedAt: input.observedAt,
      pages: [...record.readPageReceipts, page],
      failureCode: "read_thread_call_result_malformed",
      cursorExhausted: false,
      transportTruncationDetected: false,
      ...retainedAuthorEvidenceFields,
    });
  }
  if (retainedCallResult.isError || retainedCallResult.payload === null) {
    const errorPageContent = readThreadPageReceiptContentSchema.parse({
      schemaVersion: 1,
      kind: "codex-read-thread-page-receipt",
      transportId: record.transportId,
      commandDigest: command.commandDigest,
      observedAt: input.observedAt,
      codexTaskId: record.codexTaskId,
      pageIndex: record.readPageReceipts.length,
      requestedCursor: command.arguments.cursor ?? null,
      nextCursor: null,
      hasMore: false,
      callOutcome: "error",
      rawCallResultDigest: retainedCallResult.rawResultDigest,
      rawCallResult: retainedCallResult.rawResult,
      rawResultDigest: null,
      rawResult: null,
      agentFinalMessageCount: 0,
      transportTruncationDetected: false,
    });
    const errorPageReceipt = sealReceipt(
      exp0001aCodexReadThreadPageReceiptSchema,
      errorPageContent as Omit<Exp0001aCodexReadThreadPageReceipt, "receiptDigest">,
    );
    return terminalizeExp0001aReadFailure({
      lifecycle: record,
      command,
      observedAt: input.observedAt,
      pages: [...record.readPageReceipts, errorPageReceipt],
      failureCode: "read_thread_tool_error_non_evaluable",
      cursorExhausted: false,
      transportTruncationDetected: false,
      ...retainedAuthorEvidenceFields,
    });
  }
  const rawPageResult = rawReadThreadPageSchema.safeParse(retainedCallResult.payload);
  if (!rawPageResult.success) {
    const page = retainMalformedExp0001aReadPage({
      lifecycle: record,
      command,
      observedAt: input.observedAt,
      rawCallResult: retainedCallResult.rawResult,
      rawResult: retainedCallResult.payload,
    });
    return terminalizeExp0001aReadFailure({
      lifecycle: record,
      command,
      observedAt: input.observedAt,
      pages: [...record.readPageReceipts, page],
      failureCode: "read_thread_payload_schema_invalid",
      cursorExhausted: false,
      transportTruncationDetected: false,
      ...retainedAuthorEvidenceFields,
    });
  }
  const rawPage = rawPageResult.data;
  if (rawPage.thread.id !== record.threadId || rawPage.thread.hostId !== record.hostId) {
    const page = retainMalformedExp0001aReadPage({
      lifecycle: record,
      command,
      observedAt: input.observedAt,
      rawCallResult: retainedCallResult.rawResult,
      rawResult: retainedCallResult.payload,
    });
    return terminalizeExp0001aReadFailure({
      lifecycle: record,
      command,
      observedAt: input.observedAt,
      pages: [...record.readPageReceipts, page],
      failureCode: "read_thread_task_binding_mismatch",
      cursorExhausted: false,
      transportTruncationDetected: false,
      ...retainedAuthorEvidenceFields,
    });
  }
  const transportTruncationDetected = rawPage.turns.some((turn) => turn.items.some(outputMetadataTruncated));
  const agentFinalMessageCount = rawPage.turns.reduce((count, turn) => count + turn.items.filter((item) => {
    const object = jsonObject(item);
    return object?.type === "agentMessage" && object.phase === "final_answer" && typeof object.text === "string";
  }).length, 0);
  const pageContent = readThreadPageReceiptContentSchema.parse({
    schemaVersion: 1,
    kind: "codex-read-thread-page-receipt",
    transportId: record.transportId,
    commandDigest: command.commandDigest,
    observedAt: input.observedAt,
    codexTaskId: record.codexTaskId,
    pageIndex: record.readPageReceipts.length,
    requestedCursor: command.arguments.cursor ?? null,
    nextCursor: rawPage.page.nextCursor,
    hasMore: rawPage.page.hasMore,
    callOutcome: "success",
    rawCallResultDigest: retainedCallResult.rawResultDigest,
    rawCallResult: retainedCallResult.rawResult,
    rawResultDigest: hashCanonicalJson(rawPage as unknown as JsonValue),
    rawResult: rawPage,
    agentFinalMessageCount,
    transportTruncationDetected,
  });
  const pageReceipt = sealReceipt(
    exp0001aCodexReadThreadPageReceiptSchema,
    pageContent as Omit<Exp0001aCodexReadThreadPageReceipt, "receiptDigest">,
  );
  const pages = [...record.readPageReceipts, pageReceipt];
  const pageReceiptRoot = readPageReceiptRoot(pages);
  const { lifecycleDigest: _lifecycleDigest, ...recordContent } = record;
  void _lifecycleDigest;

  if (rawPage.page.hasMore && input.finalAuthoritativeEvidenceReceipt !== null) {
    throw new Error("CODEX_AUTHOR_EVIDENCE_BEFORE_READ_CURSOR_EXHAUSTION");
  }
  if (transportTruncationDetected) {
    return terminalizeExp0001aReadFailure({
      lifecycle: record,
      command,
      observedAt: input.observedAt,
      pages,
      failureCode: "read_thread_transport_truncated",
      cursorExhausted: !rawPage.page.hasMore,
      transportTruncationDetected: true,
      ...retainedAuthorEvidenceFields,
    });
  }
  if (rawPage.page.hasMore) {
    const priorCursors = new Set(record.readPageReceipts.flatMap((receipt) => [
      ...(receipt.requestedCursor === null ? [] : [receipt.requestedCursor]),
      ...(receipt.nextCursor === null ? [] : [receipt.nextCursor]),
    ]));
    if (rawPage.page.nextCursor !== null && priorCursors.has(rawPage.page.nextCursor)) {
      return terminalizeExp0001aReadFailure({
        lifecycle: record,
        command,
        observedAt: input.observedAt,
        pages,
        failureCode: "read_thread_cursor_cycle",
        cursorExhausted: false,
        transportTruncationDetected: false,
        ...retainedAuthorEvidenceFields,
      });
    }
    if (pages.length >= EXP0001A_CODEX_READ_THREAD_MAX_PAGES) {
      return terminalizeExp0001aReadFailure({
        lifecycle: record,
        command,
        observedAt: input.observedAt,
        pages,
        failureCode: "read_thread_page_limit_exhausted",
        cursorExhausted: false,
        transportTruncationDetected: false,
        ...retainedAuthorEvidenceFields,
      });
    }
    return sealLifecycle({
      ...recordContent,
      latestReadCursor: rawPage.page.nextCursor,
      readPageReceipts: pages,
    });
  }

  const traceObservation = deriveExp0001aCodexTaskTraceObservation({
    plan,
    lifecycle: record,
    pages,
    capturedAt: input.observedAt,
  });
  const tracePolicy = evaluateExp0001aCodexTaskTracePolicy({
    plan,
    lifecycle: record,
    evaluatedAt: input.observedAt,
    observation: traceObservation,
  });
  let terminalArtifact: Exp0001aCodexTerminalArtifact | null = null;
  const authorFinalRoomReadReceipt = retainedAuthorEvidence?.raw ?? null;
  const authorFinalEvidence = retainedAuthorEvidence?.projected ?? null;
  let acceptedTerminalJson: JsonValue | null = null;
  let retainedTerminalResultDigest: string | null = null;
  let validatedTerminalJson: Exp0001aCodexTerminalJson | null = null;
  let evaluationFailureCode: string | null = waitOutcome.failureCode;
  if (waitOutcome.outcome === "completed") {
    const terminalMessages = finalAgentMessages(pages);
    if (terminalMessages.length !== 1) {
      evaluationFailureCode = "terminal_agent_message_count_invalid";
    } else if (terminalMessages[0]!.length > EXP0001A_CODEX_TERMINAL_RESULT_MAX_CHARS) {
      evaluationFailureCode = "terminal_agent_message_capacity_exceeded";
    } else {
      retainedTerminalResultDigest = sha256Digest(Buffer.from(terminalMessages[0]!, "utf8"));
      if (retainedTerminalResultDigest !== waitOutcome.terminalResultDigest) {
        evaluationFailureCode = "terminal_wait_read_digest_mismatch";
      } else {
        try {
          validatedTerminalJson = validateExp0001aCodexTerminalJson(plan, JSON.parse(terminalMessages[0]!));
        } catch {
          validatedTerminalJson = null;
          evaluationFailureCode = "terminal_json_invalid";
        }
      }
    }
    if (tracePolicy.decision === "pass" && validatedTerminalJson !== null) {
      const terminalJson = validatedTerminalJson;
      if (plan.role === "author") {
        if (plan.envelope.role !== "author") throw new Error("AUTHOR_PLAN_ENVELOPE_ROLE_MISMATCH");
        if (authorFinalRoomReadReceipt !== null && authorFinalEvidence !== null) {
          terminalArtifact = createExp0001aIndependentAuthorArtifact({
            plan,
            lifecycle: record,
            modelTerminalResultDigest: retainedTerminalResultDigest!,
            modelTerminalJson: terminalJson,
            finalAuthoritativeRoomReadReceipt: authorFinalRoomReadReceipt,
            taskTraceObservation: traceObservation,
          });
          evaluationFailureCode = null;
        } else {
          evaluationFailureCode = "author_final_authoritative_evidence_missing";
        }
      } else {
        if (input.finalAuthoritativeEvidenceReceipt !== null) {
          throw new Error("REVIEW_TASK_CANNOT_RECEIVE_AUTHOR_ROOM_EVIDENCE");
        }
        terminalArtifact = createExp0001aIndependentReviewArtifact({
          plan,
          lifecycle: record,
          modelTerminalResultDigest: retainedTerminalResultDigest!,
          result: terminalJson,
        });
        evaluationFailureCode = null;
      }
      if (terminalArtifact !== null) {
        verifyTerminalArtifactBinding(plan, terminalArtifact);
        acceptedTerminalJson = cloneJson(terminalJson as unknown as JsonValue);
      }
    } else if (tracePolicy.decision === "policy_violation") {
      evaluationFailureCode = "task_trace_policy_violation";
    } else if (tracePolicy.decision === "non_evaluable") {
      evaluationFailureCode = "task_trace_non_evaluable";
    }
  }
  const receiptContent = readThreadReceiptContentSchema.parse({
    schemaVersion: 1,
    kind: "codex-read-thread-receipt",
    transportId: record.transportId,
    commandDigest: command.commandDigest,
    observedAt: input.observedAt,
    codexTaskId: record.codexTaskId,
    outcome: "retained",
    terminalResultDigest: retainedTerminalResultDigest,
    terminalJson: acceptedTerminalJson,
    taskTraceDigest: traceObservation.taskTraceDigest,
    taskTraceObservation: traceObservation,
    tracePolicyReceipt: tracePolicy,
    terminalArtifact,
    authorFinalRoomReadReceipt,
    authorFinalEvidence,
    retainedPageCount: pages.length,
    pageReceiptRoot,
    cursorExhausted: true,
    transportTruncationDetected: false,
    evidenceDigest: pageReceiptRoot,
    failureCode: terminalArtifact === null
      ? evaluationFailureCode ?? "terminal_result_not_accepted"
      : null,
  });
  const receipt = sealReceipt(exp0001aCodexReadThreadReceiptSchema, receiptContent as Omit<Exp0001aCodexReadThreadReceipt, "receiptDigest">);
  const terminalOutcome = waitOutcome.outcome === "failed"
    ? "infra_failure" as const
    : waitOutcome.outcome === "usage_limit"
      ? "usage_limit_interrupted" as const
      : waitOutcome.outcome === "needs_attention"
        ? "needs_attention" as const
        : terminalArtifact !== null
          ? "succeeded" as const
          : tracePolicy.decision === "policy_violation"
            ? "policy_violation" as const
            : "non_evaluable" as const;
  return sealLifecycle({
    ...recordContent,
    state: "terminal",
    latestReadCursor: null,
    readPageReceipts: pages,
    readReceipt: receipt,
    terminalOutcome,
  });
}

/** Verifies fresh, non-forked contexts across authors and every review role. */
export function assertExp0001aCodexTaskContextsSeparated(input: ReadonlyArray<{
  plan: Exp0001aCodexTaskTransportPlan;
  lifecycle: Exp0001aCodexTaskLifecycle;
}>): void {
  const taskIds = new Set<string>();
  const transportIds = new Set<string>();
  const authorRoomIds = new Set<string>();
  const authorRoomAccessBindings = new Set<string>();
  const authorRoomProvisioningReceipts = new Set<string>();
  for (const item of input) {
    const plan = exp0001aCodexTaskTransportPlanSchema.parse(item.plan);
    const lifecycle = exp0001aCodexTaskLifecycleSchema.parse(item.lifecycle);
    if (plan.planDigest !== lifecycle.planDigest || plan.transportId !== lifecycle.transportId || plan.role !== lifecycle.role) {
      throw new Error("CODEX_TASK_PLAN_LIFECYCLE_BINDING_INVALID");
    }
    if (transportIds.has(plan.transportId)) throw new Error("CODEX_TRANSPORT_ID_REUSED");
    transportIds.add(plan.transportId);
    if (lifecycle.codexTaskId !== null) {
      if (taskIds.has(lifecycle.codexTaskId)) throw new Error("CODEX_TASK_CONTEXT_REUSED");
      taskIds.add(lifecycle.codexTaskId);
    }
    if (plan.envelope.role === "author" && lifecycle.taskBegun) {
      if (authorRoomIds.has(plan.envelope.roomId)
          || authorRoomAccessBindings.has(plan.envelope.privateRoomAccessBindingDigest)
          || authorRoomProvisioningReceipts.has(plan.envelope.roomProvisioningReceiptDigest)) {
        throw new Error("CODEX_AUTHOR_PRIVATE_ROOM_REUSED");
      }
      authorRoomIds.add(plan.envelope.roomId);
      authorRoomAccessBindings.add(plan.envelope.privateRoomAccessBindingDigest);
      authorRoomProvisioningReceipts.add(plan.envelope.roomProvisioningReceiptDigest);
    }
    const isolation = plan.createThreadCommand.isolation;
    if (plan.createThreadCommand.arguments.target.type !== "projectless" || isolation.sourceThreadId !== null
        || isolation.forkedFromThreadId !== null || isolation.projectId !== null || isolation.sharedHistory
        || isolation.repositoryAccess || isolation.privateApiAccess || isolation.preparedCoordinates || isolation.evaluatorContext) {
      throw new Error("CODEX_TASK_ISOLATION_VIOLATION");
    }
  }
}
