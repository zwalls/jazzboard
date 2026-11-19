import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

// node research/benchmarks/marquee-latency.mjs <baseline-ref> <output-json>
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const [baselineRef, output] = process.argv.slice(2);
assert(baselineRef && output, "Pass a baseline ref and output JSON path.");
const baselineCommit = execFileSync("git", ["rev-parse", baselineRef], { cwd: root, encoding: "utf8" }).trim();
const modulePath = "src/lib/canvas/semantic-selection-session.ts";
const temporary = await mkdtemp(path.join(tmpdir(), "jazzboard-marquee-latency-"));
const server = await createServer({
  root, configFile: false, logLevel: "error",
  resolve: { alias: { "@": path.join(root, "src") } },
  server: { middlewareMode: true, hmr: false, ws: false },
});

const actor = { participantId: "marquee", displayName: "Marquee", color: "blue", kind: "human" };

// Clustered service diagrams on a grid, with geometry and locked-image variation.
function makeScene(buildSemanticScene, clusters) {
  const objects = [];
  for (let cluster = 0; cluster < clusters; cluster++) {
    const groupId = `cluster-${cluster}`;
    const left = (cluster % 12) * 550;
    const top = Math.floor(cluster / 12) * 400;
    const members = Array.from({ length: 14 }, (_, index) => ({
      id: `${groupId}-node-${index}`, kind: "shape", label: `Service ${index}`,
      shape: ["rectangle", "ellipse", "diamond", "rectangle"][index % 4],
      x: left + (index % 4) * 125, y: top + Math.floor(index / 4) * 85,
      width: 93, height: 50, rotation: index === 10 ? 0.21 : 0, zIndex: cluster * 20 + index,
      groupId, revision: 1, createdAt: 1, updatedAt: 1, diagramIds: [],
      createdBy: actor, lastEditedBy: actor, fill: "white", stroke: "black", nodeType: null,
    }));
    members[13] = {
      ...members[13], kind: "image", url: "/synthetic.png", assetId: "synthetic", alt: "Synthetic",
      sourceUrl: null, mimeType: "image/png", locked: true,
    };
    objects.push(...members);
    for (let index = 0; index < 6; index++) {
      const from = members[index], to = members[index + 4];
      objects.push({
        ...from, id: `${groupId}-link-${index}`, kind: "connector",
        start: { x: from.x + from.width / 2, y: from.y + from.height, objectId: from.id },
        end: { x: to.x + to.width / 2, y: to.y, objectId: to.id },
        routing: { mode: "straight", kind: "straight", bend: 0, elbowMidPoint: 0.5, labelPosition: 0.5 },
        direction: "end", color: "black", label: index % 3 ? "" : "calls",
      });
    }
  }
  return buildSemanticScene({ id: "marquee-latency", roomRevision: 1,
    objects: Object.fromEntries(objects.map((object) => [object.id, object])), diagrams: {} });
}

function makeWorkload(scene, spec) {
  const wide = spec.span === "wide";
  const points = Array.from({ length: 18 }, (_, index) => ({
    x: wide ? 3300 + index * 185 : 122 + index * 24,
    y: wide ? scene.bounds.height * (0.58 + index / 42) : 110 + index * 13,
  }));
  return {
    points,
    options: {
      pointerStart: { x: -12, y: -12 }, zoom: 0.7, groupMode: spec.groupMode ?? "group",
      mode: spec.mode ?? "intersect", intent: spec.intent, lockedImages: "exclude",
      selectedObjectIds: scene.objects
        .filter((_, index) => spec.intent !== "replace" && index % 40 === 0)
        .map(({ object }) => object.id),
    },
  };
}

function drive(Engine, scene, frame, validate = false) {
  const engine = new Engine();
  const start = engine.begin(scene, frame.options);
  const token = start.session.token;
  const snapshots = validate ? [start] : null;
  let count = 0;
  for (const point of frame.points) {
    const value = engine.updatePointer(token, point);
    count += value.session.selectedObjectIds.length;
    if (snapshots) snapshots.push(value);
  }
  const finish = engine.finish(token);
  if (snapshots) snapshots.push(finish);
  return snapshots ?? count + finish.session.selectedObjectIds.length;
}

