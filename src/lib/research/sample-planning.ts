import { z } from "zod";

const probability = z.number().finite().min(0).max(1);
const positiveInteger = z.number().int().positive();

export const pairedBinaryAssumptionsSchema = z.object({
  baselineRate: probability,
  candidateLift: z.number().finite().min(-1).max(1),
  discordanceRate: probability,
  alpha: z.number().finite().positive().max(0.5),
  targetPower: z.number().finite().positive().max(1),
}).strict().superRefine((input, context) => {
  const candidateRate = input.baselineRate + input.candidateLift;
  if (candidateRate < 0 || candidateRate > 1) {
    context.addIssue({ code: "custom", path: ["candidateLift"], message: "Baseline rate plus lift must remain in [0, 1]." });
  }
  if (input.discordanceRate < Math.abs(input.candidateLift)) {
    context.addIssue({ code: "custom", path: ["discordanceRate"], message: "Discordance must be at least the absolute paired-rate difference." });
  }
  const candidateOnlyPass = (input.discordanceRate + input.candidateLift) / 2;
  const baselineOnlyPass = (input.discordanceRate - input.candidateLift) / 2;
  const bothPass = input.baselineRate - baselineOnlyPass;
  const bothFail = 1 - input.baselineRate - candidateOnlyPass;
  if (candidateOnlyPass < 0 || baselineOnlyPass < 0 || bothPass < 0 || bothFail < 0) {
    context.addIssue({
      code: "custom",
      path: ["discordanceRate"],
      message: "Baseline rate, lift, and discordance do not define a feasible paired 2x2 distribution.",
    });
  }
});

export type PairedBinaryAssumptions = z.infer<typeof pairedBinaryAssumptionsSchema>;

export type PairedBinaryProbabilities = {
  bothFail: number;
  baselineOnlyPass: number;
  candidateOnlyPass: number;
  bothPass: number;
};

export function pairedBinaryProbabilities(raw: PairedBinaryAssumptions): PairedBinaryProbabilities {
  const input = pairedBinaryAssumptionsSchema.parse(raw);
  const candidateOnlyPass = (input.discordanceRate + input.candidateLift) / 2;
  const baselineOnlyPass = (input.discordanceRate - input.candidateLift) / 2;
  return {
    bothFail: 1 - input.baselineRate - candidateOnlyPass,
    baselineOnlyPass,
    candidateOnlyPass,
    bothPass: input.baselineRate - baselineOnlyPass,
  };
}

function logGamma(value: number): number {
  const coefficients = [
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.6150291621406,
    12.507343278686905,
    -0.13857109526572012,
    9.984369578019572e-6,
    1.5056327351493116e-7,
  ];
  if (value < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * value)) - logGamma(1 - value);
  const adjusted = value - 1;
  let series = 0.9999999999998099;
  coefficients.forEach((coefficient, index) => {
    series += coefficient / (adjusted + index + 1);
  });
  const shifted = adjusted + coefficients.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI)
    + (adjusted + 0.5) * Math.log(shifted)
    - shifted
    + Math.log(series);
}

function logBinomialCoefficient(n: number, k: number): number {
  return logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);
}

function binomialProbabilities(n: number, successProbability: number): number[] {
  if (successProbability === 0) return [1, ...Array.from({ length: n }, () => 0)];
  if (successProbability === 1) return [...Array.from({ length: n }, () => 0), 1];
  const logs = Array.from({ length: n + 1 }, (_, successes) =>
    logBinomialCoefficient(n, successes)
    + successes * Math.log(successProbability)
    + (n - successes) * Math.log1p(-successProbability));
  const maximumLog = Math.max(...logs);
  const unnormalized = logs.map((value) => Math.exp(value - maximumLog));
  const total = unnormalized.reduce((sum, value) => sum + value, 0);
  return unnormalized.map((value) => value / total);
}

