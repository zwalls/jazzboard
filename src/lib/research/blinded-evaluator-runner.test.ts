import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

import {
  EXP0001A_EVALUATOR_SEMANTIC_ENVELOPE,
  EXP0001A_EVALUATOR_SEMANTIC_ENVELOPE_DIGEST,
  EXP0001A_EVALUATOR_SEMANTIC_ENVELOPE_SOURCE_PATH,
} from "./blinded-review-orchestration";

const runnerModulePath: string = "../../../research/scripts/blinded-evaluator-runner.mjs";
const {
  artifactRoot,
  buildBlindedRevisionAssessmentPacket,
  buildEvaluatorLocalInputPreflight,
  buildFrozenIndividualReviewerInstructions,
  buildReviewerOutputJsonSchema,
  buildReviewerRequest: buildReviewerRequestRaw,
  canonicalJson,
  createExp0001aEvaluatorCommittedSourceSet,
  EVALUATOR_SEMANTIC_ENVELOPE_RECEIPT_RELATIVE_PATH,
  evaluatorSemanticEnvelopeReceipt,
  FROZEN_FAILURE_TAXONOMY_RELATIVE_PATH,
  loadExactRubric: loadExactRubricRaw,
  loadEvaluatorSemanticEnvelopeReceipt: loadEvaluatorSemanticEnvelopeReceiptRaw,
  loadExp0001aEvaluatorCommittedSourcesFromRepositoryForTests,
  parseFrozenTaxonomy,
  projectSanitizedSpectatorState,
  publicAuthorPacket,
  recoverBlindedEvaluation: recoverBlindedEvaluationRaw,
  renderPublicAuthorBrief,
  retainCanonicalJsonExclusive,
  runBlindedEvaluation: runBlindedEvaluationRaw,
  sha256,
  validateEvaluatorConfig,
  validateExp0001aEvaluatorCommittedSourceSet,
  validateEvaluatorSemanticEnvelopeReceipt,
  validateFrozenFailureTaxonomySource,
  validateSealedAuthorVisibleSpec,
  validateStructuredReviewerOutput,
  verifySealedAttemptDirectory: verifySealedAttemptDirectoryRaw,
} = await import(runnerModulePath);

const repoRoot = path.resolve(process.cwd());
const canonicalTmpRoot = await realpath(tmpdir());
const rubricManifestSource = await readFile(path.join(repoRoot, "research/benchmarks/development-evaluator-rubrics-v1.json"), "utf8");
const benchmarkManifestSource = await readFile(path.join(repoRoot, "research/benchmarks/development-v1.json"), "utf8");
const rubricManifest = JSON.parse(rubricManifestSource);
const benchmarkManifest = JSON.parse(benchmarkManifestSource);
const taxonomySource = await readFile(path.join(repoRoot, "research/protocols/failure-taxonomy-v2.md"), "utf8");
const taxonomyV1Source = await readFile(path.join(repoRoot, "research/protocols/failure-taxonomy-v1.md"), "utf8");
const testCommittedSources = await loadExp0001aEvaluatorCommittedSourcesFromRepositoryForTests(repoRoot);
const testCommittedSourceSetRoot = testCommittedSources.sourceSetRoot as string;
const verifySealedAttemptDirectory = (config: unknown) =>
  verifySealedAttemptDirectoryRaw(config, testCommittedSources);
const loadExactRubric = (config: unknown) => loadExactRubricRaw(config, testCommittedSources);
const loadEvaluatorSemanticEnvelopeReceipt = () =>
  loadEvaluatorSemanticEnvelopeReceiptRaw(testCommittedSources);
const buildReviewerRequest = (input: Record<string, unknown>) => buildReviewerRequestRaw({
  ...input,
  committedSourceSetRoot: testCommittedSourceSetRoot,
});
const taxonomy = parseFrozenTaxonomy(taxonomySource);
const taskRubric = rubricManifest.rubrics[0];
const benchmarkTask = benchmarkManifest.tasks.find((task: { id: string }) => task.id === taskRubric.taskId);
const criterionIds = taskRubric.criteria.map((criterion: { criterionId: string }) => criterion.criterionId);
const frozenBrief = renderPublicAuthorBrief(publicAuthorPacket(benchmarkTask));
const AUTHOR_IDENTITY_COMMITMENT = `sha256:${"7".repeat(64)}`;

function liveAuthorVisibleSpec() {
  return {
    attemptId: "opaque-attempt",
    model: "author-model-snapshot",
    brief: frozenBrief,
    allowedToolNames: ["read_room_state", "apply_canvas_transaction", "inspect_canvas_scope"],
    budgets: {
      wallMs: 600_000,
      toolCalls: 80,
      perToolTimeoutMs: 30_000,
      inputTokens: 100_000,
      outputTokens: 20_000,
    },
  };
}

function bytes(value: unknown): Buffer {
  return Buffer.from(`${canonicalJson(value)}\n`);
}

