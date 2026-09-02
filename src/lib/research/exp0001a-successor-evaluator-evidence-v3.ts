import { z } from "zod";

import {
  canonicalJson,
  hashCanonicalJson,
  SHA256_DIGEST_PATTERN,
  type JsonValue,
} from "./provenance-crypto";

export const EXP0001A_SUCCESSOR_EVALUATOR_EVIDENCE_V3_VERSION =
  "exp-0001a-successor-evaluator-evidence/v3" as const;

const digestSchema = z.string().regex(SHA256_DIGEST_PATTERN);
const jsonValueSchema = z.custom<JsonValue>((value) => {
  try {
    canonicalJson(value);
    return true;
  } catch {
    return false;
  }
}, "Expected a finite plain JSON value.");

export const exp0001aSuccessorEvaluatorFileMetadataV3Schema = z.object({
  relativePath: z.string().min(1).max(512).regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/),
  sha256: digestSchema,
  bytes: z.number().int().positive().max(10 * 1024 * 1024),
  mimeType: z.enum(["image/png", "application/json"]),
}).strict();
export type Exp0001aSuccessorEvaluatorFileMetadataV3 = z.infer<
  typeof exp0001aSuccessorEvaluatorFileMetadataV3Schema
>;

export const exp0001aSuccessorEvaluatorPacketPointerV3Schema = z.object({
  kind: z.literal("read-only-loopback-evaluator-packet"),
  manifestUrl: z.string().url(),
  manifestDigest: digestSchema,
  files: z.array(exp0001aSuccessorEvaluatorFileMetadataV3Schema).min(1).max(14),
  allowedMethods: z.tuple([z.literal("GET"), z.literal("HEAD")]),
  postReleaseGetRequiredPerExactUrl: z.literal(true),
}).strict().superRefine((packet, context) => {
  const manifestUrl = new URL(packet.manifestUrl);
  if (manifestUrl.protocol !== "http:" || manifestUrl.hostname !== "127.0.0.1" || !manifestUrl.port
      || manifestUrl.username || manifestUrl.password || manifestUrl.search || manifestUrl.hash) {
    context.addIssue({ code: "custom", path: ["manifestUrl"], message: "Evaluator packets require an exact loopback manifest URL." });
  }
  const paths = packet.files.map((file) => file.relativePath);
  if (new Set(paths).size !== paths.length
      || paths.some((value, index) => index > 0 && packet.files[index - 1]!.relativePath.localeCompare(value) >= 0)) {
    context.addIssue({ code: "custom", path: ["files"], message: "Evaluator packet paths must be unique and sorted." });
  }
  const expectedManifestDigest = hashCanonicalJson({
    schemaVersion: EXP0001A_SUCCESSOR_EVALUATOR_EVIDENCE_V3_VERSION,
    kind: "successor-evaluator-packet-manifest",
    files: packet.files,
  });
  if (packet.manifestDigest !== expectedManifestDigest) {
    context.addIssue({ code: "custom", path: ["manifestDigest"], message: "Evaluator packet manifest digest is invalid." });
  }
  const expectedPath = `/exp0001a/evaluator/${expectedManifestDigest.slice("sha256:".length)}/manifest.json`;
  if (manifestUrl.pathname !== expectedPath) {
    context.addIssue({ code: "custom", path: ["manifestUrl"], message: "Evaluator packet manifest URL is not hash addressed." });
  }
});

const rubricSchema = z.object({
  rubricId: z.string().trim().min(1).max(200),
  criterionIds: z.array(z.string().trim().min(1).max(200)).min(1).max(32),
  allowedMechanismTags: z.array(z.string().trim().min(1).max(200)).max(256),
  sha256: digestSchema,
  content: jsonValueSchema,
}).strict().superRefine((rubric, context) => {
  if (hashCanonicalJson(rubric.content) !== rubric.sha256) {
    context.addIssue({ code: "custom", path: ["sha256"], message: "Rubric digest is invalid." });
  }
  if (new Set(rubric.criterionIds).size !== rubric.criterionIds.length
      || new Set(rubric.allowedMechanismTags).size !== rubric.allowedMechanismTags.length) {
    context.addIssue({ code: "custom", path: ["criterionIds"], message: "Rubric criterion IDs and mechanism tags must be unique." });
  }
});

const semanticStateSchema = z.object({
  sha256: digestSchema,
  bytes: z.number().int().positive().max(64 * 1024),
  content: jsonValueSchema,
}).strict().superRefine((state, context) => {
  if (Buffer.byteLength(canonicalJson(state.content), "utf8") !== state.bytes
      || hashCanonicalJson(state.content) !== state.sha256) {
    context.addIssue({ code: "custom", message: "Sanitized semantic state bytes or digest are invalid." });
  }
});

