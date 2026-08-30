import { describe, expect, it } from "vitest";

import type { ArtifactEntry, AttemptRegistry, RunSpec, ScoreRun } from "./attempt-schemas";
import {
  allocateAttempt,
  appendScoreRun,
  createArtifactIndex,
  createAttemptRegistry,
  createPublicAttemptManifest,
  sealAttempt,
  transitionAttempt,
} from "./attempt-ledger";
import { canonicalJson, hashCanonicalJson, sha256Digest } from "./provenance-crypto";
import { assertNoSecretLeakage, findSecretLeakage, redactResearchSecrets } from "./provenance-redaction";
import {
  verifyArtifactIndex,
  verifyArtifactPayload,
  verifyAttemptRecord,
  verifyAttemptRegistry,
  verifyEventChain,
  verifyPublicAttemptManifest,
  verifyPublicManifestAgainstAttempt,
} from "./provenance-verification";

const AT = [
  "2026-08-30T20:00:00.000Z",
  "2026-08-30T20:00:01.000Z",
  "2026-08-30T20:00:02.000Z",
  "2026-08-30T20:00:03.000Z",
  "2026-08-30T20:00:04.000Z",
  "2026-08-30T20:00:05.000Z",
];

const digest = (value: string) => sha256Digest(value);

function runSpec(): RunSpec {
  return {
    schemaVersion: 1,
    runId: "run-001",
    protocol: { id: "protocol-001", digest: digest("protocol") },
    conditions: {
      baseline: {
        gitCommit: "a".repeat(40),
        buildDigest: digest("baseline-build"),
        deploymentUrl: "https://baseline.example.test",
      },
      candidate: {
        gitCommit: "b".repeat(40),
        buildDigest: digest("candidate-build"),
        deploymentUrl: "https://candidate.example.test",
      },
    },
    runner: { runnerDigest: digest("runner") },
    taskSet: { id: "visual-authoring", version: "v1", split: "development", commitment: digest("task-set") },
    model: { provider: "openai", snapshot: "model-snapshot", reasoningEffort: "high", temperature: null, seed: null },
    environment: {
      imageDigest: digest("environment"),
      browser: "Chromium 140",
      viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
      locale: "en-US",
      timezone: "UTC",
    },
    budgets: { wallTimeMs: 600_000, maxToolCalls: 200, maxInputTokens: 100_000, maxOutputTokens: 20_000 },
    createdAt: AT[0],
  };
}

const assignment = {
  pairId: "pair-task-001-r1",
  condition: "baseline" as const,
  replicateIndex: 0,
  orderIndex: 0 as const,
  timeBlock: 0,
};

function entries(label = "attempt"): ArtifactEntry[] {
  return [
    { path: "author/events.jsonl", category: "trace", mimeType: "application/jsonl", bytes: 21, sha256: digest(`${label}:events`) },
    { path: "author/final.png", category: "image", mimeType: "image/png", bytes: 50, sha256: digest(`${label}:image`) },
  ];
}

function advance(registry: AttemptRegistry, attemptId: string, outcome: "author_completed" | "author_failed" | "timeout" | "policy_violation" = "author_completed") {
  let next = transitionAttempt(registry, attemptId, "provisioned", AT[1]);
  next = transitionAttempt(next, attemptId, "started", AT[2]);
  return transitionAttempt(next, attemptId, outcome, AT[3]);
}

function sealedAttempt(outcome: "author_completed" | "author_failed" | "timeout" | "policy_violation" = "author_completed") {
  let registry = createAttemptRegistry(runSpec());
  registry = allocateAttempt(registry, { attemptId: "attempt-001", taskId: "task-001", taskCommitment: digest("task-001"), ...assignment, at: AT[0] });
  registry = advance(registry, "attempt-001", outcome);
  return sealAttempt(registry, "attempt-001", AT[4], createArtifactIndex("attempt-001", entries()));
}

function scoreRun(id: string, status: "succeeded" | "failed"): ScoreRun {
  return {
    scoreRunId: id,
    scorerId: "visual-scorer",
    scorerVersion: "v1",
    configurationDigest: digest("score-config"),
    startedAt: AT[4],
    completedAt: AT[5],
    status,
    resultArtifactDigest: status === "succeeded" ? digest(`score:${id}`) : null,
    errorCode: status === "failed" ? "JUDGE_UNAVAILABLE" : null,
  };
}