async function sealedFixture(options: {
  inspectionRevision?: number;
  omitPixels?: boolean;
  authorVisibleSpec?: unknown;
  authorInspectionRevisions?: number[];
  pixelDimensions?: { width: number; height: number };
  objectCount?: number;
  objectLabel?: string;
  connectorCount?: number;
  objectKind?: "shape" | "path";
  grouping?: boolean;
  richMetadata?: boolean;
} = {}) {
  const root = await mkdtemp(path.join(canonicalTmpRoot, "blinded-eval-"));
  const attemptDirectory = path.join(root, "attempt");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(attemptDirectory));
  const png = await sharp({
    create: {
      width: options.pixelDimensions?.width ?? 4,
      height: options.pixelDimensions?.height ?? 3,
      channels: 4,
      background: { r: 20, g: 40, b: 80, alpha: 1 },
    },
  }).png().toBuffer();
  const authorIdentityBytes = Buffer.from(canonicalJson({
    attemptId: "opaque-attempt",
    identityCommitment: AUTHOR_IDENTITY_COMMITMENT,
    schemaVersion: "author-identity-commitment/v1",
  }), "utf8");
  const authorIdentityArtifactSha256 = `sha256:${sha256(authorIdentityBytes)}`;
  const authorEvents: Array<{ sequence: number; elapsedMs: number; type: string; data: Record<string, unknown> }> = [];
  const addAuthorEvent = (type: string, data: Record<string, unknown>) => {
    authorEvents.push({ sequence: authorEvents.length, elapsedMs: authorEvents.length * 100, type, data });
  };
  const authorFiles = new Map<string, Buffer>([
    ["author-brief.json", bytes(options.authorVisibleSpec ?? liveAuthorVisibleSpec())],
    ["author-final.json", bytes({ termination: "completed", finalText: "done" })],
    ["author-identity-commitment.json", authorIdentityBytes],
  ]);
  for (const [index, revision] of (options.authorInspectionRevisions ?? []).entries()) {
    const ordinal = index + 1;
    const artifactPath = `author-pixels/call-${String(ordinal).padStart(4, "0")}-r${revision}.png`;
    addAuthorEvent("author_tool_started", { ordinal, name: "inspect_canvas_scope", input: {} });
    addAuthorEvent("author_pixel_captured", {
      ordinal,
      name: "inspect_canvas_scope",
      roomRevision: revision,
      artifactPath,
      sha256: sha256(png),
    });
    addAuthorEvent("author_tool_completed", {
      ordinal,
      name: "inspect_canvas_scope",
      result: { ok: true, data: { sceneContext: { revisions: { roomRevision: revision } } } },
    });
    authorFiles.set(artifactPath, png);
  }
  authorFiles.set("author-events.jsonl", Buffer.from(authorEvents.map((event) => canonicalJson(event)).join("\n")
    + (authorEvents.length ? "\n" : "")));
  const authorLeaves = [...authorFiles].map(([artifactPath, contents]) => ({
    path: artifactPath,
    bytes: contents.byteLength,
    sha256: sha256(contents),
  })).sort((left, right) => left.path.localeCompare(right.path));
  const authorSeal = { algorithm: "sha256", leaves: authorLeaves, root: artifactRoot(authorLeaves) };
  const objectCount = options.objectCount ?? 1;
  const shapeIds = Array.from({ length: objectCount }, (_, index) => `service-${String(index).padStart(4, "0")}`);
  const connectorIds = Array.from({ length: options.connectorCount ?? 0 }, (_, index) => `connector-${String(index).padStart(4, "0")}`);
  const objectIds = [...shapeIds, ...connectorIds];
  const state = {
    ok: true,
    tool: "read_room_state",
    data: {
      room: { id: "[REDACTED]", code: "[REDACTED]", title: "private title", roomRevision: 7 },
      participants: [{ participantId: "[REDACTED]", displayName: "Research Author" }],
      objects: [
        ...shapeIds.map((id, index) => ({
        id,
        kind: options.objectKind ?? "shape",
        revision: 1,
        x: (index % 20) * 180,
        y: Math.floor(index / 20) * 100,
        width: 160,
        height: 72,
        rotation: 0,
        zIndex: index,
        groupId: options.grouping ? `group-${index % 3}` : null,
        diagramIds: ["diagram-main"],
        semanticName: `service-${index}`,
        semanticRole: "architecture-component",
        ...(options.objectKind === "path" ? {
          segments: Array.from({ length: 20 }, (_, segment) => ({ x: segment, y: segment % 3 })),
          closed: index % 2 === 0,
        } : {
          shape: "rectangle",
          nodeType: "service",
          nodeMetadata: options.richMetadata ? {
            status: index % 2 === 0 ? "active" : "degraded",
            owner: `team-${index % 3}`,
            resolution: `classified-resolution-${index % 3}`,
          } : null,
          label: options.objectLabel === undefined ? `Production Service ${index}` : `${options.objectLabel} ${index}`,
        }),
        createdBy: { participantId: "[REDACTED]", displayName: "Research Author" },
      })),
        ...connectorIds.map((id, index) => ({
          id,
          kind: "connector",
          revision: 1,
          x: 0,
          y: 0,
          width: 180,
          height: 0,
          rotation: 0,
          zIndex: objectCount + index,
          groupId: options.grouping ? `group-${index % 3}` : null,
          diagramIds: ["diagram-main"],
          semanticName: `flow-${index}`,
          semanticRole: "architecture-relationship",
          start: { objectId: shapeIds[index % shapeIds.length], normalizedAnchor: { x: 1, y: 0.5 }, isExact: true },
          end: { objectId: shapeIds[(index + 1) % shapeIds.length], normalizedAnchor: { x: 0, y: 0.5 }, isExact: true },
          direction: "forward",
          routing: { mode: "elbow", kind: "orthogonal", labelPosition: 0.5 },
          label: options.objectLabel === undefined ? `request flow ${index}` : `relationship ${options.objectLabel} ${index}`,
          createdBy: { participantId: "[REDACTED]", displayName: "Research Author" },
        })),
      ],
      diagrams: [{
        id: "diagram-main",
        revision: 1,
        title: "Production service architecture",
        description: "A realistic multi-service system topology.",
        diagramType: "architecture",
        category: "system",
        tags: ["architecture", "production"],
        memberObjectIds: objectIds,
        connectorIds,
        bounds: { x: 0, y: 0, width: 3_600, height: Math.ceil(objectCount / 20) * 100 },
      }],
    },
  };
  const files = new Map<string, Buffer>([
    ...authorFiles,
    ["author-evidence-seal.json", bytes(authorSeal)],
    ["spectator-final-state.json", bytes(state)],
    ["spectator-inspection.json", bytes({ result: { ok: true }, pixel: { roomRevision: options.inspectionRevision ?? 7, sha256: sha256(png) } })],
    ["spectator-tool-contract.json", bytes({ hash: "a".repeat(64), tools: [] })],
    ["coordinator-events.jsonl", Buffer.from('{"type":"spectator_captured"}\n')],
  ]);
  if (!options.omitPixels) files.set("spectator-final-r7.png", png);
  for (const [artifactPath, contents] of files) {
    await import("node:fs/promises").then(({ mkdir }) => mkdir(path.dirname(path.join(attemptDirectory, artifactPath)), { recursive: true }));
    await writeFile(path.join(attemptDirectory, artifactPath), contents);
  }
  const leaves = [...files].map(([artifactPath, contents]) => ({
    path: artifactPath,
    bytes: contents.byteLength,
    sha256: sha256(contents),
  })).sort((left, right) => left.path.localeCompare(right.path));
  const index = { algorithm: "sha256", leaves, root: artifactRoot(leaves) };
  const bundle = {
    schemaVersion: "clean-room-live-attempt/v1",
    attemptId: "opaque-attempt",
    mode: "live",
    status: "completed",
    failure: null,
    startedAt: "2026-08-30T00:00:00.000Z",
    attemptStartedAt: "2026-08-30T00:00:01.000Z",
    authorIdentity: {
      identityCommitment: AUTHOR_IDENTITY_COMMITMENT,
      artifactPath: "author-identity-commitment.json",
      artifactSha256: authorIdentityArtifactSha256,
    },
    authorEvidenceRoot: authorSeal,
    artifactIndex: index,
    isolation: { authorContextClosedBeforeEvaluation: true, evaluatorRole: "spectator" },
  };
  const bundleBytes = bytes(bundle);
  await writeFile(path.join(attemptDirectory, "attempt-bundle.json"), bundleBytes);
  const outputDirectory = path.join(root, "reviews");
  const config = {
    attemptDirectory,
    expectedAttemptBundleSha256: sha256(bundleBytes),
    expectedArtifactRoot: index.root,
    expectedAuthorEvidenceRoot: authorSeal.root,
    expectedAuthorIdentityCommitment: AUTHOR_IDENTITY_COMMITMENT,
    expectedAuthorIdentityArtifactSha256: authorIdentityArtifactSha256,
    taskId: taskRubric.taskId,
    expectedRubricSha256: `sha256:${sha256(canonicalJson(taskRubric))}`,
    committedSourceSetRoot: testCommittedSourceSetRoot,
    reviewerId: "reviewer-opaque-01",
    reviewerRole: "primary" as const,
    model: "gpt-test-snapshot",
    serviceTier: "default" as const,
    reasoningEffort: "low" as const,
    inputTokenBudget: 100_000,
    outputTokenBudget: 2_000,
    pricing: {
      currency: "USD" as const,
      inputUsdPerMillionTokens: 1,
      cachedInputUsdPerMillionTokens: 0.1,
      cacheWriteInputUsdPerMillionTokens: 2,
      outputUsdPerMillionTokens: 5,
      source: "frozen-test-price",
    },
    measurement: {
      role: "standard" as const,
      samplerId: "unique-author-revisions-first3-last3-plus-final/v1" as const,
    },
    outputDirectory,
  };
  return { root, attemptDirectory, config, files, bundle, png };
}

