// @vitest-environment node

import { afterEach, describe, expect, it } from "vitest";

import {
  createExp0001aSuccessorAdjudicatorVisibleInputV3,
  createExp0001aSuccessorPairwiseVisibleInputV3,
  createExp0001aSuccessorPrimaryReviewerVisibleInputV3,
  renderExp0001aSuccessorEvaluatorPromptV3,
  validateExp0001aSuccessorEvaluatorResultBindingV3,
  type Exp0001aSuccessorReviewEvidenceV3,
} from "./exp0001a-successor-evaluator-evidence-v3";
import {
  startExp0001aSuccessorEvaluatorSidecarV3,
  type Exp0001aSuccessorEvaluatorSidecarV3,
} from "./exp0001a-successor-evaluator-sidecar-v3";
import { canonicalJson, hashCanonicalJson, sha256Digest } from "./provenance-crypto";

const activeSidecars: Exp0001aSuccessorEvaluatorSidecarV3[] = [];

afterEach(async () => {
  await Promise.all(activeSidecars.splice(0).map((sidecar) => sidecar.abort()));
});

function retainedPng(relativePath: string, content = "same-png-bytes") {
  const bytes = Buffer.from(content, "utf8");
  return {
    relativePath,
    sha256: sha256Digest(bytes),
    bytes: bytes.byteLength,
    mimeType: "image/png" as const,
    contentBase64: bytes.toString("base64"),
  };
}

function evidenceFor(file: ReturnType<typeof retainedPng>): Exp0001aSuccessorReviewEvidenceV3 {
  const rubricContent = { criteria: [{ id: "legibility", requirement: "The result is legible." }] };
  const semanticContent = { objects: [{ id: "node-1", type: "service", label: "Gateway" }] };
  const rubric = {
    rubricId: "rubric-legibility",
    criterionIds: ["legibility"],
    allowedMechanismTags: ["overlap"],
    sha256: hashCanonicalJson(rubricContent),
    content: rubricContent,
  };
  const semanticState = {
    sha256: hashCanonicalJson(semanticContent),
    bytes: Buffer.byteLength(canonicalJson(semanticContent), "utf8"),
    content: semanticContent,
  };
  const images = [{
    slot: "image-01",
    roomRevision: 7,
    final: true,
    sha256: file.sha256,
    bytes: file.bytes,
    width: 1200,
    height: 800,
    mimeType: "image/png" as const,
    relativePath: file.relativePath,
  }];
  const publicRequirement = "Create a legible service diagram with an explicitly labeled gateway.";
  return {
    publicRequirement,
    rubric,
    semanticState,
    images,
    evidenceRoot: hashCanonicalJson({
      publicRequirement,
      rubricSha256: rubric.sha256,
      rubricCriterionIds: rubric.criterionIds,
      allowedMechanismTags: rubric.allowedMechanismTags,
      semanticStateSha256: semanticState.sha256,
      images: images.map(({ slot, roomRevision, final, sha256, bytes, width, height, relativePath }) => ({
        slot, roomRevision, final, sha256, bytes, width, height, relativePath,
      })),
    }),
  };
}

async function sidecarFor(files: ReturnType<typeof retainedPng>[]) {
  const sidecar = await startExp0001aSuccessorEvaluatorSidecarV3({ files });
  activeSidecars.push(sidecar);
  return sidecar;
}

function exactFileUrls(sidecar: Exp0001aSuccessorEvaluatorSidecarV3) {
  const root = new URL("./", sidecar.packet.manifestUrl);
  return sidecar.packet.files.map((file) => new URL(file.relativePath, root).href);
}

