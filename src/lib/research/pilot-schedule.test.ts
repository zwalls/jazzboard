import { describe, expect, it } from "vitest";

import {
  createPilotRandomizationManifest,
  validatePilotRandomizationManifest,
} from "./pilot-schedule";

const tasks = [
  { taskId: "arch-one", taskFamily: "architecture" },
  { taskId: "arch-two", taskFamily: "architecture" },
  { taskId: "draw-one", taskFamily: "drawing" },
  { taskId: "draw-two", taskFamily: "drawing" },
];

describe("pilot randomization", () => {
  it("allocates every baseline and candidate attempt before execution", () => {
    const manifest = createPilotRandomizationManifest("EXP-0001", tasks, 2, 42);
    expect(manifest.taskCount).toBe(4);
    expect(manifest.pairCount).toBe(8);
    expect(manifest.attemptCount).toBe(16);
    expect(manifest.assignments.flatMap((assignment) => assignment.attempts)).toHaveLength(16);
    expect(validatePilotRandomizationManifest(manifest)).toEqual([]);
  });

  it("is deterministic for a frozen seed and changes with a new seed", () => {
    const first = createPilotRandomizationManifest("EXP-0001", tasks, 2, 42);
    const second = createPilotRandomizationManifest("EXP-0001", tasks, 2, 42);
    const changed = createPilotRandomizationManifest("EXP-0001", tasks, 2, 43);
    expect(first).toEqual(second);
    expect(first.assignments).not.toEqual(changed.assignments);
  });

  it("balances order within even-sized family and replicate blocks", () => {
    const manifest = createPilotRandomizationManifest("EXP-0001", tasks, 2, 7);
    for (const family of ["architecture", "drawing"]) {
      for (const replicateIndex of [0, 1]) {
        const assignments = manifest.assignments.filter(
          (assignment) => assignment.taskFamily === family && assignment.replicateIndex === replicateIndex,
        );
        expect(assignments.filter((assignment) => assignment.order[0] === "baseline")).toHaveLength(1);
        expect(assignments.filter((assignment) => assignment.order[0] === "candidate")).toHaveLength(1);
      }
    }
  });

  it("detects count, identity, and order tampering", () => {
    const manifest = createPilotRandomizationManifest("EXP-0001", tasks, 1, 5);
    const tampered = structuredClone(manifest);
    tampered.pairCount = 9;
    tampered.assignments[1].pairId = tampered.assignments[0].pairId;
    tampered.assignments[1].attempts[0].condition = tampered.assignments[1].order[1];
    expect(validatePilotRandomizationManifest(tampered)).toEqual(expect.arrayContaining([
      "PAIR_COUNT_MISMATCH",
      `DUPLICATE_PAIR:${tampered.assignments[0].pairId}`,
      `ATTEMPT_ORDER_MISMATCH:${tampered.assignments[1].attempts[0].attemptId}`,
    ]));
  });

  it("rejects duplicate tasks and invalid replicate counts", () => {
    expect(() => createPilotRandomizationManifest("EXP-0001", [tasks[0], tasks[0]], 1, 1))
      .toThrow("Duplicate pilot task ID");
    expect(() => createPilotRandomizationManifest("EXP-0001", tasks, 0, 1))
      .toThrow("Replicate count must be a positive integer");
  });
});
