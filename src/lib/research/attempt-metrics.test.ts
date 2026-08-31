// @vitest-environment node

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import developmentManifest from "../../../research/benchmarks/development-v1.json";

import {
  computeExp0001aAttemptMetricsSpecDigest,
  computeExp0001aAttemptMetricsTaskDigest,
  createEvaluatorAssessmentEnvelope,
  EXP0001A_ATTEMPT_METRICS_EXTRACTOR_SOURCE_PATH,
  EXP0001A_ATTEMPT_METRICS_EXTRACTOR_VERSION,
  EXP0001A_ATTEMPT_METRICS_SCORER_SOURCE_PATH,
  EXP0001A_ATTEMPT_METRICS_SCORER_VERSION,
  extractExp0001aAttemptMetrics,
  identifyBoundedSampleFirstUsefulRevision,
  verifyExp0001aAttemptMetricsArtifact,
  type AttemptArtifactBytes,
  type AttemptMetricsExtractionInput,
} from "./attempt-metrics";
import { canonicalJson } from "./provenance-crypto";

type JsonRecord = Record<string, unknown>;

const architectureTask = developmentManifest.tasks.find((task) =>
  task.id === "dev-architecture-create-checkout")!;
const intentionalOverlapDrawingTask = developmentManifest.tasks.find((task) =>
  task.id === "dev-drawing-create-layered-portrait")!;

const spec = {
  costRatesUsdPerMillion: {
    uncachedInput: 4,
    cachedInput: 1,
    cacheWriteInput: 2,
    output: 20,
  },
  presentationCriteria: {
    maximumTimeToFirstVisibleObjectMs: 2_000,
    minimumVisibleActivityRatio: 0.5,
    minimumRevealEventCount: 2,
    minimumSemanticRevealOrderRate: 1,
    maximumFlickerCount: 0,
    maximumDuplicatePresentationFrameCount: 0,
    maximumViewportInstabilityCount: 0,
    maximumHandoffGapMs: 1_000,
  },
  efficiencyBudgets: {
    toolCalls: 20,
    roundTrips: 10,
    inputTokens: 10_000,
    outputTokens: 2_000,
    contextBytes: 20_000,
    receiptBytes: 100_000,
    wallTimeMs: 30_000,
    timeToUsefulDraftMs: 10_000,
    costUsd: 1,
  },
  qualityScaleId: "public-criteria-quality-v1",
  possibleIssueOpportunityCount: 20,
};

const PNG_1X1 = Uint8Array.from(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
));

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function jsonl(values: readonly unknown[]): string {
  return values.map((value) => JSON.stringify(value)).join("\n") + (values.length ? "\n" : "");
}

function artifactSet(artifacts: AttemptArtifactBytes) {
  const leaves = Object.entries(artifacts).map(([path, contents]) => {
    const content = typeof contents === "string" ? Buffer.from(contents) : Buffer.from(contents);
    return { path, bytes: content.byteLength, sha256: sha256(content) };
  }).sort((left, right) => left.path.localeCompare(right.path, "en-US"));
  return { algorithm: "sha256", leaves, root: sha256(canonicalJson(leaves)) };
}

function usage() {
  return {
    inputTokens: 100,
    uncachedInputTokens: 40,
    cachedInputTokens: 50,
    cacheWriteInputTokens: 10,
    outputTokens: 20,
    reasoningOutputTokens: 5,
    totalTokens: 120,
  };
}

type FixtureOptions = {
  drawing?: boolean;
  invalidPixels?: boolean;
  missingPixels?: boolean;
  noncompletion?: boolean;
  providerUsage?: ReturnType<typeof usage>;
  mutateEvents?: (events: JsonRecord[]) => void;
};

