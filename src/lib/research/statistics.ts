export type PairedBinaryObservation = {
  pairId: string;
  taskId: string;
  taskFamily: string;
  baselineAccepted: boolean;
  candidateAccepted: boolean;
};

export type PairedPositiveObservation = {
  pairId: string;
  taskId: string;
  baselineValue: number;
  candidateValue: number;
};

export type ConfidenceInterval = {
  lower: number;
  upper: number;
  level: 0.95;
  method: "task_cluster_percentile_bootstrap";
  draws: number;
  seed: number;
};

export type PairedBinarySummary = {
  pairCount: number;
  taskCount: number;
  baselineAcceptedCount: number;
  candidateAcceptedCount: number;
  baselinePassRate: number;
  candidatePassRate: number;
  absoluteDifference: number;
  relativeDifference: number | null;
  candidateOnlySuccessCount: number;
  baselineOnlySuccessCount: number;
  concordantSuccessCount: number;
  concordantFailureCount: number;
  exactMcNemarPValue: number;
  absoluteDifferenceConfidenceInterval: ConfidenceInterval;
  byTaskFamily: Record<string, Omit<PairedBinarySummary, "byTaskFamily">>;
};

export type PairedRatioSummary = {
  pairCount: number;
  taskCount: number;
  medianBaseline: number;
  medianCandidate: number;
  medianPairedRatio: number;
  medianPairedRatioConfidenceInterval: ConfidenceInterval;
};

export type BlindedPreferenceSummary = {
  comparisonCount: number;
  candidateWinCount: number;
  baselineWinCount: number;
  tieCount: number;
  candidateWinRateAmongNonTies: number | null;
};

function assertUniquePairs<T extends { pairId: string }>(observations: readonly T[]): void {
  const seen = new Set<string>();
  for (const observation of observations) {
    if (seen.has(observation.pairId)) throw new Error(`Duplicate paired observation: ${observation.pairId}`);
    seen.add(observation.pairId);
  }
}

function assertNonEmpty<T>(observations: readonly T[]): asserts observations is readonly [T, ...T[]] {
  if (observations.length === 0) throw new Error("At least one paired observation is required.");
}

function xorshift32(seed: number): () => number {
  let state = seed >>> 0 || 0x6d2b79f5;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function quantile(sortedValues: readonly number[], probability: number): number {
  if (sortedValues.length === 0) throw new Error("Cannot calculate a quantile of an empty sample.");
  const position = (sortedValues.length - 1) * probability;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  if (lowerIndex === upperIndex) return sortedValues[lowerIndex];
  const weight = position - lowerIndex;
  return sortedValues[lowerIndex] * (1 - weight) + sortedValues[upperIndex] * weight;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return quantile(sorted, 0.5);
}

function groupByTask<T extends { taskId: string }>(observations: readonly T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const observation of observations) {
    const group = grouped.get(observation.taskId) ?? [];
    group.push(observation);
    grouped.set(observation.taskId, group);
  }
  return grouped;
}

function clusterBootstrap<T extends { taskId: string }>(
  observations: readonly T[],
  statistic: (sample: readonly T[]) => number,
  draws: number,
  seed: number,
): ConfidenceInterval {
  if (!Number.isInteger(draws) || draws < 100) throw new Error("Bootstrap draws must be an integer of at least 100.");
  const grouped = groupByTask(observations);
  const taskIds = [...grouped.keys()].sort();
  const random = xorshift32(seed);
  const estimates: number[] = [];

  for (let draw = 0; draw < draws; draw += 1) {
    const sample: T[] = [];
    for (let index = 0; index < taskIds.length; index += 1) {
      const selectedTask = taskIds[Math.floor(random() * taskIds.length)];
      sample.push(...(grouped.get(selectedTask) ?? []));
    }
    estimates.push(statistic(sample));
  }
  estimates.sort((left, right) => left - right);
  return {
    lower: quantile(estimates, 0.025),
    upper: quantile(estimates, 0.975),
    level: 0.95,
    method: "task_cluster_percentile_bootstrap",
    draws,
    seed,
  };
}

function exactTwoSidedBinomialPValue(successes: number, trials: number): number {
  if (trials === 0) return 1;
  const lowerTailMaximum = Math.min(successes, trials - successes);
  let probability = 2 ** -trials;
  let cumulative = probability;
  for (let count = 1; count <= lowerTailMaximum; count += 1) {
    probability *= (trials - count + 1) / count;
    cumulative += probability;
  }
  return Math.min(1, cumulative * 2);
}

function binaryDifference(observations: readonly PairedBinaryObservation[]): number {
  const baseline = observations.filter((observation) => observation.baselineAccepted).length / observations.length;
  const candidate = observations.filter((observation) => observation.candidateAccepted).length / observations.length;
  return candidate - baseline;
}

