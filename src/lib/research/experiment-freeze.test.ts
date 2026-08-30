// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  FROZEN_BASELINE_RECEIPT_IDENTITY,
  computeEnvironmentFreezeDigest,
  computeExperimentFreezeDigest,
  computeModelFreezeDigest,
  computeTreatmentDigest,
  createExperimentFreezeReceipt,
  verifyExperimentFreezeReceipt,
  type ConditionFreeze,
  type EnvironmentFreeze,
  type ExperimentFreezeContent,
  type ExperimentFreezeReceipt,
  type ModelFreeze,
} from "./experiment-freeze";
import { sha256Digest } from "./provenance-crypto";

const digest = (label: string) => sha256Digest(label);

function model(): ModelFreeze {
  const value: ModelFreeze = {
    provider: "openai",
    snapshot: "gpt-frozen-snapshot",
    reasoningEffort: "high",
    sampling: { temperature: null, topP: null, seed: null },
    configurationDigest: digest("pending"),
  };
  value.configurationDigest = computeModelFreezeDigest(value);
  return value;
}

function environment(): EnvironmentFreeze {
  const value: EnvironmentFreeze = {
    browser: { name: "Chromium", version: "140.0.0", buildDigest: digest("browser") },
    host: { name: "Codex", version: "1.0", capabilityDigest: digest("host") },
    viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
    runtime: { nodeVersion: "24.x", operatingSystem: "linux", imageDigest: digest("image") },
    locale: "en-US",
    timezone: "UTC",
    configurationDigest: digest("pending"),
  };
  value.configurationDigest = computeEnvironmentFreezeDigest(value);
  return value;
}

function condition(label: string, overrides: Partial<ConditionFreeze> = {}): ConditionFreeze {
  const value: ConditionFreeze = {
    opaqueLabel: label,
    baselineReceiptDigest: FROZEN_BASELINE_RECEIPT_IDENTITY.receiptDigest,
    buildDigest: FROZEN_BASELINE_RECEIPT_IDENTITY.buildIdentityDigest,
    harnessDigest: digest("harness-v1"),
    systemInstructionsDigest: digest("system-v1"),
    toolConfigurationDigest: digest("tools-v1"),
    treatmentDigest: digest("pending"),
    ...overrides,
  };
  value.treatmentDigest = computeTreatmentDigest(value);
  return value;
}

function aaContent(): ExperimentFreezeContent {
  return {
    schemaVersion: 1,
    freezeId: "exp-0001a-freeze-v1",
    studyKind: "aa_calibration",
    partition: "development",
    frozenAt: "2026-08-30T20:30:00.000Z",
    executionStateAtFreeze: "not_started",
    baselineReceipt: { ...FROZEN_BASELINE_RECEIPT_IDENTITY },
    commitments: {
      protocol: { id: "exp-0001a", digest: digest("protocol") },
      taskManifest: { id: "development-v1", digest: digest("tasks") },
      randomizationSchedule: { id: "aa-schedule-v1", digest: digest("schedule") },
      runner: { id: "clean-room-runner-v1", digest: digest("runner") },
      scorerConfiguration: { id: "scorer-config-v1", digest: digest("scorer") },
      evaluatorInstructions: { id: "evaluator-instructions-v1", digest: digest("evaluator") },
      artifactSchemas: [
        { id: "attempt-schema-v1", digest: digest("attempt-schema") },
        { id: "trace-schema-v1", digest: digest("trace-schema") },
      ],
      toolInventory: { id: "baseline-webmcp-inventory-v1", digest: digest("inventory") },
    },
    model: model(),
    environment: environment(),
    budgets: {
      wallTimeMs: 600_000,
      maxInputTokens: 100_000,
      maxOutputTokens: 20_000,
      maxToolCalls: 200,
      maxCorrectionRounds: 3,
    },
    conditions: {
      first: condition("A0"),
      second: condition("A1"),
    },
    sensitiveMaterialRedacted: true,
  };
}

function aaReceipt(): ExperimentFreezeReceipt {
  return createExperimentFreezeReceipt(aaContent());
}