function makeFixture(options: FixtureOptions = {}) {
  const pixelBytes = options.invalidPixels ? Uint8Array.from([1, 2, 3]) : PNG_1X1;
  const retainedBrief = "Exact isolated author brief.";
  const events: JsonRecord[] = [];
  const providerUsage = options.providerUsage ?? usage();
  const add = (elapsedMs: number, type: string, data: JsonRecord) => {
    events.push({ sequence: events.length, elapsedMs, type, data });
  };
  let authorFinal: JsonRecord;
  if (options.noncompletion) {
    add(0, "brief_delivered", { briefHash: sha256(retainedBrief) });
    add(100, "responses_request_started", { turn: 1, remainingOutputTokens: 2_000 });
    authorFinal = {
      termination: "runner_failed",
      finalText: "",
      toolCalls: 0,
      usage: {
        totals: {
          inputTokens: 0,
          uncachedInputTokens: 0,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
          totalTokens: 0,
        },
        byTurn: [],
        costInputs: {
          uncachedInputTokens: 0,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 0,
        },
      },
    };
  } else {
    add(0, "brief_delivered", { briefHash: sha256(retainedBrief) });
    add(1, "responses_request_started", { turn: 1, remainingOutputTokens: 2_000 });
    add(500, "responses_request_completed", {
      turn: 1,
      requestContextBytes: 1_234,
      usage: providerUsage,
      cumulativeUsage: providerUsage,
      status: "completed",
      provider: { model: "gpt-test", serviceTier: "default" },
    });
    add(1_000, "author_tool_started", { ordinal: 1, name: "apply_canvas_transaction", input: {} });
    add(2_000, "author_tool_completed", {
      ordinal: 1,
      name: "apply_canvas_transaction",
      result: {
        ok: true,
        data: {
          outcome: "drafted",
          draftId: "draft-1",
          draftRevision: 1,
          previewObjects: [{ id: "node-a" }, { id: "node-b" }],
          presentation: {
            state: "complete",
            requestedRevision: 1,
            observedRevision: 1,
            objectCount: 2,
            completedObjectCount: 2,
            complete: true,
          },
        },
      },
    });
    add(2_500, "author_tool_started", { ordinal: 2, name: "finish_canvas_draft", input: {} });
    add(3_000, "author_tool_completed", {
      ordinal: 2,
      name: "finish_canvas_draft",
      result: { ok: true, data: { outcome: "applied", roomRevision: 1, changedObjectIds: ["node-a"] } },
    });
    add(3_500, "author_tool_started", { ordinal: 3, name: "inspect_canvas_scope", input: {} });
    if (!options.missingPixels) {
      add(3_900, "author_pixel_captured", {
        ordinal: 3,
        name: "inspect_canvas_scope",
        roomRevision: 2,
        artifactPath: "author-pixels/call-0003-r2.png",
        sha256: sha256(pixelBytes),
      });
    }
    add(4_000, "author_tool_completed", {
      ordinal: 3,
      name: "inspect_canvas_scope",
      result: {
        ok: true,
        data: {
          sceneContext: {
            revisions: { roomRevision: 2 },
            findingKeys: options.drawing ? ["scope:member_object_overlap:intentional"] : ["issue-a"],
            coverage: { findings: "complete" },
          },
        },
      },
    });
    add(4_500, "author_tool_started", { ordinal: 4, name: "apply_canvas_transaction", input: {} });
    add(5_000, "author_tool_completed", {
      ordinal: 4,
      name: "apply_canvas_transaction",
      result: { ok: true, data: { outcome: "applied", changedObjectIds: ["node-b"], roomRevision: 3 } },
    });
    add(5_500, "author_tool_started", { ordinal: 5, name: "inspect_canvas_scope", input: {} });
    if (!options.missingPixels) {
      add(5_900, "author_pixel_captured", {
        ordinal: 5,
        name: "inspect_canvas_scope",
        roomRevision: 3,
        artifactPath: "author-pixels/call-0005-r3.png",
        sha256: sha256(pixelBytes),
      });
    }
    add(6_000, "author_tool_completed", {
      ordinal: 5,
      name: "inspect_canvas_scope",
      result: {
        ok: true,
        data: {
          sceneContext: {
            revisions: { roomRevision: 3 },
            findingKeys: [],
            coverage: { findings: "complete" },
          },
        },
      },
    });
    authorFinal = {
      termination: "author_completed",
      finalText: "done",
      toolCalls: 5,
      usage: {
        totals: providerUsage,
        byTurn: [{ turn: 1, ...providerUsage }],
        costInputs: {
          uncachedInputTokens: providerUsage.uncachedInputTokens,
          cachedInputTokens: providerUsage.cachedInputTokens,
          cacheWriteInputTokens: providerUsage.cacheWriteInputTokens,
          outputTokens: providerUsage.outputTokens,
        },
      },
    };
  }
  options.mutateEvents?.(events);

  const coordinatorEvents = options.noncompletion ? [] : [{
    sequence: 0,
    elapsedMs: 3_200,
    type: "draft_presentation_measured",
    data: {
      observed: {
        totalDurationMs: 2_000,
        timeToFirstVisibleObjectMs: 500,
        visibleActivityMs: 1_500,
        revealEventCount: 2,
        semanticallyOrderedRevealCount: 2,
        flickerCount: 0,
        duplicatePresentationFrameCount: 0,
        viewportInstabilityCount: 0,
        draftAuthoritativeOverlapFrameCount: 0,
        handoffGapMs: 250,
        artificialAuthorDelayMs: 0,
        activePresentationAcceleratedOrSkipped: false,
      },
      reveals: [
        { objectId: "node-a", revealOrdinal: 1, elapsedMs: 500, semanticallyOrdered: true },
        { objectId: "node-b", revealOrdinal: 2, elapsedMs: 1_000, semanticallyOrdered: true },
      ],
    },
  }];

  const authorArtifacts: Record<string, string | Uint8Array> = {
    "author-brief.json": json({
      taskId: options.drawing ? intentionalOverlapDrawingTask.id : architectureTask.id,
      brief: retainedBrief,
    }),
    "author-events.jsonl": jsonl(events),
    "author-final-state.json": json({ ok: true }),
    "author-final.json": json(authorFinal),
  };
  if (!options.noncompletion && !options.missingPixels) {
    authorArtifacts["author-pixels/call-0003-r2.png"] = pixelBytes;
    authorArtifacts["author-pixels/call-0005-r3.png"] = pixelBytes;
  }
  const authorEvidenceRoot = artifactSet(authorArtifacts);
  const artifacts: Record<string, string | Uint8Array> = {
    ...authorArtifacts,
    "author-evidence-seal.json": json(authorEvidenceRoot),
    "coordinator-events.jsonl": jsonl(coordinatorEvents),
  };
  if (!options.noncompletion) {
    artifacts["spectator-final-state.json"] = json({
      ok: true,
      tool: "read_room_state",
      data: { room: { roomRevision: 4 }, objects: [], diagrams: [] },
    });
    artifacts["spectator-final-r4.png"] = pixelBytes;
  }
  const bundle = {
    schemaVersion: "clean-room-live-attempt/v1",
    attemptId: options.noncompletion ? "attempt-noncompletion" : "attempt-complete-v3",
    mode: "live",
    status: options.noncompletion ? "runner_failed" : "author_completed",
    failure: options.noncompletion ? { message: "interrupted" } : null,
    startedAt: "2026-08-30T00:00:00.000Z",
    elapsedMs: options.noncompletion ? 2_000 : 8_000,
    attemptStartedAt: "2026-08-30T00:00:01.000Z",
    providerIntent: {
      provider: "openai_responses",
      requestedModelIdentifier: "gpt-5.6-sol",
      requestedServiceTier: "default",
      immutableModelSnapshotVerified: false,
    },
    author: authorFinal,
    authorEvidenceRoot,
    artifactIndex: artifactSet(artifacts),
    isolation: {
      authorContextClosedBeforeEvaluation: true,
      evaluatorRole: "spectator",
      apiTransport: "raw_fetch",
    },
  };
  return {
    attemptBundleBytes: json(bundle),
    artifacts,
    task: options.drawing ? intentionalOverlapDrawingTask : architectureTask,
    spec,
  };
}