describe("canonical provenance hashing", () => {
  it("is independent of object insertion order and rejects non-JSON values", () => {
    expect(canonicalJson({ z: 1, a: { y: 2, x: 3 } })).toBe('{"a":{"x":3,"y":2},"z":1}');
    expect(hashCanonicalJson({ a: 1, b: [2, 3] })).toBe(hashCanonicalJson({ b: [2, 3], a: 1 }));
    expect(() => canonicalJson({ bad: undefined })).toThrow(/Non-JSON/);
    expect(() => canonicalJson({ bad: Number.NaN })).toThrow(/Non-finite/);
  });

  it("detects artifact tampering even if an entry still has a valid-looking digest", () => {
    const index = createArtifactIndex("attempt-001", entries());
    expect(verifyArtifactIndex(index)).toEqual({ ok: true });
    const tampered = structuredClone(index);
    tampered.entries[0].sha256 = digest("replacement");
    expect(verifyArtifactIndex(tampered)).toMatchObject({ ok: false });
  });

  it("verifies artifact bytes as well as the index root", () => {
    const payload = "immutable trace";
    const index = createArtifactIndex("attempt-001", [{
      path: "author/trace.txt",
      category: "trace",
      mimeType: "text/plain",
      bytes: Buffer.byteLength(payload),
      sha256: digest(payload),
    }]);
    expect(verifyArtifactPayload(index, "author/trace.txt", payload)).toEqual({ ok: true });
    expect(verifyArtifactPayload(index, "author/trace.txt", `${payload}!`)).toMatchObject({ ok: false });
  });
});

describe("attempt lifecycle and append-only retention", () => {
  it("enforces valid transitions and never permits attempt ID reuse", () => {
    let registry = createAttemptRegistry(runSpec());
    registry = allocateAttempt(registry, { attemptId: "attempt-001", taskId: "task-001", taskCommitment: digest("task"), ...assignment, at: AT[0] });
    expect(() => transitionAttempt(registry, "attempt-001", "author_completed", AT[1])).toThrow(/Invalid attempt transition/);
    expect(() => allocateAttempt(registry, { attemptId: "attempt-001", taskId: "task-001", taskCommitment: digest("task"), ...assignment, at: AT[1] })).toThrow(/new attempt ID/);
  });

  it("requires a sealed retained parent and a new ID for every retry", () => {
    let registry = createAttemptRegistry(runSpec());
    registry = allocateAttempt(registry, { attemptId: "attempt-001", taskId: "task-001", taskCommitment: digest("task"), ...assignment, at: AT[0] });
    expect(() => allocateAttempt(registry, { attemptId: "attempt-002", taskId: "task-001", taskCommitment: digest("task"), ...assignment, at: AT[1], parentAttemptId: "attempt-001", retryReason: "infra retry" })).toThrow(/parent attempt is sealed/);

    registry = advance(registry, "attempt-001", "author_failed");
    registry = sealAttempt(registry, "attempt-001", AT[4], createArtifactIndex("attempt-001", entries("first")));
    registry = allocateAttempt(registry, { attemptId: "attempt-002", taskId: "task-001", taskCommitment: digest("task"), ...assignment, at: AT[5], parentAttemptId: "attempt-001", retryReason: "preregistered retry" });
    expect(registry.attempts).toHaveLength(2);
    expect(registry.attempts[0].authorOutcome).toBe("failed");
    expect(registry.attempts[1]).toMatchObject({ parentAttemptId: "attempt-001", retryReason: "preregistered retry" });
  });

  it.each([
    ["author_failed", "failed"],
    ["timeout", "timeout"],
  ] as const)("retains and seals %s attempts", (state, outcome) => {
    const registry = sealedAttempt(state);
    expect(registry.attempts).toHaveLength(1);
    expect(registry.attempts[0]).toMatchObject({ state: "sealed", authorOutcome: outcome });
    expect(registry.attempts[0].events.map((event) => event.to)).toEqual(["allocated", "provisioned", "started", state, "sealed"]);
    expect(verifyAttemptRegistry(registry)).toEqual({ ok: true });
  });
});

