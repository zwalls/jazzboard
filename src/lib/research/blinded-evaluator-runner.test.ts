import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

const runnerModulePath: string = "../../../research/scripts/blinded-evaluator-runner.mjs";
const {
  artifactRoot,
  buildReviewerOutputJsonSchema,
  buildReviewerRequest,
  buildInputTokenCountRequest,
  canonicalJson,
  evaluationOutputPath,
  loadExactRubric,
  parseFrozenTaxonomy,
  projectSanitizedSpectatorState,
  publicAuthorPacket,
  renderPublicAuthorBrief,
  runBlindedEvaluation,
  sha256,
  validateEvaluatorConfig,
  validateStructuredReviewerOutput,
  verifySealedAttemptDirectory,
} = await import(runnerModulePath);

const repoRoot = path.resolve(process.cwd());
const rubricManifest = JSON.parse(await readFile(path.join(repoRoot, "research/benchmarks/development-evaluator-rubrics-v1.json"), "utf8"));
const benchmarkManifest = JSON.parse(await readFile(path.join(repoRoot, "research/benchmarks/development-v1.json"), "utf8"));
const taxonomy = parseFrozenTaxonomy(await readFile(path.join(repoRoot, "research/protocols/failure-taxonomy-v1.md"), "utf8"));
const taskRubric = rubricManifest.rubrics[0];
const benchmarkTask = benchmarkManifest.tasks.find((task: { id: string }) => task.id === taskRubric.taskId);
const criterionIds = taskRubric.criteria.map((criterion: { criterionId: string }) => criterion.criterionId);

function bytes(value: unknown): Buffer {
  return Buffer.from(`${canonicalJson(value)}\n`);
}

async function sealedFixture(options: { inspectionRevision?: number } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "blinded-eval-"));
  const attemptDirectory = path.join(root, "attempt");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(attemptDirectory));
  const png = await sharp({
    create: { width: 4, height: 3, channels: 4, background: { r: 20, g: 40, b: 80, alpha: 1 } },
  }).png().toBuffer();
  const authorFiles = new Map<string, Buffer>([
    ["author-brief.json", bytes(renderPublicAuthorBrief(publicAuthorPacket(benchmarkTask)))],
    ["author-events.jsonl", Buffer.from('{"type":"author_finished"}\n')],
    ["author-final.json", bytes({ termination: "completed", finalText: "done" })],
  ]);
  const authorLeaves = [...authorFiles].map(([artifactPath, contents]) => ({
    path: artifactPath,
    bytes: contents.byteLength,
    sha256: sha256(contents),
  })).sort((left, right) => left.path.localeCompare(right.path));
  const authorSeal = { algorithm: "sha256", leaves: authorLeaves, root: artifactRoot(authorLeaves) };
  const state = {
    ok: true,
    tool: "read_room_state",
    data: {
      room: { id: "[REDACTED]", code: "[REDACTED]", title: "private title", roomRevision: 7 },
      participants: [{ participantId: "[REDACTED]", displayName: "Research Author" }],
      objects: [{ id: "object-1", type: "text", text: "Public result", createdBy: { participantId: "[REDACTED]", displayName: "Research Author" } }],
      diagrams: [],
    },
  };
  const files = new Map<string, Buffer>([
    ...authorFiles,
    ["author-evidence-seal.json", bytes(authorSeal)],
    ["spectator-final-state.json", bytes(state)],
    ["spectator-final-r7.png", png],
    ["spectator-inspection.json", bytes({ result: { ok: true }, pixel: { roomRevision: options.inspectionRevision ?? 7, sha256: sha256(png) } })],
    ["spectator-tool-contract.json", bytes({ hash: "a".repeat(64), tools: [] })],
    ["coordinator-events.jsonl", Buffer.from('{"type":"spectator_captured"}\n')],
  ]);
  for (const [artifactPath, contents] of files) await writeFile(path.join(attemptDirectory, artifactPath), contents);
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
    taskId: taskRubric.taskId,
    expectedRubricSha256: `sha256:${sha256(canonicalJson(taskRubric))}`,
    reviewerId: "reviewer-opaque-01",
    reviewerRole: "primary" as const,
    model: "gpt-test-snapshot",
    reasoningEffort: "low" as const,
    inputTokenBudget: 10_000,
    outputTokenBudget: 2_000,
    pricing: {
      currency: "USD" as const,
      inputUsdPerMillionTokens: 1,
      cachedInputUsdPerMillionTokens: 0.1,
      outputUsdPerMillionTokens: 5,
      source: "frozen-test-price",
    },
    outputDirectory,
  };
  return { root, attemptDirectory, config, files, bundle, png };
}

function acceptedResult() {
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
    accepted: true,
    rationale: "All mandatory public criteria pass with complete state and pixel evidence.",
  };
}

