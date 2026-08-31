import { describe, expect, it } from "vitest";

import manifestJson from "../../../research/data/development-execution-manifest-v1.json";
import freezeV1Json from "../../../research/data/exp-0001a-prebrief-freeze-v1.json";
import freezeV2Json from "../../../research/data/exp-0001a-codex-prebrief-freeze-v2.json";
import spikeGateV2Json from "../../../research/data/exp0001a-codex-webmcp-spike-gate-public-v2.json";
import {
  EXP0001A_CODEX_FROZEN_ROLE_SETTINGS,
} from "./exp0001a-codex-accounting";
import {
  computeExp0001aCodexPrebriefFreezeDigest,
  verifyExp0001aCodexPrebriefFreeze,
} from "./exp0001a-codex-prebrief-freeze";

describe("EXP-0001A Codex-native superseding prebrief freeze", () => {
  it("preserves the exact scientific/product commitments while superseding only transport and accounting", () => {
    const freeze = verifyExp0001aCodexPrebriefFreeze(freezeV2Json);
    expect(freeze.supersedes.freezeDigest).toBe(freezeV1Json.freezeDigest);
    expect(freeze.schedule).toMatchObject({
      manifestDigest: manifestJson.manifestDigest,
      benchmarkBundleDigest: manifestJson.benchmark.bundleDigest,
      taskCount: 12,
      pairCount: 24,
      attemptCount: 48,
      rerunsPermitted: false,
    });
    expect(freeze.schedule.taskCommitments).toEqual(manifestJson.tasks.map((task) => ({
      taskId: task.taskId,
      taskDigest: task.taskDigest,
    })));
    expect(freeze.sources.rubrics.digest).toBe("sha256:d29deb48689514f3b4e1bd98dcb5de309701b1ec2c479f273bff004856d98554");
    expect(freeze.conditions.A0).toEqual(freeze.conditions.A1);
    expect(freeze.roleSettings).toEqual(EXP0001A_CODEX_FROZEN_ROLE_SETTINGS);
    expect(freeze.passedSpikeGate).toMatchObject({
      spikeEvidenceDigest: spikeGateV2Json.evidenceDigest,
      gateDigest: spikeGateV2Json.gateDigest,
      authoritySignaturePayloadDigest: spikeGateV2Json.authoritySignature.payloadDigest,
      authoritySignatureBase64: spikeGateV2Json.authoritySignature.signatureBase64,
      decision: "allow",
    });
  });

  it("has a valid immutable digest and no active provider-billing contract", () => {
    const freeze = verifyExp0001aCodexPrebriefFreeze(freezeV2Json);
    const { freezeDigest: _digest, ...content } = freeze;
    void _digest;
    expect(computeExp0001aCodexPrebriefFreezeDigest(content)).toBe(freeze.freezeDigest);
    expect(JSON.stringify(freeze)).not.toMatch(
      /OPENAI_API_KEY|api\.openai\.com|responses api|serviceTier|tokenBudget|pricing|costUsd|spendAuthorization|maximumUsd/i,
    );

    expect(() => verifyExp0001aCodexPrebriefFreeze({
      ...freeze,
      schedule: { ...freeze.schedule, attemptCount: 47 },
    })).toThrow();
    expect(() => verifyExp0001aCodexPrebriefFreeze({
      ...freeze,
      freezeDigest: `sha256:${"0".repeat(64)}`,
    })).toThrow(/DIGEST_INVALID/);
  });
});
