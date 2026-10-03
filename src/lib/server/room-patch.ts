import type { RoomState } from "@/lib/domain/types";
import type { RoomPatch } from "@/lib/realtime/room-patch";

const MAX_DOCUMENT_FINGERPRINT_BYTES = 1024 * 1024;

/** Immutable serialized values also detect normalization without a revision bump. */
export type DocumentFingerprints = {
  objects: ReadonlyMap<string, string>;
  diagrams: ReadonlyMap<string, string>;
};

export function fingerprintRoomDocument(room: RoomState, previous?: DocumentFingerprints | null): DocumentFingerprints | null {
  let bytes = 0;
  let unchanged = Boolean(previous);
  const capture = (records: RoomState["objects"] | RoomState["diagrams"], prior?: ReadonlyMap<string, string>) => {
    const result = new Map<string, string>();
    if (prior?.size !== Object.keys(records).length) unchanged = false;
    for (const [id, value] of Object.entries(records)) {
      const serialized = JSON.stringify(value);
      bytes += Buffer.byteLength(serialized) + Buffer.byteLength(id);
      if (bytes > MAX_DOCUMENT_FINGERPRINT_BYTES) return null;
      const old = prior?.get(id);
      if (old !== serialized) unchanged = false;
      result.set(id, old === serialized ? old : serialized);
    }
    return result;
  };
  const objects = capture(room.objects, previous?.objects);
  if (!objects) return null;
  const diagrams = capture(room.diagrams, previous?.diagrams);
  if (!diagrams) return null;
  return unchanged && previous ? previous : { objects, diagrams };
}

export function buildRoomPatch(
  room: RoomState,
  before: DocumentFingerprints | null,
  after: DocumentFingerprints | null,
  baseStateRevision: number,
  baseRoomRevision: number,
): RoomPatch | null {
  if (!before || !after || baseStateRevision < 0 || baseRoomRevision < 0) return null;
  const changed = <T>(records: Record<string, T>, old: ReadonlyMap<string, string>, next: ReadonlyMap<string, string>) =>
    Object.fromEntries(Object.entries(records).filter(([id]) => old.get(id) !== next.get(id)));
  const removed = (old: ReadonlyMap<string, string>, next: ReadonlyMap<string, string>) =>
    [...old.keys()].filter((id) => !next.has(id));
  const objects = changed(room.objects, before.objects, after.objects);
  const diagrams = changed(room.diagrams, before.diagrams, after.diagrams);
  const deletedObjectIds = removed(before.objects, after.objects);
  const deletedDiagramIds = removed(before.diagrams, after.diagrams);
  // Large replacements use the existing snapshot path and reset the baseline.
  if (Object.keys(objects).length + deletedObjectIds.length > Math.max(64, after.objects.size * 0.75)) return null;
  const metadata = Object.fromEntries(
    Object.entries(room).filter(([key]) => key !== "objects" && key !== "diagrams"),
  ) as Omit<RoomState, "objects" | "diagrams">;
  return { baseStateRevision, baseRoomRevision, room: metadata, objects, diagrams, deletedObjectIds, deletedDiagramIds };
}
