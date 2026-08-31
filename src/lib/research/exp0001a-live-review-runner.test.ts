// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import { createExp0001aLiveReviewRunner } from "./exp0001a-live-review-runner";

function options() {
  return {
    sources: vi.fn(async () => []),
    reviewerRoster: [],
    reviewPolicy: {} as never,
    pairwise: {
      context: vi.fn(),
      run: vi.fn(),
      recover: vi.fn(),
      load: vi.fn(),
      sealedAt: vi.fn(() => "2026-08-30T20:00:00.000Z"),
    },
    retainAggregates: vi.fn(),
    evaluator: {
      run: vi.fn(),
      recover: vi.fn(),
      load: vi.fn(),
    },
  };
}

describe("EXP-0001A live review runner safety boundary", () => {
  it("is dry-run by default and calls neither evaluator nor pairwise model seam", async () => {
    const configured = options();
    const runner = createExp0001aLiveReviewRunner(configured);
    await expect(runner({} as never, {} as never)).rejects.toThrow(/dry-run.*explicit execute/i);
    expect(configured.sources).not.toHaveBeenCalled();
    expect(configured.evaluator.run).not.toHaveBeenCalled();
    expect(configured.evaluator.recover).not.toHaveBeenCalled();
    expect(configured.pairwise.run).not.toHaveBeenCalled();
  });

  it("validates the all-attempt evidence before an explicit execute can reach a model seam", async () => {
    const configured = options();
    const runner = createExp0001aLiveReviewRunner({ ...configured, mode: "execute" });
    await expect(runner({ sealedAttemptRegistry: {} } as never, {} as never)).rejects.toThrow();
    expect(configured.evaluator.run).not.toHaveBeenCalled();
    expect(configured.pairwise.run).not.toHaveBeenCalled();
  });
});
