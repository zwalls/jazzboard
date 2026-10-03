import type { RoomState } from "@/lib/domain/types";
import { isLegacyRoomEventPayload, roomStateRevision } from "./events";

/** Each patch is cumulative from one exact composed-room boundary. */
export type RoomPatch = {
  baseStateRevision: number;
  baseRoomRevision: number;
  room: Omit<RoomState, "objects" | "diagrams">;
  objects: RoomState["objects"];
  diagrams: RoomState["diagrams"];
  deletedObjectIds: string[];
  deletedDiagramIds: string[];
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function revision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validChanges(upserts: unknown, deleted: unknown, canvas: boolean): boolean {
  if (!record(upserts) || !Array.isArray(deleted)) return false;
  const deletedIds = new Set<string>();
  for (const id of deleted) {
    if (typeof id !== "string" || !id || id.length > 128 || deletedIds.has(id) || Object.hasOwn(upserts, id)) return false;
    deletedIds.add(id);
  }
  return Object.entries(upserts).every(([id, value]) =>
    id.length > 0 && id.length <= 128 && record(value) && value.id === id &&
    revision(value.revision) && typeof value.createdAt === "number" && Number.isFinite(value.createdAt) &&
    (!canvas || ["text", "shape", "connector", "image", "draw", "path"].includes(String(value.kind))),
  );
}

export function isRoomPatch(value: unknown): value is RoomPatch {
  if (!record(value) || !record(value.room)) return false;
  return revision(value.baseStateRevision) && revision(value.baseRoomRevision) &&
    value.baseStateRevision >= value.baseRoomRevision &&
    revision(value.room.stateRevision) && revision(value.room.roomRevision) &&
    value.room.stateRevision >= value.baseStateRevision && value.room.roomRevision >= value.baseRoomRevision &&
    isLegacyRoomEventPayload({ room: { ...value.room, objects: value.objects, diagrams: value.diagrams } }) &&
    validChanges(value.objects, value.deletedObjectIds, true) &&
    validChanges(value.diagrams, value.deletedDiagramIds, false);
}

/** null means a missing/base-mismatched update: request a full snapshot. */
export function applyRoomPatch(current: RoomState | null, patch: RoomPatch): RoomState | null {
  if (!current || current.id !== patch.room.id) return null;
  if (patch.room.roomRevision <= current.roomRevision && roomStateRevision(patch.room) <= roomStateRevision(current)) return current;
  if (current.roomRevision !== patch.baseRoomRevision || roomStateRevision(current) !== patch.baseStateRevision) return null;
  const objects = { ...current.objects, ...patch.objects };
  const diagrams = { ...current.diagrams, ...patch.diagrams };
  for (const id of patch.deletedObjectIds) delete objects[id];
  for (const id of patch.deletedDiagramIds) delete diagrams[id];
  return { ...patch.room, objects, diagrams };
}
