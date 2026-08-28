import {
  ACTIVE_PRESENCE_KEYFRAME_MS,
  IDLE_PRESENCE_KEYFRAME_MS,
  TRANSIENT_PRESENCE_INTERVAL_MS,
  activePresenceDelay,
  idlePresenceKeyframeDue,
} from "@/lib/client/presence-cadence";
import type { Point, Viewport } from "@/lib/domain/types";

export type SemanticPresenceValue = Readonly<{
  cursor: Point | null;
  viewport: Viewport | null;
}>;

export type SemanticPresencePublisherHost = Readonly<{
  /** Read at send time so coalesced frames always publish the newest camera/cursor. */
  current(): SemanticPresenceValue | null;
  transient(value: SemanticPresenceValue): boolean | void;
  durable(value: SemanticPresenceValue): Promise<unknown>;
  isVisible(): boolean;
}>;

export type SemanticPresencePublisherClock = Readonly<{
  now(): number;
  setTimeout(callback: () => void, milliseconds: number): number;
  clearTimeout(timer: number): void;
  setInterval(callback: () => void, milliseconds: number): number;
  clearInterval(timer: number): void;
}>;

function browserClock(): SemanticPresencePublisherClock {
  return {
    now: Date.now,
    setTimeout: (callback, milliseconds) => window.setTimeout(callback, milliseconds),
    clearTimeout: (timer) => window.clearTimeout(timer),
    setInterval: (callback, milliseconds) => window.setInterval(callback, milliseconds),
    clearInterval: (timer) => window.clearInterval(timer),
  };
}

/**
 * Renderer-neutral multiplayer presence cadence.
 *
 * Pointer and camera frames may call `notifyChanged` as often as they render.
 * Transient WebSocket awareness is coalesced to 20 Hz, while durable room
 * keyframes remain serialized and bounded to 1 Hz. A visible idle client also
 * refreshes liveness every 30 seconds. No late promise can restart work after
 * disposal.
 */
export class SemanticPresencePublisher {
  private readonly clock: SemanticPresencePublisherClock;
  private transientTimer: number | null = null;
  private durableTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private durableInFlight: Promise<void> | null = null;
  private durableQueued = false;
  private durableForceQueued = false;
  private lastDurableAt: number;
  private disposed = false;

  constructor(
    private readonly host: SemanticPresencePublisherHost,
    clock: SemanticPresencePublisherClock = browserClock(),
  ) {
    this.clock = clock;
    // The first visible motion/reconnect is immediately eligible for a
    // durable keyframe without special-casing an invalid timestamp.
    this.lastDurableAt = this.clock.now() - ACTIVE_PRESENCE_KEYFRAME_MS;
    this.heartbeatTimer = this.clock.setInterval(
      () => this.publishIdleKeyframeIfDue(),
      IDLE_PRESENCE_KEYFRAME_MS,
    );
  }

  /** Coalesce the latest pointer/camera frame without retaining its snapshot. */
  notifyChanged(): void {
    if (this.disposed || !this.host.isVisible()) return;
    if (this.transientTimer === null) {
      this.transientTimer = this.clock.setTimeout(() => {
        this.transientTimer = null;
        this.publishTransientNow();
      }, TRANSIENT_PRESENCE_INTERVAL_MS);
    }
    this.requestDurable(false);
  }

  /** Publish a reconnect keyframe even if the previous frame was recent. */
  connectionBecameLive(): void {
    if (this.disposed || !this.host.isVisible()) return;
    this.requestDurable(true);
  }

  /** Restore both fast awareness and durable liveness after tab visibility. */
  becameVisible(): void {
    if (this.disposed || !this.host.isVisible()) return;
    this.publishTransientNow();
    this.requestDurable(true);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.transientTimer !== null) this.clock.clearTimeout(this.transientTimer);
    if (this.durableTimer !== null) this.clock.clearTimeout(this.durableTimer);
    if (this.heartbeatTimer !== null) this.clock.clearInterval(this.heartbeatTimer);
    this.transientTimer = null;
    this.durableTimer = null;
    this.heartbeatTimer = null;
    this.durableQueued = false;
    this.durableForceQueued = false;
  }

  /** Test/cleanup observation; scheduled future keyframes are intentionally excluded. */
  async whenCurrentDurableSettles(): Promise<void> {
    await this.durableInFlight;
  }

  private publishTransientNow(): void {
    if (this.disposed || !this.host.isVisible()) return;
    const value = this.host.current();
    if (value) this.host.transient(value);
  }

  private publishIdleKeyframeIfDue(): void {
    if (
      this.disposed ||
      !this.host.isVisible() ||
      !idlePresenceKeyframeDue(this.lastDurableAt, this.clock.now())
    ) return;
    this.requestDurable(true);
  }

  private requestDurable(force: boolean): void {
    if (this.disposed || !this.host.isVisible()) return;
    if (this.durableInFlight) {
      this.durableQueued = true;
      this.durableForceQueued ||= force;
      return;
    }

    const delay = force ? 0 : activePresenceDelay(this.lastDurableAt, this.clock.now());
    if (delay > 0) {
      if (this.durableTimer === null) {
        this.durableTimer = this.clock.setTimeout(() => {
          this.durableTimer = null;
          this.requestDurable(false);
        }, delay);
      }
      return;
    }

    if (this.durableTimer !== null) {
      this.clock.clearTimeout(this.durableTimer);
      this.durableTimer = null;
    }
    const value = this.host.current();
    if (!value) return;

    this.lastDurableAt = this.clock.now();
    let durableResult: Promise<unknown>;
    try {
      durableResult = this.host.durable(value);
    } catch (error) {
      durableResult = Promise.reject(error);
    }
    const operation = Promise.resolve(durableResult)
      .catch(() => undefined)
      .then(() => {
        if (this.durableInFlight !== operation) return;
        this.durableInFlight = null;
        if (this.disposed || !this.durableQueued) return;
        const forceQueued = this.durableForceQueued;
        this.durableQueued = false;
        this.durableForceQueued = false;
        this.requestDurable(forceQueued);
      });
    this.durableInFlight = operation;
  }
}
