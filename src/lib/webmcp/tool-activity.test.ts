import { afterEach, describe, expect, it, vi } from "vitest";

import { LocalWebMcpToolActivityTracker } from "./tool-activity";

afterEach(() => {
  vi.useRealTimers();
});

describe("LocalWebMcpToolActivityTracker", () => {
  it("keeps overlapping executions active until the final token settles", () => {
    vi.useFakeTimers();
    const changes = vi.fn();
    const tracker = new LocalWebMcpToolActivityTracker(changes, 160);

    const releaseRead = tracker.begin("read_canvas_summary");
    const releaseWrite = tracker.begin("apply_canvas_transaction");
    releaseRead();

    expect(changes.mock.calls.at(-1)?.[0]).toEqual({
      active: true,
      count: 1,
      toolNames: ["apply_canvas_transaction"],
    });
    vi.advanceTimersByTime(1_000);
    expect(changes.mock.calls.at(-1)?.[0].active).toBe(true);

    releaseWrite();
    expect(changes.mock.calls.at(-1)?.[0].active).toBe(true);
    vi.advanceTimersByTime(159);
    expect(changes.mock.calls.at(-1)?.[0].active).toBe(true);
    vi.advanceTimersByTime(1);
    expect(changes.mock.calls.at(-1)?.[0]).toEqual({ active: false, count: 0, toolNames: [] });
  });

  it("cancels a pending settle when another real call begins", () => {
    vi.useFakeTimers();
    const changes = vi.fn();
    const tracker = new LocalWebMcpToolActivityTracker(changes, 160);

    tracker.begin("first")();
    vi.advanceTimersByTime(100);
    const releaseSecond = tracker.begin("second");
    vi.advanceTimersByTime(100);

    expect(changes.mock.calls.at(-1)?.[0]).toEqual({
      active: true,
      count: 1,
      toolNames: ["second"],
    });
    releaseSecond();
    vi.advanceTimersByTime(160);
    expect(changes.mock.calls.at(-1)?.[0].active).toBe(false);
  });

  it("supports immediate unregister cleanup and ignores late or duplicate releases", () => {
    vi.useFakeTimers();
    const changes = vi.fn();
    const tracker = new LocalWebMcpToolActivityTracker(changes, 160);
    const release = tracker.begin("read_room_context");

    release(true);
    release();
    vi.advanceTimersByTime(1_000);

    expect(changes).toHaveBeenCalledTimes(2);
    expect(changes.mock.calls.at(-1)?.[0].active).toBe(false);
  });

  it("hard-cleans timers and tokens on dispose", () => {
    vi.useFakeTimers();
    const changes = vi.fn();
    const tracker = new LocalWebMcpToolActivityTracker(changes, 160);
    const release = tracker.begin("inspect_canvas_scope");

    tracker.dispose();
    release();
    tracker.begin("late_call");
    vi.runAllTimers();

    expect(changes.mock.calls.at(-1)?.[0]).toEqual({ active: false, count: 0, toolNames: [] });
  });
});