function rehash(receipt: ExperimentFreezeReceipt): void {
  receipt.freezeDigest = computeExperimentFreezeDigest(receipt);
}

describe("immutable experiment execution freeze", () => {
  it("accepts a complete A/A freeze before brief delivery", () => {
    expect(verifyExperimentFreezeReceipt(aaReceipt(), {
      firstBriefDeliveredAt: "2026-08-30T20:31:00.000Z",
    })).toMatchObject({ ok: true });
  });

  it("detects canonical receipt and prerequisite tampering", () => {
    const receipt = aaReceipt();
    receipt.commitments.runner.digest = digest("tampered-runner");

    expect(verifyExperimentFreezeReceipt(receipt)).toMatchObject({
      ok: false,
      falsified: true,
      errors: expect.arrayContaining([expect.stringMatching(/Canonical freeze digest/)]),
    });
  });

  it("falsifies an A/A configuration mismatch even after all affected hashes are recomputed", () => {
    const receipt = aaReceipt();
    receipt.conditions.second.harnessDigest = digest("different-harness");
    receipt.conditions.second.treatmentDigest = computeTreatmentDigest(receipt.conditions.second);
    rehash(receipt);

    expect(verifyExperimentFreezeReceipt(receipt)).toMatchObject({
      ok: false,
      falsified: true,
      errors: expect.arrayContaining([expect.stringMatching(/not byte-identical/)]),
    });
  });

  it("rejects unknown fields under strict schemas", () => {
    const receipt = { ...aaReceipt(), roomHint: "not-allowed" };

    expect(verifyExperimentFreezeReceipt(receipt)).toMatchObject({
      ok: false,
      falsified: true,
      errors: expect.arrayContaining([expect.stringMatching(/Unrecognized key/)]),
    });
  });

  it("falsifies a freeze made at or after first brief delivery", () => {
    expect(verifyExperimentFreezeReceipt(aaReceipt(), {
      firstBriefDeliveredAt: "2026-08-30T20:29:59.000Z",
    })).toMatchObject({
      ok: false,
      falsified: true,
      errors: expect.arrayContaining([expect.stringMatching(/before first brief/)]),
    });
  });

  it("rejects every non-development partition and sealed task identity", () => {
    const receipt = aaReceipt();
    receipt.partition = "sealed-test-A";
    receipt.commitments.taskManifest.id = "sealed-test-A-v1";
    rehash(receipt);

    expect(verifyExperimentFreezeReceipt(receipt)).toMatchObject({
      ok: false,
      falsified: true,
      errors: expect.arrayContaining([
        expect.stringMatching(/only the development partition/),
        expect.stringMatching(/sealed or replication partition/),
      ]),
    });
  });

  it("accepts a real A/B distinction anchored to the same baseline receipt", () => {
    const content = aaContent();
    content.studyKind = "ab_pilot";
    content.freezeId = "exp-0001-ab-freeze-v1";
    content.conditions.second = condition("B1", {
      buildDigest: digest("candidate-build"),
      harnessDigest: digest("candidate-harness"),
      systemInstructionsDigest: digest("candidate-system"),
      toolConfigurationDigest: digest("candidate-tools"),
    });
    content.conditions.second.treatmentDigest = computeTreatmentDigest(content.conditions.second);

    expect(verifyExperimentFreezeReceipt(createExperimentFreezeReceipt(content))).toMatchObject({ ok: true });
  });

  it("rejects sensitive fields and raw room identifiers", () => {
    const withSecret = { ...aaReceipt(), sessionToken: "secret-value" };
    expect(verifyExperimentFreezeReceipt(withSecret, { knownSecrets: ["secret-value"] })).toMatchObject({ ok: false });

    const receipt = aaReceipt();
    receipt.conditions.first.opaqueLabel = "room_41130bc6-0bf5-842d";
    receipt.conditions.first.treatmentDigest = computeTreatmentDigest(receipt.conditions.first);
    rehash(receipt);
    expect(verifyExperimentFreezeReceipt(receipt)).toMatchObject({
      ok: false,
      falsified: true,
      errors: expect.arrayContaining([expect.stringMatching(/raw-room-id/)]),
    });
  });
});