const imageSchema = exp0001aSuccessorEvaluatorFileMetadataV3Schema.extend({
  slot: z.string().regex(/^image-[0-9]{2}$/),
  roomRevision: z.number().int().nonnegative(),
  final: z.boolean(),
  width: z.number().int().positive().max(8_192),
  height: z.number().int().positive().max(8_192),
  mimeType: z.literal("image/png"),
}).strict();

export const exp0001aSuccessorReviewEvidenceV3Schema = z.object({
  publicRequirement: z.string().trim().min(20).max(16_000),
  rubric: rubricSchema,
  semanticState: semanticStateSchema,
  images: z.array(imageSchema).min(1).max(7),
  evidenceRoot: digestSchema,
}).strict().superRefine((evidence, context) => {
  if (evidence.images.some((image, index) => image.slot !== `image-${String(index + 1).padStart(2, "0")}`)
      || evidence.images.some((image, index) => index > 0 && image.roomRevision < evidence.images[index - 1]!.roomRevision)
      || evidence.images.filter((image) => image.final).length !== 1
      || evidence.images.at(-1)?.final !== true) {
    context.addIssue({ code: "custom", path: ["images"], message: "Review images must be sequential, revision-monotonic, and final-last." });
  }
  const expectedRoot = hashCanonicalJson({
    publicRequirement: evidence.publicRequirement,
    rubricSha256: evidence.rubric.sha256,
    rubricCriterionIds: evidence.rubric.criterionIds,
    allowedMechanismTags: evidence.rubric.allowedMechanismTags,
    semanticStateSha256: evidence.semanticState.sha256,
    images: evidence.images.map(({ slot, roomRevision, final, sha256, bytes, width, height, relativePath }) => ({
      slot, roomRevision, final, sha256, bytes, width, height, relativePath,
    })),
  });
  if (evidence.evidenceRoot !== expectedRoot) {
    context.addIssue({ code: "custom", path: ["evidenceRoot"], message: "Review evidence root is invalid." });
  }
});
export type Exp0001aSuccessorReviewEvidenceV3 = z.infer<typeof exp0001aSuccessorReviewEvidenceV3Schema>;

const primaryVisibleInputSchema = z.object({
  schemaVersion: z.literal(EXP0001A_SUCCESSOR_EVALUATOR_EVIDENCE_V3_VERSION),
  kind: z.literal("primary-reviewer-visible-input"),
  role: z.literal("primary_reviewer"),
  evidence: exp0001aSuccessorReviewEvidenceV3Schema,
  packet: exp0001aSuccessorEvaluatorPacketPointerV3Schema,
}).strict();

const adjudicatorVisibleInputSchema = z.object({
  schemaVersion: z.literal(EXP0001A_SUCCESSOR_EVALUATOR_EVIDENCE_V3_VERSION),
  kind: z.literal("adjudicator-visible-input"),
  role: z.literal("adjudicator"),
  evidence: exp0001aSuccessorReviewEvidenceV3Schema,
  packet: exp0001aSuccessorEvaluatorPacketPointerV3Schema,
}).strict();

const pairwiseSideSchema = z.object({
  slot: z.enum(["canvas-1", "canvas-2"]),
  image: imageSchema,
  sideRoot: digestSchema,
}).strict().superRefine((side, context) => {
  const expected = hashCanonicalJson({
    slot: side.slot,
    finalImage: {
      roomRevision: side.image.roomRevision,
      sha256: side.image.sha256,
      bytes: side.image.bytes,
      width: side.image.width,
      height: side.image.height,
      relativePath: side.image.relativePath,
    },
  });
  if (!side.image.final || side.sideRoot !== expected) {
    context.addIssue({ code: "custom", message: "Pairwise side must bind one exact final image." });
  }
});

const pairwiseVisibleInputSchema = z.object({
  schemaVersion: z.literal(EXP0001A_SUCCESSOR_EVALUATOR_EVIDENCE_V3_VERSION),
  kind: z.literal("pairwise-visual-judge-visible-input"),
  role: z.literal("pairwise_visual_judge"),
  publicRequirement: z.string().trim().min(20).max(16_000),
  rubric: rubricSchema,
  sides: z.tuple([pairwiseSideSchema, pairwiseSideSchema]),
  pairRoot: digestSchema,
  packet: exp0001aSuccessorEvaluatorPacketPointerV3Schema,
}).strict().superRefine((input, context) => {
  if (input.sides[0].slot !== "canvas-1" || input.sides[1].slot !== "canvas-2"
      || input.sides[0].sideRoot === input.sides[1].sideRoot
      || input.pairRoot !== hashCanonicalJson(input.sides.map(({ slot, sideRoot }) => ({ slot, sideRoot })))) {
    context.addIssue({ code: "custom", path: ["pairRoot"], message: "Pairwise visible input is not bound to two distinct opaque sides." });
  }
});