function fakeResponses(result = acceptedResult()) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetch = vi.fn(async (url: string, init: { body: string }) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (url.endsWith("/input_tokens")) {
      return { ok: true, status: 200, json: async () => ({ input_tokens: 800 }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        id: "resp-secret-provider-id",
        status: "completed",
        output_text: JSON.stringify(result),
        usage: {
          input_tokens: 800,
          input_tokens_details: { cached_tokens: 100 },
          output_tokens: 500,
          output_tokens_details: { reasoning_tokens: 100 },
          total_tokens: 1_300,
        },
      }),
    };
  });
  return { fetch, calls };
}

describe("blinded evaluator sealed evidence", () => {
  it("verifies all artifact bytes, the index root, the author seal, and deterministic evidence hashes", async () => {
    const fixture = await sealedFixture();
    const first = await verifySealedAttemptDirectory(fixture.config);
    const second = await verifySealedAttemptDirectory(fixture.config);
    expect(first.artifactRoot).toBe(fixture.config.expectedArtifactRoot);
    expect(first.authorEvidenceRoot).toBe(fixture.config.expectedAuthorEvidenceRoot);
    expect(first.finalStateSha256).toBe(second.finalStateSha256);
    expect(first.pixelSha256).toBe(second.pixelSha256);
    expect(first.finalState.data.room).not.toHaveProperty("id");
    expect(JSON.stringify(first.finalState)).not.toContain("Research Author");
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
});

describe("blinded evaluator request and output contract", () => {
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
    expect(inputText).not.toContain("baseline");
    expect(request.input[0].content[1].image_url).toMatch(/^data:image\/png;base64,/);
    expect(buildInputTokenCountRequest(request)).not.toHaveProperty("store");
    expect(buildInputTokenCountRequest(request)).not.toHaveProperty("max_output_tokens");
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

  it("locks exactly one opaque reviewer identity and records budgets, usage, cost inputs, hashes, and blinding flags", async () => {
    const fixture = await sealedFixture();
    const fake = fakeResponses();
    const result = await runBlindedEvaluation(fixture.config, {
      fetch: fake.fetch,
      apiKey: "test-only-key-not-retained",
      now: () => new Date("2026-08-30T12:00:00.000Z"),
    });
    expect(result.record).toMatchObject({
      status: "scored",
      reviewer: { id: fixture.config.reviewerId, role: "primary", invocationCount: 1 },
      lockedAt: "2026-08-30T12:00:00.000Z",
      treatmentLabelKnownAtLock: false,
      pairedArtifactSeenBeforeLock: false,
      accepted: true,
      primaryFailureClass: "SUCCESS",
      budgets: { inputTokens: 10_000, outputTokens: 2_000 },
      provider: { usage: { inputTokens: 800, outputTokens: 500, reasoningTokens: 100 } },
    });
    expect(result.record.recordSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.record.hashes.promptSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.record.hashes.outputSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result.record)).not.toContain("test-only-key-not-retained");
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1].body).toMatchObject({ store: false, tools: [], max_output_tokens: 2_000 });
    await expect(runBlindedEvaluation(fixture.config, { fetch: fake.fetch, apiKey: "again" })).rejects.toThrow(/already has an immutable record/);
  });

  it("retains a failed non-acceptance record when the scorer API fails", async () => {
    const fixture = await sealedFixture();
    const fetch = vi.fn(async (url: string) => url.endsWith("/input_tokens")
      ? { ok: true, status: 200, json: async () => ({ input_tokens: 800 }) }
      : { ok: false, status: 503, json: async () => ({}) });
    await expect(runBlindedEvaluation(fixture.config, {
      fetch,
      apiKey: "test-key",
      now: () => new Date("2026-08-30T12:30:00.000Z"),
    })).rejects.toMatchObject({ code: "SCORER_API_FAILED" });
    const record = JSON.parse(await readFile(evaluationOutputPath(fixture.config), "utf8"));
    expect(record).toMatchObject({
      status: "failed",
      accepted: false,
      primaryFailureClass: "FAIL_EVALUATOR_SCORER",
      treatmentLabelKnownAtLock: false,
      pairedArtifactSeenBeforeLock: false,
      failure: { code: "SCORER_API_FAILED", stage: "provider_response" },
    });
  });

  it("enforces cumulative input and output budgets fail-closed", async () => {
    const fixture = await sealedFixture();
    const inputFetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ input_tokens: 10_001 }) }));
    await expect(runBlindedEvaluation(fixture.config, { fetch: inputFetch, apiKey: "test-key" })).rejects.toMatchObject({ code: "INPUT_TOKEN_BUDGET_EXHAUSTED" });
    expect(inputFetch).toHaveBeenCalledTimes(1);

    const second = await sealedFixture();
    const outputFetch = vi.fn(async (url: string) => url.endsWith("/input_tokens")
      ? { ok: true, status: 200, json: async () => ({ input_tokens: 800 }) }
      : {
        ok: true,
        status: 200,
        json: async () => ({ status: "completed", output_text: JSON.stringify(acceptedResult()), usage: { input_tokens: 800, output_tokens: 2_001, total_tokens: 2_801 } }),
      });
    await expect(runBlindedEvaluation(second.config, { fetch: outputFetch, apiKey: "test-key" })).rejects.toMatchObject({ code: "TOKEN_BUDGET_EXHAUSTED" });
  });
});
