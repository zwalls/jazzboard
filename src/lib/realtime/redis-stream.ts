import type { RoomEvent } from "@/lib/domain/types";

import { isRoomEvent, laterStreamCursor, parseStreamCursor } from "./protocol";

export type RealtimeStreamRecord = {
  cursor: string;
  event: RoomEvent;
};

function text(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return null;
}

function parseEntry(value: unknown): RealtimeStreamRecord | null {
  if (!Array.isArray(value) || value.length !== 2 || !Array.isArray(value[1])) return null;
  const cursor = text(value[0]);
  if (!cursor || parseStreamCursor(cursor) === null) return null;

  const fields = value[1];
  let encodedEvent: string | null = null;
  let encodedRoomId: string | null = null;
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const key = text(fields[index]);
    const fieldValue = text(fields[index + 1]);
    if (key === "data") encodedEvent = fieldValue;
    if (key === "roomId") encodedRoomId = fieldValue;
  }
  if (!encodedEvent) return null;

  try {
    const event: unknown = JSON.parse(encodedEvent);
    if (!isRoomEvent(event) || (encodedRoomId && encodedRoomId !== event.roomId)) return null;
    return { cursor, event };
  } catch {
    return null;
  }
}

export function decodeStreamEntries(value: unknown): RealtimeStreamRecord[] {
  if (!Array.isArray(value)) return [];
  return value.map(parseEntry).filter((entry): entry is RealtimeStreamRecord => entry !== null);
}

export function latestCursorFromStreamEntries(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  let latest: string | null = null;
  for (const entry of value) {
    if (!Array.isArray(entry)) continue;
    const cursor = text(entry[0]);
    latest = laterStreamCursor(latest, parseStreamCursor(cursor));
  }
  return latest;
}

export function decodeXRead(value: unknown): RealtimeStreamRecord[] {
  if (!Array.isArray(value)) return [];
  const records: RealtimeStreamRecord[] = [];
  for (const stream of value) {
    if (!Array.isArray(stream) || stream.length !== 2) continue;
    records.push(...decodeStreamEntries(stream[1]));
  }
  return records;
}

export function latestCursorFromXRead(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  let latest: string | null = null;
  for (const stream of value) {
    if (!Array.isArray(stream) || stream.length !== 2) continue;
    latest = laterStreamCursor(latest, latestCursorFromStreamEntries(stream[1]));
  }
  return latest;
}