function assessments() {
  return [
    {
      revisionId: "revision_01",
      roomRevision: 2,
      evidencePaths: ["author-pixels/call-0003-r2.png"],
      satisfiedCriterionRefs: ["criterion_01"],
      issueKeys: ["criterion_failure:criterion_02", "criterion_failure:criterion_03"],
      semanticScore: 1 / 3,
      visualUsabilityScore: 0.5 as const,
      blockingViolationCount: 0,
      qualityValue: 5 / 12,
      usefulDraft: false,
    },
    {
      revisionId: "revision_02",
      roomRevision: 3,
      evidencePaths: ["author-pixels/call-0005-r3.png"],
      satisfiedCriterionRefs: ["criterion_01", "criterion_02"],
      issueKeys: ["criterion_failure:criterion_03"],
      semanticScore: 2 / 3,
      visualUsabilityScore: 0.75 as const,
      blockingViolationCount: 0,
      qualityValue: 17 / 24,
      usefulDraft: true,
    },
    {
      revisionId: "revision_03",
      roomRevision: 4,
      evidencePaths: ["spectator-final-r4.png", "spectator-final-state.json"],
      satisfiedCriterionRefs: ["criterion_01", "criterion_02", "criterion_03"],
      issueKeys: [],
      semanticScore: 1,
      visualUsabilityScore: 1 as const,
      blockingViolationCount: 0,
      qualityValue: 1,
      usefulDraft: true,
    },
  ];
}

