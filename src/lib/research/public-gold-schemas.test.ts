import { describe, expect, it } from "vitest";

import {
  publicGoldInfrastructureManifestV1,
  publicGoldInfrastructurePlanV1,
  publicGoldInfrastructureReviewRecordsV1,
} from "../../../research/fixtures/public-gold-infrastructure-v1.fixture";
import {
  buildBlindedPublicGoldPackets,
  computePublicGoldManifestDigest,
  computePublicGoldPlanDigest,
  computePublicGoldReviewRecordDigest,
  computePublicGoldThresholdsDigest,
  parseBlindedPublicGoldPacket,
  publicGoldCorpusManifestSchema,
  resolvePublicGoldLabel,
  validatePublicGoldPlan,
  validatePublicGoldRecords,
} from "./public-gold-schemas";

function redigestManifest(source: unknown): Record<string, unknown> {
  const manifest = structuredClone(source) as Record<string, unknown>;
  const thresholds = manifest.graduationThresholds as Record<string, unknown>;
  thresholds.thresholdsDigest = computePublicGoldThresholdsDigest(thresholds);
  manifest.manifestDigest = computePublicGoldManifestDigest(manifest);
  return manifest;
}

function redigestPlan(source: unknown): Record<string, unknown> {
  const plan = structuredClone(source) as Record<string, unknown>;
  plan.planDigest = computePublicGoldPlanDigest(plan);
  return plan;
}

function redigestRecord(source: unknown): Record<string, unknown> {
  const record = structuredClone(source) as Record<string, unknown>;
  record.recordDigest = computePublicGoldReviewRecordDigest(record);
  return record;
}

function replacePath(source: unknown, path: readonly (string | number)[], value: unknown): unknown {
  const clone = structuredClone(source);
  let cursor: unknown = clone;
  path.slice(0, -1).forEach((segment) => {
    cursor = Array.isArray(cursor)
      ? cursor[segment as number]
      : (cursor as Record<string, unknown>)[segment as string];
  });
  const final = path[path.length - 1];
  if (Array.isArray(cursor)) cursor[final as number] = value;
  else (cursor as Record<string, unknown>)[final as string] = value;
  return clone;
}

