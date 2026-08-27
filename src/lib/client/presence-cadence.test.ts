import { describe, expect, it } from "vitest";

import {
  ACTIVE_PRESENCE_KEYFRAME_MS,
  IDLE_PRESENCE_KEYFRAME_MS,
  TRANSIENT_PRESENCE_INTERVAL_MS,
  activePresenceDelay,
  idlePresenceKeyframeDue,
} from "./presence-cadence";

describe("presence cadence", () => {
  it("keeps transient motion smooth while bounding durable active keyframes to 1 Hz", () => {
    expect(TRANSIENT_PRESENCE_INTERVAL_MS).toBe(50);
    expect(ACTIVE_PRESENCE_KEYFRAME_MS).toBe(1_000);
    expect(activePresenceDelay(10_000, 10_050)).toBe(950);
    expect(activePresenceDelay(10_000, 11_000)).toBe(0);
    expect(activePresenceDelay(10_000, 12_500)).toBe(0);
  });

  it("persists visible idle liveness at 30 seconds, not on every pointer frame", () => {
    expect(IDLE_PRESENCE_KEYFRAME_MS).toBe(30_000);
    expect(idlePresenceKeyframeDue(10_000, 39_999)).toBe(false);
    expect(idlePresenceKeyframeDue(10_000, 40_000)).toBe(true);
  });
});
