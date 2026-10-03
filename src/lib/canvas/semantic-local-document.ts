import { roomStateRevision } from "@/lib/realtime/events";
import type { CanvasObject, RoomState } from "@/lib/domain/types";
import { reconcileRoomSnapshot } from "@/lib/client/room-reconciliation";

export type SemanticLocalObjectFence = Readonly<{
  generation: number;
  recoveryEpoch: number;
}>;

export type SemanticLocalObjectOverride = SemanticLocalObjectFence &
  Readonly<
    | { kind: "upsert"; object: CanvasObject }
    | { kind: "delete"; objectId: string }
  >;

export type SemanticAuthoritativeRoomOptions = Readonly<{
  /** The room hook already owns canonical document-record sharing. */
  canonicalDocument?: boolean;
}>;

type Listener = () => void;

/** Map wrappers may differ after independent reconciliation of one decoded room. */
function sharesDocumentRecords(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  if (left === right) return true;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length
    && keys.every((key) => Object.hasOwn(right, key) && left[key] === right[key]);
}

function objectIdForOverride(override: SemanticLocalObjectOverride): string {
  return override.kind === "upsert" ? override.object.id : override.objectId;
}

function compareFence(
  left: SemanticLocalObjectFence,
  right: SemanticLocalObjectFence,
): number {
  return left.recoveryEpoch - right.recoveryEpoch || left.generation - right.generation;
}

/**
 * Renderer-neutral authoritative document plus generation-fenced local pixels.
 *
 * Incoming room snapshots always advance the authoritative layer, including
 * presence and lease state, but never replace an optimistic object override.
 * A save acknowledgement must first install its returned room and only then
 * clear the exact generation it acknowledged. Older acknowledgements are
 * therefore harmless while a newer local generation is visible.
 */
export class SemanticLocalDocumentStore {
  private authoritative: RoomState;
  private projected: RoomState;
  private projectedAuthoritativeObjects: RoomState["objects"];
  private readonly overrides = new Map<string, SemanticLocalObjectOverride>();
  private readonly listeners = new Set<Listener>();
  private disposed = false;

  constructor(room: RoomState) {
    this.authoritative = room;
    this.projected = room;
    this.projectedAuthoritativeObjects = room.objects;
  }

  getSnapshot = (): RoomState => this.projected;

  getAuthoritativeRoom(): RoomState {
    return this.authoritative;
  }

  getOverride(objectId: string): SemanticLocalObjectOverride | undefined {
    return this.overrides.get(objectId);
  }

  optimisticObjectIds(): ReadonlySet<string> {
    return new Set(this.overrides.keys());
  }

  subscribe = (listener: Listener): (() => void) => {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /**
   * Accept aggregate-monotonic room state. An equal-watermark value is allowed
   * only when it structurally shares the complete authoritative document and
   * coordination planes; this is the socket-local transient-presence path.
   * A separately decoded equal snapshot can never replace document objects.
   */
  acceptAuthoritative(room: RoomState, options: SemanticAuthoritativeRoomOptions = {}): boolean {
    if (this.disposed || room.id !== this.authoritative.id) return false;
    const currentStateRevision = roomStateRevision(this.authoritative);
    const nextStateRevision = roomStateRevision(room);
    const reconciled = reconcileRoomSnapshot(this.authoritative, room, {
      shareDocumentRecords: !options.canonicalDocument,
    });
    if (reconciled) {
      this.authoritative = reconciled;
      this.reproject(false);
      return true;
    }
    if (
      nextStateRevision === currentStateRevision &&
      room.roomRevision === this.authoritative.roomRevision &&
      (
        !sharesDocumentRecords(room.objects, this.authoritative.objects) ||
        !sharesDocumentRecords(room.diagrams, this.authoritative.diagrams) ||
        room.leases !== this.authoritative.leases ||
        room.spotlight !== this.authoritative.spotlight ||
        room.agentEditPolicy !== this.authoritative.agentEditPolicy ||
        room.reviewProposals !== this.authoritative.reviewProposals
      )
    ) {
      return false;
    }
    if (
      nextStateRevision !== currentStateRevision ||
      room.roomRevision !== this.authoritative.roomRevision
    ) return false;
    if (room === this.authoritative) return false;
    // Preserve the store's document-map identities when the hook and store
    // independently shared the same decoded records into different wrappers.
    // No separately decoded entity is trusted at an equal watermark.
    this.authoritative = room.objects === this.authoritative.objects
      && room.diagrams === this.authoritative.diagrams
      ? room
      : { ...room, objects: this.authoritative.objects, diagrams: this.authoritative.diagrams };
    this.reproject(false);
    return true;
  }

  applyOverride(override: SemanticLocalObjectOverride): boolean {
    return this.applyOverrides([override]);
  }

  /** Publish the complete intent synchronously, with no partially moved group. */
  applyOverrides(overrides: readonly SemanticLocalObjectOverride[]): boolean {
    if (this.disposed) return false;
    let changed = false;
    for (const override of overrides) {
      const objectId = objectIdForOverride(override);
      const current = this.overrides.get(objectId);
      if (current && compareFence(override, current) < 0) continue;
      this.overrides.set(objectId, override);
      changed = true;
    }
    if (changed) this.reproject();
    return changed;
  }

  /** Clear only the exact local generation whose authority is now installed. */
  clearAcknowledged(objectId: string, fence: SemanticLocalObjectFence): boolean {
    return this.clearAcknowledgedMany([{ objectId, ...fence }]);
  }

  clearAcknowledgedMany(
    acknowledgements: readonly (SemanticLocalObjectFence & { objectId: string })[],
  ): boolean {
    if (this.disposed) return false;
    let changed = false;
    for (const { objectId, ...fence } of acknowledgements) {
      const current = this.overrides.get(objectId);
      if (!current || compareFence(current, fence) !== 0) continue;
      this.overrides.delete(objectId);
      changed = true;
    }
    if (changed) this.reproject();
    return changed;
  }

  /**
   * Deliberate rollback path after conflict/failure/cancel. The caller supplies
   * the best authoritative refresh available; an older response cannot replace
   * a newer accepted room, but the requested local overrides are still removed.
   */
  forceRecover(room: RoomState, objectIds: readonly string[]): void {
    if (this.disposed || room.id !== this.authoritative.id) return;
    if (roomStateRevision(room) > roomStateRevision(this.authoritative)) {
      this.authoritative = room;
    }
    for (const objectId of objectIds) this.overrides.delete(objectId);
    this.reproject();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.overrides.clear();
    this.listeners.clear();
  }

  private reproject(overridesChanged = true): void {
    if (!this.overrides.size) {
      this.projected = this.authoritative;
    } else if (!overridesChanged && this.projectedAuthoritativeObjects === this.authoritative.objects) {
      // Coordination-only arrivals must not invalidate optimistic document
      // identities; observers still receive the new presence/lease envelope.
      this.projected = { ...this.authoritative, objects: this.projected.objects };
    } else {
      const objects = { ...this.authoritative.objects };
      for (const override of this.overrides.values()) {
        if (override.kind === "delete") delete objects[override.objectId];
        else objects[override.object.id] = override.object;
      }
      this.projected = { ...this.authoritative, objects };
    }
    this.projectedAuthoritativeObjects = this.authoritative.objects;
    this.emit();
  }

  private emit(): void {
    if (this.disposed) return;
    for (const listener of this.listeners) listener();
  }
}