export const exp0001aSuccessorEvaluatorVisibleInputV3Schema = z.discriminatedUnion("role", [
  primaryVisibleInputSchema,
  adjudicatorVisibleInputSchema,
  pairwiseVisibleInputSchema,
]);
export type Exp0001aSuccessorEvaluatorVisibleInputV3 = z.infer<typeof exp0001aSuccessorEvaluatorVisibleInputV3Schema>;

const privateAdjudicationKey = /^(?:primary(?:review)?(?:s|decisions?|results?|root|digest|rationales?)|adjudication(?:subject)?(?:root|digest)|author(?:id|identity|transcript)|condition(?:id|label)?)$/i;

function privateAdjudicationPaths(value: JsonValue, at = "$", found: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((child, index) => privateAdjudicationPaths(child, `${at}[${index}]`, found));
  } else if (value !== null && typeof value === "object") {
    Object.entries(value).forEach(([key, child]) => {
      if (privateAdjudicationKey.test(key.replaceAll(/[^A-Za-z0-9]/g, ""))) found.push(`${at}.${key}`);
      privateAdjudicationPaths(child, `${at}.${key}`, found);
    });
  }
  return found;
}

function assertPacketMatchesFiles(
  packet: z.infer<typeof exp0001aSuccessorEvaluatorPacketPointerV3Schema>,
  files: readonly Exp0001aSuccessorEvaluatorFileMetadataV3[],
): void {
  const expected = [...files].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  if (canonicalJson(packet.files) !== canonicalJson(expected)) {
    throw new Error("SUCCESSOR_EVALUATOR_PACKET_FILES_NOT_BOUND_TO_VISIBLE_INPUT");
  }
}

export function createExp0001aSuccessorPrimaryReviewerVisibleInputV3(input: {
  evidence: Exp0001aSuccessorReviewEvidenceV3;
  packet: z.infer<typeof exp0001aSuccessorEvaluatorPacketPointerV3Schema>;
}): Extract<Exp0001aSuccessorEvaluatorVisibleInputV3, { role: "primary_reviewer" }> {
  const evidence = exp0001aSuccessorReviewEvidenceV3Schema.parse(input.evidence);
  const packet = exp0001aSuccessorEvaluatorPacketPointerV3Schema.parse(input.packet);
  assertPacketMatchesFiles(packet, evidence.images.map(({ relativePath, sha256, bytes, mimeType }) => ({ relativePath, sha256, bytes, mimeType })));
  return Object.freeze(primaryVisibleInputSchema.parse({
    schemaVersion: EXP0001A_SUCCESSOR_EVALUATOR_EVIDENCE_V3_VERSION,
    kind: "primary-reviewer-visible-input",
    role: "primary_reviewer",
    evidence,
    packet,
  }));
}

export function createExp0001aSuccessorAdjudicatorVisibleInputV3(input: unknown): Extract<
  Exp0001aSuccessorEvaluatorVisibleInputV3,
  { role: "adjudicator" }
> {
  const rawForbidden = privateAdjudicationPaths(input as JsonValue);
  if (rawForbidden.length > 0) {
    throw new Error(`SUCCESSOR_ADJUDICATOR_VISIBLE_INPUT_CONTAINS_PRIVATE_CONTEXT:${rawForbidden.slice(0, 5).join(",")}`);
  }
  const parsed = z.object({
    evidence: exp0001aSuccessorReviewEvidenceV3Schema,
    packet: exp0001aSuccessorEvaluatorPacketPointerV3Schema,
  }).strict().parse(input);
  const forbidden = privateAdjudicationPaths(parsed as unknown as JsonValue);
  if (forbidden.length > 0) {
    throw new Error(`SUCCESSOR_ADJUDICATOR_VISIBLE_INPUT_CONTAINS_PRIVATE_CONTEXT:${forbidden.slice(0, 5).join(",")}`);
  }
  assertPacketMatchesFiles(parsed.packet, parsed.evidence.images.map(({ relativePath, sha256, bytes, mimeType }) => ({
    relativePath, sha256, bytes, mimeType,
  })));
  return Object.freeze(adjudicatorVisibleInputSchema.parse({
    schemaVersion: EXP0001A_SUCCESSOR_EVALUATOR_EVIDENCE_V3_VERSION,
    kind: "adjudicator-visible-input",
    role: "adjudicator",
    evidence: parsed.evidence,
    packet: parsed.packet,
  }));
}

