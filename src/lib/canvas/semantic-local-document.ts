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

type Listener = () => void;

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
  private readonly overrides = new Map<string, SemanticLocalObjectOverride>();
  private readonly listeners = new Set<Listener>();
  private disposed = false;

  constructor(room: RoomState) {
    this.authoritative = room;
    this.projected = room;
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
  acceptAuthoritative(room: RoomState): boolean {
    if (this.disposed || room.id !== this.authoritative.id) return false;
    const currentStateRevision = roomStateRevision(this.authoritative);
    const nextStateRevision = roomStateRevision(room);
    const reconciled = reconcileRoomSnapshot(this.authoritative, room);
    if (reconciled) {
      this.authoritative = reconciled;
      this.reproject();
      return true;
    }
    if (
      nextStateRevision === currentStateRevision &&
      room.roomRevision === this.authoritative.roomRevision &&
      (
        room.objects !== this.authoritative.objects ||
        room.diagrams !== this.authoritative.diagrams ||
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
    this.authoritative = room;
    this.reproject();
    return true;
  }

  applyOverride(override: SemanticLocalObjectOverride): boolean {
    if (this.disposed) return false;
    const objectId = objectIdForOverride(override);
    const current = this.overrides.get(objectId);
    if (current && compareFence(override, current) < 0) return false;
    this.overrides.set(objectId, override);
    this.reproject();
    return true;
  }

  /** Clear only the exact local generation whose authority is now installed. */
  clearAcknowledged(objectId: string, fence: SemanticLocalObjectFence): boolean {
    if (this.disposed) return false;
    const current = this.overrides.get(objectId);
    if (!current || compareFence(current, fence) !== 0) return false;
    this.overrides.delete(objectId);
    this.reproject();
    return true;
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

  private reproject(): void {
    if (!this.overrides.size) {
      this.projected = this.authoritative;
      this.emit();
      return;
    }
    const objects = { ...this.authoritative.objects };
    for (const override of this.overrides.values()) {
      if (override.kind === "delete") delete objects[override.objectId];
      else objects[override.object.id] = override.object;
    }
    this.projected = { ...this.authoritative, objects };
    this.emit();
  }

  private emit(): void {
    if (this.disposed) return;
    for (const listener of this.listeners) listener();
  }
}