function acceptedResult(measurementPacket: null | {
  packetRoot: string;
  finalRevisionRef: string;
  inventory: Array<{ revisionRef: string }>;
  measurementRubric: { criteria: Array<{ criterionRef: string }> };
} = null) {
  return {
    schemaVersion: "blinded-evaluator-result/v1",
    evidenceCoverage: {
      status: "complete",
      semanticState: true,
      spectatorPixels: true,
      criteriaAddressed: criterionIds,
      gaps: [],
    },
    criteria: criterionIds.map((criterionId: string) => ({
      criterionId,
      decision: "pass",
      evidenceRefs: ["semantic_state", "spectator_png", `rubric:${criterionId}`],
      rationale: "The criterion is satisfied in both allowed evidence views.",
    })),
    observations: {
      semantic: { status: "pass", summary: "Semantic state satisfies the rubric.", evidenceRefs: ["semantic_state"] },
      visual: { status: "pass", summary: "Exact pixels satisfy the visual rubric.", evidenceRefs: ["spectator_png"] },
      correction: { status: "not_observable", summary: "Author trace is intentionally unavailable.", evidenceRefs: [] },
      presentation: { status: "not_observable", summary: "Temporal trace is intentionally unavailable.", evidenceRefs: [] },
      efficiency: { status: "not_observable", summary: "Resource trace is intentionally unavailable.", evidenceRefs: [] },
    },
    primaryFailureClass: "SUCCESS",
    mechanismTags: [],
    causalConfidence: "high",
    metricsAssessment: measurementPacket ? {
      packetRoot: measurementPacket.packetRoot,
      revisions: measurementPacket.inventory.map((entry) => ({
        revisionRef: entry.revisionRef,
        satisfiedCriterionRefs: measurementPacket.measurementRubric.criteria.map((criterion) => criterion.criterionRef),
        issueKeys: [],
        semanticScore: 1,
        visualUsabilityScore: 1,
        blockingViolationCount: 0,
        qualityValue: 1,
        usefulDraft: true,
      })),
      finalState: { revisionRef: measurementPacket.finalRevisionRef, successfulArtifact: true },
    } : null,
    accepted: true,
    rationale: "All mandatory public criteria pass with complete state and pixel evidence.",
  };
}


