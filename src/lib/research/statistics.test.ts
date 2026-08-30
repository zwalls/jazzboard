import { describe, expect, it } from "vitest";

import {
  summarizeBlindedPreference,
  summarizePairedBinary,
  summarizePairedPositiveRatio,
} from "./statistics";

describe("paired research statistics", () => {
  it("reports absolute and relative pass-rate lift with paired discordance", () => {
    const result = summarizePairedBinary([
      { pairId: "a1", taskId: "a", taskFamily: "architecture", baselineAccepted: false, candidateAccepted: true },
      { pairId: "a2", taskId: "a", taskFamily: "architecture", baselineAccepted: true, candidateAccepted: true },
      { pairId: "b1", taskId: "b", taskFamily: "drawing", baselineAccepted: false, candidateAccepted: true },
      { pairId: "b2", taskId: "b", taskFamily: "drawing", baselineAccepted: true, candidateAccepted: false },
    ], { bootstrapDraws: 500, seed: 17 });

    expect(result.pairCount).toBe(4);
    expect(result.taskCount).toBe(2);
    expect(result.baselinePassRate).toBe(0.5);
    expect(result.candidatePassRate).toBe(0.75);
    expect(result.absoluteDifference).toBe(0.25);
    expect(result.relativeDifference).toBe(0.5);
    expect(result.candidateOnlySuccessCount).toBe(2);
    expect(result.baselineOnlySuccessCount).toBe(1);
    expect(result.byTaskFamily.architecture.absoluteDifference).toBe(0.5);
    expect(result.byTaskFamily.drawing.absoluteDifference).toBe(0);
    expect(result.absoluteDifferenceConfidenceInterval.method).toBe("task_cluster_percentile_bootstrap");
  });

  it("keeps task clusters intact and is deterministic for a fixed seed", () => {
    const observations = [
      { pairId: "a1", taskId: "a", taskFamily: "architecture", baselineAccepted: false, candidateAccepted: true },
      { pairId: "a2", taskId: "a", taskFamily: "architecture", baselineAccepted: false, candidateAccepted: true },
      { pairId: "b1", taskId: "b", taskFamily: "architecture", baselineAccepted: true, candidateAccepted: false },
      { pairId: "b2", taskId: "b", taskFamily: "architecture", baselineAccepted: true, candidateAccepted: false },
    ];
    const first = summarizePairedBinary(observations, { bootstrapDraws: 500, seed: 99 });
    const second = summarizePairedBinary(observations, { bootstrapDraws: 500, seed: 99 });
    expect(first.absoluteDifferenceConfidenceInterval).toEqual(second.absoluteDifferenceConfidenceInterval);
    expect(first.absoluteDifferenceConfidenceInterval.lower).toBe(-1);
    expect(first.absoluteDifferenceConfidenceInterval.upper).toBe(1);
  });

  it("does not invent a relative lift when the baseline pass rate is zero", () => {
    const result = summarizePairedBinary([
      { pairId: "a", taskId: "a", taskFamily: "drawing", baselineAccepted: false, candidateAccepted: true },
    ], { bootstrapDraws: 100 });
    expect(result.relativeDifference).toBeNull();
  });

  it("rejects duplicate pair IDs instead of inflating the sample size", () => {
    expect(() => summarizePairedBinary([
      { pairId: "same", taskId: "a", taskFamily: "drawing", baselineAccepted: false, candidateAccepted: true },
      { pairId: "same", taskId: "b", taskFamily: "drawing", baselineAccepted: true, candidateAccepted: true },
    ], { bootstrapDraws: 100 })).toThrow("Duplicate paired observation");
  });

  it("summarizes skew-safe paired efficiency ratios", () => {
    const result = summarizePairedPositiveRatio([
      { pairId: "a1", taskId: "a", baselineValue: 100, candidateValue: 80 },
      { pairId: "a2", taskId: "a", baselineValue: 120, candidateValue: 108 },
      { pairId: "b1", taskId: "b", baselineValue: 60, candidateValue: 30 },
    ], { bootstrapDraws: 500, seed: 12 });
    expect(result.medianBaseline).toBe(100);
    expect(result.medianCandidate).toBe(80);
    expect(result.medianPairedRatio).toBe(0.8);
  });

  it("rejects zero or negative ratio denominators", () => {
    expect(() => summarizePairedPositiveRatio([
      { pairId: "a", taskId: "a", baselineValue: 0, candidateValue: 1 },
    ], { bootstrapDraws: 100 })).toThrow("finite and positive");
  });

  it("reports blinded preference as a win rate among non-ties", () => {
    expect(summarizeBlindedPreference(["candidate", "tie", "baseline", "candidate"])).toEqual({
      comparisonCount: 4,
      candidateWinCount: 2,
      baselineWinCount: 1,
      tieCount: 1,
      candidateWinRateAmongNonTies: 2 / 3,
    });
    expect(summarizeBlindedPreference(["tie", "tie"]).candidateWinRateAmongNonTies).toBeNull();
  });
});
