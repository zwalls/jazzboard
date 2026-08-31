import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = path.join(process.cwd(), "research/scripts/exp0001a-artifact-packet-sidecar.mjs");
const roots: string[] = [];
const childPids = new Set<number>();
const SUBJECT_DIGEST = `sha256:${"a".repeat(64)}`;

const FIXTURE_RUNTIME = String.raw`
import { createHash } from "node:crypto";
import { createServer } from "node:http";
function canonical(value) { if(value===null||typeof value!=="object")return JSON.stringify(value);if(Array.isArray(value))return "["+value.map(canonical).join(",")+"]";return "{"+Object.keys(value).sort().map((key)=>JSON.stringify(key)+":"+canonical(value[key])).join(",")+"}"; }
function digest(value) { return "sha256:" + createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex"); }
function listen(server) { return new Promise((resolve, reject) => { server.once("error", reject); server.listen({host:"127.0.0.1",port:0,exclusive:true},()=>resolve(server.address())); }); }
function close(server) { return new Promise((resolve,reject)=>server.close((error)=>error?reject(error):resolve())); }
async function start(input, role) {
  if (input.subject.subjectDigest !== "${SUBJECT_DIGEST}") throw new Error("fixture subject invalid");
  if (role === "primary_reviewer" && (input.authorPlan.fixtureBinding !== "exact-plan" || input.authorLifecycle.fixtureBinding !== "exact-lifecycle")) throw new Error("fixture primary evidence invalid");
  const counts = {get:0,head:0,rejectedWrite:0,notFound:0,rejectedHost:0}; let fileGet = 0; let fileHead = 0;
  let expectedHost = null;
  const body = Buffer.from(JSON.stringify({artifact:"retained-author-state"}));
  const manifest = Buffer.from(JSON.stringify({schemaVersion:1,files:[{relativePath:"artifact.json",sha256:digest(body),bytes:body.length,mimeType:"application/json"}]}));
  const server = createServer((request,response)=>{
    if (request.headers.host !== expectedHost) { counts.rejectedHost++; response.writeHead(421); response.end(); return; }
    if (request.method !== "GET" && request.method !== "HEAD") { counts.rejectedWrite++; response.writeHead(405,{allow:"GET, HEAD"}); response.end(); return; }
    const url = new URL(request.url,"http://"+expectedHost); let selected = null;
    if (!url.search && url.pathname === "/packet/manifest.json") selected = manifest;
    if (!url.search && url.pathname === "/packet/artifact.json") { selected = body; if(request.method === "GET") fileGet++; else fileHead++; }
    if (!selected) { counts.notFound++; response.writeHead(404); response.end(); return; }
    if(request.method === "GET") counts.get++; else counts.head++;
    response.writeHead(200,{"content-length":String(selected.length),"content-type":"application/json","cache-control":"no-store"});
    response.end(request.method === "HEAD" ? undefined : selected);
  });
  const address = await listen(server); expectedHost = "127.0.0.1:"+address.port;
  const origin = "http://"+expectedHost+"/"; const manifestUrl = origin+"packet/manifest.json";
  const envelope = {schemaVersion:"fixture-envelope/v1",role,artifactPacket:{origin,manifestUrl,manifestDigest:digest(manifest),files:[{relativePath:"artifact.json",sha256:digest(body),bytes:body.length,mimeType:"application/json"}]}};
  const reviewerEnvelopeDigest = digest(envelope);
  const startReceipt = {schemaVersion:"fixture/v1",kind:"start",role,subjectDigest:input.subject.subjectDigest,reviewerEnvelopeDigest,receiptDigest:digest("start:"+reviewerEnvelopeDigest)};
  // This is the real readiness access whose count must survive until stop.
  await fetch(manifestUrl); const artifactResponse = await fetch(origin+"packet/artifact.json"); if(!artifactResponse.ok) throw new Error("probe failed"); await artifactResponse.arrayBuffer();
  const readyReceipt = {schemaVersion:"fixture/v1",kind:"ready",envelopeDigest:reviewerEnvelopeDigest,servedFileCount:1,receiptDigest:digest("ready:"+reviewerEnvelopeDigest)};
  return {envelope,startReceipt,readyReceipt,stop:async()=>{await close(server);return {schemaVersion:"fixture/v1",kind:"stop",requestCounts:counts,servedFiles:[{relativePath:"artifact.json",getCount:fileGet,headCount:fileHead}],everyFileOpened:fileGet>0,serverClosed:true,receiptDigest:digest("stop:"+fileGet+":"+fileHead)};}};
}
export const exp0001aCodexArtifactPacketServerStartReceiptSchema = {parse(value){return value;}};
export function startExp0001aCodexPrimaryArtifactPacketServer(input){return start(input,"primary_reviewer");}
export function startExp0001aCodexAdjudicationArtifactPacketServer(input){return start(input,"adjudicator");}
export function startExp0001aCodexPairwiseArtifactPacketServer(input){return start(input,"pairwise_visual_judge");}
`;