describe("blinded evaluator sealed evidence", () => {
  it("requires the exact fixed committed-source inventory and rejects missing or digest-mismatched bytes", () => {
    const exactEntries = testCommittedSources.entries.map((entry: {
      role: string;
      path: string;
      fileDigest: string;
      bytesBase64: string;
    }) => ({
      role: entry.role,
      path: entry.path,
      fileDigest: entry.fileDigest,
      bytes: Buffer.from(entry.bytesBase64, "base64"),
    }));
    expect(createExp0001aEvaluatorCommittedSourceSet(exactEntries).sourceSetRoot)
      .toBe(testCommittedSourceSetRoot);
    expect(() => createExp0001aEvaluatorCommittedSourceSet(exactEntries.slice(1)))
      .toThrow(/exact authenticated committed-source set/);
    expect(() => createExp0001aEvaluatorCommittedSourceSet(exactEntries.map((
      entry: (typeof exactEntries)[number],
      index: number,
    ) => index === 0
      ? { ...entry, fileDigest: `sha256:${"0".repeat(64)}` }
      : entry))).toThrow(/digest does not match its bytes/);
    const mutated = structuredClone(testCommittedSources);
    mutated.entries[0].bytesBase64 = Buffer.from("{}", "utf8").toString("base64");
    expect(() => validateExp0001aEvaluatorCommittedSourceSet(mutated))
      .toThrow(/bytes do not match their authenticated digest/);
  });

  it("verifies all artifact bytes, the index root, the author seal, and deterministic evidence hashes", async () => {
    const fixture = await sealedFixture();
    const first = await verifySealedAttemptDirectory(fixture.config);
    const second = await verifySealedAttemptDirectory(fixture.config);
    expect(first.artifactRoot).toBe(fixture.config.expectedArtifactRoot);
    expect(first.authorEvidenceRoot).toBe(fixture.config.expectedAuthorEvidenceRoot);
    expect(first.authorIdentityCommitment).toBe(fixture.config.expectedAuthorIdentityCommitment);
    expect(first.authorIdentityArtifactSha256).toBe(fixture.config.expectedAuthorIdentityArtifactSha256);
    expect(first.finalStateSha256).toBe(second.finalStateSha256);
    expect(first.pixelSha256).toBe(second.pixelSha256);
    expect(first.authorVisibleSpecVersion).toBe("clean-room-author-visible-spec/v1");
    expect(first.authorVisibleSpecSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.authorExecutionContractSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.finalState.data.room).not.toHaveProperty("id");
    expect(JSON.stringify(first.finalState)).not.toContain("Research Author");
  });

  it("fits the production-shaped six-revision measurement packet inside the frozen 60K primary budget", async () => {
    const fixture = await sealedFixture({
      authorInspectionRevisions: [1, 2, 3, 4, 5, 6],
      pixelDimensions: { width: 1_280, height: 720 },
    });
    const config = {
      ...fixture.config,
      inputTokenBudget: 60_000,
      measurement: { ...fixture.config.measurement, role: "measurement" as const },
    };
    const evidence = await verifySealedAttemptDirectory(config);
    const rubric = await loadExactRubric(config);
    const request = buildReviewerRequest({
      model: config.model,
      serviceTier: config.serviceTier,
      reasoningEffort: config.reasoningEffort,
      outputTokenBudget: config.outputTokenBudget,
      instructions: "Frozen evaluator instructions.",
      rubric: rubric.rubric,
      finalState: evidence.finalState,
      pixelBytes: evidence.pixelBytes,
      measurementPacket: evidence.measurement.packet,
      measurementPixelBytes: evidence.measurement.pixelBytes,
      outputSchema: buildReviewerOutputJsonSchema(rubric.criterionIds, taxonomy, evidence.measurement.packet),
    });
    const preflight = buildEvaluatorLocalInputPreflight(request, evidence.measurement.pixelBytes, 60_000);
    expect(preflight.images).toHaveLength(7);
    expect(preflight.images.slice(0, 6).every((image: { detail: string }) => image.detail === "low")).toBe(true);
    expect(preflight.images[6].detail).toBe("high");
    expect(preflight).toMatchObject({ withinImageLimits: true, withinInputTokenBudget: true, eligibleForRelease: true });
    expect(preflight.conservativeInputTokenUpperBound).toBe(30_236);
  });

  it.each([10, 20, 50, 75, 300])(
    "keeps a production-shaped %i-object measurement review inside the frozen 60K primary budget",
    async (objectCount) => {
      const fixture = await sealedFixture({
        authorInspectionRevisions: [1, 2, 3, 4, 5, 6],
        pixelDimensions: { width: 1_280, height: 720 },
        objectCount,
        objectLabel: "svc",
      });
      const config = {
        ...fixture.config,
        inputTokenBudget: 60_000,
        measurement: { ...fixture.config.measurement, role: "measurement" as const },
      };
      const evidence = await verifySealedAttemptDirectory(config);
      const rubric = await loadExactRubric(config);
      const request = buildReviewerRequest({
        model: config.model,
        serviceTier: config.serviceTier,
        reasoningEffort: config.reasoningEffort,
        outputTokenBudget: config.outputTokenBudget,
        instructions: buildFrozenIndividualReviewerInstructions(taxonomySource),
        rubric: rubric.rubric,
        finalState: evidence.finalState,
        pixelBytes: evidence.pixelBytes,
        measurementPacket: evidence.measurement.packet,
        measurementPixelBytes: evidence.measurement.pixelBytes,
        outputSchema: buildReviewerOutputJsonSchema(rubric.criterionIds, taxonomy, evidence.measurement.packet),
      });
      const preflight = buildEvaluatorLocalInputPreflight(request, evidence.measurement.pixelBytes, 60_000);
      expect(evidence.finalState.data.coverage).toMatchObject({ status: "complete", objectCount });
      expect(preflight, `objectCount=${objectCount}; bound=${preflight.conservativeInputTokenUpperBound}`)
        .toMatchObject({ withinImageLimits: true, withinInputTokenBudget: true, eligibleForRelease: true });
      if (objectCount === 300) {
        expect(preflight.conservativeInputTokenUpperBound).toBeLessThanOrEqual(58_000);
      }
    },
    30_000,
  );

  it("roots the pilot architecture envelope in all 12 frozen tasks and evaluates a 9-node/9-connector board", async () => {
    const semanticEnvelope = evaluatorSemanticEnvelopeReceipt();
    expect(semanticEnvelope.pilotTaskBasis).toMatchObject({
      benchmarkSource: { fileDigest: `sha256:${sha256(Buffer.from(benchmarkManifestSource, "utf8"))}` },
      rubricSource: { fileDigest: `sha256:${sha256(Buffer.from(rubricManifestSource, "utf8"))}` },
    });
    expect(benchmarkManifest.tasks).toHaveLength(12);
    const architectureTasks = benchmarkManifest.tasks.filter(
      (task: { publicTaskPacket: { kind: string } }) => task.publicTaskPacket.kind === "architecture",
    );
    expect(Math.max(...architectureTasks.map((task: { publicTaskPacket: { entities: unknown[] } }) => task.publicTaskPacket.entities.length)))
      .toBe(9);
    expect(Math.max(...architectureTasks.map((task: { publicTaskPacket: { relationships: unknown[] } }) => task.publicTaskPacket.relationships.length)))
      .toBe(9);
    expect(new Set(benchmarkManifest.tasks.map((task: { acceptanceCriteria: unknown[] }) => task.acceptanceCriteria.length)))
      .toEqual(new Set([3]));

    const fixture = await sealedFixture({
      authorInspectionRevisions: [1, 2, 3, 4, 5, 6],
      pixelDimensions: { width: 1_280, height: 720 },
      objectCount: 9,
      connectorCount: 9,
      grouping: true,
      richMetadata: true,
      objectLabel: "Production event-processing component with explicit ownership and observable contract".padEnd(120, "x"),
    });
    const config = { ...fixture.config, inputTokenBudget: 60_000, measurement: { ...fixture.config.measurement, role: "measurement" as const } };
    const evidence = await verifySealedAttemptDirectory(config);
    const rubric = await loadExactRubric(config);
    const request = buildReviewerRequest({
      model: config.model,
      serviceTier: config.serviceTier,
      reasoningEffort: config.reasoningEffort,
      outputTokenBudget: config.outputTokenBudget,
      instructions: buildFrozenIndividualReviewerInstructions(taxonomySource),
      rubric: rubric.rubric,
      finalState: evidence.finalState,
      pixelBytes: evidence.pixelBytes,
      measurementPacket: evidence.measurement.packet,
      measurementPixelBytes: evidence.measurement.pixelBytes,
      outputSchema: buildReviewerOutputJsonSchema(rubric.criterionIds, taxonomy, evidence.measurement.packet),
    });
    const preflight = buildEvaluatorLocalInputPreflight(request, evidence.measurement.pixelBytes, 60_000);
    expect(evidence.finalState.data.coverage).toMatchObject({
      status: "complete",
      objectCount: 18,
      topology: "complete",
      visibleTextAggregateLimit: 4_096,
      truncatedTextCount: 0,
    });
    const projection = evidence.finalState.data;
    expect(projection.objects.connector).toHaveLength(9);
    expect(projection.objects.connector.every((row: unknown[]) => Number.isInteger((row[1] as unknown[])[0])
      && Number.isInteger((row[2] as unknown[])[0])
      && (row[4] as unknown[])[0] !== null
      && (row[4] as unknown[])[1] !== null)).toBe(true);
    expect(projection.objects.shape).toHaveLength(9);
    expect(projection.objects.shape.every((row: unknown[]) => row.slice(2, 6).every((value) => value !== null))).toBe(true);
    expect(new Set([
      ...projection.objects.shape.map((row: unknown[]) => row.at(-1)),
      ...projection.objects.connector.map((row: unknown[]) => row.at(-1)),
    ])).toHaveProperty("size", 18);
    expect(projection.objects.revisions).toBeDefined();
    expect(projection.diagrams[0][6]).toHaveLength(18);
    expect(projection.diagrams[0][7]).toHaveLength(9);
    expect(projection.dictionaries.groupStableIdRoot).not.toBe(sha256(canonicalJson([])));
    expect(projection.coverage.sourceVisibleTextBytes).toBeGreaterThan(2_000);
    expect(projection.coverage.semanticEnvelope).toMatchObject({
      envelopeDigest: evaluatorSemanticEnvelopeReceipt().envelopeDigest,
      observed: { semanticObjectCount: 18, connectorCount: 9, diagramCount: 1 },
      withinEnvelope: true,
    });
    expect(preflight).toMatchObject({ eligibleForRelease: true, withinInputTokenBudget: true });
    expect(preflight.conservativeInputTokenUpperBound).toBe(36_035);
  }, 30_000);

  it("keeps a 300-path drawing losslessly coverage-bound without imposing an architecture object cap", async () => {
    const fixture = await sealedFixture({
      authorInspectionRevisions: [1, 2, 3, 4, 5, 6],
      pixelDimensions: { width: 1_280, height: 720 },
      objectCount: 300,
      objectKind: "path",
    });
    const config = { ...fixture.config, inputTokenBudget: 60_000, measurement: { ...fixture.config.measurement, role: "measurement" as const } };
    const evidence = await verifySealedAttemptDirectory(config);
    const rubric = await loadExactRubric(config);
    const request = buildReviewerRequest({
      model: config.model,
      serviceTier: config.serviceTier,
      reasoningEffort: config.reasoningEffort,
      outputTokenBudget: config.outputTokenBudget,
      instructions: buildFrozenIndividualReviewerInstructions(taxonomySource),
      rubric: rubric.rubric,
      finalState: evidence.finalState,
      pixelBytes: evidence.pixelBytes,
      measurementPacket: evidence.measurement.packet,
      measurementPixelBytes: evidence.measurement.pixelBytes,
      outputSchema: buildReviewerOutputJsonSchema(rubric.criterionIds, taxonomy, evidence.measurement.packet),
    });
    const preflight = buildEvaluatorLocalInputPreflight(request, evidence.measurement.pixelBytes, 60_000);
    expect(evidence.finalState.data.coverage).toMatchObject({
      status: "complete",
      objectCount: 300,
      freehandAndPathGeometry: "bounds_counts_pixels",
      truncatedTextCount: 0,
    });
    expect(evidence.finalState.data.objects.path).toHaveLength(300);
    expect(evidence.finalState.data.objects.path.every((row: unknown[]) => row[1] === 20)).toBe(true);
    expect(evidence.finalState.data.objects.geometry).toMatchObject({
      x: expect.anything(),
      y: expect.anything(),
      width: expect.anything(),
      height: expect.anything(),
      rotation: expect.anything(),
    });
    expect(evidence.finalState.data.objects.stableIdRoot).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.finalState.data.coverage.semanticEnvelope).toMatchObject({
      observed: { semanticObjectCount: 0, drawingObjectCount: 300, connectorCount: 0 },
      withinEnvelope: true,
    });
    expect(preflight).toMatchObject({ eligibleForRelease: true, withinInputTokenBudget: true });
    expect(preflight.conservativeInputTokenUpperBound).toBe(44_626);
  }, 30_000);

  it("fails aggregate image and semantic-projection transport ceilings before provider release", () => {
    const request = (finalState: unknown, imageCount: number) => {
      const receipt = evaluatorSemanticEnvelopeReceipt();
      const state = finalState as { ok?: boolean; data?: Record<string, unknown> };
      const coverage = state?.data && typeof state.data === "object"
        ? (state.data.coverage as Record<string, unknown> | undefined)
        : undefined;
      const spectatorFinalState = {
        ...state,
        data: {
          ...(state?.data ?? {}),
          coverage: {
            ...(coverage ?? {}),
            semanticEnvelope: {
              envelopeDigest: receipt.envelopeDigest,
              observed: {
                sourceVisibleTextBytes: 0,
                retainedVisibleTextBytes: 0,
                truncatedTextCount: 0,
                semanticObjectCount: 0,
                drawingObjectCount: 0,
                connectorCount: 0,
                diagramCount: 0,
              },
              limits: receipt.limits,
              withinEnvelope: true,
            },
          },
        },
      };
      return ({
      model: "gpt-5.6-sol",
      service_tier: "default",
      instructions: "frozen",
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: canonicalJson({ spectatorFinalState }) },
          ...Array.from({ length: imageCount }, () => ({ type: "input_image", image_url: "data:image/png;base64,AA==", detail: "low" })),
        ],
      }],
      reasoning: { effort: "high" },
      max_output_tokens: 8_000,
      store: false,
      tools: [],
    });
    };
    const aggregateImages = Array.from({ length: 4 }, () => ({
      bytes: Buffer.alloc(9 * 1024 * 1024),
      width: 10,
      height: 10,
      detail: "low",
    }));
    const aggregate = buildEvaluatorLocalInputPreflight(
      request({ ok: true, data: { room: { roomRevision: 1 } } }, aggregateImages.length),
      aggregateImages,
      60_000,
    );
    expect(aggregate).toMatchObject({
      aggregateRawImageBytes: 36 * 1024 * 1024,
      withinAggregateImageLimits: false,
      eligibleForRelease: false,
    });

    const oversizedProjection = { ok: true, data: { room: { roomRevision: 1 }, payload: "x".repeat(70 * 1024) } };
    const semantic = buildEvaluatorLocalInputPreflight(
      request(oversizedProjection, 1),
      [{ bytes: Buffer.from("png"), width: 10, height: 10, detail: "low" }],
      200_000,
    );
    expect(semantic).toMatchObject({ withinSemanticProjectionLimit: false, eligibleForRelease: false });

    const tooMany = buildEvaluatorLocalInputPreflight(
      request({ ok: true, data: { room: { roomRevision: 1 } } }, 8),
      Array.from({ length: 8 }, () => ({ bytes: Buffer.from("png"), width: 10, height: 10, detail: "low" })),
      60_000,
    );
    expect(tooMany).toMatchObject({ withinAggregateImageLimits: false, eligibleForRelease: false });
  });

  it("rejects orphan pixels and deduplicates repeated same-revision captures by earliest valid chronology", async () => {
    const fixture = await sealedFixture({ authorInspectionRevisions: [2] });
    const extraPath = "author-pixels/call-0002-r4.png";
    const orphanBytes = new Map(fixture.files).set(extraPath, fixture.png);
    const orphanLeaves = [...fixture.bundle.artifactIndex.leaves, {
      path: extraPath,
      bytes: fixture.png.byteLength,
      sha256: sha256(fixture.png),
    }];
    await expect(buildBlindedRevisionAssessmentPacket({
      artifactBytes: orphanBytes,
      leaves: orphanLeaves,
      finalRevision: 7,
      finalPixelPath: "spectator-final-r7.png",
      task: benchmarkTask,
    })).rejects.toThrow(/reconcile exactly/);

    const duplicatePath = "author-pixels/call-0002-r2.png";
    const changedViewportPath = "author-pixels/call-0003-r2.png";
    const changedViewportPng = await sharp({
      create: { width: 4, height: 3, channels: 4, background: { r: 220, g: 10, b: 20, alpha: 1 } },
    }).png().toBuffer();
    const eventsText = fixture.files.get("author-events.jsonl")!.toString("utf8").trim();
    const events = eventsText ? eventsText.split("\n").map((line) => JSON.parse(line)) : [];
    const append = (type: string, data: Record<string, unknown>) => events.push({
      sequence: events.length,
      elapsedMs: events.length * 100,
      type,
      data,
    });
    append("author_tool_started", { ordinal: 2, name: "inspect_canvas_scope", input: {} });
    append("author_pixel_captured", {
      ordinal: 2,
      name: "inspect_canvas_scope",
      roomRevision: 2,
      artifactPath: duplicatePath,
      sha256: sha256(fixture.png),
    });
    append("author_tool_completed", {
      ordinal: 2,
      name: "inspect_canvas_scope",
      result: { ok: true, data: { sceneContext: { revisions: { roomRevision: 2 } } } },
    });
    append("author_tool_started", { ordinal: 3, name: "render_canvas_preview", input: {} });
    append("author_pixel_captured", {
      ordinal: 3,
      name: "render_canvas_preview",
      roomRevision: 2,
      artifactPath: changedViewportPath,
      sha256: sha256(changedViewportPng),
    });
    append("author_tool_completed", {
      ordinal: 3,
      name: "render_canvas_preview",
      result: { ok: true, data: { sceneContext: { revisions: { roomRevision: 2 } } } },
    });
    const duplicateBytes = new Map(fixture.files)
      .set("author-events.jsonl", Buffer.from(`${events.map((event) => canonicalJson(event)).join("\n")}\n`))
      .set(duplicatePath, fixture.png)
      .set(changedViewportPath, changedViewportPng);
    const duplicateLeaves = fixture.bundle.artifactIndex.leaves
      .filter((leaf: { path: string }) => leaf.path !== "author-events.jsonl")
      .concat([
        {
          path: "author-events.jsonl",
          bytes: duplicateBytes.get("author-events.jsonl")!.byteLength,
          sha256: sha256(duplicateBytes.get("author-events.jsonl")!),
        },
        { path: duplicatePath, bytes: fixture.png.byteLength, sha256: sha256(fixture.png) },
        { path: changedViewportPath, bytes: changedViewportPng.byteLength, sha256: sha256(changedViewportPng) },
      ]);
    const deduplicated = await buildBlindedRevisionAssessmentPacket({
      artifactBytes: duplicateBytes,
      leaves: duplicateLeaves,
      finalRevision: 7,
      finalPixelPath: "spectator-final-r7.png",
      task: benchmarkTask,
    });
    expect(deduplicated.packet.sampler).toMatchObject({
      deduplicatedAuthorCaptureCount: 2,
      deduplicatedAuthorCapturesRoot: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    expect(deduplicated.packet.inventory[0].pixel.path).toBe("author-pixels/call-0001-r2.png");
  });

  it("replaces an author capture at the final room revision with the exact spectator state and pixels", async () => {
    const fixture = await sealedFixture({ authorInspectionRevisions: [7] });
    const packet = await buildBlindedRevisionAssessmentPacket({
      artifactBytes: fixture.files,
      leaves: fixture.bundle.artifactIndex.leaves,
      finalRevision: 7,
      finalPixelPath: "spectator-final-r7.png",
      task: benchmarkTask,
    });
    expect(packet.packet.sampler).toMatchObject({
      selectedAuthorRevisionCount: 0,
      finalRevisionDeduplicated: true,
    });
    expect(packet.packet.inventory).toHaveLength(1);
    expect(packet.packet.inventory[0]).toMatchObject({ kind: "final_spectator", roomRevision: 7 });
  });

  it("rejects tampered bytes even when the filename is unchanged", async () => {
    const fixture = await sealedFixture();
    await writeFile(path.join(fixture.attemptDirectory, "spectator-final-state.json"), bytes({ ok: true, data: {} }));
    await expect(verifySealedAttemptDirectory(fixture.config)).rejects.toThrow(/bytes do not match/);
  });

  it("rejects missing pixels, extra artifacts, and mismatched final revisions", async () => {
    const missing = await sealedFixture();
    await import("node:fs/promises").then(({ unlink }) => unlink(path.join(missing.attemptDirectory, "spectator-final-r7.png")));
    await expect(verifySealedAttemptDirectory(missing.config)).rejects.toThrow(/missing or extra/);

    const missingState = await sealedFixture();
    await import("node:fs/promises").then(({ unlink }) => unlink(path.join(missingState.attemptDirectory, "spectator-final-state.json")));
    await expect(verifySealedAttemptDirectory(missingState.config)).rejects.toThrow(/missing or extra/);

    const extra = await sealedFixture();
    await writeFile(path.join(extra.attemptDirectory, "unsealed.txt"), "extra");
    await expect(verifySealedAttemptDirectory(extra.config)).rejects.toThrow(/missing or extra/);

    const mismatched = await sealedFixture({ inspectionRevision: 6 });
    await expect(verifySealedAttemptDirectory(mismatched.config)).rejects.toThrow(/same revision/);
  });

  it("rejects label, pair/order, raw secret, and author-trace leakage", async () => {
    const fixture = await sealedFixture();
    expect(() => validateEvaluatorConfig({ ...fixture.config, condition: "baseline" })).toThrow();
    expect(() => validateEvaluatorConfig({ ...fixture.config, pairOrder: 1 })).toThrow();
    expect(() => validateEvaluatorConfig({ ...fixture.config, reviewerId: "reviewer-baseline-1" })).toThrow(/assignment metadata/);
    expect(() => projectSanitizedSpectatorState({
      ok: true,
      data: { room: { id: "raw-room", code: "ABC123", roomRevision: 1 } },
    })).toThrow(/redacted/);
    expect(() => projectSanitizedSpectatorState({
      ok: true,
      data: { room: { id: "[REDACTED]", code: "[REDACTED]", roomRevision: 1 }, authorTranscript: "hidden" },
    })).toThrow(/trace material/);
  });

  it("accepts only the exact versioned live author-visible spec shape and byte-exact frozen brief", () => {
    const spec = liveAuthorVisibleSpec();
    const validated = validateSealedAuthorVisibleSpec(spec, frozenBrief, "opaque-attempt");
    expect(validated).toMatchObject({ version: "clean-room-author-visible-spec/v1" });
    expect(validated.executionContractSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() => validateSealedAuthorVisibleSpec(frozenBrief, frozenBrief, "opaque-attempt")).toThrow(/exact clean-room-author-visible-spec\/v1 shape/);
    expect(() => validateSealedAuthorVisibleSpec({ ...spec, brief: `${frozenBrief} ` }, frozenBrief, "opaque-attempt"))
      .toThrow(/brief bytes/);
    expect(() => validateSealedAuthorVisibleSpec({ ...spec, model: undefined }, frozenBrief, "opaque-attempt"))
      .toThrow(/exact clean-room-author-visible-spec/);
    for (const forbidden of [
      { condition: "baseline" },
      { pairId: "pair-1" },
      { orderIndex: 0 },
      { roomCode: "ABC234" },
      { sessionToken: "secret" },
      { evaluatorRubric: "hidden" },
    ]) {
      expect(() => validateSealedAuthorVisibleSpec({ ...spec, ...forbidden }, frozenBrief, "opaque-attempt"))
        .toThrow(/without extra, secret, evaluator, or assignment fields/);
    }
  });

  it("binds author model, tool allowlist, and budgets without placing them in reviewer inputs", async () => {
    const spec = liveAuthorVisibleSpec();
    const base = validateSealedAuthorVisibleSpec(spec, frozenBrief, "opaque-attempt");
    const changedModel = validateSealedAuthorVisibleSpec({ ...spec, model: "another-author-model" }, frozenBrief, "opaque-attempt");
    const changedTools = validateSealedAuthorVisibleSpec({ ...spec, allowedToolNames: [...spec.allowedToolNames, "query_objects"] }, frozenBrief, "opaque-attempt");
    const changedBudgets = validateSealedAuthorVisibleSpec({ ...spec, budgets: { ...spec.budgets, toolCalls: 79 } }, frozenBrief, "opaque-attempt");
    expect(new Set([
      base.executionContractSha256,
      changedModel.executionContractSha256,
      changedTools.executionContractSha256,
      changedBudgets.executionContractSha256,
    ]).size).toBe(4);

    const fixture = await sealedFixture();
    const evidence = await verifySealedAttemptDirectory(fixture.config);
    const rubric = await loadExactRubric(fixture.config);
    const request = buildReviewerRequest({
      model: fixture.config.model,
      reasoningEffort: fixture.config.reasoningEffort,
      outputTokenBudget: fixture.config.outputTokenBudget,
      instructions: "Frozen evaluator instructions.",
      rubric: rubric.rubric,
      finalState: evidence.finalState,
      pixelBytes: evidence.pixelBytes,
      outputSchema: buildReviewerOutputJsonSchema(rubric.criterionIds, taxonomy),
    });
    const reviewerInput = JSON.stringify(request.input);
    expect(reviewerInput).not.toContain(spec.model);
    expect(reviewerInput).not.toContain("apply_canvas_transaction");
    expect(reviewerInput).not.toContain(`"toolCalls":${spec.budgets.toolCalls}`);
  });
});

