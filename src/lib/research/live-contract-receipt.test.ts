// @vitest-environment node

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import baselineFreeze from "../../../research/data/baseline-freeze-v1.json";
import liveContractReceipt from "../../../research/data/baseline-live-contract-v1.json";
import baselineInventory from "../../../research/data/baseline-webmcp-inventory-v1.json";

import {
  BASELINE_SPECTATOR_TOOL_NAMES,
  EXPECTED_BASELINE_LIVE_CONTRACT,
  baselineLiveContractReceiptSchema,
  findLiveContractSensitiveFields,
  verifyBaselineLiveContractReceipt,
} from "./live-contract-receipt";

const runnerBytes = readFileSync("research/scripts/clean-room-live-runner.mjs");
const receiptBytes = readFileSync("research/data/baseline-live-contract-v1.json");

function receiptClone() {
  return structuredClone(liveContractReceipt);
}

function verificationWithBytes(receipt: unknown = liveContractReceipt) {
  return verifyBaselineLiveContractReceipt(receipt, baselineFreeze, baselineInventory, {
    receiptFileBytes: receiptBytes,
  });
}

describe("checked-in baseline live-contract receipt", () => {
  it("verifies the frozen production contract and its immutable receipt bytes", () => {
    const verification = verificationWithBytes();
    expect(verification).toMatchObject({
      ok: true,
      verifiedFileByteDigests: {
        runnerScript: null,
        receiptFile: EXPECTED_BASELINE_LIVE_CONTRACT.receiptFileArtifactDigest,
      },
    });
  });

  it("keeps normalized live-contract hashes distinct from serialized artifact hashes", () => {
    const verification = verificationWithBytes();
    expect(verification.ok).toBe(true);
    if (!verification.ok) throw new Error(verification.errors.join(" "));
    expect(verification.liveContractDigests).toEqual({
      participant: liveContractReceipt.participant.contractDigest,
      spectator: liveContractReceipt.spectator.contractDigest,
    });
    expect(verification.declaredArtifactDigests).toEqual({
      runnerScriptFile: liveContractReceipt.runner.scriptDigest,
      attemptBundleFile: liveContractReceipt.runner.attemptBundleDigest,
      participantContractFile: liveContractReceipt.participant.contractArtifactDigest,
      spectatorContractFile: liveContractReceipt.spectator.contractArtifactDigest,
      artifactSetRoot: liveContractReceipt.runner.artifactRoot,
    });
    expect(Object.values(verification.liveContractDigests)).not.toContain(
      verification.verifiedFileByteDigests.receiptFile,
    );
    expect(liveContractReceipt.participant.contractDigest).not.toBe(
      liveContractReceipt.participant.contractArtifactDigest,
    );
    expect(liveContractReceipt.spectator.contractDigest).not.toBe(
      liveContractReceipt.spectator.contractArtifactDigest,
    );
  });

  it("does not claim byte verification when artifacts are not explicitly supplied", () => {
    expect(verifyBaselineLiveContractReceipt(
      liveContractReceipt,
      baselineFreeze,
      baselineInventory,
    )).toMatchObject({
      ok: true,
      verifiedFileByteDigests: { runnerScript: null, receiptFile: null },
    });
  });

  it("agrees with the full frozen commit, tree, deployment, build, and URL identity", () => {
    const mutations: Array<[string, (receipt: ReturnType<typeof receiptClone>) => void]> = [
      ["Git commit", (receipt) => { receipt.baseline.gitCommit = "0".repeat(40); }],
      ["Git tree", (receipt) => { receipt.baseline.gitTree = "1".repeat(40); }],
      ["deployment ID", (receipt) => { receipt.baseline.deploymentId = "dpl_Drifted"; }],
      ["build ID", (receipt) => { receipt.baseline.buildId = "bld_Drifted"; }],
      ["immutable deployment URL", (receipt) => { receipt.baseline.immutableDeploymentUrl = "https://drifted.example"; }],
      ["public execution alias", (receipt) => { receipt.baseline.executionUrl = "https://drifted.example"; }],
      ["public alias verified deployment ID", (receipt) => {
        receipt.baseline.executionUrlVerifiedDeploymentId = "dpl_Drifted";
      }],
    ];
    for (const [expectedError, mutate] of mutations) {
      const receipt = receiptClone();
      mutate(receipt);
      expect(verifyBaselineLiveContractReceipt(receipt, baselineFreeze, baselineInventory)).toMatchObject({
        ok: false,
        errors: expect.arrayContaining([expect.stringContaining(expectedError)]),
      });
    }
  });

  it("requires participant count agreement with the frozen inventory", () => {
    const tampered = receiptClone();
    tampered.participant.toolCount += 1;
    expect(verifyBaselineLiveContractReceipt(tampered, baselineFreeze, baselineInventory)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringMatching(/participant tool count/)]),
    });
  });

  it("requires the exact 18-name sorted spectator read/export allowlist", () => {
    expect(liveContractReceipt.spectator.toolNames).toEqual(BASELINE_SPECTATOR_TOOL_NAMES);
    expect(liveContractReceipt.spectator.toolCount).toBe(18);
    const participantNames = new Set(baselineInventory.participant.tools.map((tool) => tool.name));
    expect(BASELINE_SPECTATOR_TOOL_NAMES.every((name) => participantNames.has(name))).toBe(true);

    const mutation = receiptClone();
    mutation.spectator.toolNames[0] = "create_shape";
    expect(verifyBaselineLiveContractReceipt(mutation, baselineFreeze, baselineInventory)).toMatchObject({ ok: false });

    const reordered = receiptClone();
    [reordered.spectator.toolNames[0], reordered.spectator.toolNames[1]] = [
      reordered.spectator.toolNames[1]!,
      reordered.spectator.toolNames[0]!,
    ];
    expect(baselineLiveContractReceiptSchema.safeParse(reordered).success).toBe(false);
  });

  it("rejects valid-looking live contract and artifact digest tampering", () => {
    const participantTamper = receiptClone();
    participantTamper.participant.contractDigest = `sha256:${"a".repeat(64)}`;
    expect(verifyBaselineLiveContractReceipt(participantTamper, baselineFreeze, baselineInventory)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringMatching(/participant normalized contract digest/)]),
    });

    const artifactTamper = receiptClone();
    artifactTamper.spectator.contractArtifactDigest = `sha256:${"b".repeat(64)}`;
    expect(verifyBaselineLiveContractReceipt(artifactTamper, baselineFreeze, baselineInventory)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringMatching(/spectator contract artifact digest/)]),
    });

    const malformed = receiptClone();
    malformed.runner.artifactRoot = "sha256:not-a-digest";
    expect(baselineLiveContractReceiptSchema.safeParse(malformed).success).toBe(false);
  });

  it("enforces public-alias execution, protected immutable fallback, and its disclosure", () => {
    const swapped = receiptClone();
    [swapped.baseline.executionUrl, swapped.baseline.immutableDeploymentUrl] = [
      swapped.baseline.immutableDeploymentUrl,
      swapped.baseline.executionUrl,
    ];
    expect(verifyBaselineLiveContractReceipt(swapped, baselineFreeze, baselineInventory)).toMatchObject({ ok: false });

    const noFallback = receiptClone();
    noFallback.baseline.immutableUrlAccess = "public";
    expect(baselineLiveContractReceiptSchema.safeParse(noFallback).success).toBe(false);

    const noDisclosure = receiptClone();
    noDisclosure.limitations[0] = "Immutable URL was used directly.";
    expect(baselineLiveContractReceiptSchema.safeParse(noDisclosure).success).toBe(false);
  });

  it("requires contract_verified contract mode, privacy, no Responses API, and context separation", () => {
    const mutations: Array<(receipt: ReturnType<typeof receiptClone>) => void> = [
      (receipt) => { receipt.runner.mode = "live"; },
      (receipt) => { receipt.runner.status = "runner_completed"; },
      (receipt) => { receipt.runner.responsesApiInvoked = true; },
      (receipt) => { receipt.privacy.responsesApiInvoked = true; },
      (receipt) => { receipt.privacy.roomIdentifiersPersisted = true; },
      (receipt) => { receipt.privacy.sessionCredentialsPersisted = true; },
      (receipt) => { receipt.privacy.apiCredentialsPersisted = true; },
      (receipt) => { receipt.runner.authorContextClosedBeforeEvaluation = false; },
    ];
    for (const mutate of mutations) {
      const receipt = receiptClone();
      mutate(receipt);
      expect(baselineLiveContractReceiptSchema.safeParse(receipt).success).toBe(false);
    }
  });

  it("pins the clean Chromium browser, viewport, and runner environment", () => {
    const browserDrift = receiptClone();
    browserDrift.runner.browser.version = "152.0.0.0";
    expect(verifyBaselineLiveContractReceipt(browserDrift, baselineFreeze, baselineInventory)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringMatching(/browser version/)]),
    });

    const viewportDrift = receiptClone();
    viewportDrift.runner.viewport.width = 1_024;
    expect(baselineLiveContractReceiptSchema.safeParse(viewportDrift).success).toBe(false);
  });

  it("detects runner and receipt byte tampering independently", () => {
    const tamperedRunner = Buffer.concat([runnerBytes, Buffer.from("\n// tampered")]);
    expect(verifyBaselineLiveContractReceipt(
      liveContractReceipt,
      baselineFreeze,
      baselineInventory,
      { runnerScriptBytes: tamperedRunner },
    )).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringMatching(/Runner script artifact bytes/)]),
    });

    const semanticallyEquivalentReceipt = Buffer.concat([receiptBytes, Buffer.from("\n")]);
    expect(verifyBaselineLiveContractReceipt(
      liveContractReceipt,
      baselineFreeze,
      baselineInventory,
      { receiptFileBytes: semanticallyEquivalentReceipt },
    )).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringMatching(/Receipt file artifact bytes/)]),
    });

    const differentReceipt = Buffer.from(JSON.stringify({ ...liveContractReceipt, capturedAt: "2026-08-30T00:00:00.000Z" }));
    expect(verifyBaselineLiveContractReceipt(
      liveContractReceipt,
      baselineFreeze,
      baselineInventory,
      { receiptFileBytes: differentReceipt },
    )).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringMatching(/do not encode the supplied receipt value/)]),
    });
  });

  it("uses a strict schema and rejects secrets and raw room identifiers", () => {
    expect(baselineLiveContractReceiptSchema.safeParse({ ...liveContractReceipt, unexpected: true }).success).toBe(false);
    expect(findLiveContractSensitiveFields(liveContractReceipt)).toEqual([]);

    const rawRoom = receiptClone();
    rawRoom.limitations[1] = "room_41130bc6-0bf5-842d";
    expect(findLiveContractSensitiveFields(rawRoom)).toContain("/limitations/1:raw-room-id");
    expect(verifyBaselineLiveContractReceipt(rawRoom, baselineFreeze, baselineInventory)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringMatching(/Sensitive material/)]),
    });

    const secretKey = { ...liveContractReceipt, sessionToken: "do-not-publish" };
    expect(findLiveContractSensitiveFields(secretKey)).toContain("/sessionToken:secret-key");
    expect(verifyBaselineLiveContractReceipt(secretKey, baselineFreeze, baselineInventory)).toMatchObject({ ok: false });

    const knownSecret = receiptClone();
    knownSecret.limitations[1] = "private-value";
    expect(findLiveContractSensitiveFields(knownSecret, ["private-value"]))
      .toContain("/limitations/1:known-secret");
  });
});
