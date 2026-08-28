import { describe, expect, it, vi } from "vitest";

import {
  IDLE_PRESENCE_KEYFRAME_MS,
  TRANSIENT_PRESENCE_INTERVAL_MS,
} from "@/lib/client/presence-cadence";
import type { SemanticPresenceValue } from "./semantic-presence-publisher";
import {
  SemanticPresencePublisher,
  type SemanticPresencePublisherClock,
} from "./semantic-presence-publisher";

type Timer = Readonly<{
  id: number;
  at: number;
  callback: () => void;
  interval: number | null;
}>;

class FakeClock implements SemanticPresencePublisherClock {
  private time = 10_000;
  private nextId = 1;
  private timers = new Map<number, Timer>();

  now = () => this.time;

  setTimeout = (callback: () => void, milliseconds: number) => {
    const id = this.nextId++;
    this.timers.set(id, { id, at: this.time + milliseconds, callback, interval: null });
    return id;
  };

  clearTimeout = (timer: number) => {
    this.timers.delete(timer);
  };

  setInterval = (callback: () => void, milliseconds: number) => {
    const id = this.nextId++;
    this.timers.set(id, { id, at: this.time + milliseconds, callback, interval: milliseconds });
    return id;
  };

  clearInterval = (timer: number) => {
    this.timers.delete(timer);
  };

  advance(milliseconds: number): void {
    const target = this.time + milliseconds;
    while (true) {
      const next = [...this.timers.values()]
        .filter((timer) => timer.at <= target)
        .sort((left, right) => left.at - right.at || left.id - right.id)[0];
      if (!next) break;
      this.time = next.at;
      this.timers.delete(next.id);
      if (next.interval !== null) {
        this.timers.set(next.id, {
          ...next,
          at: next.at + next.interval,
        });
      }
      next.callback();
    }
    this.time = target;
  }

  pendingCount(): number {
    return this.timers.size;
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function value(x: number): SemanticPresenceValue {
  return {
    cursor: { x, y: x + 1 },
    viewport: { x, y: x, width: 800, height: 600, zoom: 1 },
  };
}

describe("SemanticPresencePublisher", () => {
  it("coalesces transient frames to the newest value and bounds durable updates to 1 Hz", async () => {
    const clock = new FakeClock();
    let current = value(1);
    const transient = vi.fn();
    const durable = vi.fn(async () => undefined);
    const publisher = new SemanticPresencePublisher({
      current: () => current,
      transient,
      durable,
      isVisible: () => true,
    }, clock);

    publisher.notifyChanged();
    current = value(2);
    publisher.notifyChanged();
    expect(durable).toHaveBeenCalledTimes(1);
    expect(durable).toHaveBeenLastCalledWith(value(1));
    expect(transient).not.toHaveBeenCalled();

    clock.advance(TRANSIENT_PRESENCE_INTERVAL_MS);
    expect(transient).toHaveBeenCalledTimes(1);
    expect(transient).toHaveBeenLastCalledWith(value(2));

    await publisher.whenCurrentDurableSettles();
    publisher.notifyChanged();
    clock.advance(949);
    expect(durable).toHaveBeenCalledTimes(1);
    clock.advance(1);
    expect(durable).toHaveBeenCalledTimes(2);
    expect(durable).toHaveBeenLastCalledWith(value(2));
    publisher.dispose();
  });

  it("serializes slow durable sends and publishes only the newest queued frame", async () => {
    const clock = new FakeClock();
    let current = value(10);
    const first = deferred();
    const second = deferred();
    const durable = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const publisher = new SemanticPresencePublisher({
      current: () => current,
      transient: vi.fn(),
      durable,
      isVisible: () => true,
    }, clock);

    publisher.notifyChanged();
    current = value(20);
    publisher.notifyChanged();
    current = value(30);
    publisher.notifyChanged();
    expect(durable).toHaveBeenCalledTimes(1);

    first.resolve();
    await first.promise;
    await Promise.resolve();
    expect(durable).toHaveBeenCalledTimes(1);
    clock.advance(1_000);
    expect(durable).toHaveBeenCalledTimes(2);
    expect(durable).toHaveBeenLastCalledWith(value(30));

    second.resolve();
    await publisher.whenCurrentDurableSettles();
    publisher.dispose();
  });

  it("forces reconnect and visibility keyframes without duplicate in-flight requests", async () => {
    const clock = new FakeClock();
    let visible = true;
    let current = value(4);
    const first = deferred();
    const durable = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(undefined);
    const transient = vi.fn();
    const publisher = new SemanticPresencePublisher({
      current: () => current,
      transient,
      durable,
      isVisible: () => visible,
    }, clock);

    publisher.connectionBecameLive();
    publisher.connectionBecameLive();
    current = value(5);
    publisher.becameVisible();
    expect(durable).toHaveBeenCalledTimes(1);
    expect(transient).toHaveBeenLastCalledWith(value(5));

    first.resolve();
    await first.promise;
    await Promise.resolve();
    expect(durable).toHaveBeenCalledTimes(2);
    expect(durable).toHaveBeenLastCalledWith(value(5));

    visible = false;
    current = value(6);
    publisher.notifyChanged();
    clock.advance(2_000);
    expect(durable).toHaveBeenCalledTimes(2);
    expect(transient).toHaveBeenCalledTimes(1);
    publisher.dispose();
  });

  it("emits a visible idle keyframe at 30 seconds", async () => {
    const clock = new FakeClock();
    const durable = vi.fn(async () => undefined);
    const publisher = new SemanticPresencePublisher({
      current: () => value(9),
      transient: vi.fn(),
      durable,
      isVisible: () => true,
    }, clock);

    publisher.connectionBecameLive();
    await publisher.whenCurrentDurableSettles();
    clock.advance(IDLE_PRESENCE_KEYFRAME_MS - 1);
    expect(durable).toHaveBeenCalledTimes(1);
    clock.advance(1);
    expect(durable).toHaveBeenCalledTimes(2);
    publisher.dispose();
  });

  it("contains a synchronous durable-host failure and permits the next keyframe", async () => {
    const clock = new FakeClock();
    const durable = vi.fn()
      .mockImplementationOnce(() => { throw new Error("transport unavailable"); })
      .mockResolvedValue(undefined);
    const publisher = new SemanticPresencePublisher({
      current: () => value(12),
      transient: vi.fn(),
      durable,
      isVisible: () => true,
    }, clock);

    publisher.connectionBecameLive();
    await publisher.whenCurrentDurableSettles();
    publisher.connectionBecameLive();
    await publisher.whenCurrentDurableSettles();
    expect(durable).toHaveBeenCalledTimes(2);
    publisher.dispose();
  });

  it("cancels every timer and ignores late completion after disposal", async () => {
    const clock = new FakeClock();
    const pending = deferred();
    const durable = vi.fn(() => pending.promise);
    const transient = vi.fn();
    const publisher = new SemanticPresencePublisher({
      current: () => value(3),
      transient,
      durable,
      isVisible: () => true,
    }, clock);

    publisher.notifyChanged();
    publisher.notifyChanged();
    expect(clock.pendingCount()).toBeGreaterThan(0);
    publisher.dispose();
    expect(clock.pendingCount()).toBe(0);

    pending.resolve();
    await pending.promise;
    await Promise.resolve();
    clock.advance(IDLE_PRESENCE_KEYFRAME_MS * 2);
    expect(durable).toHaveBeenCalledTimes(1);
    expect(transient).not.toHaveBeenCalled();
  });
});
