#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const BASE_CAPTURE_DIGEST = "102ac23118d91d8a8782bf303885065f7afdef7fe208afe22bb6c85baf54b601";
const EXPECTED_DEPLOYMENT_ID = "dpl_CePet5gs1u52rMvQUGye92qByJAQ";
const EXPECTED_SPECTATOR_COUNT = 18;
const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), "../..");
const baseCapturePath = path.join(repositoryRoot, "research/scripts/capture-baseline-v2.mjs");

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function parseBaselineV3CaptureArguments(argv) {
  const outputIndex = argv.indexOf("--output-dir");
  const historyIndex = argv.indexOf("--capture-history-log");
  if (argv.length !== 4 || outputIndex < 0 || historyIndex < 0
      || outputIndex === argv.length - 1 || historyIndex === argv.length - 1) {
    throw new Error("Usage: --output-dir /absolute/path --capture-history-log /absolute/path.json");
  }
  return {
    outputDir: path.resolve(argv[outputIndex + 1]),
    captureHistoryLog: path.resolve(argv[historyIndex + 1]),
  };
}

export async function loadBaselineV3CaptureRuntime() {
  const bytes = await readFile(baseCapturePath);
  if (digest(bytes) !== BASE_CAPTURE_DIGEST) {
    throw new Error("The frozen baseline-v2 capture implementation changed.");
  }
  const playwrightUrl = import.meta.resolve("@playwright/test");
  let source = bytes.toString("utf8")
    .replace('from "@playwright/test";', `from ${JSON.stringify(playwrightUrl)};`)
    .replace(
      'const EXPECTED_DEPLOYMENT_ID = "dpl_46pyqWtLXGfzeU1JsqXEWQjTBfd8";',
      `const EXPECTED_DEPLOYMENT_ID = ${JSON.stringify(EXPECTED_DEPLOYMENT_ID)};`,
    )
    .replace(
      "const EXPECTED_SPECTATOR_COUNT = 18;",
      `const EXPECTED_SPECTATOR_COUNT = ${EXPECTED_SPECTATOR_COUNT};`,
    )
    .replace("async function captureProduction(", "export async function captureProduction(")
    .replace(
      "  let authoritativeStateRedacted;",
      [
        "  let authoritativeStateRedacted;",
        "  let progressiveDraftFinish;",
        "  let progressiveDraftStageCallResult;",
        "  let progressiveDraftFinishCallResult;",
      ].join("\n"),
    )
    .replace(
      `    const createdShape = successfulTool(await callTool(page, "create_shape", {
      label: "Baseline exact-revision evidence",
      semanticName: "Baseline exact-revision evidence",
      semanticRole: "verification-marker",
      shape: "rectangle",
      x: 120,
      y: 100,
      width: 360,
      height: 180,
      fill: "light-blue",
      stroke: "blue",
    }), "create_shape");`,
      `    progressiveDraftStageCallResult = JSON.parse(JSON.stringify(await callTool(page, "apply_canvas_transaction", {
      operations: [{
        op: "create_shape",
        tempRef: "baselineMarker",
        label: "Baseline exact-revision evidence",
        semanticName: "Baseline exact-revision evidence",
        semanticRole: "verification-marker",
        shape: "rectangle",
        x: 120,
        y: 100,
        width: 360,
        height: 180,
        fill: "light-blue",
        stroke: "blue",
      }],
      delivery: { mode: "draft" },
    })));
    const stagedDraft = successfulTool(progressiveDraftStageCallResult, "apply_canvas_transaction");
    if (stagedDraft.outcome !== "drafted" || typeof stagedDraft.draftId !== "string"
        || !Number.isSafeInteger(stagedDraft.draftRevision) || stagedDraft.draftRevision < 1) {
      throw new Error("Baseline-v3 progressive draft was not staged exactly once.");
    }
    progressiveDraftFinishCallResult = JSON.parse(JSON.stringify(await callTool(page, "finish_canvas_draft", {
      draftId: stagedDraft.draftId,
      expectedDraftRevision: stagedDraft.draftRevision,
      action: "commit",
    })));
    const createdShape = successfulTool(progressiveDraftFinishCallResult, "finish_canvas_draft");
    if (createdShape.outcome !== "applied") {
      throw new Error("Baseline-v3 progressive draft did not finish with an applied commit.");
    }
    progressiveDraftFinish = {
      stageTool: "apply_canvas_transaction",
      finishTool: "finish_canvas_draft",
      stageOutcome: stagedDraft.outcome,
      finishOutcome: createdShape.outcome,
      stageCallResultDigest: hashCanonicalJson(progressiveDraftStageCallResult),
      finishCallResultDigest: hashCanonicalJson(progressiveDraftFinishCallResult),
      directFallbackUsed: false,
      finishInvocationCount: 1,
    };`,
    )
    .replace(
      "    semanticExport,\n    pngExport,",
      "    semanticExport,\n    pngExport,\n    progressiveDraftFinish,",
    )
    .replace(
      `    ["baseline-authoritative-state-redacted-v2.json", authoritativeStateRedacted],`,
      `    ["baseline-authoritative-state-redacted-v2.json", authoritativeStateRedacted],
    ["baseline-progressive-draft-stage-call-result-v3.json", progressiveDraftStageCallResult],
    ["baseline-progressive-draft-finish-call-result-v3.json", progressiveDraftFinishCallResult],`,
    );
  for (const required of [
    `const EXPECTED_DEPLOYMENT_ID = ${JSON.stringify(EXPECTED_DEPLOYMENT_ID)};`,
    `const EXPECTED_SPECTATOR_COUNT = ${EXPECTED_SPECTATOR_COUNT};`,
    "export async function captureProduction(",
    `from ${JSON.stringify(playwrightUrl)};`,
    "Baseline-v3 progressive draft did not finish with an applied commit.",
    "baseline-progressive-draft-stage-call-result-v3.json",
    "progressiveDraftFinish,",
  ]) {
    if (!source.includes(required)) throw new Error("The baseline-v3 capture transformation was incomplete.");
  }
  source = `${source}\n//# sourceURL=${pathToFileURL(baseCapturePath).href}?baseline-v3\n`;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

async function promotePublicArtifact(outputDir, fromName, toName) {
  const fromPath = path.join(outputDir, fromName);
  const toPath = path.join(outputDir, toName);
  const parsed = JSON.parse(await readFile(fromPath, "utf8"));
  parsed.schemaVersion = 3;
  await writeFile(toPath, `${JSON.stringify(parsed, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(fromPath, `${fromPath}.source-v2`);
}

export async function captureBaselineV3(outputDir, captureHistoryLog) {
  const runtime = await loadBaselineV3CaptureRuntime();
  const summary = await runtime.captureProduction(outputDir, captureHistoryLog);
  await promotePublicArtifact(
    outputDir,
    "baseline-webmcp-inventory-v2.json",
    "baseline-webmcp-inventory-v3.json",
  );
  await promotePublicArtifact(
    outputDir,
    "baseline-production-evidence-v2.json",
    "baseline-production-evidence-v3.json",
  );
  return {
    ...summary,
    captureWrapper: path.relative(repositoryRoot, scriptPath),
    publicSchemaVersion: 3,
  };
}

async function main() {
  const args = parseBaselineV3CaptureArguments(process.argv.slice(2));
  const summary = await captureBaselineV3(args.outputDir, args.captureHistoryLog);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    process.stderr.write(`baseline-v3 capture failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