export function createExp0001aSuccessorPairwiseVisibleInputV3(input: Omit<
  z.input<typeof pairwiseVisibleInputSchema>,
  "schemaVersion" | "kind" | "role"
>): Extract<Exp0001aSuccessorEvaluatorVisibleInputV3, { role: "pairwise_visual_judge" }> {
  const parsed = pairwiseVisibleInputSchema.parse({
    schemaVersion: EXP0001A_SUCCESSOR_EVALUATOR_EVIDENCE_V3_VERSION,
    kind: "pairwise-visual-judge-visible-input",
    role: "pairwise_visual_judge",
    ...input,
  });
  assertPacketMatchesFiles(parsed.packet, parsed.sides.map(({ image }) => ({
    relativePath: image.relativePath,
    sha256: image.sha256,
    bytes: image.bytes,
    mimeType: image.mimeType,
  })));
  return Object.freeze(parsed);
}

const reviewResultBindingSchema = z.object({
  schemaVersion: z.literal("exp-0001a-successor-review-result-binding/v3"),
  role: z.enum(["primary_reviewer", "adjudicator"]),
  evidenceRoot: digestSchema,
  result: z.record(z.string(), jsonValueSchema),
}).strict();

const pairwiseResultBindingSchema = z.object({
  schemaVersion: z.literal("exp-0001a-successor-pairwise-result-binding/v3"),
  role: z.literal("pairwise_visual_judge"),
  pairRoot: digestSchema,
  result: z.record(z.string(), jsonValueSchema),
}).strict();

export const exp0001aSuccessorEvaluatorResultBindingV3Schema = z.union([
  reviewResultBindingSchema,
  pairwiseResultBindingSchema,
]);
export type Exp0001aSuccessorEvaluatorResultBindingV3 = z.infer<
  typeof exp0001aSuccessorEvaluatorResultBindingV3Schema
>;

export function validateExp0001aSuccessorEvaluatorResultBindingV3(
  visibleInput: Exp0001aSuccessorEvaluatorVisibleInputV3,
  rawResult: unknown,
): Exp0001aSuccessorEvaluatorResultBindingV3 {
  const subject = exp0001aSuccessorEvaluatorVisibleInputV3Schema.parse(visibleInput);
  const result = exp0001aSuccessorEvaluatorResultBindingV3Schema.parse(rawResult);
  if (result.role !== subject.role) throw new Error("SUCCESSOR_EVALUATOR_RESULT_ROLE_MISMATCH");
  if (subject.role === "pairwise_visual_judge") {
    if (result.role !== "pairwise_visual_judge" || result.pairRoot !== subject.pairRoot) {
      throw new Error("SUCCESSOR_PAIRWISE_RESULT_ROOT_MISMATCH");
    }
  } else if (result.role === "pairwise_visual_judge" || result.evidenceRoot !== subject.evidence.evidenceRoot) {
    throw new Error("SUCCESSOR_REVIEW_RESULT_ROOT_MISMATCH");
  }
  return Object.freeze(result);
}

export function renderExp0001aSuccessorEvaluatorPromptV3(
  visibleInput: Exp0001aSuccessorEvaluatorVisibleInputV3,
): string {
  const input = exp0001aSuccessorEvaluatorVisibleInputV3Schema.parse(visibleInput);
  const rootName = input.role === "pairwise_visual_judge" ? "pairRoot" : "evidenceRoot";
  const root = input.role === "pairwise_visual_judge" ? input.pairRoot : input.evidence.evidenceRoot;
  const schemaVersion = input.role === "pairwise_visual_judge"
    ? "exp-0001a-successor-pairwise-result-binding/v3"
    : "exp-0001a-successor-review-result-binding/v3";
  return [
    "Independent blinded evaluator task",
    "",
    "Open the exact loopback manifest and every listed exact file URL before evaluating.",
    "Use only the visible input below. Do not access Jazzboard, a repository, private APIs, prior reviewers, or external evidence.",
    `Copy the supplied ${rootName} exactly into the terminal JSON. Do not calculate, recompute, or hash it.`,
    "Return JSON only with no extra fields:",
    canonicalJson({ schemaVersion, role: input.role, [rootName]: root, result: { "<role-specific-field>": "<strict value>" } }),
    "",
    "Visible input:",
    canonicalJson(input as unknown as JsonValue),
  ].join("\n");
}