afterEach(async () => {
  for (const pid of childPids) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already stopped */ }
  }
  childPids.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "exp0001a-packet-sidecar-"));
  roots.push(root);
  await chmod(root, 0o700);
  const canonicalRoot = await import("node:fs/promises").then(({ realpath }) => realpath(root));
  const runtimePath = path.join(canonicalRoot, "fixture-runtime.mjs");
  const inputPath = path.join(canonicalRoot, "start-input.json");
  await writeFile(runtimePath, FIXTURE_RUNTIME, { mode: 0o600 });
  await writeFile(inputPath, JSON.stringify({
    schemaVersion: "exp-0001a-artifact-packet-sidecar-start-input/v1",
    role: "primary_reviewer",
    subject: { kind: "primary-review-success-subject", subjectDigest: SUBJECT_DIGEST, frozen: "origin-free" },
    evidence: {
      authorPlan: { fixtureBinding: "exact-plan" },
      authorLifecycle: { fixtureBinding: "exact-lifecycle" },
    },
  }), { mode: 0o600 });
  return { root: canonicalRoot, runtimePath, inputPath, packetId: "primary-review-001" };
}

async function cli(args: string[]) {
  const result = await execFileAsync(process.execPath, [SCRIPT_PATH, ...args], { timeout: 25_000 });
  return { raw: result.stdout.trim(), parsed: JSON.parse(result.stdout) };
}

async function privateProcess(root: string, packetId: string) {
  const filePath = path.join(root, "artifact-packet-sidecars", packetId, "process-receipt.json");
  const receipt = JSON.parse(await readFile(filePath, "utf8"));
  childPids.add(receipt.pid);
  return receipt;
}

