import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const REPOSITORY_ROOT = process.cwd();
const SCRIPT = path.join(REPOSITORY_ROOT, "research/scripts/exp0036-review-bundle.mjs");
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z1Z0AAAAASUVORK5CYII=",
  "base64",
);
const temporaryDirectories: string[] = [];

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function execute(args: string[]): Record<string, unknown> {
  return JSON.parse(execFileSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
  })) as Record<string, unknown>;
}

function sanitizedState(revision: number) {
  const entity = (id: string, semanticName: string, x: number) => ({
    id, kind: "shape", semanticName, semanticRole: "entity",
    x, y: 20, width: 100, height: 60, rotation: 0, zIndex: 1, groupId: null,
    diagramIds: ["diagram"],
  });
  const connector = (id: string, start: string, end: string, semanticRole: string) => ({
    id, kind: "connector", semanticName: id, semanticRole,
    x: 0, y: 0, width: 1, height: 1, rotation: 0, zIndex: 2, groupId: null,
    diagramIds: ["diagram"], start: { objectId: start }, end: { objectId: end },
    direction: "end", label: semanticRole,
  });
  return {
    schemaVersion: "jazzboard-exp0036-sanitized-final-state/v1",
    finalRevision: revision,
    objects: [
      entity("checkout", "Checkout API", 150),
      connector("checkout-fulfillment", "checkout", "fulfillment", "asynchronous_event"),
      connector("checkout-payment", "checkout", "payment", "synchronous_request"),
      entity("fulfillment", "Fulfillment Worker", 430),
      entity("payment", "Payment Service", 290),
      connector("shopper-checkout", "shopper", "checkout", "synchronous_request"),
      entity("shopper", "Shopper Browser", 10),
    ].sort((left, right) => left.id.localeCompare(right.id)),
    diagrams: [{
      id: "diagram", title: "Checkout", description: "", diagramType: "architecture",
      category: "service", tags: [],
      memberObjectIds: ["shopper", "checkout", "payment", "fulfillment"],
      connectorIds: ["shopper-checkout", "checkout-payment", "checkout-fulfillment"],
      bounds: { x: 0, y: 0, width: 600, height: 300 },
    }],
  };
}

function artifactMetadata(revision: number, attachmentReference: string) {
  const content = {
    schemaVersion: "jazzboard-exp0036-artifact-metadata/v1",
    finalRevision: revision,
    sanitizedFinalState: sanitizedState(revision),
    pixels: {
      revision,
      mimeType: "image/png",
      width: 1,
      height: 1,
      sha256: sha256(PNG),
      attachmentReference,
    },
  };
  return {
    ...content,
    controllerPreparedArtifactMetadataSha256: sha256(Buffer.from(canonical(content), "utf8")),
  };
}

async function prepareAttempt(
  root: string,
  attemptId: "attempt05" | "attempt06",
  revision: number,
  bindings: Array<[string, "left" | "right"]>,
) {
  const attemptDirectory = path.join(root, attemptId);
  const privateDirectory = path.join(attemptDirectory, ".private");
  await mkdir(privateDirectory, { recursive: true, mode: 0o700 });
  const pngPath = path.join(privateDirectory, `final-r${revision}.png`);
  await writeFile(pngPath, PNG);
  await writeFile(path.join(privateDirectory, "capture.json"), JSON.stringify({
    schemaVersion: "jazzboard-exp0036-controller-capture/v1",
    attemptId,
    finalRevision: revision,
    pixels: { path: pngPath },
  }));
  for (const [reviewSlotId, side] of bindings) {
    await writeFile(
      path.join(privateDirectory, `artifact-metadata-${reviewSlotId}-${side}.json`),
      JSON.stringify(artifactMetadata(revision, `attachment:${reviewSlotId}-${side}`)),
    );
  }
  return attemptDirectory;
}

async function validResult(bundleDirectory: string, resultPath: string) {
  const packet = JSON.parse(await readFile(path.join(bundleDirectory, "packet.json"), "utf8")) as {
    schemaVersion: string;
    reviewSlotId: string;
    taskId: string;
    artifacts: Array<{ label: string; displaySide: string }>;
    rubric: { criteria: Array<{ criterionId: string }> };
  };
  const result = {
    schemaVersion: "jazzboard-exp0036-pair-review-result/v1",
    reviewSlotId: packet.reviewSlotId,
    taskId: packet.taskId,
    artifacts: packet.artifacts.map((artifact) => ({
      label: artifact.label,
      displaySide: artifact.displaySide,
      criteria: packet.rubric.criteria.map((criterion) => ({
        criterionId: criterion.criterionId,
        result: "pass",
        evidence: "Visible and semantically supported in the supplied evidence.",
      })),
      hardGate: "pass",
      blockingDefects: [],
    })),
    preference: "tie",
    preferenceEvidence: "No supported advantage.",
  };
  await writeFile(resultPath, JSON.stringify(result));
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("EXP0036 neutral local review bundles", () => {
  it("prepares explicit capture paths, validates reviews, and applies the existing architecture audit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exp0036-review-bundle-test-"));
    temporaryDirectories.push(root);
    const attempt05 = await prepareAttempt(root, "attempt05", 11, [
      ["checkout-review-1", "left"], ["checkout-review-2", "right"],
    ]);
    const attempt06 = await prepareAttempt(root, "attempt06", 12, [
      ["checkout-review-1", "right"], ["checkout-review-2", "left"],
    ]);
    const review1 = path.join(root, "neutral-review-1");
    const review2 = path.join(root, "neutral-review-2");
    for (const [slot, output] of [["checkout-review-1", review1], ["checkout-review-2", review2]]) {
      const prepared = execute([
        "prepare", "--slot", slot,
        "--capture-attempt05", attempt05,
        "--capture-attempt06", attempt06,
        "--output", output,
      ]);
      expect(prepared).toMatchObject({ ok: true, reviewSlotId: slot });
      const visible = await Promise.all([
        "packet.json", "reviewer-prompt.txt", "bundle-receipt.json",
      ].map((name) => readFile(path.join(output, name), "utf8")));
      expect(visible.join("\n")).not.toMatch(/attempt0[1-8]|\bA[01]\b|baseline|candidate|roomCode|controllerOrigin/);
    }

    const result1 = path.join(root, "result-1.json");
    const result2 = path.join(root, "result-2.json");
    await validResult(review1, result1);
    await validResult(review2, result2);
    const validationPath = path.join(root, "validation.json");
    expect(execute([
      "validate", "--bundle", review1, "--result", result1, "--output", validationPath,
    ])).toMatchObject({ ok: true, valid: true, reasons: [] });

    const gradePath = path.join(root, "pair-grade.json");
    expect(execute([
      "grade",
      "--review-one-bundle", review1, "--review-one-result", result1,
      "--review-two-bundle", review2, "--review-two-result", result2,
      "--output", gradePath,
    ])).toMatchObject({ ok: true, pairAcceptedBothArtifacts: true });
    const grade = JSON.parse(await readFile(gradePath, "utf8")) as {
      artifacts: Array<{ authoritativeAudit: { status: string }; hardGate: string }>;
    };
    expect(grade.artifacts).toHaveLength(2);
    expect(grade.artifacts.every((artifact) =>
      artifact.authoritativeAudit.status === "pass" && artifact.hardGate === "pass")).toBe(true);
  });
});
