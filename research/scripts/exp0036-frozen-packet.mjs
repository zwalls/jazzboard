#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  createExp0035ContextFixture,
  gradeExp0035ContextFixture,
} from "./exp0035-context-fixture.mjs";

export const EXP0036_PACKET_SCHEMA_VERSION = "jazzboard-exp0036-author-packets/v1";
export const EXP0036_GRADER_SCHEMA_VERSION = "jazzboard-exp0036-grader-manifest/v1";
export const EXP0036_CONTEXT_GRADE_SCHEMA_VERSION = "jazzboard-exp0036-context-grade/v1";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, "../..");
const SUPPORTED_OBJECT_KINDS = ["text", "shape", "connector", "image", "draw", "path"];
const BASELINE_COMMIT = "f7762da4ea7d1603671a35b4912143c4bff83f34";
const CANDIDATE_COMMIT = "5a67b21505b50c643bf282774f0e7bf4698edf05";
const INVENTORY_SEED = "20260904-exp0036-inventory-2";
const REPAIR_SEED = "20260904-exp0036-repair-2";

const SOURCE_FREEZE = Object.freeze({
  baselineArchiveSha256: "sha256:63f18ac4ad78724fa9cf5601a47b8ca61853947590eccb2ab59144bcf41946ab",
  candidateArchiveSha256: "sha256:cd800597a23fc76d3bc861b30b2803ca51ffa448477f0da0339bfbcafeacdaa5",
  packageLockSha256: "sha256:a1abc6ddf29116dfbeefc38ecc56053988356a1d303f608fcbcb0ec983ad1561",
  developmentV2Sha256: "sha256:9326d2e0d8cd06fdaabfe9345b0eb85e0634fbcc9ece285124553c2a0a649227",
  developmentRubricsV2Sha256: "sha256:15bde60f5e593164a2b8d7ec924cf3d722c049e18db07b0ded5586f9b00f8919",
  contextFixtureSourceSha256: "sha256:07f51991c2d408591412d15d5a1fa76fd5af0edb6a25d3e9961864bf82bd52fe",
  packetProtocolSha256: "sha256:f15d1c2c9217dad5401606b38752228820e54c31a508aa25a67f999047aa981f",
});

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonical(value[key])}`
  )).join(",")}}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadJson(relativePath) {
  return JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, relativePath), "utf8"));
}

function exactTask(bundle, taskId) {
  const task = bundle.tasks?.find((item) => item.id === taskId);
  if (!task) throw new Error(`Missing frozen development-v2 task ${taskId}.`);
  return clone(task);
}

function exactRubric(bundle, taskId) {
  const rubric = bundle.rubrics?.find((item) => item.taskId === taskId);
  if (!rubric) throw new Error(`Missing frozen development-v2 rubric ${taskId}.`);
  return clone(rubric);
}

function assertSourceDigest(relativePath, expected) {
  const actual = sha256(readFileSync(path.join(REPOSITORY_ROOT, relativePath)));
  if (actual !== expected) throw new Error(`Frozen source digest mismatch for ${relativePath}: ${actual}.`);
}

function contextPublicTask(family, fixture) {
  return {
    id: family === "inventory" ? "exp0036-existing-inventory" : "exp0036-existing-metadata-edit",
    title: family === "inventory" ? "Existing-board inventory" : "Existing-board metadata edit",
    domain: "existing_board",
    stratum: family === "inventory" ? "inventory" : "editing",
    operation: family === "inventory" ? "inspect" : "edit",
    brief: family === "inventory"
      ? `${fixture.public.brief} objectCounts may omit an absent supported kind or include it with the exact value 0; do not include unknown kinds.`
      : fixture.public.brief,
    acceptanceCriteria: family === "inventory" ? [
      { id: "criterion-inventory-answer", text: "Return exact counts for every present kind, the exact Diagram count, and the exact sorted Mira open-question names; absent supported kinds may be omitted or set to 0." },
      { id: "criterion-inventory-read-only", text: "Preserve the complete authoritative document unchanged." },
    ] : [
      { id: "criterion-edit-targets", text: "Update every and only open questions owned by Mira to the requested lifecycle state." },
      { id: "criterion-edit-protection", text: "Preserve every unrelated object, Diagram, geometry, label, style, and non-lifecycle target field exactly." },
      { id: "criterion-edit-answer", text: "Return the exact sorted changed semantic names and exact changed count." },
    ],
  };
}

function promptTemplate(task, resultInstruction) {
  return `Complete the following task in Jazzboard using the Codex in-app browser.\n\nOpen {{ORIGIN}}/ and join the exact private room code {{ROOM_CODE}} as a participant with display name "Board author". This exact room is authorized for the requested work.\n\n${task.brief}\n\nPublic task packet:\n${JSON.stringify(task, null, 2)}\n\nUse only this room's native browser WebMCP tools, public application guidance, and browser pixels. Do not use terminal commands, filesystem access, repository context, direct HTTP requests, page evaluation, private APIs, other rooms, other tasks, or other authors' transcripts. Do not delegate or create additional tasks. Choose your own application workflow from the tools and guidance available in the room.\n\nFinish within 15 minutes. If blocked, state the blocker rather than guessing or claiming completion. ${resultInstruction}`;
}

const FIXED_ATTEMPTS = [
  { attemptId: "attempt01", pairId: "pair-inventory", taskId: "exp0036-existing-inventory", arm: "A0" },
  { attemptId: "attempt02", pairId: "pair-inventory", taskId: "exp0036-existing-inventory", arm: "A1" },
  { attemptId: "attempt03", pairId: "pair-metadata-edit", taskId: "exp0036-existing-metadata-edit", arm: "A1" },
  { attemptId: "attempt04", pairId: "pair-metadata-edit", taskId: "exp0036-existing-metadata-edit", arm: "A0" },
  { attemptId: "attempt05", pairId: "pair-checkout", taskId: "dev-architecture-create-checkout", arm: "A1" },
  { attemptId: "attempt06", pairId: "pair-checkout", taskId: "dev-architecture-create-checkout", arm: "A0" },
  { attemptId: "attempt07", pairId: "pair-portrait", taskId: "dev-drawing-create-layered-portrait", arm: "A0" },
  { attemptId: "attempt08", pairId: "pair-portrait", taskId: "dev-drawing-create-layered-portrait", arm: "A1" },
];

const REVIEW_ASSIGNMENTS = [
  { reviewSlotId: "checkout-review-1", taskId: "dev-architecture-create-checkout", reviewerIndex: 1, left: ["checkout-kestrel", "attempt05"], right: ["checkout-lantern", "attempt06"] },
  { reviewSlotId: "checkout-review-2", taskId: "dev-architecture-create-checkout", reviewerIndex: 2, left: ["checkout-sable", "attempt06"], right: ["checkout-ember", "attempt05"] },
  { reviewSlotId: "portrait-review-1", taskId: "dev-drawing-create-layered-portrait", reviewerIndex: 1, left: ["portrait-orchid", "attempt07"], right: ["portrait-harbor", "attempt08"] },
  { reviewSlotId: "portrait-review-2", taskId: "dev-drawing-create-layered-portrait", reviewerIndex: 2, left: ["portrait-cinder", "attempt08"], right: ["portrait-meadow", "attempt07"] },
];

export function createExp0036ProvisioningFixture(taskId) {
  const family = taskId === "exp0036-existing-inventory" ? "inventory"
    : taskId === "exp0036-existing-metadata-edit" ? "repair" : null;
  if (!family) throw new Error("Unknown EXP0036 context task fixture.");
  const seed = family === "inventory" ? INVENTORY_SEED : REPAIR_SEED;
  const source = createExp0035ContextFixture({ family, seed });
  return {
    ...source,
    schemaVersion: "jazzboard-exp0036-context-fixture/v1",
    protocolId: "EXP-0036",
    taskId,
    derivation: {
      source: "research/scripts/exp0035-context-fixture.mjs",
      sourceSha256: SOURCE_FREEZE.contextFixtureSourceSha256,
      seed,
    },
  };
}

export function createExp0036FrozenPacketBundle() {
  assertSourceDigest("research/benchmarks/development-v2.json", SOURCE_FREEZE.developmentV2Sha256);
  assertSourceDigest("research/benchmarks/development-evaluator-rubrics-v2.json", SOURCE_FREEZE.developmentRubricsV2Sha256);
  assertSourceDigest("research/scripts/exp0035-context-fixture.mjs", SOURCE_FREEZE.contextFixtureSourceSha256);
  assertSourceDigest("research/protocols/exp-0036-frozen-packet-v1.md", SOURCE_FREEZE.packetProtocolSha256);
  const benchmark = loadJson("research/benchmarks/development-v2.json");
  const rubrics = loadJson("research/benchmarks/development-evaluator-rubrics-v2.json");
  const reviewInstructionsPath = "research/protocols/exp-0036-blinded-pair-review-v1.md";
  const reviewInstructions = readFileSync(path.join(REPOSITORY_ROOT, reviewInstructionsPath), "utf8");
  const inventoryFixture = createExp0036ProvisioningFixture("exp0036-existing-inventory");
  const repairFixture = createExp0036ProvisioningFixture("exp0036-existing-metadata-edit");
  const tasks = {
    "exp0036-existing-inventory": contextPublicTask("inventory", inventoryFixture),
    "exp0036-existing-metadata-edit": contextPublicTask("repair", repairFixture),
    "dev-architecture-create-checkout": exactTask(benchmark, "dev-architecture-create-checkout"),
    "dev-drawing-create-layered-portrait": exactTask(benchmark, "dev-drawing-create-layered-portrait"),
  };
  const authorManifest = {
    schemaVersion: EXP0036_PACKET_SCHEMA_VERSION,
    protocolId: "EXP-0036",
    status: "prepared_not_authorized",
    answerPolicy: "public_packets_only_no_controller_answers_or_grader_mappings",
    taskPacketSource: {
      developmentV2Path: "research/benchmarks/development-v2.json",
      developmentV2Sha256: SOURCE_FREEZE.developmentV2Sha256,
      contextFixtureDerivation: "exp0035 deterministic generator with new EXP0036 seeds; public fields only",
    },
    taskPackets: Object.values(tasks),
    attempts: FIXED_ATTEMPTS.map((attempt, ordinal) => {
      const task = tasks[attempt.taskId];
      const contextTask = attempt.taskId.startsWith("exp0036-existing-");
      return {
        ordinal: ordinal + 1,
        attemptId: attempt.attemptId,
        pairId: attempt.pairId,
        taskId: attempt.taskId,
        freshProjectlessTaskRequired: true,
        uniqueLocalhostOriginRequired: true,
        signedGuestSessionRequired: true,
        promptTemplate: promptTemplate(
          task,
          contextTask
            ? "Return only the JSON object requested by the task, without surrounding prose or Markdown fences."
            : "Inspect the final pixels at the exact final revision before finishing. When the artifact is complete, state completion briefly without inventing evaluation results.",
        ),
      };
    }),
  };
  const reviewRubrics = [
    exactRubric(rubrics, "dev-architecture-create-checkout"),
    exactRubric(rubrics, "dev-drawing-create-layered-portrait"),
  ];
  const graderManifest = {
    schemaVersion: EXP0036_GRADER_SCHEMA_VERSION,
    protocolId: "EXP-0036",
    status: "prepared_not_authorized",
    builds: {
      A0: { role: "baseline", commit: BASELINE_COMMIT, archiveSha256: SOURCE_FREEZE.baselineArchiveSha256 },
      A1: { role: "candidate", commit: CANDIDATE_COMMIT, archiveSha256: SOURCE_FREEZE.candidateArchiveSha256 },
      commonPackageLockSha256: SOURCE_FREEZE.packageLockSha256,
      freezeScope: "product_source_archives_only",
      researchHarnessHeadPolicy: "later research-only commits do not change either product arm",
    },
    sourceFreeze: {
      ...SOURCE_FREEZE,
      packetProtocolPath: "research/protocols/exp-0036-frozen-packet-v1.md",
      reviewInstructionsPath,
      reviewInstructionsSha256: sha256(Buffer.from(reviewInstructions, "utf8")),
    },
    deterministicSeeds: { inventory: INVENTORY_SEED, metadataEdit: REPAIR_SEED },
    fixedAttemptOrder: FIXED_ATTEMPTS.map((attempt, ordinal) => ({ ordinal: ordinal + 1, ...attempt })),
    taskDigests: Object.fromEntries(Object.entries(tasks).map(([id, task]) => [id, sha256(Buffer.from(canonical(task), "utf8"))])),
    contextGraders: {
      "exp0036-existing-inventory": {
        family: "inventory",
        fixtureSha256: sha256(Buffer.from(canonical(inventoryFixture), "utf8")),
        provisioningSha256: sha256(Buffer.from(canonical(inventoryFixture.provisioning), "utf8")),
        expectedAnswer: inventoryFixture.controller.expectedAnswer,
        invariants: inventoryFixture.controller.invariants,
        absentKindPolicy: {
          supportedKinds: SUPPORTED_OBJECT_KINDS,
          accepted: "omit_absent_or_include_exact_zero",
          unknownKindsAccepted: false,
          nonzeroAbsentKindsAccepted: false,
        },
      },
      "exp0036-existing-metadata-edit": {
        family: "repair",
        fixtureSha256: sha256(Buffer.from(canonical(repairFixture), "utf8")),
        provisioningSha256: sha256(Buffer.from(canonical(repairFixture.provisioning), "utf8")),
        expectedAnswer: repairFixture.controller.expectedAnswer,
        invariants: repairFixture.controller.invariants,
        protectedStatePolicy: "strict_all_unrelated_objects_diagrams_visual_fields_and_target_non_lifecycle_fields",
      },
    },
    creationGraders: Object.fromEntries(reviewRubrics.map((rubric) => [rubric.taskId, rubric])),
    blindedPairReview: {
      instructionsPath: reviewInstructionsPath,
      instructionsSha256: sha256(Buffer.from(reviewInstructions, "utf8")),
      reviewerModel: "gpt-5.6-sol",
      reasoningEffort: "high",
      independentReviewerCountPerPair: 2,
      assignments: REVIEW_ASSIGNMENTS.map((assignment) => ({
        reviewSlotId: assignment.reviewSlotId,
        taskId: assignment.taskId,
        reviewerIndex: assignment.reviewerIndex,
        display: {
          left: { label: assignment.left[0], attemptId: assignment.left[1] },
          right: { label: assignment.right[0], attemptId: assignment.right[1] },
        },
      })),
      reviewerInputPolicy: {
        include: ["public task packet", "frozen rubric", "sanitized final semantic state", "final pixels", "neutral artifact labels"],
        exclude: ["author transcript", "arm or condition", "timing", "room credential", "peer verdict", "private label mapping"],
      },
      outputSchemaVersion: "jazzboard-exp0036-pair-review-result/v1",
    },
    validity: {
      allEightAttemptsMustBeReported: true,
      authorTaskCreationAuthorized: false,
      productCandidateRemains: CANDIDATE_COMMIT,
      missingOrIncompleteTelemetry: "inconclusive",
      failedArtifactAcceptedCompletionTime: null,
    },
  };
  return { authorManifest, graderManifest };
}

function structuredAnswer(value) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return null; }
}

function gradeCheck(name, passed, detail) {
  return { name, passed, ...(passed ? {} : { detail }) };
}

function select(value, keys) {
  return Object.fromEntries(keys.filter((key) => Object.hasOwn(value, key))
    .map((key) => [key, clone(value[key])]));
}

export function sanitizeExp0036FinalState(room) {
  if (!room || !Number.isSafeInteger(room.roomRevision) || room.roomRevision < 1
      || !room.objects || typeof room.objects !== "object"
      || !room.diagrams || typeof room.diagrams !== "object") {
    throw new Error("EXP0036 final state is incomplete.");
  }
  const commonObjectKeys = [
    "id", "kind", "semanticName", "semanticRole", "x", "y", "width", "height",
    "rotation", "zIndex", "groupId", "diagramIds",
  ];
  const kindKeys = {
    text: ["content", "color", "size", "align"],
    shape: ["shape", "nodeType", "nodeMetadata", "label", "fill", "stroke"],
    connector: ["start", "end", "routing", "direction", "label", "color"],
    image: ["alt", "mimeType", "locked"],
    draw: ["points", "color", "size"],
    path: ["start", "segments", "closed", "fill", "stroke", "strokeWidth", "opacity", "lineCap", "lineJoin", "fillRule"],
  };
  const objects = Object.values(room.objects).sort((left, right) => left.id.localeCompare(right.id))
    .map((object) => {
      if (!SUPPORTED_OBJECT_KINDS.includes(object.kind)) throw new Error("Unknown object kind in final state.");
      return select(object, [...commonObjectKeys, ...kindKeys[object.kind]]);
    });
  const diagramKeys = [
    "id", "title", "description", "diagramType", "category", "tags",
    "memberObjectIds", "connectorIds", "bounds",
  ];
  const diagrams = Object.values(room.diagrams).sort((left, right) => left.id.localeCompare(right.id))
    .map((diagram) => select(diagram, diagramKeys));
  return {
    schemaVersion: "jazzboard-exp0036-sanitized-final-state/v1",
    finalRevision: room.roomRevision,
    objects,
    diagrams,
  };
}

export function createExp0036ArtifactMetadata({ finalRevision, finalState, pixels }) {
  if (!Number.isSafeInteger(finalRevision) || finalRevision < 1
      || finalState?.roomRevision !== finalRevision
      || !pixels || pixels.revision !== finalRevision
      || pixels.mimeType !== "image/png"
      || !/^sha256:[a-f0-9]{64}$/.test(pixels.sha256 ?? "")
      || !Number.isSafeInteger(pixels.width) || pixels.width < 1
      || !Number.isSafeInteger(pixels.height) || pixels.height < 1
      || !/^attachment:[A-Za-z0-9._:-]+$/.test(pixels.attachmentReference ?? "")) {
    throw new Error("EXP0036 artifact pixels or revision provenance is invalid.");
  }
  const content = {
    schemaVersion: "jazzboard-exp0036-artifact-metadata/v1",
    finalRevision,
    sanitizedFinalState: sanitizeExp0036FinalState(finalState),
    pixels: select(pixels, ["revision", "mimeType", "width", "height", "sha256", "attachmentReference"]),
  };
  return {
    ...content,
    controllerPreparedArtifactMetadataSha256: sha256(Buffer.from(canonical(content), "utf8")),
  };
}

export function gradeExp0036ContextFixture({ family, beforeRoom, afterRoom, finalAnswer } = {}) {
  if (family === "repair") {
    const result = gradeExp0035ContextFixture({ family, beforeRoom, afterRoom, finalAnswer });
    return { ...result, schemaVersion: EXP0036_CONTEXT_GRADE_SCHEMA_VERSION, policy: "strict_repair" };
  }
  if (family !== "inventory") throw new Error("EXP0036 context grade family must be inventory or repair.");
  if (!beforeRoom || !afterRoom) throw new Error("EXP0036 context grade requires beforeRoom and afterRoom.");
  const submitted = structuredAnswer(finalAnswer);
  const objects = Object.values(beforeRoom.objects ?? {});
  const counts = Object.fromEntries(SUPPORTED_OBJECT_KINDS.map((kind) => [
    kind, objects.filter((object) => object.kind === kind).length,
  ]));
  const presentKinds = SUPPORTED_OBJECT_KINDS.filter((kind) => counts[kind] > 0);
  const submittedCounts = submitted?.objectCounts;
  const countKeys = submittedCounts && typeof submittedCounts === "object" && !Array.isArray(submittedCounts)
    ? Object.keys(submittedCounts) : [];
  const countsValid = submittedCounts && typeof submittedCounts === "object"
    && presentKinds.every((kind) => submittedCounts[kind] === counts[kind])
    && countKeys.every((kind) => SUPPORTED_OBJECT_KINDS.includes(kind)
      && (counts[kind] > 0 ? submittedCounts[kind] === counts[kind] : submittedCounts[kind] === 0));
  const openQuestionNames = objects.filter((object) => object.kind === "shape"
    && object.nodeType === "open_question"
    && object.nodeMetadata?.kind === "open_question"
    && object.nodeMetadata.status === "open"
    && object.nodeMetadata.owner === "Mira")
    .map((object) => object.semanticName).sort();
  const exactTopLevel = submitted && typeof submitted === "object" && !Array.isArray(submitted)
    && canonical(Object.keys(submitted).sort())
      === canonical(["diagramCount", "objectCounts", "openQuestionNames"]);
  const checks = [
    gradeCheck("inventory fixture cardinality", objects.length === 360
      && counts.shape === 180 && counts.text === 90 && counts.path === 90
      && counts.connector === 0 && counts.image === 0 && counts.draw === 0
      && Object.keys(beforeRoom.diagrams ?? {}).length === 6
      && openQuestionNames.length === 8, "The before state is not the complete frozen inventory fixture."),
    gradeCheck("authoritative document unchanged", canonical({ objects: afterRoom.objects, diagrams: afterRoom.diagrams })
      === canonical({ objects: beforeRoom.objects, diagrams: beforeRoom.diagrams }), "Inventory work mutated authoritative objects or Diagrams."),
    gradeCheck("exact structured answer with explicit absent-kind policy", Boolean(exactTopLevel && countsValid
      && submitted.diagramCount === 6
      && canonical(submitted.openQuestionNames) === canonical(openQuestionNames)), "Present counts, optional zero-valued absent kinds, Diagram count, or sorted target names are not exact."),
  ];
  return {
    schemaVersion: EXP0036_CONTEXT_GRADE_SCHEMA_VERSION,
    family,
    passed: checks.every((item) => item.passed),
    score: checks.every((item) => item.passed) ? 1 : 0,
    policy: "absent_supported_kinds_may_be_omitted_or_zero",
    checks,
    failedCheckCount: checks.filter((item) => !item.passed).length,
  };
}

export function validateExp0036PairReviewResult(result, assignment, rubric) {
  const failures = [];
  const fail = (condition, code) => { if (!condition) failures.push(code); };
  const criteria = Array.isArray(rubric?.criteria) ? rubric.criteria : [];
  const expectedCriteria = criteria.map((item) => item.criterionId);
  const artifacts = Array.isArray(result?.artifacts) ? result.artifacts : [];
  const expectedArtifacts = [
    { label: assignment?.display?.left?.label, displaySide: "left" },
    { label: assignment?.display?.right?.label, displaySide: "right" },
  ];
  fail(result?.schemaVersion === "jazzboard-exp0036-pair-review-result/v1", "SCHEMA_INVALID");
  fail(result?.reviewSlotId === assignment?.reviewSlotId, "REVIEW_SLOT_MISMATCH");
  fail(result?.taskId === assignment?.taskId && result?.taskId === rubric?.taskId, "TASK_MISMATCH");
  fail(artifacts.length === 2, "ARTIFACT_COUNT_INVALID");
  for (let index = 0; index < 2; index += 1) {
    const artifact = artifacts[index];
    const expectedArtifact = expectedArtifacts[index];
    const results = Array.isArray(artifact?.criteria) ? artifact.criteria : [];
    const resultIds = results.map((item) => item?.criterionId);
    const criteriaValid = results.length === expectedCriteria.length
      && canonical(resultIds) === canonical(expectedCriteria)
      && results.every((item) => ["pass", "fail"].includes(item?.result)
        && typeof item?.evidence === "string" && item.evidence.trim().length > 0);
    const expectedHardGate = criteriaValid && results.every((item) => item.result === "pass")
      ? "pass" : "fail";
    fail(artifact?.label === expectedArtifact.label
      && artifact?.displaySide === expectedArtifact.displaySide, `ARTIFACT_${index + 1}_BINDING_INVALID`);
    fail(criteriaValid, `ARTIFACT_${index + 1}_CRITERIA_INVALID`);
    fail(artifact?.hardGate === expectedHardGate, `ARTIFACT_${index + 1}_HARD_GATE_INVALID`);
    fail(Array.isArray(artifact?.blockingDefects)
      && artifact.blockingDefects.every((item) => typeof item === "string" && item.trim().length > 0)
      && (artifact.hardGate !== "pass" || artifact.blockingDefects.length === 0),
    `ARTIFACT_${index + 1}_DEFECTS_INVALID`);
  }
  const labels = expectedArtifacts.map((item) => item.label);
  fail([...labels, "tie"].includes(result?.preference), "PREFERENCE_INVALID");
  fail(typeof result?.preferenceEvidence === "string"
    && result.preferenceEvidence.trim().length > 0, "PREFERENCE_EVIDENCE_MISSING");
  return {
    schemaVersion: "jazzboard-exp0036-pair-review-validation/v1",
    valid: failures.length === 0,
    reasons: failures,
  };
}

export function createExp0036BlindedReviewPacket({ reviewSlotId, artifactMetadataByAttempt }) {
  const { authorManifest, graderManifest } = createExp0036FrozenPacketBundle();
  const assignment = graderManifest.blindedPairReview.assignments
    .find((item) => item.reviewSlotId === reviewSlotId);
  if (!assignment) throw new Error("Unknown EXP0036 review slot.");
  const task = authorManifest.taskPackets.find((item) => item.id === assignment.taskId);
  const rubric = graderManifest.creationGraders[assignment.taskId];
  const instructions = readFileSync(
    path.join(REPOSITORY_ROOT, graderManifest.blindedPairReview.instructionsPath),
    "utf8",
  );
  const artifact = (side) => {
    const mapping = assignment.display[side];
    const metadata = artifactMetadataByAttempt?.[mapping.attemptId];
    if (!metadata || metadata.schemaVersion !== "jazzboard-exp0036-artifact-metadata/v1") {
      throw new Error(`Incomplete sanitized evidence for ${side} artifact.`);
    }
    const content = select(metadata, ["schemaVersion", "finalRevision", "sanitizedFinalState", "pixels"]);
    const expectedMetadataSha256 = sha256(Buffer.from(canonical(content), "utf8"));
    const state = metadata.sanitizedFinalState;
    const pixels = metadata.pixels;
    if (metadata.controllerPreparedArtifactMetadataSha256 !== expectedMetadataSha256
        || state?.schemaVersion !== "jazzboard-exp0036-sanitized-final-state/v1"
        || state?.finalRevision !== metadata.finalRevision
        || pixels?.revision !== metadata.finalRevision
        || pixels?.mimeType !== "image/png"
        || !/^sha256:[a-f0-9]{64}$/.test(pixels?.sha256 ?? "")
        || pixels?.attachmentReference !== `attachment:${reviewSlotId}-${side}`) {
      throw new Error(`Invalid controller-prepared metadata for ${side} artifact.`);
    }
    return {
      label: mapping.label,
      displaySide: side,
      finalRevision: metadata.finalRevision,
      sanitizedFinalState: clone(state),
      finalPixels: {
        attachmentReference: pixels.attachmentReference,
        revision: pixels.revision,
        mimeType: pixels.mimeType,
        width: pixels.width,
        height: pixels.height,
        sha256: pixels.sha256,
      },
      controllerPreparedArtifactMetadataSha256: metadata.controllerPreparedArtifactMetadataSha256,
    };
  };
  return {
    schemaVersion: "jazzboard-exp0036-pair-review-packet/v1",
    reviewSlotId,
    taskId: assignment.taskId,
    instructions,
    publicTask: clone(task),
    rubric: clone(rubric),
    artifacts: [artifact("left"), artifact("right")],
    excludedEvidence: graderManifest.blindedPairReview.reviewerInputPolicy.exclude,
    outputSchemaVersion: graderManifest.blindedPairReview.outputSchemaVersion,
  };
}

export function renderExp0036AuthorPrompt({ attempt, origin, roomCode }) {
  if (!attempt?.promptTemplate || !/^http:\/\/[a-z0-9-]+\.localhost:\d+$/.test(origin ?? "")
      || !/^[A-HJ-NP-Z2-9]{6}$/.test(roomCode ?? "")) {
    throw new Error("EXP0036 author prompt inputs are invalid.");
  }
  return attempt.promptTemplate.replaceAll("{{ORIGIN}}", origin).replaceAll("{{ROOM_CODE}}", roomCode);
}

function writeFrozenFiles() {
  const { authorManifest, graderManifest } = createExp0036FrozenPacketBundle();
  writeFileSync(path.join(REPOSITORY_ROOT, "research/data/exp-0036-author-packets-v1.json"), `${JSON.stringify(authorManifest, null, 2)}\n`);
  writeFileSync(path.join(REPOSITORY_ROOT, "research/data/exp-0036-grader-manifest-v1.json"), `${JSON.stringify(graderManifest, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== "--write") {
    process.stderr.write("Usage: exp0036-frozen-packet.mjs --write\n");
    process.exitCode = 1;
  } else {
    writeFrozenFiles();
  }
}