function summarize(samplesMs) {
  const ordered = samplesMs.toSorted((a, b) => a - b);
  return { medianMs: ordered[10], p95Ms: ordered[19], samplesMs };
}

try {
  const baselinePath = path.join(temporary, "selection-baseline.ts");
  await writeFile(baselinePath,
    execFileSync("git", ["show", `${baselineCommit}:${modulePath}`], { cwd: root, encoding: "utf8" }));
  const { buildSemanticScene } = await server.ssrLoadModule("/src/lib/canvas/semantic-scene.ts");
  const baseline = (await server.ssrLoadModule(baselinePath)).SemanticMarqueeSelectionSessionEngine;
  const candidate = (await server.ssrLoadModule(`/${modulePath}`)).SemanticMarqueeSelectionSessionEngine;
  const workloads = [
    { name: "small-160-replace", clusters: 8, span: "local", intent: "replace", iterations: 20 },
    { name: "dense-5000-local-replace", clusters: 250, span: "local", intent: "replace", iterations: 6 },
    { name: "dense-5000-wide-replace", clusters: 250, span: "wide", intent: "replace", iterations: 3 },
    { name: "dense-5000-wide-add", clusters: 250, span: "wide", intent: "add", iterations: 3 },
    { name: "dense-5000-wide-toggle", clusters: 250, span: "wide", intent: "toggle", iterations: 3 },
    { name: "dense-5000-wide-object-contain", clusters: 250, span: "wide", intent: "replace",
      groupMode: "object", mode: "contain", iterations: 3 },
  ];
  const scenes = new Map();
  const results = [];
  for (const spec of workloads) {
    if (!scenes.has(spec.clusters)) scenes.set(spec.clusters, makeScene(buildSemanticScene, spec.clusters));
    const scene = scenes.get(spec.clusters);
    const frame = makeWorkload(scene, spec);
    const expected = drive(baseline, scene, frame, true);
    assert.deepEqual(drive(candidate, scene, frame, true), expected, spec.name);
    assert(expected.at(-1).session.selectedObjectIds.length > 0, spec.name);
    for (let i = 0; i < 10; i++) for (const Engine of [baseline, candidate]) drive(Engine, scene, frame);
    const runners = [{ Engine: baseline, samples: [], checksum: 0 }, { Engine: candidate, samples: [], checksum: 0 }];
    for (let sample = 0; sample < 21; sample++) {
      for (const runner of sample % 2 ? [...runners].reverse() : runners) {
        const start = performance.now();
        for (let iteration = 0; iteration < spec.iterations; iteration++) {
          runner.checksum += drive(runner.Engine, scene, frame);
        }
        runner.samples.push((performance.now() - start) / spec.iterations);
      }
    }
    assert.equal(runners[0].checksum, runners[1].checksum, spec.name);
    const [before, after] = runners.map(({ samples, checksum }) => ({ ...summarize(samples), checksum }));
    results.push({ ...spec, objects: scene.objects.length, comparedSnapshots: expected.length,
      finishSelectionCount: expected.at(-1).session.selectedObjectIds.length, baseline: before, candidate: after });
    console.log(`${spec.name}: median ${before.medianMs.toFixed(3)} -> ${after.medianMs.toFixed(3)} ms; p95 ${before.p95Ms.toFixed(3)} -> ${after.p95Ms.toFixed(3)} ms`);
  }
  await writeFile(path.resolve(root, output), JSON.stringify({
    baselineCommit, node: process.version, platform: process.platform, architecture: process.arch,
    method: "Vite SSR. Time per gesture: begin, 18 pointer updates, finish. Scene setup excluded. Ten warmups and 21 alternating samples per variant per fixture. Complete lifecycle outputs deep-compared before timing.",
    results,
  }, null, 2) + "\n");
} finally {
  await server.close();
  await rm(temporary, { recursive: true, force: true });
}