describe("EXP-0001A successor evaluator evidence/result binding v3", () => {
  it("requires successful primary and adjudicator outputs to echo the exact supplied evidence root", async () => {
    const file = retainedPng("images/primary.png");
    const sidecar = await sidecarFor([file]);
    const evidence = evidenceFor(file);
    const primary = createExp0001aSuccessorPrimaryReviewerVisibleInputV3({ evidence, packet: sidecar.packet });
    const adjudicator = createExp0001aSuccessorAdjudicatorVisibleInputV3({ evidence, packet: sidecar.packet });
    const base = {
      schemaVersion: "exp-0001a-successor-review-result-binding/v3" as const,
      evidenceRoot: evidence.evidenceRoot,
      result: { accepted: true, rationale: "All visible criteria pass." },
    };

    expect(validateExp0001aSuccessorEvaluatorResultBindingV3(primary, {
      ...base, role: "primary_reviewer",
    })).toMatchObject({ evidenceRoot: evidence.evidenceRoot });
    expect(validateExp0001aSuccessorEvaluatorResultBindingV3(adjudicator, {
      ...base, role: "adjudicator",
    })).toMatchObject({ evidenceRoot: evidence.evidenceRoot });
    expect(() => validateExp0001aSuccessorEvaluatorResultBindingV3(primary, {
      schemaVersion: base.schemaVersion,
      role: "primary_reviewer",
      result: base.result,
    })).toThrow();
    expect(() => validateExp0001aSuccessorEvaluatorResultBindingV3(primary, {
      ...base,
      role: "primary_reviewer",
      evidenceRoot: `sha256:${"f".repeat(64)}`,
    })).toThrow("SUCCESSOR_REVIEW_RESULT_ROOT_MISMATCH");
  });

  it("keeps adjudicator-visible input and prompt free of primary decisions and private adjudication roots", async () => {
    const file = retainedPng("images/adjudication.png");
    const sidecar = await sidecarFor([file]);
    const evidence = evidenceFor(file);
    const visible = createExp0001aSuccessorAdjudicatorVisibleInputV3({ evidence, packet: sidecar.packet });
    const prompt = renderExp0001aSuccessorEvaluatorPromptV3(visible);
    const privateRoot = `sha256:${"a".repeat(64)}`;

    expect(prompt).toContain(evidence.evidenceRoot);
    expect(prompt).toContain("Do not calculate, recompute, or hash it");
    expect(prompt).not.toMatch(/primaryReviews|primaryReviewRoot|adjudicationSubjectRoot/);
    expect(prompt).not.toContain(privateRoot);
    expect(() => createExp0001aSuccessorAdjudicatorVisibleInputV3({
      evidence,
      packet: sidecar.packet,
      primaryReviews: [{ accepted: false }],
      adjudicationSubjectRoot: privateRoot,
    })).toThrow();
    expect(() => createExp0001aSuccessorAdjudicatorVisibleInputV3({
      evidence: {
        ...evidence,
        semanticState: {
          ...evidence.semanticState,
          content: { primaryDecisions: [{ accepted: false }] },
          sha256: hashCanonicalJson({ primaryDecisions: [{ accepted: false }] }),
          bytes: Buffer.byteLength(canonicalJson({ primaryDecisions: [{ accepted: false }] }), "utf8"),
        },
      },
      packet: sidecar.packet,
    })).toThrow(/PRIVATE_CONTEXT/);
  });

  it("requires a successful pairwise output to echo its exact pair root", async () => {
    const first = retainedPng("canvas-1/images/one.png", "first-image");
    const second = retainedPng("canvas-2/images/two.png", "second-image");
    const sidecar = await sidecarFor([first, second]);
    const baseEvidence = evidenceFor(first);
    const makeSide = (file: ReturnType<typeof retainedPng>, slot: "canvas-1" | "canvas-2") => {
      const image = {
        ...baseEvidence.images[0],
        slot: "image-01",
        relativePath: file.relativePath,
        sha256: file.sha256,
        bytes: file.bytes,
      };
      return {
        slot,
        image,
        sideRoot: hashCanonicalJson({
          slot,
          finalImage: {
            roomRevision: image.roomRevision,
            sha256: image.sha256,
            bytes: image.bytes,
            width: image.width,
            height: image.height,
            relativePath: image.relativePath,
          },
        }),
      };
    };
    const firstSide = { ...makeSide(first, "canvas-1"), slot: "canvas-1" as const };
    const secondSide = { ...makeSide(second, "canvas-2"), slot: "canvas-2" as const };
    const sides: [typeof firstSide, typeof secondSide] = [firstSide, secondSide];
    const pairRoot = hashCanonicalJson(sides.map(({ slot, sideRoot }) => ({ slot, sideRoot })));
    const visible = createExp0001aSuccessorPairwiseVisibleInputV3({
      publicRequirement: baseEvidence.publicRequirement,
      rubric: baseEvidence.rubric,
      sides,
      pairRoot,
      packet: sidecar.packet,
    });
    const result = {
      schemaVersion: "exp-0001a-successor-pairwise-result-binding/v3" as const,
      role: "pairwise_visual_judge" as const,
      pairRoot,
      result: { preference: "canvas-1", rationale: "Clearer hierarchy." },
    };
    expect(validateExp0001aSuccessorEvaluatorResultBindingV3(visible, result)).toMatchObject({ pairRoot });
    expect(() => validateExp0001aSuccessorEvaluatorResultBindingV3(visible, {
      ...result, pairRoot: `sha256:${"e".repeat(64)}`,
    })).toThrow("SUCCESSOR_PAIRWISE_RESULT_ROOT_MISMATCH");
  });
});