describe("EXP-0001A durable artifact packet sidecar", () => {
  it("keeps one exact loopback packet alive across CLI invocations and stops idempotently with opened-file proof", async () => {
    const value = await fixture();
    const startArgs = ["start", "--run-root", value.root, "--packet-id", value.packetId,
      "--input", value.inputPath, "--runtime-bundle", value.runtimePath];
    const started = await cli(startArgs);
    const privateReceipt = await privateProcess(value.root, value.packetId);
    const privateControl = JSON.parse(await readFile(path.join(
      value.root, "artifact-packet-sidecars", value.packetId, "control-secret.json",
    ), "utf8"));

    expect(started.parsed).toMatchObject({ state: "active", role: "primary_reviewer", subjectDigest: SUBJECT_DIGEST });
    expect(started.raw).not.toContain(String(privateReceipt.pid));
    expect(started.raw).not.toContain(privateControl.processNonce);
    expect(started.raw).not.toContain(privateControl.controlSecret);
    const manifest = await fetch(started.parsed.envelope.artifactPacket.manifestUrl);
    expect(manifest.status).toBe(200);
    expect((await fetch(started.parsed.envelope.artifactPacket.manifestUrl, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${started.parsed.envelope.artifactPacket.manifestUrl}?list=1`)).status).toBe(404);

    const status = await cli(["status", "--run-root", value.root, "--packet-id", value.packetId,
      "--request-id", "status-one"]);
    expect(status.parsed).toMatchObject({ state: "active", envelope: started.parsed.envelope });
    expect(status.raw).not.toContain(String(privateReceipt.pid));
    expect(status.raw).not.toContain(privateControl.controlSecret);

    const replay = await cli(startArgs);
    expect(replay.parsed).toMatchObject({ state: "active", envelope: started.parsed.envelope });

    const stopped = await cli(["stop", "--run-root", value.root, "--packet-id", value.packetId,
      "--task-lifecycle-state", "terminal"]);
    expect(stopped.parsed).toMatchObject({
      state: "stopped",
      stopReceipt: { everyFileOpened: true, serverClosed: true, servedFiles: [{ relativePath: "artifact.json" }] },
    });
    expect(stopped.parsed.stopReceipt.servedFiles[0].getCount).toBeGreaterThanOrEqual(1);
    childPids.delete(privateReceipt.pid);
    const replayedStop = await cli(["stop", "--run-root", value.root, "--packet-id", value.packetId,
      "--task-lifecycle-state", "terminal"]);
    expect(replayedStop.parsed).toEqual(stopped.parsed);
    const finalStatus = await cli(["status", "--run-root", value.root, "--packet-id", value.packetId]);
    expect(finalStatus.parsed).toEqual(stopped.parsed);
  }, 35_000);

  it("restarts a readiness-complete packet generation when the exact pre-task start action is replayed", async () => {
    const value = await fixture();
    const startArgs = ["start", "--run-root", value.root, "--packet-id", value.packetId,
      "--input", value.inputPath, "--runtime-bundle", value.runtimePath];
    const firstStart = await cli(startArgs);
    const firstProcess = await privateProcess(value.root, value.packetId);
    process.kill(firstProcess.pid, "SIGKILL");
    childPids.delete(firstProcess.pid);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const first = await cli(["status", "--run-root", value.root, "--packet-id", value.packetId,
      "--request-id", "after-crash"]);
    expect(first.parsed).toMatchObject({
      state: "crashed",
      reconciliationReceipt: {
        reason: "daemon-process-not-running-without-stop-receipt",
        safeToRestartSamePacketId: true,
      },
    });
    const second = await cli(["status", "--run-root", value.root, "--packet-id", value.packetId]);
    expect(second.parsed).toEqual(first.parsed);

    // Replaying the same coordinator start action archives the dead generation
    // and returns one fresh surface. The sidecar never releases a Codex task.
    const restarted = await cli(startArgs);
    const secondProcess = await privateProcess(value.root, value.packetId);
    expect(restarted.parsed).toMatchObject({ state: "active", packetId: value.packetId });
    expect(restarted.parsed.envelope.artifactPacket.origin).not.toBe(firstStart.parsed.envelope.artifactPacket.origin);
    expect(secondProcess.pid).not.toBe(firstProcess.pid);
    const restartReceipt = JSON.parse(await readFile(path.join(
      value.root, "artifact-packet-sidecars", value.packetId, "restart-history",
      "generation-0001", "restart-generation-receipt.json",
    ), "utf8"));
    expect(restartReceipt).toMatchObject({
      packetId: value.packetId,
      generation: 1,
      reviewerTaskReleasedBySidecar: false,
      archivedEntries: expect.arrayContaining([
        "crash-reconciliation-receipt.json", "packet-readiness-receipt.json", "public-task-surface.json",
      ]),
    });

    const changedInputPath = path.join(value.root, "changed-input.json");
    await writeFile(changedInputPath, JSON.stringify({
      schemaVersion: "exp-0001a-artifact-packet-sidecar-start-input/v1",
      role: "primary_reviewer",
      subject: { kind: "primary-review-success-subject", subjectDigest: SUBJECT_DIGEST, frozen: "changed" },
      evidence: { authorPlan: { fixtureBinding: "exact-plan" }, authorLifecycle: { fixtureBinding: "exact-lifecycle" } },
    }), { mode: 0o600 });
    await expect(cli(["start", "--run-root", value.root, "--packet-id", value.packetId,
      "--input", changedInputPath, "--runtime-bundle", value.runtimePath])).rejects.toThrow(/START_REPLAY_INPUT_DRIFT/);

    const stopped = await cli(["stop", "--run-root", value.root, "--packet-id", value.packetId,
      "--task-lifecycle-state", "terminal"]);
    expect(stopped.parsed).toMatchObject({ state: "stopped", stopReceipt: { everyFileOpened: true } });
    childPids.delete(secondProcess.pid);
  }, 35_000);

  it("terminalizes a dead post-review packet from retained bindings without rerunning reviewer work", async () => {
    const value = await fixture();
    const startArgs = ["start", "--run-root", value.root, "--packet-id", value.packetId,
      "--input", value.inputPath, "--runtime-bundle", value.runtimePath];
    const started = await cli(startArgs);
    const privateReceipt = await privateProcess(value.root, value.packetId);

    // This kill models the boundary after the coordinator has retained the
    // reviewer's terminal task evidence but before a server stop receipt lands.
    process.kill(privateReceipt.pid, "SIGKILL");
    childPids.delete(privateReceipt.pid);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const recovered = await cli(["stop", "--run-root", value.root, "--packet-id", value.packetId,
      "--task-lifecycle-state", "terminal"]);
    expect(recovered.parsed).toMatchObject({
      state: "recovered_after_crash",
      packetId: value.packetId,
      recoveryReceipt: {
        kind: "artifact-packet-sidecar-terminal-crash-recovery",
        taskLifecycleState: "terminal",
        reason: "task-lifecycle-terminal-before-sidecar-stop-receipt",
        startReceiptDigest: started.parsed.startReceipt.receiptDigest,
        readyReceiptDigest: started.parsed.readyReceipt.receiptDigest,
        reviewerEnvelopeDigest: started.parsed.startReceipt.reviewerEnvelopeDigest,
        subjectDigest: SUBJECT_DIGEST,
        serverProcessState: "confirmed_not_running",
        packetAccessEvidence: "readiness_receipt_retained_runtime_counters_unavailable_after_crash",
        reviewerEvidenceDisposition: "preserved_by_terminal_coordinator_task_lifecycle",
      },
    });
    const replayed = await cli(["stop", "--run-root", value.root, "--packet-id", value.packetId,
      "--task-lifecycle-state", "terminal"]);
    expect(replayed.parsed).toEqual(recovered.parsed);
    const finalStatus = await cli(["status", "--run-root", value.root, "--packet-id", value.packetId]);
    expect(finalStatus.parsed).toEqual(recovered.parsed);
    await expect(cli(startArgs)).rejects.toThrow(/NOT_RESTARTABLE:recovered_after_crash/);
  }, 35_000);

  it("records exact unstarted reviewer-create provenance and rejects recovery-state replay drift", async () => {
    const cases = [
      {
        taskLifecycleState: "not_started_usage_limited",
        reason: "reviewer-create-usage-limited-before-task-begun",
        reviewerEvidenceDisposition: "same_assignment_preserved_unstarted_for_usage_reset_retry",
        conflictingState: "not_started_failed",
      },
      {
        taskLifecycleState: "not_started_failed",
        reason: "reviewer-create-failed-before-task-begun",
        reviewerEvidenceDisposition: "same_assignment_preserved_unstarted_for_create_retry",
        conflictingState: "terminal",
      },
    ] as const;
    for (const item of cases) {
      const value = await fixture();
      const packetId = `${value.packetId}-${item.taskLifecycleState}`;
      const started = await cli(["start", "--run-root", value.root, "--packet-id", packetId,
        "--input", value.inputPath, "--runtime-bundle", value.runtimePath]);
      const privateReceipt = await privateProcess(value.root, packetId);
      process.kill(privateReceipt.pid, "SIGKILL");
      childPids.delete(privateReceipt.pid);
      await new Promise((resolve) => setTimeout(resolve, 100));

      const recovered = await cli(["stop", "--run-root", value.root, "--packet-id", packetId,
        "--task-lifecycle-state", item.taskLifecycleState]);
      expect(recovered.parsed).toMatchObject({
        state: "recovered_after_crash",
        packetId,
        recoveryReceipt: {
          kind: "artifact-packet-sidecar-unstarted-task-crash-recovery",
          taskLifecycleState: item.taskLifecycleState,
          reason: item.reason,
          reviewerEvidenceDisposition: item.reviewerEvidenceDisposition,
          startReceiptDigest: started.parsed.startReceipt.receiptDigest,
          readyReceiptDigest: started.parsed.readyReceipt.receiptDigest,
        },
      });
      const replayed = await cli(["stop", "--run-root", value.root, "--packet-id", packetId,
        "--task-lifecycle-state", item.taskLifecycleState]);
      expect(replayed.parsed).toEqual(recovered.parsed);
      await expect(cli(["stop", "--run-root", value.root, "--packet-id", packetId,
        "--task-lifecycle-state", item.conflictingState]))
        .rejects.toThrow(/RECOVERY_TASK_LIFECYCLE_STATE_DRIFT/);
    }
  }, 35_000);

  it("rejects origins in the stable subject and every caller path outside the private run root", async () => {
    const value = await fixture();
    await writeFile(value.inputPath, JSON.stringify({
      schemaVersion: "exp-0001a-artifact-packet-sidecar-start-input/v1",
      role: "primary_reviewer",
      subject: { subjectDigest: SUBJECT_DIGEST, origin: "http://127.0.0.1:9999/" },
      evidence: { authorPlan: { fixtureBinding: "exact-plan" }, authorLifecycle: { fixtureBinding: "exact-lifecycle" } },
    }), { mode: 0o600 });
    await expect(cli(["start", "--run-root", value.root, "--packet-id", value.packetId,
      "--input", value.inputPath, "--runtime-bundle", value.runtimePath])).rejects.toThrow(/SUBJECT_MUST_BE_ORIGIN_FREE/);
    await expect(cli(["start", "--run-root", value.root, "--packet-id", "outside-path",
      "--input", path.join(path.dirname(value.root), "not-inside.json"), "--runtime-bundle", value.runtimePath]))
      .rejects.toThrow(/INPUT_PATH_OUTSIDE_RUN_ROOT|ENOENT/);
  });

  it("routes each origin-free review role through its exact retained evidence shape", async () => {
    const value = await fixture();
    const cases = [
      {
        role: "adjudicator",
        packetId: "adjudicator-review-001",
        subjectKind: "adjudication-review-subject",
        evidence: { primarySubject: { retained: true }, primaryReviews: { retained: true } },
      },
      {
        role: "pairwise_visual_judge",
        packetId: "pairwise-review-001",
        subjectKind: "pairwise-review-success-subject",
        evidence: { sides: [{ authorPlan: { retained: "left" }, authorLifecycle: { retained: "left" } },
          { authorPlan: { retained: "right" }, authorLifecycle: { retained: "right" } }] },
      },
    ] as const;
    for (const [index, item] of cases.entries()) {
      const inputPath = path.join(value.root, `role-input-${index}.json`);
      await writeFile(inputPath, JSON.stringify({
        schemaVersion: "exp-0001a-artifact-packet-sidecar-start-input/v1",
        role: item.role,
        subject: { kind: item.subjectKind, subjectDigest: SUBJECT_DIGEST, frozen: "origin-free" },
        evidence: item.evidence,
      }), { mode: 0o600 });
      const started = await cli(["start", "--run-root", value.root, "--packet-id", item.packetId,
        "--input", inputPath, "--runtime-bundle", value.runtimePath]);
      const privateReceipt = await privateProcess(value.root, item.packetId);
      expect(started.parsed).toMatchObject({ state: "active", role: item.role });
      const stopped = await cli(["stop", "--run-root", value.root, "--packet-id", item.packetId,
        "--task-lifecycle-state", "terminal"]);
      expect(stopped.parsed).toMatchObject({ state: "stopped", stopReceipt: { everyFileOpened: true } });
      childPids.delete(privateReceipt.pid);
    }
  }, 35_000);
});
