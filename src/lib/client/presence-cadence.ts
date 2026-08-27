export const TRANSIENT_PRESENCE_INTERVAL_MS = 50;
export const ACTIVE_PRESENCE_KEYFRAME_MS = 1_000;
export const IDLE_PRESENCE_KEYFRAME_MS = 30_000;

export function activePresenceDelay(lastCommittedAt: number, now: number): number {
  if (!Number.isFinite(lastCommittedAt) || !Number.isFinite(now)) {
    return ACTIVE_PRESENCE_KEYFRAME_MS;
  }
  return Math.max(ACTIVE_PRESENCE_KEYFRAME_MS - (now - lastCommittedAt), 0);
}

export function idlePresenceKeyframeDue(lastCommittedAt: number, now: number): boolean {
  return Number.isFinite(lastCommittedAt) &&
    Number.isFinite(now) &&
    now - lastCommittedAt >= IDLE_PRESENCE_KEYFRAME_MS;
}