describe("public gold corpus and execution schemas", () => {
  it("validates public synthetic architecture and drawing fixtures while retaining raw gold labels", () => {
    const manifest = publicGoldCorpusManifestSchema.parse(publicGoldInfrastructureManifestV1);
    expect(manifest.corpusKind).toBe("infrastructure_fixture");
    expect(manifest.containsSealedMaterial).toBe(false);
    expect(manifest.artifacts).toHaveLength(4);

    const disagreed = manifest.artifacts.find((artifact) => artifact.artifactId === "artifact-arch-corrupt");
    expect(disagreed?.gold.primaryRatings.map((rating) => rating.accepted)).toEqual([false, true]);
    expect(disagreed?.gold.adjudication?.accepted).toBe(false);
    expect(resolvePublicGoldLabel(disagreed as NonNullable<typeof disagreed>)).toMatchObject({
      accepted: false,
      primaryClass: "FAIL_SEMANTIC",
      resolution: "gold_adjudication",
    });
  });

  it("builds evaluator packets without gold, corruption, parent, cluster, or sibling fields", () => {
    const packets = buildBlindedPublicGoldPackets(publicGoldInfrastructureManifestV1, publicGoldInfrastructurePlanV1);
    expect(packets).toHaveLength(4);
    const serialized = JSON.stringify(packets);
    expect(serialized).not.toMatch(/gold|corruption|parentArtifact|sourceCluster|siblingArtifact|expectedDecision/i);
    expect(() => parseBlindedPublicGoldPacket({ ...packets[0], expectedDecision: "reject" })).toThrow(/forbidden leakage field/);
    expect(() => parseBlindedPublicGoldPacket({ ...packets[0], nested: { goldAccepted: false } })).toThrow(/forbidden leakage field/);
  });

  it("rejects sealed material and post-evaluation gold locks", () => {
    expect(() => publicGoldCorpusManifestSchema.parse(replacePath(
      publicGoldInfrastructureManifestV1,
      ["containsSealedMaterial"],
      true,
    ))).toThrow();
    expect(() => publicGoldCorpusManifestSchema.parse(replacePath(
      publicGoldInfrastructureManifestV1,
      ["artifacts", 0, "gold", "primaryRatings", 0, "lockedAt"],
      "2026-08-05T00:00:00.000Z",
    ))).toThrow(/Gold labels must lock before evaluation opens/);
  });

  it("rejects duplicate identities, orphan artifacts, and rater/evaluator overlap", () => {
    expect(() => publicGoldCorpusManifestSchema.parse(replacePath(
      publicGoldInfrastructureManifestV1,
      ["identities", 5, "identityId"],
      "gold-rater-one",
    ))).toThrow(/globally unique/);
    expect(() => publicGoldCorpusManifestSchema.parse(replacePath(
      publicGoldInfrastructureManifestV1,
      ["artifacts", 1, "corruption", "parentArtifactId"],
      "artifact-orphan",
    ))).toThrow(/existing source exemplar/);
    expect(() => validatePublicGoldPlan(
      publicGoldInfrastructureManifestV1,
      redigestPlan(replacePath(publicGoldInfrastructurePlanV1, ["entries", 0, "primaryReviewerIdentityIds", 0], "gold-rater-one")),
    )).toThrow(/evaluated reviewer/);
  });

  it("requires an ordered distinct primary pair and an independently capable adjudicator", () => {
    const reusedPrimary = replacePath(
      publicGoldInfrastructurePlanV1,
      ["entries", 0, "primaryReviewerIdentityIds", 1],
      "model-primary-measurement",
    );
    expect(() => validatePublicGoldPlan(
      publicGoldInfrastructureManifestV1,
      redigestPlan(reusedPrimary),
    )).toThrow(/two distinct primaries and an independent adjudicator assignment/);

    const manifest = redigestManifest(replacePath(
      publicGoldInfrastructureManifestV1,
      ["identities", 5, "reviewerCapabilities"],
      ["primary_standard"],
    ));
    const plan = structuredClone(publicGoldInfrastructurePlanV1) as unknown as Record<string, unknown>;
    plan.corpusManifestDigest = manifest.manifestDigest;
    plan.planDigest = computePublicGoldPlanDigest(plan);
    expect(() => validatePublicGoldPlan(manifest, plan)).toThrow(/without the frozen capability/);
  });

  it("rejects missing or outcome-selective gold adjudication", () => {
    expect(() => publicGoldCorpusManifestSchema.parse(replacePath(
      publicGoldInfrastructureManifestV1,
      ["artifacts", 1, "gold", "adjudication"],
      null,
    ))).toThrow(/requires independent adjudication/);
    const agreedAdjudication = structuredClone(publicGoldInfrastructureManifestV1.artifacts[0].gold.primaryRatings[0]);
    agreedAdjudication.role = "adjudicator";
    agreedAdjudication.raterIdentityId = "gold-adjudicator";
    agreedAdjudication.ratingId = "rating-outcome-selective";
    expect(() => publicGoldCorpusManifestSchema.parse(replacePath(
      publicGoldInfrastructureManifestV1,
      ["artifacts", 0, "gold", "adjudication"],
      agreedAdjudication,
    ))).toThrow(/must not receive outcome-selective adjudication/);
  });

  it("rejects sibling variants placed in one model context", () => {
    const plan = structuredClone(publicGoldInfrastructurePlanV1) as unknown as {
      contexts: Array<{ contextId: string; caseIds: string[] }>;
      entries: Array<{ caseId: string; contextId: string }>;
    };
    plan.contexts[0].caseIds = ["case-001", "case-003"];
    plan.contexts.splice(2, 1);
    const drawingSourceEntry = plan.entries.find((entry) => entry.caseId === "case-003");
    if (drawingSourceEntry) drawingSourceEntry.contextId = "context-001";
    expect(() => validatePublicGoldPlan(publicGoldInfrastructureManifestV1, redigestPlan(plan))).toThrow(/sibling variants/);
  });

  it("rejects incomplete denominators and duplicate terminal records", () => {
    expect(() => validatePublicGoldRecords(
      publicGoldInfrastructureManifestV1,
      publicGoldInfrastructurePlanV1,
      publicGoldInfrastructureReviewRecordsV1.slice(1),
    )).toThrow(/exactly two ordered retained primary projections/);
    expect(() => validatePublicGoldRecords(
      publicGoldInfrastructureManifestV1,
      publicGoldInfrastructurePlanV1,
      [...publicGoldInfrastructureReviewRecordsV1, publicGoldInfrastructureReviewRecordsV1[0]],
    )).toThrow(/exactly one retained terminal record/);
  });

  it("requires binary-only adjudication and forbids adjudication for class-only disagreement", () => {
    expect(() => validatePublicGoldRecords(
      publicGoldInfrastructureManifestV1,
      publicGoldInfrastructurePlanV1,
      publicGoldInfrastructureReviewRecordsV1.filter((record) => record.reviewerRole !== "adjudicator"),
    )).toThrow(/binary primary disagreement and requires exactly one retained adjudication/);

    const caseThreePrimaries = publicGoldInfrastructureReviewRecordsV1
      .filter((record) => record.evaluationId === "evaluation-003");
    const caseThreeEvidence = caseThreePrimaries[0];
    const illegalAdjudication = structuredClone(publicGoldInfrastructureReviewRecordsV1.at(-1)) as unknown as Record<string, unknown>;
    illegalAdjudication.callId = "call-003-illegal-adjudication";
    illegalAdjudication.evaluationId = "evaluation-003";
    illegalAdjudication.caseId = "case-003";
    illegalAdjudication.artifactDigest = caseThreeEvidence.artifactDigest;
    illegalAdjudication.renderDigest = caseThreeEvidence.renderDigest;
    illegalAdjudication.semanticStateDigest = caseThreeEvidence.semanticStateDigest;
    illegalAdjudication.lockedEvaluatorRecordDigest = `sha256:${"b".repeat(64)}`;
    illegalAdjudication.primaryLockedEvaluatorRecordDigests = caseThreePrimaries
      .map((record) => record.lockedEvaluatorRecordDigest);
    illegalAdjudication.result = {
      resultKind: "adjudication",
      accepted: false,
      primaryClass: "FAIL_SEMANTIC",
      mechanismTags: ["SEM_RELATIONSHIP_MISSING"],
      criticalIntegrityIncident: false,
      evidenceCoverageComplete: true,
    };
    expect(() => validatePublicGoldRecords(
      publicGoldInfrastructureManifestV1,
      publicGoldInfrastructurePlanV1,
      [...publicGoldInfrastructureReviewRecordsV1, redigestRecord(illegalAdjudication)],
    )).toThrow(/illegal adjudication without a binary primary disagreement/);
  });

  it("binds adjudication to the ordered pair of primary record commitments", () => {
    const records = structuredClone(publicGoldInfrastructureReviewRecordsV1) as unknown as Array<Record<string, unknown>>;
    const adjudication = records.at(-1) as Record<string, unknown>;
    adjudication.primaryLockedEvaluatorRecordDigests = structuredClone(
      adjudication.primaryLockedEvaluatorRecordDigests as unknown[],
    ).reverse();
    records[records.length - 1] = redigestRecord(adjudication);
    expect(() => validatePublicGoldRecords(
      publicGoldInfrastructureManifestV1,
      publicGoldInfrastructurePlanV1,
      records,
    )).toThrow(/ordered locked primary record commitments/);
  });

  it("rejects duplicate and incomplete criterion labels", () => {
    const duplicateCriterion = replacePath(
      publicGoldInfrastructureManifestV1,
      ["artifacts", 0, "gold", "primaryRatings", 0, "criteria", 1, "criterionId"],
      "criterion-semantic",
    );
    expect(() => publicGoldCorpusManifestSchema.parse(duplicateCriterion)).toThrow(/decide every rubric criterion exactly once/);
  });

  it("verifies canonical manifest, threshold, and plan self-digests", () => {
    expect(() => publicGoldCorpusManifestSchema.parse(replacePath(
      publicGoldInfrastructureManifestV1,
      ["manifestDigest"],
      `sha256:${"7".repeat(64)}`,
    ))).toThrow(/manifest digest does not match/);
    expect(() => publicGoldCorpusManifestSchema.parse(replacePath(
      publicGoldInfrastructureManifestV1,
      ["graduationThresholds", "maximumNonEvaluableRate"],
      0.25,
    ))).toThrow(/threshold digest does not match/);

    const reorderedManifest = structuredClone(publicGoldInfrastructureManifestV1) as unknown as { artifacts: unknown[] };
    reorderedManifest.artifacts.reverse();
    expect(() => publicGoldCorpusManifestSchema.parse(reorderedManifest)).toThrow(/manifest digest does not match/);

    const reorderedPlan = structuredClone(publicGoldInfrastructurePlanV1) as unknown as { entries: unknown[] };
    reorderedPlan.entries.reverse();
    expect(() => validatePublicGoldPlan(publicGoldInfrastructureManifestV1, reorderedPlan)).toThrow(/plan digest does not match/);
  });

  it("rejects terminal records replayed under another canonically committed plan", () => {
    const alternatePlan = structuredClone(publicGoldInfrastructurePlanV1) as unknown as Record<string, unknown>;
    alternatePlan.planId = "public-gold-alternate-plan-v1";
    alternatePlan.planDigest = computePublicGoldPlanDigest(alternatePlan);
    expect(() => validatePublicGoldRecords(
      publicGoldInfrastructureManifestV1,
      alternatePlan,
      publicGoldInfrastructureReviewRecordsV1,
    )).toThrow(/replayed under a different corpus or evaluation plan/);
  });

  it("requires evidence commitments instead of caller-asserted verification booleans", () => {
    expect(() => validatePublicGoldRecords(
      publicGoldInfrastructureManifestV1,
      publicGoldInfrastructurePlanV1,
      replacePath(publicGoldInfrastructureReviewRecordsV1, [1, "providerIdentityVerification"], {
        status: "verified",
        evidenceDigest: null,
      }),
    )).toThrow();
    expect(() => validatePublicGoldRecords(
      publicGoldInfrastructureManifestV1,
      publicGoldInfrastructurePlanV1,
      replacePath(publicGoldInfrastructureReviewRecordsV1, [1, "providerIdentityVerified"], true),
    )).toThrow();
  });

  it("allows canonical object-key reordering but not semantic array reordering", () => {
    const reversedKeys = Object.fromEntries(Object.entries(publicGoldInfrastructureManifestV1).reverse());
    expect(publicGoldCorpusManifestSchema.parse(reversedKeys).manifestDigest).toBe(publicGoldInfrastructureManifestV1.manifestDigest);
    expect(redigestManifest(reversedKeys).manifestDigest).toBe(publicGoldInfrastructureManifestV1.manifestDigest);
  });
});