function conditionalExactSignTestPower(
  discordantPairs: number,
  candidateWinAmongDiscordant: number,
  alpha: number,
): number {
  if (discordantPairs === 0) return 0;
  const nullProbabilities = binomialProbabilities(discordantPairs, 0.5);
  let cumulativeLowerTail = 0;
  let largestRejectedLowerCount = -1;
  for (let wins = 0; wins <= Math.floor(discordantPairs / 2); wins += 1) {
    cumulativeLowerTail += nullProbabilities[wins];
    if (Math.min(1, 2 * cumulativeLowerTail) <= alpha) largestRejectedLowerCount = wins;
    else break;
  }
  if (largestRejectedLowerCount < 0) return 0;
  const smallestRejectedUpperCount = discordantPairs - largestRejectedLowerCount;
  const alternative = binomialProbabilities(discordantPairs, candidateWinAmongDiscordant);
  return alternative.reduce((power, probabilityMass, wins) =>
    power + (wins <= largestRejectedLowerCount || wins >= smallestRejectedUpperCount ? probabilityMass : 0), 0);
}

export function exactPairedBinaryPower(
  pairCount: number,
  raw: PairedBinaryAssumptions,
): number {
  if (!Number.isInteger(pairCount) || pairCount < 1) throw new Error("Pair count must be a positive integer.");
  const input = pairedBinaryAssumptionsSchema.parse(raw);
  if (input.discordanceRate === 0) return 0;
  const candidateWinAmongDiscordant = (input.discordanceRate + input.candidateLift)
    / (2 * input.discordanceRate);
  const discordantCountProbabilities = binomialProbabilities(pairCount, input.discordanceRate);
  return discordantCountProbabilities.reduce((power, discordantProbability, discordantPairs) =>
    power + discordantProbability * conditionalExactSignTestPower(
      discordantPairs,
      candidateWinAmongDiscordant,
      input.alpha,
    ), 0);
}

export const nominalPairRequirementInputSchema = pairedBinaryAssumptionsSchema.extend({
  maximumPairs: positiveInteger.max(20_000),
}).strict();

export type NominalPairRequirementInput = z.infer<typeof nominalPairRequirementInputSchema>;

export type NominalPairRequirement = {
  requiredPairs: number | null;
  achievedPower: number;
  previousPairPower: number | null;
  maximumPairs: number;
  targetPower: number;
  method: "exact_equal_tailed_mcnemar_conditional_on_discordance";
  assumption: "independent_pairs_no_task_clustering";
};

export function findNominalPairRequirement(raw: NominalPairRequirementInput): NominalPairRequirement {
  const input = nominalPairRequirementInputSchema.parse(raw);
  const assumptions: PairedBinaryAssumptions = {
    baselineRate: input.baselineRate,
    candidateLift: input.candidateLift,
    discordanceRate: input.discordanceRate,
    alpha: input.alpha,
    targetPower: input.targetPower,
  };
  if (input.discordanceRate === 0 || input.candidateLift === 0) {
    return {
      requiredPairs: null,
      achievedPower: exactPairedBinaryPower(input.maximumPairs, assumptions),
      previousPairPower: null,
      maximumPairs: input.maximumPairs,
      targetPower: input.targetPower,
      method: "exact_equal_tailed_mcnemar_conditional_on_discordance",
      assumption: "independent_pairs_no_task_clustering",
    };
  }
  const candidateWinAmongDiscordant = (input.discordanceRate + input.candidateLift)
    / (2 * input.discordanceRate);
  const conditionalPowers = Array.from({ length: input.maximumPairs + 1 }, (_, discordantPairs) =>
    conditionalExactSignTestPower(discordantPairs, candidateWinAmongDiscordant, input.alpha));
  let previousPower: number | null = null;
  for (let pairCount = 1; pairCount <= input.maximumPairs; pairCount += 1) {
    const discordantProbabilities = binomialProbabilities(pairCount, input.discordanceRate);
    const power = discordantProbabilities.reduce((sum, mass, discordantPairs) =>
      sum + mass * conditionalPowers[discordantPairs], 0);
    if (power >= input.targetPower) {
      return {
        requiredPairs: pairCount,
        achievedPower: power,
        previousPairPower: previousPower,
        maximumPairs: input.maximumPairs,
        targetPower: input.targetPower,
        method: "exact_equal_tailed_mcnemar_conditional_on_discordance",
        assumption: "independent_pairs_no_task_clustering",
      };
    }
    previousPower = power;
  }
  return {
    requiredPairs: null,
    achievedPower: previousPower ?? 0,
    previousPairPower: null,
    maximumPairs: input.maximumPairs,
    targetPower: input.targetPower,
    method: "exact_equal_tailed_mcnemar_conditional_on_discordance",
    assumption: "independent_pairs_no_task_clustering",
  };
}