function frozenBindings(fixture: ReturnType<typeof makeFixture>) {
  return {
    taskDigest: computeExp0001aAttemptMetricsTaskDigest(fixture.task),
    scoringSpecDigest: computeExp0001aAttemptMetricsSpecDigest(fixture.spec),
    extractor: {
      sourcePath: EXP0001A_ATTEMPT_METRICS_EXTRACTOR_SOURCE_PATH,
      sourceDigest: `sha256:${"1".repeat(64)}`,
      version: EXP0001A_ATTEMPT_METRICS_EXTRACTOR_VERSION,
    },
    scorer: {
      sourcePath: EXP0001A_ATTEMPT_METRICS_SCORER_SOURCE_PATH,
      sourceDigest: `sha256:${"2".repeat(64)}`,
      version: EXP0001A_ATTEMPT_METRICS_SCORER_VERSION,
    },
    evaluatorAuthority: {
      reviewRegistryRoot: `sha256:${"6".repeat(64)}`,
      policyDigest: `sha256:${"4".repeat(64)}`,
      allowedIdentityCommitments: [`sha256:${"3".repeat(64)}`],
    },
  };
}

function extractionInput(fixture: ReturnType<typeof makeFixture>): AttemptMetricsExtractionInput {
  return { ...fixture, frozenBindings: frozenBindings(fixture) };
}

function extractAssessed(
  fixture: ReturnType<typeof makeFixture>,
  revisionAssessments = assessments(),
  finalStateResult: { successfulArtifact: boolean; evidencePaths: string[] } | null = {
    successfulArtifact: true,
    evidencePaths: ["spectator-final-state.json", "spectator-final-r4.png"],
  },
) {
  const input = extractionInput(fixture);
  const unassessed = extractExp0001aAttemptMetrics(input);
  const provenance = unassessed.scoreArtifact.provenance;
  const evaluatorAssessment = createEvaluatorAssessmentEnvelope({
    schemaVersion: "exp-0001a-metrics-evaluator-assessment/v1",
    protocolId: "EXP-0001A",
    evaluator: {
      evaluatorId: "metrics-evaluator-01",
      identityCommitment: `sha256:${"3".repeat(64)}`,
      policyDigest: `sha256:${"4".repeat(64)}`,
      reviewRegistryRoot: `sha256:${"6".repeat(64)}`,
      recordDigest: `sha256:${"5".repeat(64)}`,
    },
    assessedAt: "2026-08-30T00:15:00.000Z",
    binding: {
      attemptId: unassessed.scoreArtifact.attemptId,
      taskId: unassessed.scoreArtifact.taskId,
      taskDigest: provenance.taskDigest,
      scoringSpecDigest: provenance.scoringSpecDigest,
      attemptBundleDigest: provenance.attemptBundleDigest,
      artifactRoot: provenance.artifactRoot,
      authorEvidenceRoot: provenance.authorEvidenceRoot,
      rawEvidenceRoot: provenance.rawEvidence.rawEvidenceRoot,
      evaluatorPacketDigest: unassessed.finalStateEvaluatorPacket.packetDigest,
    },
    revisionAssessments,
    finalStateResult,
  });
  return extractExp0001aAttemptMetrics({ ...input, evaluatorAssessment });
}

