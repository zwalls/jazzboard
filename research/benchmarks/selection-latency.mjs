import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

// Run from any directory:
// node research/benchmarks/selection-latency.mjs --baseline-ref <commit> --output <json-path>
// This measures local geometry work, not browser frame time or native WebMCP latency.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const argument = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const baselineRef = argument("--baseline-ref");
const output = argument("--output");
const modulePath = "src/lib/canvas/semantic-selection-session.ts";
const temporary = await mkdtemp(path.join(tmpdir(), "jazzboard-selection-latency-"));
const server = await createServer({
  root,
  configFile: false,
  logLevel: "error",
  resolve: { alias: { "@": path.join(root, "src") } },
  server: { middlewareMode: true, hmr: false, ws: false },
});

const actor = { participantId: "latency", displayName: "Latency", color: "blue", kind: "human" };
function makeScene(buildSemanticScene, count, overlapping, grouped) {
  const objects = Array.from({ length: count }, (_, index) => ({
    id: `shape-${String(index).padStart(5, "0")}`,
    kind: "shape", shape: "rectangle", nodeType: null, label: "Node", fill: "white", stroke: "black",
    x: overlapping ? 0 : (index % 80) * 140,
    y: overlapping ? 0 : Math.floor(index / 80) * 100,
    width: 100, height: 60, rotation: 0, zIndex: Math.floor(index / 2), revision: 1,
    groupId: grouped ? `group-${Math.floor(index / 20)}` : null,
    diagramIds: [], createdAt: 1, updatedAt: 1, createdBy: actor, lastEditedBy: actor,
  }));
  return buildSemanticScene({
    id: "selection-latency", roomRevision: 1,
    objects: Object.fromEntries(objects.map((object) => [object.id, object])), diagrams: {},
  });
}

function probe(operation, iterations) {
  let checksum = 0;
  const start = performance.now();
  for (let index = 0; index < iterations; index++) checksum += operation(index);
  return { milliseconds: (performance.now() - start) / iterations, checksum };
}

function summarize(samples, iterations, checksum) {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    medianMs: sorted[Math.floor(sorted.length / 2)],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    iterationsPerSample: iterations,
    samplesMs: samples,
    checksum,
  };
}

try {
  const { buildSemanticScene } = await server.ssrLoadModule("/src/lib/canvas/semantic-scene.ts");
  const current = await server.ssrLoadModule(`/${modulePath}`);
  let baseline;
  if (baselineRef) {
    const source = execFileSync("git", ["show", `${baselineRef}:${modulePath}`], { cwd: root, encoding: "utf8" });
    const baselinePath = path.join(temporary, "selection-baseline.ts");
    await writeFile(baselinePath, source);
    baseline = await server.ssrLoadModule(baselinePath);
  }
  const workloads = [
    { name: "sparse-1000-topmost", count: 1000, all: false, overlapping: false, grouped: false },
    { name: "sparse-5000-topmost", count: 5000, all: false, overlapping: false, grouped: false },
    { name: "sparse-5000-all-hits", count: 5000, all: true, overlapping: false, grouped: false },
    { name: "sparse-5000-grouped-topmost", count: 5000, all: false, overlapping: false, grouped: true },
    { name: "overlap-1000-topmost", count: 1000, all: false, overlapping: true, grouped: false },
    { name: "overlap-1000-all-hits", count: 1000, all: true, overlapping: true, grouped: false },
    { name: "overlap-1000-grouped-all-hits", count: 1000, all: true, overlapping: true, grouped: true },
    { name: "miss-5000-topmost", count: 5000, all: false, overlapping: false, grouped: false, miss: true },
  ];
  const results = [];
  for (const workload of workloads) {
    const scene = makeScene(buildSemanticScene, workload.count, workload.overlapping, workload.grouped);
    const points = workload.overlapping ? [{ x: 20, y: 20 }] : workload.miss ? [{ x: -100, y: -100 }] :
      [0, 0.25, 0.5, 0.75, 0.999].map((fraction) => {
        const index = Math.floor(workload.count * fraction);
        return { x: (index % 80) * 140 + 20, y: Math.floor(index / 80) * 100 + 20 };
      });
    const method = workload.all ? "hitTestSemanticSceneObjects" : "hitTestSemanticScene";
    const options = { zoom: 1 };
    if (baseline) {
      for (const point of points) assert.deepEqual(current[method](scene, point, options), baseline[method](scene, point, options));
    }
    const versions = baseline ? { baseline, current } : { current };
    const runners = Object.entries(versions).map(([version, module]) => {
      const operation = (index) => {
        const result = module[method](scene, points[index % points.length], options);
        return workload.all ? result.length : result?.selectionObjectIds.length ?? 0;
      };
      for (let index = 0; index < 10; index++) operation(index);
      const pilot = probe(operation, points.length);
      // About 5 ms per sample, bounded for very fast and very slow implementations.
      const iterations = Math.max(points.length, Math.min(1000, Math.ceil(5 / Math.max(pilot.milliseconds, 0.0001) / points.length) * points.length));
      return { version, operation, iterations, samples: [], checksum: 0 };
    });
    for (let sample = 0; sample < 21; sample++) {
      for (const runner of sample % 2 ? [...runners].reverse() : runners) {
        const result = probe(runner.operation, runner.iterations);
        runner.samples.push(result.milliseconds);
        runner.checksum += result.checksum;
      }
    }
    const measured = Object.fromEntries(runners.map((runner) => [runner.version,
      summarize(runner.samples, runner.iterations, runner.checksum)]));
    results.push({
      ...workload,
      ...(baseline ? { equivalentToBaseline: true, medianSpeedup: measured.baseline.medianMs / measured.current.medianMs } : {}),
      ...measured,
    });
    console.log(`${workload.name}: ${baseline ? `${measured.baseline.medianMs.toFixed(4)} -> ` : ""}${measured.current.medianMs.toFixed(4)} ms${baseline ? ` (${(measured.baseline.medianMs / measured.current.medianMs).toFixed(2)}x)` : ""}`);
  }
  const report = {
    measuredAt: new Date().toISOString(), node: process.version, platform: process.platform, architecture: process.arch,
    baselineRef: baselineRef ?? null,
    method: "Local Vite SSR geometry microbenchmark; 10 warmups, 21 alternating samples; no scene build, DOM/rendering, network, or WebMCP timing included.",
    results,
  };
  if (output) await writeFile(path.resolve(root, output), `${JSON.stringify(report, null, 2)}\n`);
} finally {
  await server.close();
  await rm(temporary, { recursive: true, force: true });
}