export function intrataskDesignEffect(replicatesPerTask: number, intrataskCorrelation: number): number {
  if (!Number.isInteger(replicatesPerTask) || replicatesPerTask < 1) {
    throw new Error("Replicates per task must be a positive integer.");
  }
  if (!Number.isFinite(intrataskCorrelation) || intrataskCorrelation < 0 || intrataskCorrelation > 1) {
    throw new Error("Intratask correlation must be in [0, 1].");
  }
  return 1 + (replicatesPerTask - 1) * intrataskCorrelation;
}

function inverseStandardNormal(probabilityValue: number): number {
  if (probabilityValue <= 0 || probabilityValue >= 1) throw new Error("Normal quantile probability must be in (0, 1).");
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  const high = 1 - low;
  if (probabilityValue < low) {
    const q = Math.sqrt(-2 * Math.log(probabilityValue));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (probabilityValue > high) {
    const q = Math.sqrt(-2 * Math.log(1 - probabilityValue));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = probabilityValue - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
    / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
  };
}

function wilsonInterval(successes: number, trials: number, confidence = 0.95): [number, number] {
  const zValue = inverseStandardNormal(1 - (1 - confidence) / 2);
  const estimate = successes / trials;
  const denominator = 1 + zValue * zValue / trials;
  const center = (estimate + zValue * zValue / (2 * trials)) / denominator;
  const halfWidth = zValue / denominator * Math.sqrt(
    estimate * (1 - estimate) / trials + zValue * zValue / (4 * trials * trials),
  );
  return [Math.max(0, center - halfWidth), Math.min(1, center + halfWidth)];
}

export const clusterMonteCarloInputSchema = pairedBinaryAssumptionsSchema.extend({
  taskCount: positiveInteger.min(30).max(10_000),
  replicatesPerTask: positiveInteger.max(100),
  intrataskCorrelation: probability,
  simulations: positiveInteger.min(1_000).max(1_000_000),
  seed: z.number().int().min(0).max(0xffff_ffff),
}).strict();

export type ClusterMonteCarloInput = z.infer<typeof clusterMonteCarloInputSchema>;

export type ClusterMonteCarloPower = {
  power: number;
  rejectedSimulations: number;
  simulations: number;
  monteCarlo95Interval: [number, number];
  taskCount: number;
  replicatesPerTask: number;
  totalPairs: number;
  intrataskCorrelation: number;
  designEffect: number;
  seed: number;
  method: "cluster_mean_normal_test_with_common_shock_correlation";
};

export function monteCarloClusterPower(raw: ClusterMonteCarloInput): ClusterMonteCarloPower {
  const input = clusterMonteCarloInputSchema.parse(raw);
  const probabilities = pairedBinaryProbabilities({
    baselineRate: input.baselineRate,
    candidateLift: input.candidateLift,
    discordanceRate: input.discordanceRate,
    alpha: input.alpha,
    targetPower: input.targetPower,
  });
  const random = mulberry32(input.seed);
  const sharedOutcomeProbability = Math.sqrt(input.intrataskCorrelation);
  const criticalValue = inverseStandardNormal(1 - input.alpha / 2);
  const drawDifference = (): -1 | 0 | 1 => {
    const draw = random();
    if (draw < probabilities.candidateOnlyPass) return 1;
    if (draw < probabilities.candidateOnlyPass + probabilities.baselineOnlyPass) return -1;
    return 0;
  };
  let rejectedSimulations = 0;
  for (let simulation = 0; simulation < input.simulations; simulation += 1) {
    const taskMeans: number[] = [];
    for (let task = 0; task < input.taskCount; task += 1) {
      const commonOutcome = drawDifference();
      let taskDifference = 0;
      for (let replicate = 0; replicate < input.replicatesPerTask; replicate += 1) {
        taskDifference += random() < sharedOutcomeProbability ? commonOutcome : drawDifference();
      }
      taskMeans.push(taskDifference / input.replicatesPerTask);
    }
    const mean = taskMeans.reduce((sum, value) => sum + value, 0) / input.taskCount;
    const variance = input.taskCount > 1
      ? taskMeans.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (input.taskCount - 1)
      : 0;
    const standardError = Math.sqrt(variance / input.taskCount);
    const statistic = standardError === 0
      ? mean === 0 ? 0 : Number.POSITIVE_INFINITY
      : Math.abs(mean / standardError);
    if (statistic >= criticalValue) rejectedSimulations += 1;
  }
  return {
    power: rejectedSimulations / input.simulations,
    rejectedSimulations,
    simulations: input.simulations,
    monteCarlo95Interval: wilsonInterval(rejectedSimulations, input.simulations),
    taskCount: input.taskCount,
    replicatesPerTask: input.replicatesPerTask,
    totalPairs: input.taskCount * input.replicatesPerTask,
    intrataskCorrelation: input.intrataskCorrelation,
    designEffect: intrataskDesignEffect(input.replicatesPerTask, input.intrataskCorrelation),
    seed: input.seed,
    method: "cluster_mean_normal_test_with_common_shock_correlation",
  };
}

export const sealedSampleScenarioSchema = nominalPairRequirementInputSchema.extend({
  id: z.string().regex(/^sensitivity-[a-z0-9-]{3,100}$/),
  replicatesPerTask: positiveInteger.max(100),
  intrataskCorrelation: probability,
  simulations: positiveInteger.min(1_000).max(1_000_000),
  seed: z.number().int().min(0).max(0xffff_ffff),
}).strict();

export type SealedSampleScenario = z.infer<typeof sealedSampleScenarioSchema>;

export type SealedSamplePlanRow = {
  id: string;
  assumptions: PairedBinaryAssumptions;
  nominal: NominalPairRequirement;
  clusterAdjusted: {
    replicatesPerTask: number;
    intrataskCorrelation: number;
    designEffect: number;
    adjustedPairRequirement: number | null;
    uniqueTaskRequirement: number | null;
    roundedTotalPairs: number | null;
    monteCarlo: ClusterMonteCarloPower | null;
  };
};

export function planSealedSampleScenario(raw: SealedSampleScenario): SealedSamplePlanRow {
  const input = sealedSampleScenarioSchema.parse(raw);
  const nominal = findNominalPairRequirement({
    baselineRate: input.baselineRate,
    candidateLift: input.candidateLift,
    discordanceRate: input.discordanceRate,
    alpha: input.alpha,
    targetPower: input.targetPower,
    maximumPairs: input.maximumPairs,
  });
  const designEffect = intrataskDesignEffect(input.replicatesPerTask, input.intrataskCorrelation);
  const adjustedPairRequirement = nominal.requiredPairs === null
    ? null
    : Math.ceil(nominal.requiredPairs * designEffect);
  const uniqueTaskRequirement = adjustedPairRequirement === null
    ? null
    : Math.ceil(adjustedPairRequirement / input.replicatesPerTask);
  const roundedTotalPairs = uniqueTaskRequirement === null
    ? null
    : uniqueTaskRequirement * input.replicatesPerTask;
  const assumptions: PairedBinaryAssumptions = {
    baselineRate: input.baselineRate,
    candidateLift: input.candidateLift,
    discordanceRate: input.discordanceRate,
    alpha: input.alpha,
    targetPower: input.targetPower,
  };
  return {
    id: input.id,
    assumptions,
    nominal,
    clusterAdjusted: {
      replicatesPerTask: input.replicatesPerTask,
      intrataskCorrelation: input.intrataskCorrelation,
      designEffect,
      adjustedPairRequirement,
      uniqueTaskRequirement,
      roundedTotalPairs,
      monteCarlo: uniqueTaskRequirement === null ? null : monteCarloClusterPower({
        ...assumptions,
        taskCount: uniqueTaskRequirement,
        replicatesPerTask: input.replicatesPerTask,
        intrataskCorrelation: input.intrataskCorrelation,
        simulations: input.simulations,
        seed: input.seed,
      }),
    },
  };
}

export function planSealedSampleScenarios(rawScenarios: readonly SealedSampleScenario[]): SealedSamplePlanRow[] {
  const ids = rawScenarios.map((scenario) => scenario.id);
  if (new Set(ids).size !== ids.length) throw new Error("Sealed-sample sensitivity scenario IDs must be unique.");
  return rawScenarios.map(planSealedSampleScenario);
}

export function formatSealedSampleScenarioTable(rows: readonly SealedSamplePlanRow[]): string {
  const header = "| Scenario | Baseline | Lift | Discordance | Nominal independent pairs | Replicates/task | ICC | Design effect | Cluster-adjusted unique tasks | Rounded pairs | Monte Carlo power (95% MC interval) |";
  const separator = "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |";
  const body = rows.map((row) => {
    const monteCarlo = row.clusterAdjusted.monteCarlo;
    const power = monteCarlo
      ? `${monteCarlo.power.toFixed(3)} (${monteCarlo.monteCarlo95Interval[0].toFixed(3)}–${monteCarlo.monteCarlo95Interval[1].toFixed(3)})`
      : "not estimable";
    return `| ${row.id} | ${row.assumptions.baselineRate.toFixed(2)} | ${row.assumptions.candidateLift.toFixed(2)} | ${row.assumptions.discordanceRate.toFixed(2)} | ${row.nominal.requiredPairs ?? "not reached"} | ${row.clusterAdjusted.replicatesPerTask} | ${row.clusterAdjusted.intrataskCorrelation.toFixed(2)} | ${row.clusterAdjusted.designEffect.toFixed(2)} | ${row.clusterAdjusted.uniqueTaskRequirement ?? "not reached"} | ${row.clusterAdjusted.roundedTotalPairs ?? "not reached"} | ${power} |`;
  });
  return [header, separator, ...body].join("\n");
}

export type TaskAllocationCandidate = {
  taskCount: number;
  replicatesPerTask: number;
  totalPairs: number;
  estimatedPower: number;
};

/**
 * Preregistered recommendation order: meet target power, then maximize unique
 * tasks, then maximize estimated power, then minimize total pairs.
 */
export function rankTaskAllocations(
  allocations: readonly TaskAllocationCandidate[],
  targetPower: number,
): TaskAllocationCandidate[] {
  if (!Number.isFinite(targetPower) || targetPower <= 0 || targetPower > 1) {
    throw new Error("Target power must be in (0, 1].");
  }
  return [...allocations].sort((left, right) => {
    const leftMeetsTarget = left.estimatedPower >= targetPower;
    const rightMeetsTarget = right.estimatedPower >= targetPower;
    if (leftMeetsTarget !== rightMeetsTarget) return leftMeetsTarget ? -1 : 1;
    if (left.taskCount !== right.taskCount) return right.taskCount - left.taskCount;
    if (left.estimatedPower !== right.estimatedPower) return right.estimatedPower - left.estimatedPower;
    return left.totalPairs - right.totalPairs;
  });
}
