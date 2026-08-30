import { describe, expect, it } from "vitest";

import {
  exactPairedBinaryPower,
  findNominalPairRequirement,
  formatSealedSampleScenarioTable,
  intrataskDesignEffect,
  monteCarloClusterPower,
  pairedBinaryAssumptionsSchema,
  pairedBinaryProbabilities,
  planSealedSampleScenario,
  planSealedSampleScenarios,
  rankTaskAllocations,
  type PairedBinaryAssumptions,
  type SealedSampleScenario,
} from "./sample-planning";

const assumptions: PairedBinaryAssumptions = {
  baselineRate: 0.55,
  candidateLift: 0.12,
  discordanceRate: 0.3,
  alpha: 0.05,
  targetPower: 0.8,
};

describe("paired-binary assumptions", () => {
  it("derives a feasible paired 2x2 distribution with the requested marginals", () => {
    const probabilities = pairedBinaryProbabilities(assumptions);
    expect(Object.values(probabilities).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 12);
    const baselineRate = probabilities.bothPass + probabilities.baselineOnlyPass;
    const candidateRate = probabilities.bothPass + probabilities.candidateOnlyPass;
    expect(baselineRate).toBeCloseTo(assumptions.baselineRate, 12);
    expect(candidateRate).toBeCloseTo(assumptions.baselineRate + assumptions.candidateLift, 12);
    expect(probabilities.baselineOnlyPass + probabilities.candidateOnlyPass)
      .toBeCloseTo(assumptions.discordanceRate, 12);
  });

  it("rejects impossible lift, discordance, and marginal combinations", () => {
    expect(pairedBinaryAssumptionsSchema.safeParse({
      ...assumptions,
      candidateLift: 0.2,
      discordanceRate: 0.1,
    }).success).toBe(false);
    expect(pairedBinaryAssumptionsSchema.safeParse({
      ...assumptions,
      baselineRate: 0.95,
      candidateLift: 0.1,
    }).success).toBe(false);
    expect(pairedBinaryAssumptionsSchema.safeParse({
      ...assumptions,
      unknownPilotEstimate: 0.4,
    }).success).toBe(false);
  });
});

describe("exact nominal paired-binary power", () => {
  it("uses a two-sided exact test that cannot reject with one pair", () => {
    expect(exactPairedBinaryPower(1, assumptions)).toBe(0);
  });

  it("increases materially with independent pair count under a fixed alternative", () => {
    const small = exactPairedBinaryPower(25, assumptions);
    const large = exactPairedBinaryPower(250, assumptions);
    expect(large).toBeGreaterThan(small);
    expect(large).toBeGreaterThan(0.8);
  });

  it("depends on paired discordance and lift, while baseline only constrains feasibility", () => {
    const lowerBaseline = exactPairedBinaryPower(120, { ...assumptions, baselineRate: 0.4 });
    const higherBaseline = exactPairedBinaryPower(120, { ...assumptions, baselineRate: 0.7 });
    expect(lowerBaseline).toBeCloseTo(higherBaseline, 12);

    const lowerLift = exactPairedBinaryPower(120, { ...assumptions, candidateLift: 0.08 });
    expect(lowerBaseline).toBeGreaterThan(lowerLift);
  });

  it("finds the first exact nominal pair count that reaches target power", () => {
    const requirement = findNominalPairRequirement({ ...assumptions, maximumPairs: 500 });
    expect(requirement.requiredPairs).not.toBeNull();
    expect(requirement.achievedPower).toBeGreaterThanOrEqual(assumptions.targetPower);
    expect(requirement.previousPairPower).not.toBeNull();
    expect(requirement.previousPairPower!).toBeLessThan(assumptions.targetPower);
    expect(requirement.assumption).toBe("independent_pairs_no_task_clustering");
  });

  it("does not claim a finite requirement when lift is zero", () => {
    const requirement = findNominalPairRequirement({
      ...assumptions,
      candidateLift: 0,
      maximumPairs: 100,
    });
    expect(requirement.requiredPairs).toBeNull();
  });
});

