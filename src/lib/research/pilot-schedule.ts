export type PilotCondition = "baseline" | "candidate";

export type PilotTaskDescriptor = {
  taskId: string;
  taskFamily: string;
};

export type PilotPairAssignment = {
  pairId: string;
  taskId: string;
  taskFamily: string;
  replicateIndex: number;
  timeBlock: number;
  order: readonly [PilotCondition, PilotCondition];
  attempts: readonly [
    { attemptId: string; condition: PilotCondition; orderIndex: 0 },
    { attemptId: string; condition: PilotCondition; orderIndex: 1 },
  ];
};

export type PilotRandomizationManifest = {
  schemaVersion: 1;
  protocolId: string;
  seed: number;
  replicateCount: number;
  taskCount: number;
  pairCount: number;
  attemptCount: number;
  assignments: PilotPairAssignment[];
};

function stableSlug(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!slug) throw new Error(`Task IDs must contain at least one ASCII letter or number: ${value}`);
  return slug;
}

function xorshift32(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function shuffled<T>(values: readonly T[], random: () => number): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

function assertTasks(tasks: readonly PilotTaskDescriptor[]): void {
  if (tasks.length === 0) throw new Error("At least one pilot task is required.");
  const taskIds = new Set<string>();
  for (const task of tasks) {
    if (!task.taskId || !task.taskFamily) throw new Error("Pilot tasks require a task ID and task family.");
    if (taskIds.has(task.taskId)) throw new Error(`Duplicate pilot task ID: ${task.taskId}`);
    taskIds.add(task.taskId);
  }
}

/**
 * Produces a deterministic, treatment-interleaved schedule. Condition order is
 * balanced within each task family and replicate block as closely as parity
 * permits; it is never inferred from task names or execution outcomes.
 */
export function createPilotRandomizationManifest(
  protocolId: string,
  tasks: readonly PilotTaskDescriptor[],
  replicateCount: number,
  seed: number,
): PilotRandomizationManifest {
  assertTasks(tasks);
  if (!protocolId) throw new Error("A protocol ID is required.");
  if (!Number.isInteger(replicateCount) || replicateCount < 1) {
    throw new Error("Replicate count must be a positive integer.");
  }
  if (!Number.isInteger(seed)) throw new Error("The randomization seed must be an integer.");

  const random = xorshift32(seed);
  const families = [...new Set(tasks.map((task) => task.taskFamily))].sort();
  const raw: Array<Omit<PilotPairAssignment, "timeBlock" | "order" | "attempts"> & { baselineFirst: boolean }> = [];

  for (let replicateIndex = 0; replicateIndex < replicateCount; replicateIndex += 1) {
    for (const family of families) {
      const familyTasks = shuffled(
        tasks.filter((task) => task.taskFamily === family),
        random,
      );
      const startBaselineFirst = random() >= 0.5;
      familyTasks.forEach((task, index) => {
        const taskSlug = stableSlug(task.taskId);
        const pairId = `pair_${taskSlug}_r${replicateIndex + 1}`;
        raw.push({
          pairId,
          taskId: task.taskId,
          taskFamily: task.taskFamily,
          replicateIndex,
          baselineFirst: index % 2 === 0 ? startBaselineFirst : !startBaselineFirst,
        });
      });
    }
  }

  const interleaved = shuffled(raw, random);
  const assignments: PilotPairAssignment[] = interleaved.map((assignment, timeBlock) => {
    const order: readonly [PilotCondition, PilotCondition] = assignment.baselineFirst
      ? ["baseline", "candidate"]
      : ["candidate", "baseline"];
    return {
      pairId: assignment.pairId,
      taskId: assignment.taskId,
      taskFamily: assignment.taskFamily,
      replicateIndex: assignment.replicateIndex,
      timeBlock,
      order,
      attempts: [
        {
          attemptId: `attempt_${stableSlug(assignment.taskId)}_r${assignment.replicateIndex + 1}_${order[0]}`,
          condition: order[0],
          orderIndex: 0,
        },
        {
          attemptId: `attempt_${stableSlug(assignment.taskId)}_r${assignment.replicateIndex + 1}_${order[1]}`,
          condition: order[1],
          orderIndex: 1,
        },
      ],
    };
  });

  return {
    schemaVersion: 1,
    protocolId,
    seed,
    replicateCount,
    taskCount: tasks.length,
    pairCount: assignments.length,
    attemptCount: assignments.length * 2,
    assignments,
  };
}

export function validatePilotRandomizationManifest(
  manifest: PilotRandomizationManifest,
): string[] {
  const violations: string[] = [];
  const pairIds = new Set<string>();
  const attemptIds = new Set<string>();
  const taskReplicates = new Set<string>();
  const timeBlocks = new Set<number>();

  if (manifest.assignments.length !== manifest.pairCount) violations.push("PAIR_COUNT_MISMATCH");
  if (manifest.assignments.length * 2 !== manifest.attemptCount) violations.push("ATTEMPT_COUNT_MISMATCH");

  for (const assignment of manifest.assignments) {
    if (pairIds.has(assignment.pairId)) violations.push(`DUPLICATE_PAIR:${assignment.pairId}`);
    pairIds.add(assignment.pairId);
    if (timeBlocks.has(assignment.timeBlock)) violations.push(`DUPLICATE_TIME_BLOCK:${assignment.timeBlock}`);
    timeBlocks.add(assignment.timeBlock);
    const taskReplicate = `${assignment.taskId}:${assignment.replicateIndex}`;
    if (taskReplicates.has(taskReplicate)) violations.push(`DUPLICATE_TASK_REPLICATE:${taskReplicate}`);
    taskReplicates.add(taskReplicate);
    if (new Set(assignment.order).size !== 2
      || !assignment.order.includes("baseline")
      || !assignment.order.includes("candidate")) {
      violations.push(`INVALID_CONDITION_ORDER:${assignment.pairId}`);
    }
    assignment.attempts.forEach((attempt, orderIndex) => {
      if (attemptIds.has(attempt.attemptId)) violations.push(`DUPLICATE_ATTEMPT:${attempt.attemptId}`);
      attemptIds.add(attempt.attemptId);
      if (attempt.condition !== assignment.order[orderIndex] || attempt.orderIndex !== orderIndex) {
        violations.push(`ATTEMPT_ORDER_MISMATCH:${attempt.attemptId}`);
      }
    });
  }

  const expectedTaskReplicates = manifest.taskCount * manifest.replicateCount;
  if (taskReplicates.size !== expectedTaskReplicates) violations.push("TASK_REPLICATE_COVERAGE_MISMATCH");
  return [...new Set(violations)].sort();
}