describe("hash-chained event verification", () => {
  it("detects modified, missing, and reordered events", () => {
    const attempt = sealedAttempt().attempts[0];
    expect(verifyEventChain(attempt.events, attempt.attemptId)).toEqual({ ok: true });

    const modified = structuredClone(attempt.events);
    modified[2].payload = { injected: true };
    expect(verifyEventChain(modified, attempt.attemptId)).toMatchObject({ ok: false });

    const missing = attempt.events.filter((_, index) => index !== 2);
    expect(verifyEventChain(missing, attempt.attemptId)).toMatchObject({ ok: false });

    const reordered = structuredClone(attempt.events);
    [reordered[1], reordered[2]] = [reordered[2], reordered[1]];
    expect(verifyEventChain(reordered, attempt.attemptId)).toMatchObject({ ok: false });
  });

  it("detects a forged attempt and registry after nested evidence changes", () => {
    const registry = sealedAttempt();
    const tampered = structuredClone(registry);
    tampered.attempts[0].events[2].at = "2026-08-30T23:59:59.000Z";
    expect(verifyAttemptRecord(tampered.attempts[0])).toMatchObject({ ok: false });
    expect(verifyAttemptRegistry(tampered)).toMatchObject({ ok: false });
  });
});

describe("secret-safe public provenance", () => {
  it("removes room and session fields and exact secrets rather than hashing low-entropy room codes", () => {
    const privateRecord = {
      runId: "run-001",
      roomId: "room_41130bc6-0bf5-842d-56d2-84a1d5fb6d2e",
      roomCode: "XZ9HCN",
      nested: { sessionToken: "signed-session", note: "XZ9HCN" },
    };
    const redacted = redactResearchSecrets(privateRecord, ["XZ9HCN", "signed-session"]);
    expect(redacted.value).toEqual({ runId: "run-001", nested: { note: "[REDACTED]" } });
    expect(JSON.stringify(redacted.value)).not.toContain("XZ9HCN");
    expect(JSON.stringify(redacted.value)).not.toContain(digest("XZ9HCN"));
    expect(redacted.redactedPaths).toEqual(expect.arrayContaining(["/roomCode", "/roomId", "/nested/sessionToken", "/nested/note"]));
  });

  it("rejects secret-bearing keys, raw room IDs, and known low-entropy room codes", () => {
    expect(findSecretLeakage({ roomCodeHash: digest("XZ9HCN") })).toContain("/roomCodeHash:secret-key");
    expect(findSecretLeakage({ harmless: "XZ9HCN" })).toContain("/harmless:raw-room-code");
    expect(() => assertNoSecretLeakage({ harmless: "XZ9HCN" }, ["XZ9HCN"])).toThrow(/known-secret/);
    expect(() => assertNoSecretLeakage({ reference: "room_41130bc6-0bf5-842d" })).toThrow(/raw-room-id/);
  });

  it("publishes a strict redacted manifest with no room/session representation", () => {
    const attempt = sealedAttempt().attempts[0];
    const manifest = createPublicAttemptManifest(attempt);
    expect(manifest.sensitiveMaterialRedacted).toBe(true);
    expect(JSON.stringify(manifest)).not.toMatch(/roomCode|roomId|session|cookie|token/i);
    expect(verifyPublicAttemptManifest(manifest, ["XZ9HCN"])).toEqual({ ok: true });
    expect(verifyPublicManifestAgainstAttempt(manifest, attempt, ["XZ9HCN"])).toEqual({ ok: true });
    const forged = structuredClone(manifest);
    forged.evidence.artifactCount += 1;
    expect(verifyPublicManifestAgainstAttempt(forged, attempt)).toMatchObject({ ok: false });
  });
});

describe("scorer separation", () => {
  it("retains failed scorer runs and permits reruns without altering author evidence", () => {
    let registry = sealedAttempt();
    const before = registry.attempts[0];
    const authorRoot = before.authorEvidenceRoot;
    const authorEvents = structuredClone(before.events);
    const artifactRoot = before.artifactIndex?.merkleRoot;

    registry = appendScoreRun(registry, "attempt-001", scoreRun("score-001", "failed"));
    expect(registry.attempts[0]).toMatchObject({ scoringStatus: "scorer_failed" });
    registry = appendScoreRun(registry, "attempt-001", scoreRun("score-002", "succeeded"));
    expect(registry.attempts[0]).toMatchObject({ scoringStatus: "scored" });
    expect(registry.attempts[0].scoreRuns).toHaveLength(2);
    expect(registry.attempts[0].authorEvidenceRoot).toBe(authorRoot);
    expect(registry.attempts[0].events).toEqual(authorEvents);
    expect(registry.attempts[0].artifactIndex?.merkleRoot).toBe(artifactRoot);
    expect(verifyAttemptRegistry(registry)).toEqual({ ok: true });
  });
});
