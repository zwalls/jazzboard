import type { ConnectionState, LeaseAction, LeaseBatchAction } from "@/hooks/use-room";
import type { CanvasRuntime } from "@/lib/canvas/runtime";
import type {
  ActorKind,
  CanvasCommand,
  FollowTarget,
  ObjectLease,
  Participant,
  RoomPresenceDelta,
  RoomState,
  SemanticTransaction,
} from "@/lib/domain/types";

type CommandResult = { room: RoomState; changedObjectIds: string[] };
type SemanticTransactionResult = CommandResult & {
  changedDiagramIds: string[];
  membershipObjectIds: string[];
};
type LeaseResult = { lease: ObjectLease | null; room: RoomState };
type LeaseBatchResult = { leases: ObjectLease[]; room: RoomState };

/** Renderer-neutral commands and room chrome supplied by JazzboardRoom. */
export type CanvasSurfaceProps = {
  boardMenuActions: BoardMenuActions;
  persistentChromeHost?: HTMLElement | null;
  room: RoomState;
  self: Participant;
  followTarget: FollowTarget;
  command: (command: CanvasCommand, actorKind?: ActorKind) => Promise<CommandResult>;
  semanticTransaction: (transaction: SemanticTransaction) => Promise<SemanticTransactionResult>;
  lease: (action: LeaseAction, actorKind?: ActorKind) => Promise<LeaseResult>;
  leaseMany: (action: LeaseBatchAction, actorKind?: ActorKind) => Promise<LeaseBatchResult>;
  refresh: () => Promise<RoomState>;
  presence: (
    value: {
      cursor: { x: number; y: number } | null;
      viewport: { x: number; y: number; zoom: number; width: number; height: number } | null;
    },
    actorKind?: ActorKind,
  ) => Promise<RoomPresenceDelta>;
  transientPresence: (value: {
    cursor: { x: number; y: number } | null;
    viewport: { x: number; y: number; zoom: number; width: number; height: number } | null;
  }) => boolean;
  connection: ConnectionState;
  onSelectionChange: (objectIds: string[]) => void;
  onRuntimeChange: (runtime: CanvasRuntime | null) => void;
  onExitFollow: () => void;
  onError: (message: string, details?: unknown) => void;
};

/** Mutation capabilities supplied only to authorized participants. */
export type SemanticCanvasEditingHost = Pick<
  CanvasSurfaceProps,
  "command" | "semanticTransaction" | "lease" | "leaseMany" | "refresh" | "onError"
>;

export type CanvasSurfaceHandle = {
  prepareSelectionForAgentMessage(): Promise<{ objectIds: string[]; room: RoomState }>;
};

export type BoardMenuActions = {
  askPreparing: boolean;
  pendingReviewCount: number;
  selectionCount: number;
  onActivity(): void;
  onAsk(): void;
  onCanvasOutline(): void;
  onExport(): void;
  onReview(): void;
  onUpgradeRole(): void;
};