describe("blinded evaluator durable record retention", () => {
  it("keeps a file-synced append-only record after a simulated crash before directory sync", async () => {
    const root = await mkdtemp(path.join(canonicalTmpRoot, "blinded-retain-crash-"));
    const outputPath = path.join(root, "records", "review.json");
    await expect(retainCanonicalJsonExclusive(outputPath, { locked: true }, {
      afterFileSync: () => { throw new Error("simulated crash"); },
    })).rejects.toThrow(/simulated crash/);
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual({ locked: true });
    await expect(retainCanonicalJsonExclusive(outputPath, { locked: false }))
      .rejects.toMatchObject({ code: "REVIEW_ALREADY_LOCKED" });
  });

  it("rejects symlinked output parents before writing", async () => {
    const root = await mkdtemp(path.join(canonicalTmpRoot, "blinded-retain-symlink-"));
    const target = path.join(root, "target");
    const linked = path.join(root, "linked");
    await mkdir(target);
    await symlink(target, linked, "dir");
    await expect(retainCanonicalJsonExclusive(path.join(linked, "review.json"), { locked: true }))
      .rejects.toMatchObject({ code: "OUTPUT_DIRECTORY_UNSAFE" });
    await expect(readFile(path.join(target, "review.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed when exact retained bytes change before readback", async () => {
    const root = await mkdtemp(path.join(canonicalTmpRoot, "blinded-retain-readback-"));
    const outputPath = path.join(root, "review.json");
    await expect(retainCanonicalJsonExclusive(outputPath, { locked: true }, {
      beforeReadback: () => writeFile(outputPath, "{\"tampered\":true}\n"),
    })).rejects.toMatchObject({ code: "REVIEW_READBACK_MISMATCH" });
  });
});

describe("blinded evaluator request and output contract", () => {
  it("hard-blocks removed live scoring and recovery before config parsing or fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      await expect(runBlindedEvaluationRaw({ unexpected: "provider-era-config" }))
        .rejects.toMatchObject({ code: "CODEX_NATIVE_TRANSPORT_REQUIRED", stage: "provider_request" });
      await expect(recoverBlindedEvaluationRaw({ unexpected: "provider-era-config" }))
        .rejects.toMatchObject({ code: "CODEX_NATIVE_TRANSPORT_REQUIRED", stage: "provider_request" });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("keeps the source-bound TS and live-runner semantic-envelope receipts byte-identical", () => {
    const live = evaluatorSemanticEnvelopeReceipt();
    expect(live.envelopeDigest).toBe(EXP0001A_EVALUATOR_SEMANTIC_ENVELOPE_DIGEST);
    expect(Object.fromEntries(Object.entries(live).filter(([key]) => key !== "envelopeDigest")))
      .toEqual(EXP0001A_EVALUATOR_SEMANTIC_ENVELOPE);
  });

  it("loads only the exact source-bound semantic-envelope receipt", async () => {
    const retained = await loadEvaluatorSemanticEnvelopeReceipt();
    expect(EVALUATOR_SEMANTIC_ENVELOPE_RECEIPT_RELATIVE_PATH)
      .toBe(EXP0001A_EVALUATOR_SEMANTIC_ENVELOPE_SOURCE_PATH);
    expect(retained).toEqual(evaluatorSemanticEnvelopeReceipt());
    expect(() => validateEvaluatorSemanticEnvelopeReceipt({
      ...retained,
      envelopeDigest: `sha256:${"0".repeat(64)}`,
    })).toThrow(/source-bound evaluator semantic-envelope receipt/);

    for (const mutate of [
      (candidate: typeof retained) => { candidate.pilotTaskBasis.maximumArchitectureEntities = 10; },
      (candidate: typeof retained) => { candidate.pilotTaskBasis.benchmarkSource.fileDigest = `sha256:${"1".repeat(64)}`; },
    ]) {
      const candidate = structuredClone(retained);
      mutate(candidate);
      const content = Object.fromEntries(Object.entries(candidate).filter(([key]) => key !== "envelopeDigest"));
      candidate.envelopeDigest = `sha256:${sha256(canonicalJson(content))}`;
      expect(() => validateEvaluatorSemanticEnvelopeReceipt(candidate))
        .toThrow(/source-bound evaluator semantic-envelope receipt/);
    }
  });

  it("binds taxonomy v2 while preserving the v1 class and mechanism vocabulary", () => {
    const v2 = validateFrozenFailureTaxonomySource(taxonomySource);
    const v1 = parseFrozenTaxonomy(taxonomyV1Source);
    expect(v2).toMatchObject({
      sourcePath: FROZEN_FAILURE_TAXONOMY_RELATIVE_PATH,
      sourceSha256: `sha256:${sha256(Buffer.from(taxonomySource, "utf8"))}`,
    });
    expect(v2.taxonomy.primaryClasses).toEqual(v1.primaryClasses);
    expect(v2.taxonomy.mechanismTags).toEqual(v1.mechanismTags);
    expect(() => validateFrozenFailureTaxonomySource(taxonomyV1Source))
      .toThrow(/version-2 failure taxonomy/);
  });

  it("sends only rubric, sanitized state, and PNG with store false and no tools", async () => {
    const fixture = await sealedFixture();
    const evidence = await verifySealedAttemptDirectory(fixture.config);
    const rubric = await loadExactRubric(fixture.config);
    const schema = buildReviewerOutputJsonSchema(rubric.criterionIds, taxonomy);
    const request = buildReviewerRequest({
      model: fixture.config.model,
      reasoningEffort: fixture.config.reasoningEffort,
      outputTokenBudget: fixture.config.outputTokenBudget,
      instructions: "Frozen evaluator instructions.",
      rubric: rubric.rubric,
      finalState: evidence.finalState,
      pixelBytes: evidence.pixelBytes,
      outputSchema: schema,
    });
    expect(request).toMatchObject({ store: false, tools: [], tool_choice: "none", parallel_tool_calls: false });
    expect(request.text.format).toMatchObject({ type: "json_schema", strict: true });
    const inputText = request.input[0].content[0].text;
    expect(inputText).toContain(taskRubric.taskId);
    expect(inputText).toContain("spectatorFinalState");
    expect(inputText).not.toContain("author_finished");
    expect(inputText).not.toContain("Research Author");
    expect(inputText).not.toContain("opaque-attempt");
    expect(inputText).not.toContain(AUTHOR_IDENTITY_COMMITMENT);
    expect(inputText).not.toContain("baseline");
    expect(request.input[0].content[1].image_url).toMatch(/^data:image\/png;base64,/);
  });

  it("strictly rejects extra fields, duplicated criteria, and favorable incomplete output", () => {
    expect(validateStructuredReviewerOutput(acceptedResult(), criterionIds, taxonomy).accepted).toBe(true);
    expect(() => validateStructuredReviewerOutput({ ...acceptedResult(), extra: true }, criterionIds, taxonomy)).toThrow();
    const duplicated = acceptedResult();
    duplicated.criteria[1] = duplicated.criteria[0];
    expect(() => validateStructuredReviewerOutput(duplicated, criterionIds, taxonomy)).toThrow(/exactly once/);
    const incomplete = acceptedResult();
    incomplete.evidenceCoverage.status = "incomplete";
    expect(() => validateStructuredReviewerOutput(incomplete, criterionIds, taxonomy)).toThrow(/Acceptance/);
    const traceLeak = acceptedResult();
    traceLeak.criteria[0].evidenceRefs = [`rubric:${criterionIds[0]}`, "author_trace:call-1"];
    expect(() => validateStructuredReviewerOutput(traceLeak, criterionIds, taxonomy)).toThrow();
  });

  it("enforces the frozen measurement scale, issue vocabulary, and derived useful-draft rule", async () => {
    const fixture = await sealedFixture({ authorInspectionRevisions: [2] });
    const config = { ...fixture.config, measurement: { ...fixture.config.measurement, role: "measurement" as const } };
    const packet = (await verifySealedAttemptDirectory(config)).measurement.packet;
    const valid = acceptedResult(packet);
    expect(validateStructuredReviewerOutput(valid, criterionIds, taxonomy, packet).metricsAssessment)
      .toMatchObject({ packetRoot: packet.packetRoot });

    const unknownIssue = structuredClone(valid);
    (unknownIssue.metricsAssessment!.revisions[0] as { issueKeys: string[] }).issueKeys = ["unfrozen:issue"];
    expect(() => validateStructuredReviewerOutput(unknownIssue, criterionIds, taxonomy, packet)).toThrow();

    const semanticDrift = structuredClone(valid);
    semanticDrift.metricsAssessment!.revisions[0].semanticScore = 0.75;
    expect(() => validateStructuredReviewerOutput(semanticDrift, criterionIds, taxonomy, packet))
      .toThrow(/measurement rubric/);

    const qualityDrift = structuredClone(valid);
    qualityDrift.metricsAssessment!.revisions[0].qualityValue = 0.25;
    expect(() => validateStructuredReviewerOutput(qualityDrift, criterionIds, taxonomy, packet))
      .toThrow(/measurement rubric/);

    const usefulDrift = structuredClone(valid);
    usefulDrift.metricsAssessment!.revisions[0].usefulDraft = false;
    expect(() => validateStructuredReviewerOutput(usefulDrift, criterionIds, taxonomy, packet))
      .toThrow(/measurement rubric/);
  });
});

describe("blinded independent adjudication", () => {
  it("requires the explicit versioned adjudication config only for adjudicator invocations", async () => {
    const fixture = await sealedFixture();
    expect(() => validateEvaluatorConfig({ ...fixture.config, reviewerRole: "adjudicator" })).toThrow(/require exactly two committed primary records/);
    expect(() => validateEvaluatorConfig({
      ...fixture.config,
      adjudication: {
        schemaVersion: "blinded-adjudication-input/v1",
        primaryRecords: [{}, {}],
        primaryRecordSha256s: ["a".repeat(64), "b".repeat(64)],
      },
    })).toThrow(/Primary reviewer configs cannot contain adjudication evidence/);
  });
});