describe("EXP-0001A successor evaluator sidecar v3 post-release accounting", () => {
  it("does not let readiness probes stand in for reviewer GETs", async () => {
    const sidecar = await sidecarFor([retainedPng("images/readiness-only.png")]);
    sidecar.releaseReviewer({ reviewerTaskId: "reviewer-task-readiness-only" });
    await expect(sidecar.stop()).rejects.toThrow("POST_RELEASE_GET_MISSING");

    await fetch(sidecar.packet.manifestUrl);
    for (const url of exactFileUrls(sidecar)) await fetch(url);
    const receipt = await sidecar.stop();
    expect(receipt).toMatchObject({
      everyExactUrlOpenedAfterRelease: true,
      distinctUrlAccounting: true,
      exactUrlCount: 2,
    });
    expect(receipt.exactUrlReads.every((entry) => entry.readinessGetCount >= 1 && entry.postReleaseGetCount >= 1)).toBe(true);
  });

  it("requires GET rather than HEAD after release", async () => {
    const sidecar = await sidecarFor([retainedPng("images/head-only.png")]);
    sidecar.releaseReviewer({ reviewerTaskId: "reviewer-task-head-only" });
    await fetch(sidecar.packet.manifestUrl, { method: "HEAD" });
    for (const url of exactFileUrls(sidecar)) await fetch(url, { method: "HEAD" });
    await expect(sidecar.stop()).rejects.toThrow("POST_RELEASE_GET_MISSING");
    await fetch(sidecar.packet.manifestUrl);
    for (const url of exactFileUrls(sidecar)) await fetch(url);
    await sidecar.stop();
  });

  it("tracks byte-identical images by distinct exact URL and rejects one-sided consumption", async () => {
    const first = retainedPng("canvas-1/images/shared.png");
    const second = retainedPng("canvas-2/images/shared.png");
    expect(first.sha256).toBe(second.sha256);
    const sidecar = await sidecarFor([first, second]);
    sidecar.releaseReviewer({ reviewerTaskId: "reviewer-task-identical-bytes" });
    const [firstUrl, secondUrl] = exactFileUrls(sidecar);
    await fetch(sidecar.packet.manifestUrl);
    await fetch(firstUrl!);
    await fetch(firstUrl!);
    await expect(sidecar.stop()).rejects.toThrow(secondUrl!);
    await fetch(secondUrl!);
    const receipt = await sidecar.stop();
    const imageReads = receipt.exactUrlReads.filter((entry) => entry.relativePath !== null);
    expect(imageReads).toHaveLength(2);
    expect(new Set(imageReads.map((entry) => entry.exactUrl)).size).toBe(2);
    expect(new Set(imageReads.map((entry) => entry.sha256)).size).toBe(1);
  });

  it("rejects writes, queries, and duplicate paths without weakening exact routes", async () => {
    const file = retainedPng("images/exact.png");
    const sidecar = await sidecarFor([file]);
    expect((await fetch(sidecar.packet.manifestUrl, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${sidecar.packet.manifestUrl}?directory=1`)).status).toBe(404);
    await expect(startExp0001aSuccessorEvaluatorSidecarV3({ files: [file, file] }))
      .rejects.toThrow("DUPLICATE_PATH");
  });
});