function summarizeBinaryWithoutFamilies(
  observations: readonly PairedBinaryObservation[],
  draws: number,
  seed: number,
): Omit<PairedBinarySummary, "byTaskFamily"> {
  assertNonEmpty(observations);
  assertUniquePairs(observations);
  const baselineAcceptedCount = observations.filter((observation) => observation.baselineAccepted).length;
  const candidateAcceptedCount = observations.filter((observation) => observation.candidateAccepted).length;
  const candidateOnlySuccessCount = observations.filter(
    (observation) => !observation.baselineAccepted && observation.candidateAccepted,
  ).length;
  const baselineOnlySuccessCount = observations.filter(
    (observation) => observation.baselineAccepted && !observation.candidateAccepted,
  ).length;
  const concordantSuccessCount = observations.filter(
    (observation) => observation.baselineAccepted && observation.candidateAccepted,
  ).length;
  const concordantFailureCount = observations.filter(
    (observation) => !observation.baselineAccepted && !observation.candidateAccepted,
  ).length;
  const baselinePassRate = baselineAcceptedCount / observations.length;
  const candidatePassRate = candidateAcceptedCount / observations.length;
  const absoluteDifference = candidatePassRate - baselinePassRate;
  return {
    pairCount: observations.length,
    taskCount: groupByTask(observations).size,
    baselineAcceptedCount,
    candidateAcceptedCount,
    baselinePassRate,
    candidatePassRate,
    absoluteDifference,
    relativeDifference: baselinePassRate > 0 ? absoluteDifference / baselinePassRate : null,
    candidateOnlySuccessCount,
    baselineOnlySuccessCount,
    concordantSuccessCount,
    concordantFailureCount,
    exactMcNemarPValue: exactTwoSidedBinomialPValue(
      candidateOnlySuccessCount,
      candidateOnlySuccessCount + baselineOnlySuccessCount,
    ),
    absoluteDifferenceConfidenceInterval: clusterBootstrap(
      observations,
      binaryDifference,
      draws,
      seed,
    ),
  };
}

export function summarizePairedBinary(
  observations: readonly PairedBinaryObservation[],
  options: { bootstrapDraws?: number; seed?: number } = {},
): PairedBinarySummary {
  assertNonEmpty(observations);
  assertUniquePairs(observations);
  const draws = options.bootstrapDraws ?? 10_000;
  const seed = options.seed ?? 20_260_830;
  const overall = summarizeBinaryWithoutFamilies(observations, draws, seed);
  const families = normalizedFamilies(observations);
  return {
    ...overall,
    byTaskFamily: Object.fromEntries(families.map((family, index) => [
      family,
      summarizeBinaryWithoutFamilies(
        observations.filter((observation) => observation.taskFamily === family),
        draws,
        seed + index + 1,
      ),
    ])),
  };
}

function normalizedFamilies(observations: readonly PairedBinaryObservation[]): string[] {
  return [...new Set(observations.map((observation) => observation.taskFamily))].sort();
}

export function summarizePairedPositiveRatio(
  observations: readonly PairedPositiveObservation[],
  options: { bootstrapDraws?: number; seed?: number } = {},
): PairedRatioSummary {
  assertNonEmpty(observations);
  assertUniquePairs(observations);
  for (const observation of observations) {
    if (!Number.isFinite(observation.baselineValue) || observation.baselineValue <= 0
      || !Number.isFinite(observation.candidateValue) || observation.candidateValue <= 0) {
      throw new Error(`Paired ratio values must be finite and positive: ${observation.pairId}`);
    }
  }
  const draws = options.bootstrapDraws ?? 10_000;
  const seed = options.seed ?? 20_260_830;
  const ratioStatistic = (sample: readonly PairedPositiveObservation[]) => median(
    sample.map((observation) => observation.candidateValue / observation.baselineValue),
  );
  return {
    pairCount: observations.length,
    taskCount: groupByTask(observations).size,
    medianBaseline: median(observations.map((observation) => observation.baselineValue)),
    medianCandidate: median(observations.map((observation) => observation.candidateValue)),
    medianPairedRatio: ratioStatistic(observations),
    medianPairedRatioConfidenceInterval: clusterBootstrap(observations, ratioStatistic, draws, seed),
  };
}

export function summarizeBlindedPreference(
  outcomes: readonly ("candidate" | "baseline" | "tie")[],
): BlindedPreferenceSummary {
  const candidateWinCount = outcomes.filter((outcome) => outcome === "candidate").length;
  const baselineWinCount = outcomes.filter((outcome) => outcome === "baseline").length;
  const tieCount = outcomes.filter((outcome) => outcome === "tie").length;
  const nonTieCount = candidateWinCount + baselineWinCount;
  return {
    comparisonCount: outcomes.length,
    candidateWinCount,
    baselineWinCount,
    tieCount,
    candidateWinRateAmongNonTies: nonTieCount > 0 ? candidateWinCount / nonTieCount : null,
  };
}