describe("cluster adjustment and Monte Carlo sensitivity", () => {
  it("computes the conventional equal-cluster design effect", () => {
    expect(intrataskDesignEffect(1, 0.8)).toBe(1);
    expect(intrataskDesignEffect(4, 0.25)).toBe(1.75);
    expect(intrataskDesignEffect(5, 1)).toBe(5);
  });

  it("is exactly reproducible for a deterministic seed", () => {
    const input = {
      ...assumptions,
      taskCount: 80,
      replicatesPerTask: 2,
      intrataskCorrelation: 0.3,
      simulations: 2_000,
      seed: 2_026_083_001,
    };
    expect(monteCarloClusterPower(input)).toEqual(monteCarloClusterPower(input));
  });

  it("returns an explicit Monte Carlo uncertainty interval", () => {
    const result = monteCarloClusterPower({
      ...assumptions,
      taskCount: 100,
      replicatesPerTask: 2,
      intrataskCorrelation: 0.2,
      simulations: 3_000,
      seed: 41,
    });
    expect(result.monteCarlo95Interval[0]).toBeLessThan(result.power);
    expect(result.monteCarlo95Interval[1]).toBeGreaterThan(result.power);
    expect(result.totalPairs).toBe(200);
    expect(result.designEffect).toBe(1.2);
  });

  it("separates nominal independent pairs from cluster-adjusted task planning", () => {
    const independent = planSealedSampleScenario({
      id: "sensitivity-independent",
      ...assumptions,
      maximumPairs: 500,
      replicatesPerTask: 3,
      intrataskCorrelation: 0,
      simulations: 2_000,
      seed: 101,
    });
    const correlated = planSealedSampleScenario({
      id: "sensitivity-correlated",
      ...assumptions,
      maximumPairs: 500,
      replicatesPerTask: 3,
      intrataskCorrelation: 0.5,
      simulations: 2_000,
      seed: 102,
    });
    expect(correlated.nominal).toEqual(independent.nominal);
    expect(correlated.clusterAdjusted.designEffect).toBe(2);
    expect(correlated.clusterAdjusted.adjustedPairRequirement!)
      .toBeGreaterThan(independent.clusterAdjusted.adjustedPairRequirement!);
    expect(correlated.clusterAdjusted.uniqueTaskRequirement!)
      .toBeGreaterThan(independent.clusterAdjusted.uniqueTaskRequirement!);
  });

  it("returns deterministic multi-scenario rows and a transparent table", () => {
    const scenarios: SealedSampleScenario[] = [
      {
        id: "sensitivity-optimistic",
        baselineRate: 0.55,
        candidateLift: 0.15,
        discordanceRate: 0.3,
        alpha: 0.05,
        targetPower: 0.8,
        maximumPairs: 500,
        replicatesPerTask: 2,
        intrataskCorrelation: 0.1,
        simulations: 1_000,
        seed: 11,
      },
      {
        id: "sensitivity-conservative",
        baselineRate: 0.55,
        candidateLift: 0.08,
        discordanceRate: 0.35,
        alpha: 0.05,
        targetPower: 0.8,
        maximumPairs: 1_000,
        replicatesPerTask: 3,
        intrataskCorrelation: 0.4,
        simulations: 1_000,
        seed: 12,
      },
    ];
    const rows = planSealedSampleScenarios(scenarios);
    const table = formatSealedSampleScenarioTable(rows);
    expect(rows).toHaveLength(2);
    expect(table).toContain("Nominal independent pairs");
    expect(table).toContain("Cluster-adjusted unique tasks");
    expect(table).toContain("95% MC interval");
    expect(table).toContain("sensitivity-conservative");
  });

  it("reproduces the preregistered hypothetical sensitivity table", () => {
    const rows = planSealedSampleScenarios([
      {
        id: "sensitivity-larger-lift",
        baselineRate: 0.55,
        candidateLift: 0.15,
        discordanceRate: 0.3,
        alpha: 0.05,
        targetPower: 0.8,
        maximumPairs: 1_000,
        replicatesPerTask: 2,
        intrataskCorrelation: 0.1,
        simulations: 10_000,
        seed: 2_026_083_101,
      },
      {
        id: "sensitivity-central",
        baselineRate: 0.55,
        candidateLift: 0.12,
        discordanceRate: 0.3,
        alpha: 0.05,
        targetPower: 0.8,
        maximumPairs: 1_000,
        replicatesPerTask: 2,
        intrataskCorrelation: 0.25,
        simulations: 10_000,
        seed: 2_026_083_102,
      },
      {
        id: "sensitivity-smaller-lift",
        baselineRate: 0.55,
        candidateLift: 0.08,
        discordanceRate: 0.35,
        alpha: 0.05,
        targetPower: 0.8,
        maximumPairs: 2_000,
        replicatesPerTask: 3,
        intrataskCorrelation: 0.4,
        simulations: 10_000,
        seed: 2_026_083_103,
      },
    ]);
    expect(rows.map((row) => ({
      nominalPairs: row.nominal.requiredPairs,
      uniqueTasks: row.clusterAdjusted.uniqueTaskRequirement,
      roundedPairs: row.clusterAdjusted.roundedTotalPairs,
      rejectedSimulations: row.clusterAdjusted.monteCarlo?.rejectedSimulations,
    }))).toEqual([
      { nominalPairs: 112, uniqueTasks: 62, roundedPairs: 124, rejectedSimulations: 8_520 },
      { nominalPairs: 172, uniqueTasks: 108, roundedPairs: 216, rejectedSimulations: 8_425 },
      { nominalPairs: 448, uniqueTasks: 269, roundedPairs: 807, rejectedSimulations: 8_221 },
    ]);
  });
});

describe("unique-task-first recommendation rule", () => {
  it("first requires target power, then favors more unique tasks", () => {
    const ranked = rankTaskAllocations([
      { taskCount: 40, replicatesPerTask: 4, totalPairs: 160, estimatedPower: 0.85 },
      { taskCount: 80, replicatesPerTask: 2, totalPairs: 160, estimatedPower: 0.82 },
      { taskCount: 120, replicatesPerTask: 1, totalPairs: 120, estimatedPower: 0.78 },
    ], 0.8);
    expect(ranked.map((allocation) => allocation.taskCount)).toEqual([80, 40, 120]);
  });
});