describe("EXP-0001A attempt metrics extraction", () => {
  it("identifies first-useful timing only outside the sampler's omitted middle interval", () => {
    expect(identifyBoundedSampleFirstUsefulRevision({
      omittedAuthorRevisionCount: 4,
      selectedRoomRevisions: [1, 2, 3, 8, 9, 10, 11],
      usefulRoomRevisions: [3, 8, 9, 10, 11],
    })).toEqual({ status: "identified", roomRevision: 3 });
    expect(identifyBoundedSampleFirstUsefulRevision({
      omittedAuthorRevisionCount: 4,
      selectedRoomRevisions: [1, 2, 3, 8, 9, 10, 11],
      usefulRoomRevisions: [8, 9, 10, 11],
    })).toMatchObject({ status: "left_censored" });
    expect(identifyBoundedSampleFirstUsefulRevision({
      omittedAuthorRevisionCount: 4,
      selectedRoomRevisions: [1, 2, 3, 8, 9, 10, 11],
      usefulRoomRevisions: [],
    })).toMatchObject({ status: "left_censored" });
    expect(identifyBoundedSampleFirstUsefulRevision({
      omittedAuthorRevisionCount: 0,
      selectedRoomRevisions: [1, 2, 3, 4, 5, 6],
      usefulRoomRevisions: [5, 6],
    })).toEqual({ status: "identified", roomRevision: 5 });
  });

  it("extracts complete v3-shaped correction, progressive-presentation, and efficiency scores", () => {
    const fixture = makeFixture();
    const result = extractAssessed(fixture, assessments(), {
      successfulArtifact: true,
      evidencePaths: ["spectator-final-state.json", "spectator-final-r4.png"],
    });

    expect(result.scoreArtifact.timing).toMatchObject({
      timeToFirstDraftMs: { status: "observed", value: 2_000 },
      timeToFirstMutationMs: { status: "observed", value: 2_000 },
      timeToFirstInspectionMs: { status: "observed", value: 3_900 },
      draftToAuthoritativeHandoffMs: { status: "observed", value: 1_000 },
      finishToAuthoritativeHandoffMs: { status: "observed", value: 500 },
      finishRequestDurationMs: { status: "observed", value: 500 },
      timeToUsefulDraftMs: { status: "observed", value: 5_900 },
    });
    expect(result.scoreArtifact.presentation).toMatchObject({
      revealCount: { status: "observed", value: 2 },
      revealOrder: { status: "observed", value: ["node-a", "node-b"] },
      inspectionAttempts: 2,
      revisionBoundPixelCount: 2,
    });
    expect(result.scoreArtifact.correction.correctionRounds).toMatchObject({ value: 1 });
    expect(result.scoreArtifact.efficiency.costInputs).toMatchObject({
      value: { uncachedInputTokens: 40, cachedInputTokens: 50, cacheWriteInputTokens: 10, outputTokens: 20 },
    });
    expect(result.scoreArtifact.efficiency.costUsd).toMatchObject({ status: "observed", value: 0.00063 });
    expect(result.scoreArtifact.scores.presentation?.status).toBe("pass");
    expect(result.scoreArtifact.scores.efficiency?.status).toBe("pass");
    expect(result.scoreArtifact.scores.correction).toMatchObject({
      status: "scored",
      resolvedIssueKeys: ["criterion_failure:criterion_02", "criterion_failure:criterion_03"],
      bestStateRetained: true,
    });
    expect(result.scoreArtifact.scores.correction?.qualityPointDelta).toBeCloseTo(7 / 12, 12);
    expect(result.scoreArtifact.artifactDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.scoreArtifact.provenance).toMatchObject({
      taskDigest: frozenBindings(fixture).taskDigest,
      scoringSpecDigest: frozenBindings(fixture).scoringSpecDigest,
      rawEvidence: {
        authorEventsDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        coordinatorEventsDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        rawEvidenceRoot: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      },
      evaluatorAssessment: {
        status: "observed",
        envelope: { evaluator: { evaluatorId: "metrics-evaluator-01" } },
      },
    });
    expect(verifyExp0001aAttemptMetricsArtifact(result.scoreArtifact).artifactDigest)
      .toBe(result.scoreArtifact.artifactDigest);
  });

  it("returns a hash-stable artifact and a process-fact-free final-state evaluator packet", () => {
    const fixture = makeFixture();
    const first = extractAssessed(fixture);
    const reversedArtifacts = Object.fromEntries(Object.entries(fixture.artifacts).reverse());
    const second = extractAssessed({ ...fixture, artifacts: reversedArtifacts });
    expect(first.scoreArtifact.artifactDigest).toBe(second.scoreArtifact.artifactDigest);
    expect(first.finalStateEvaluatorPacket.packetDigest).toBe(second.finalStateEvaluatorPacket.packetDigest);
    const evaluatorPacket = JSON.stringify(first.finalStateEvaluatorPacket);
    expect(evaluatorPacket).not.toMatch(/toolCalls|responsesTurns|correctionRounds|author-events|elapsedMs|costUsd/);
    expect(evaluatorPacket).toContain("spectator-final-state.json");
  });

  it("marks noncompletion measurements unobservable instead of inventing zeros", () => {
    const fixture = makeFixture({ noncompletion: true });
    const result = extractExp0001aAttemptMetrics(extractionInput(fixture));
    expect(result.scoreArtifact.completion).toMatchObject({ status: "runner_failed", termination: "runner_failed" });
    expect(result.scoreArtifact.timing.timeToFirstDraftMs.status).toBe("unobservable");
    expect(result.scoreArtifact.timing.timeToFirstInspectionMs.status).toBe("unobservable");
    expect(result.scoreArtifact.efficiency.contextBytes.status).toBe("unobservable");
    expect(result.scoreArtifact.scores).toEqual({ presentation: null, efficiency: null, correction: null });
    expect(result.finalStateEvaluatorPacket).toMatchObject({
      inventory: [],
      finalRevisionRef: null,
      sampler: { selectedAuthorRevisionCount: 0, omittedAuthorRevisionCount: 0 },
    });
  });

  it("makes an absent author wall-time observation unobservable rather than zero", () => {
    const fixture = makeFixture({
      noncompletion: true,
      mutateEvents: (events) => { events.splice(0, events.length); },
    });
    const result = extractExp0001aAttemptMetrics(extractionInput(fixture));
    expect(result.scoreArtifact.timing.authorObservedWallMs).toMatchObject({ status: "unobservable" });
    expect(result.scoreArtifact.efficiency.unobservableFields).toContain("authorObservedWallMs");
    expect(result.scoreArtifact.scorerInputs.efficiency).toBeNull();
    expect(JSON.stringify(result.scoreArtifact.timing.authorObservedWallMs)).not.toContain('"value":0');
  });

  it("counts failed provider round trips and makes incomplete context/provider evidence unobservable", () => {
    const fixture = makeFixture({
      mutateEvents: (events) => {
        events.splice(
          3,
          0,
          { sequence: -1, elapsedMs: 700, type: "responses_request_started", data: { turn: 2 } },
          { sequence: -1, elapsedMs: 800, type: "responses_request_failed", data: { turn: 2, message: "failed" } },
        );
        events.forEach((event, index) => { event.sequence = index; });
      },
    });
    const result = extractExp0001aAttemptMetrics(extractionInput(fixture));
    expect(result.scoreArtifact.efficiency.responsesTurns).toMatchObject({ status: "observed", value: 2 });
    expect(result.scoreArtifact.efficiency.contextBytes.status).toBe("unobservable");
    expect(result.scoreArtifact.efficiency.tokens.status).toBe("unobservable");
    expect(result.scoreArtifact.efficiency.costUsd.status).toBe("unobservable");
    expect(result.scoreArtifact.providerIdentity).toMatchObject({
      attemptedTurns: 2,
      completedTurns: 1,
      status: "unobservable",
    });
    expect(result.scoreArtifact.scorerInputs.efficiency).toBeNull();
  });

  it("rejects a failed response bound to a different turn", () => {
    const fixture = makeFixture({
      mutateEvents: (events) => {
        events.splice(
          3,
          0,
          { sequence: -1, elapsedMs: 700, type: "responses_request_started", data: { turn: 2 } },
          { sequence: -1, elapsedMs: 800, type: "responses_request_failed", data: { turn: 7, message: "failed" } },
        );
        events.forEach((event, index) => { event.sequence = index; });
      },
    });
    expect(() => extractExp0001aAttemptMetrics(extractionInput(fixture)))
      .toThrow(/failure has no matching start/);
  });

  it("rejects retained brief bytes that do not match the delivery event", () => {
    const fixture = makeFixture({
      mutateEvents: (events) => {
        const event = events.find((candidate) => candidate.type === "brief_delivered");
        if (event) event.data = { briefHash: "a".repeat(64) };
      },
    });
    expect(() => extractExp0001aAttemptMetrics(extractionInput(fixture)))
      .toThrow(/exact retained author brief/);
  });

  it("rejects author-log presentation claims instead of treating them as coordinator observations", () => {
    const fixture = makeFixture({
      mutateEvents: (events) => {
        events.push({
          sequence: events.length,
          elapsedMs: 7_000,
          type: "draft_presentation_measured",
          data: { observed: {}, reveals: [] },
        });
      },
    });
    expect(() => extractExp0001aAttemptMetrics(extractionInput(fixture)))
      .toThrow(/must be retained by the independent coordinator/);
  });

  it("rejects caller-selected task/spec drift and legacy unbound assessments", () => {
    const fixture = makeFixture();
    const input = extractionInput(fixture);
    expect(() => extractExp0001aAttemptMetrics({
      ...input,
      task: { ...fixture.task, title: `${fixture.task.title} drifted` },
    })).toThrow(/frozen task digest/);
    expect(() => extractExp0001aAttemptMetrics({
      ...input,
      spec: { ...fixture.spec, qualityScaleId: "attacker-selected-scale" },
    })).toThrow(/frozen scoring-spec digest/);
    expect(() => extractExp0001aAttemptMetrics({
      ...input,
      revisionAssessments: assessments(),
    } as unknown as AttemptMetricsExtractionInput)).toThrow(/Unbound revisionAssessments/);
  });

  it("rejects evaluator self-hash tampering and a freshly hashed envelope bound to other evidence", () => {
    const fixture = makeFixture();
    const input = extractionInput(fixture);
    const base = extractExp0001aAttemptMetrics(input);
    const provenance = base.scoreArtifact.provenance;
    const envelope = createEvaluatorAssessmentEnvelope({
      schemaVersion: "exp-0001a-metrics-evaluator-assessment/v1",
      protocolId: "EXP-0001A",
      evaluator: {
        evaluatorId: "metrics-evaluator-01",
        identityCommitment: `sha256:${"3".repeat(64)}`,
        policyDigest: `sha256:${"4".repeat(64)}`,
        reviewRegistryRoot: `sha256:${"6".repeat(64)}`,
        recordDigest: `sha256:${"5".repeat(64)}`,
      },
      assessedAt: "2026-08-30T00:15:00.000Z",
      binding: {
        attemptId: base.scoreArtifact.attemptId,
        taskId: base.scoreArtifact.taskId,
        taskDigest: provenance.taskDigest,
        scoringSpecDigest: provenance.scoringSpecDigest,
        attemptBundleDigest: provenance.attemptBundleDigest,
        artifactRoot: provenance.artifactRoot,
        authorEvidenceRoot: provenance.authorEvidenceRoot,
        rawEvidenceRoot: provenance.rawEvidence.rawEvidenceRoot,
        evaluatorPacketDigest: base.finalStateEvaluatorPacket.packetDigest,
      },
      revisionAssessments: assessments(),
      finalStateResult: null,
    });
    expect(() => extractExp0001aAttemptMetrics({
      ...input,
      evaluatorAssessment: { ...envelope, assessedAt: "2026-08-30T00:16:00.000Z" },
    })).toThrow(/digest does not verify/);

    const { envelopeDigest: originalDigest, ...envelopeContent } = envelope;
    expect(originalDigest).toMatch(/^sha256:/);
    const rebound = createEvaluatorAssessmentEnvelope({
      ...envelopeContent,
      binding: { ...envelope.binding, rawEvidenceRoot: `sha256:${"a".repeat(64)}` },
    });
    expect(() => extractExp0001aAttemptMetrics({ ...input, evaluatorAssessment: rebound }))
      .toThrow(/not bound to this exact task/);

    const unauthorizedEvaluator = createEvaluatorAssessmentEnvelope({
      ...envelopeContent,
      evaluator: { ...envelope.evaluator, identityCommitment: `sha256:${"b".repeat(64)}` },
    });
    expect(() => extractExp0001aAttemptMetrics({ ...input, evaluatorAssessment: unauthorizedEvaluator }))
      .toThrow(/authorized identity roster/);
  });

  it("rejects artifact tampering and malformed or out-of-order retained events", () => {
    const fixture = makeFixture();
    const tampered = { ...fixture.artifacts, "author-brief.json": `${fixture.artifacts["author-brief.json"]}x` };
    expect(() => extractExp0001aAttemptMetrics({ ...extractionInput(fixture), artifacts: tampered }))
      .toThrow(/hashes or artifact root/);

    const outOfOrder = makeFixture({
      mutateEvents: (events) => { events[1].sequence = 7; },
    });
    expect(() => extractExp0001aAttemptMetrics(extractionInput(outOfOrder))).toThrow(/sequence is not contiguous/);

    const unmatchedTool = makeFixture({
      mutateEvents: (events) => {
        const completion = events.find((event) => event.type === "author_tool_completed");
        if (completion) completion.data = { ...(completion.data as JsonRecord), name: "wrong_tool" };
      },
    });
    expect(() => extractExp0001aAttemptMetrics(extractionInput(unmatchedTool))).toThrow(/completion has no matching start/);
  });

  it("records missing revision pixels and refuses unsupported correction assessments", () => {
    const fixture = makeFixture({ missingPixels: true });
    const result = extractExp0001aAttemptMetrics(extractionInput(fixture));
    expect(result.scoreArtifact.presentation.missingPixelInspectionOrdinals).toEqual([3, 5]);
    expect(result.scoreArtifact.presentation.revisionBoundPixelCount).toBe(0);
    expect(result.scoreArtifact.scores.correction).toBeNull();
    expect(() => extractAssessed(fixture, [assessments()[0]]))
      .toThrow(/cover every bounded revision-packet item|revision identity/);
  });

  it("rejects invalid image bytes presented as revision-bound visual evidence", () => {
    const fixture = makeFixture({ invalidPixels: true });
    expect(() => extractExp0001aAttemptMetrics(extractionInput(fixture))).toThrow(/valid PNG/);
  });

  it("keeps intentional drawing overlap neutral unless an independent assessment identifies damage", () => {
    const fixture = makeFixture({ drawing: true });
    const result = extractAssessed(fixture);
    expect(result.scoreArtifact.correction.inspections[0].findingKeys)
      .toContain("scope:member_object_overlap:intentional");
    expect(result.scoreArtifact.correction.rawInspectionFindingPolicy)
      .toBe("tool_findings_are_not_evaluator_issues_and_intentional_overlap_is_neutral");
    expect(result.scoreArtifact.scores.correction).toMatchObject({
      introducedIssueKeys: [],
    });
    expect(result.scoreArtifact.scores.correction?.resolvedIssueKeys)
      .not.toContain("scope:member_object_overlap:intentional");
  });

  it("does not mutate supplied retained evidence or public task metadata", () => {
    const fixture = makeFixture();
    const beforeArtifactDigests = Object.fromEntries(Object.entries(fixture.artifacts).map(([path, contents]) =>
      [path, sha256(typeof contents === "string" ? contents : contents)]));
    const beforeTask = JSON.stringify(fixture.task);
    extractAssessed(fixture);
    const afterArtifactDigests = Object.fromEntries(Object.entries(fixture.artifacts).map(([path, contents]) =>
      [path, sha256(typeof contents === "string" ? contents : contents)]));
    expect(afterArtifactDigests).toEqual(beforeArtifactDigests);
    expect(JSON.stringify(fixture.task)).toBe(beforeTask);
  });

  it("prices each retained author turn at the exact 272K long-context boundary", () => {
    const turnUsage = (inputTokens: number) => ({
      inputTokens,
      uncachedInputTokens: inputTokens,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 100,
      reasoningOutputTokens: 20,
      totalTokens: inputTokens + 100,
    });
    const atBoundary = extractExp0001aAttemptMetrics(extractionInput(makeFixture({
      providerUsage: turnUsage(272_000),
    })));
    const aboveBoundary = extractExp0001aAttemptMetrics(extractionInput(makeFixture({
      providerUsage: turnUsage(272_001),
    })));
    expect(atBoundary.scoreArtifact.efficiency.costUsd).toMatchObject({
      status: "observed",
      value: (272_000 * 4 + 100 * 20) / 1_000_000,
    });
    expect(aboveBoundary.scoreArtifact.efficiency.costUsd).toMatchObject({
      status: "observed",
      value: (272_001 * 4 * 2 + 100 * 20 * 1.5) / 1_000_000,
    });
    expect(aboveBoundary.scoreArtifact.efficiency.costPolicy).toMatchObject({
      pricingBasis: "per_responses_request",
      longContextInputThresholdTokensExclusive: 272_000,
      reasoningTokensNestedWithinOutputTokens: true,
    });
  });

  it("accepts a matched started-to-failed provider turn while leaving identity, context, and cost unobservable", () => {
    const fixture = makeFixture({
      noncompletion: true,
      mutateEvents: (events) => events.push({
        sequence: events.length,
        elapsedMs: 200,
        type: "responses_request_failed",
        data: {
          turn: 1,
          message: "network failure",
          providerCallMayHaveOccurred: true,
          costObservability: "unobservable",
        },
      }),
    });
    const result = extractExp0001aAttemptMetrics(extractionInput(fixture));
    expect(result.scoreArtifact.providerIdentity).toMatchObject({ status: "unobservable", attemptedTurns: 1 });
    expect(result.scoreArtifact.efficiency.contextBytes).toMatchObject({ status: "unobservable" });
    expect(result.scoreArtifact.efficiency.costUsd).toMatchObject({ status: "unobservable" });
  });
});
