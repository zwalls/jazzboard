export type RoomRole = "participant" | "spectator";
export type ActorKind = "human" | "agent";

export type Point = {
  x: number;
  y: number;
};

export type Viewport = Point & {
  zoom: number;
  width: number;
  height: number;
};

export type ActorRef = {
  participantId: string;
  displayName: string;
  color: string;
  kind: ActorKind;
};

export type PresenceTarget = {
  cursor: Point | null;
  viewport: Viewport | null;
  lastSeenAt: number;
  activity: AgentActivity | null;
};

export type Participant = {
  participantId: string;
  displayName: string;
  color: string;
  role: RoomRole;
  joinedAt: number;
  lastSeenAt: number;
  connected: boolean;
  agentActive: boolean;
  human: PresenceTarget;
  agent: PresenceTarget;
};

/**
 * Bounded high-frequency awareness update. The durable document revision is
 * included as a fence: clients only patch a delta onto the exact document
 * generation it describes and otherwise request an authoritative snapshot.
 */
export type RoomPresenceDelta = {
  roomId: string;
  stateRevision: number;
  roomRevision: number;
  participantId: string;
  actorKind: ActorKind;
  lastSeenAt: number;
  connected: boolean;
  agentActive: boolean;
  presence: PresenceTarget;
};

export type ObjectKind = "text" | "shape" | "connector" | "image" | "draw" | "path";
export type DiagramNodeType = "service" | "component" | "requirement" | "decision" | "open_question";
export type DiagramType = "architecture" | "flow" | "hierarchy" | "system_context" | "process" | "custom";
export type LeaseOperation = "move" | "resize" | "edit" | "connect" | "delete" | "annotate";

export type DecisionStatus = "proposed" | "accepted" | "rejected" | "superseded";
export type OpenQuestionStatus = "open" | "answered" | "deferred" | "closed";

export type NodeMetadata =
  | {
      kind: "decision";
      status: DecisionStatus;
      owner: string | null;
      resolution: string | null;
      /** Server-managed time at which the node most recently entered a resolved status. */
      resolvedAt: number | null;
    }
  | {
      kind: "open_question";
      status: OpenQuestionStatus;
      owner: string | null;
      resolution: string | null;
      /** Server-managed time at which the node most recently entered a non-open status. */
      resolvedAt: number | null;
    };

export type NodeMetadataInput =
  | Omit<Extract<NodeMetadata, { kind: "decision" }>, "resolvedAt">
  | Omit<Extract<NodeMetadata, { kind: "open_question" }>, "resolvedAt">;

export type CanvasObjectBase = {
  id: string;
  kind: ObjectKind;
  /** Stable, human-readable identity for this exact canvas part. */
  semanticName?: string | null;
  /** Agent-readable classification for this exact canvas part. */
  semanticRole?: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  zIndex: number;
  revision: number;
  groupId: string | null;
  /** Authoritative reverse index maintained from Diagram membership. */
  diagramIds: string[];
  createdAt: number;
  updatedAt: number;
  createdBy: ActorRef;
  lastEditedBy: ActorRef;
};

export type TextObject = CanvasObjectBase & {
  kind: "text";
  content: string;
  color: string;
  size: "s" | "m" | "l" | "xl";
  align: "start" | "middle" | "end";
};

export type ShapeObject = CanvasObjectBase & {
  kind: "shape";
  shape: "rectangle" | "ellipse" | "diamond";
  /** Null means a generic canvas shape rather than a classified diagram node. */
  nodeType: DiagramNodeType | null;
  /** Authoritative workflow state for decision and open-question nodes. */
  nodeMetadata?: NodeMetadata | null;
  label: string;
  fill: string;
  stroke: string;
};

export type ConnectorEndpoint = Point & {
  objectId: string | null;
  /** Normalized target-local anchor; omitted on legacy persisted connectors. */
  normalizedAnchor?: Point | null;
  /** Whether normalizedAnchor, rather than the target center, is authoritative. */
  isPrecise?: boolean | null;
  /** Whether the rendered connector may enter the target instead of stopping at its edge. */
  isExact?: boolean | null;
  /** Endpoint snap intent retained across routing and rendering. */
  snap?: ConnectorEndpointSnap | null;
};

export type ConnectorEndpointSnap = "center" | "edge-point" | "edge" | "none";
export type ConnectorRoutingMode = "auto" | "straight" | "curved" | "elbow";
export type ConnectorRoutingKind = Exclude<ConnectorRoutingMode, "auto">;
export type ConnectorLabelPositionSource = "generated" | "authored";

/** Caller intent before the server resolves deterministic ports and obstacle avoidance. */
export type ConnectorRoutingInput = {
  mode: ConnectorRoutingMode;
  bend?: number;
  elbowMidPoint?: number;
  labelPosition?: number;
};

/** Canonical persisted intent plus its concrete renderer-neutral resolution. */
export type ConnectorRouting = {
  mode: ConnectorRoutingMode;
  kind: ConnectorRoutingKind;
  bend: number;
  elbowMidPoint: number;
  labelPosition: number;
  /**
   * Distinguishes an automatic solver result from an explicit caller choice.
   * Optional so rooms persisted before this marker remain readable.
   */
  labelPositionSource?: ConnectorLabelPositionSource;
};

export type ConnectorObject = CanvasObjectBase & {
  kind: "connector";
  start: ConnectorEndpoint;
  end: ConnectorEndpoint;
  /** Optional only so persisted pre-routing rooms remain readable until normalization. */
  routing?: ConnectorRouting;
  direction: "none" | "end" | "both";
  label: string;
  color: string;
};

export type ImageObject = CanvasObjectBase & {
  kind: "image";
  url: string;
  assetId: string | null;
  alt: string;
  mimeType: string;
  sourceUrl: string | null;
  locked: boolean;
};

export type DrawObject = CanvasObjectBase & {
  kind: "draw";
  points: Point[];
  color: string;
  size: "s" | "m" | "l";
};

export type VectorPathLineSegment = {
  kind: "line";
  to: Point;
};

export type VectorPathQuadraticSegment = {
  kind: "quadratic";
  control: Point;
  to: Point;
};

export type VectorPathCubicSegment = {
  kind: "cubic";
  control1: Point;
  control2: Point;
  to: Point;
};

export type VectorPathSegment =
  | VectorPathLineSegment
  | VectorPathQuadraticSegment
  | VectorPathCubicSegment;

/**
 * A safe, renderer-neutral vector path. Coordinates are normalized to the
 * object's unrotated local box; callers author world coordinates through the
 * WebMCP path tools and never provide raw SVG path data.
 */
export type PathObject = CanvasObjectBase & {
  kind: "path";
  start: Point;
  segments: VectorPathSegment[];
  closed: boolean;
  fill: string;
  stroke: string;
  strokeWidth: number;
  opacity: number;
  lineCap: "butt" | "round" | "square";
  lineJoin: "miter" | "round" | "bevel";
  fillRule: "nonzero" | "evenodd";
};

export type CanvasObject =
  | TextObject
  | ShapeObject
  | ConnectorObject
  | ImageObject
  | DrawObject
  | PathObject;

export type ObjectLease = {
  leaseId: string;
  objectId: string;
  actor: ActorRef;
  operation: LeaseOperation;
  objectRevision: number;
  acquiredAt: number;
  expiresAt: number;
};

export type ObjectLeaseAcquireTarget = {
  objectId: string;
  expectedRevision: number;
  operation: LeaseOperation;
};

export type ObjectLeaseTokenTarget = {
  objectId: string;
  leaseId: string;
};

export type ObjectLeaseAction =
  | ({ action: "acquire" } & ObjectLeaseAcquireTarget)
  | ({ action: "renew" } & ObjectLeaseTokenTarget)
  | ({ action: "release" } & ObjectLeaseTokenTarget)
  | { action: "acquire-many"; targets: ObjectLeaseAcquireTarget[] }
  | { action: "renew-many"; targets: ObjectLeaseTokenTarget[] }
  | { action: "release-many"; targets: ObjectLeaseTokenTarget[] };

export type Spotlight = {
  presenterId: string;
  target: ActorKind;
  startedAt: number;
  autoFollowAt: number;
  followingParticipantIds: string[];
  handoffRequest: {
    requesterId: string;
    target: ActorKind;
    requestedAt: number;
  } | null;
};

export type AgentEditPolicy = "live" | "review";
export type AgentEditProposalStatus = "pending" | "applied" | "rejected";

export type AgentEditProposalRequest =
  | { kind: "canvas_command"; command: CanvasCommand }
  | { kind: "semantic_transaction"; transaction: SemanticTransaction }
  | { kind: "layout"; layout: LayoutCommand }
  | { kind: "activity_revert"; revert: RevertActivityRequest };

export type AgentEditProposalPurpose = {
  kind: AgentEditProposalRequest["kind"];
  label: string;
  operationCount: number;
  objectIds: string[];
  diagramIds: string[];
  layout: LayoutKind | null;
};

export type AgentEditProposalReview = {
  decision: "approved" | "rejected";
  reviewer: ActorRef;
  reviewedAt: number;
  note: string | null;
  appliedRoomRevision: number | null;
  activityId: string | null;
};

export type AgentEditProposal = {
  id: string;
  roomId: string;
  revision: number;
  status: AgentEditProposalStatus;
  createdAt: number;
  updatedAt: number;
  baselineRoomRevision: number;
  author: ActorRef;
  intent: string | null;
  summary: string | null;
  purpose: AgentEditProposalPurpose;
  /** Exact validated agent request, retained for conflict-safe replay. */
  request: AgentEditProposalRequest;
  review: AgentEditProposalReview | null;
};

export type AgentEditProposalSummary = Omit<AgentEditProposal, "request">;

export type RoomState = {
  id: string;
  code: string;
  title: string;
  /**
   * Monotonic revision for the complete composed room state. Document,
   * awareness, and coordination-plane changes advance this value.
   */
  stateRevision?: number;
  /** Durable semantic document revision used by public conflict checks. */
  roomRevision: number;
  createdAt: number;
  updatedAt: number;
  participants: Record<string, Participant>;
  objects: Record<string, CanvasObject>;
  /** First-class authoritative diagram containers; the room-store normalizer migrates old persisted JSON. */
  diagrams: Record<string, Diagram>;
  leases: Record<string, ObjectLease>;
  spotlight: Spotlight | null;
  /** Server-authoritative gate for direct agent canvas mutations. */
  agentEditPolicy: AgentEditPolicy;
  /** Newest-first, bounded queue including pending and resolved proposals. */
  reviewProposals: AgentEditProposal[];
};

export type CanvasBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type Diagram = {
  id: string;
  title: string;
  description: string;
  diagramType: DiagramType;
  category: string | null;
  tags: string[];
  memberObjectIds: string[];
  connectorIds: string[];
  bounds: CanvasBounds;
  revision: number;
  createdAt: number;
  updatedAt: number;
  createdBy: ActorRef;
  lastEditedBy: ActorRef;
};

export type ActivityMutationMetadata = {
  /** Human- or agent-supplied purpose for the change. */
  intent?: string;
  /** Human- or agent-supplied concise description of the completed change. */
  summary?: string;
};

export type RoomActivityAction =
  | "canvas.create"
  | "canvas.update"
  | "canvas.move"
  | "canvas.group"
  | "canvas.delete"
  | "canvas.transaction"
  | "canvas.layout"
  | "canvas.revert";

export type ActivityRevisionGuard =
  | { state: "present"; revision: number }
  | { state: "absent" };

export type ActivityObjectChange = {
  objectId: string;
  /** Derived membership changes are restored through their Diagram records. */
  mode: "direct" | "derived_membership";
  before: CanvasObject | null;
  after: CanvasObject | null;
};

export type ActivityDiagramChange = {
  diagramId: string;
  before: Diagram | null;
  after: Diagram | null;
};

/**
 * Private persisted activity record. Full entity snapshots never leave the
 * service layer; authorized clients receive RoomActivitySummary instead.
 */
export type RoomActivity = {
  id: string;
  roomId: string;
  roomRevision: number;
  occurredAt: number;
  actor: ActorRef;
  action: RoomActivityAction;
  label: string;
  intent: string | null;
  summary: string | null;
  affectedObjectIds: string[];
  affectedDiagramIds: string[];
  affectedBounds: CanvasBounds | null;
  objectChanges: ActivityObjectChange[];
  diagramChanges: ActivityDiagramChange[];
  objectGuards: Record<string, ActivityRevisionGuard>;
  diagramGuards: Record<string, ActivityRevisionGuard>;
  revertsActivityId: string | null;
};

/** Safe, concise activity projection returned to authorized room members. */
export type RoomActivitySummary = Omit<RoomActivity, "objectChanges" | "diagramChanges">;

export type RevertObjectExpectation =
  | {
      objectId: string;
      state: "present";
      expectedRevision: number;
      leaseId?: string;
    }
  | { objectId: string; state: "absent" };

export type RevertDiagramExpectation =
  | { diagramId: string; state: "present"; expectedRevision: number }
  | { diagramId: string; state: "absent" };

export type RevertActivityRequest = {
  activityId: string;
  objectExpectations: RevertObjectExpectation[];
  diagramExpectations: RevertDiagramExpectation[];
  metadata?: ActivityMutationMetadata;
};

export type RecentRoom = {
  roomId: string;
  code: string;
  title: string;
  role: RoomRole;
  lastOpenedAt: number;
};

export type AgentActivity = {
  id: string;
  type: "reading" | "creating" | "typing" | "drawing" | "connecting" | "moving" | "annotating";
  label: string;
  objectIds: string[];
  progress: number;
  startedAt: number;
  durationMs?: number;
  fromCursor?: Point | null;
  toCursor?: Point | null;
};

/** Compact invalidation written by the snapshot-first v2 stream protocol. */
export type CompactRoomEventPayloadV2 = {
  schemaVersion: 2;
  kind: "room.invalidated";
  /** Must equal the enclosing event sequence for v2 writers. */
  roomRevision: number;
  /** Bounded reference to private activity; the stream never embeds activity snapshots. */
  activityId: string | null;
};

/**
 * Compact invalidation for split document, awareness, and coordination state.
 * The enclosing event sequence is the aggregate state revision; roomRevision
 * remains the durable semantic document revision.
 */
export type CompactRoomEventPayload = {
  schemaVersion: 3;
  kind: "room.invalidated";
  /** Must equal the enclosing event sequence. */
  stateRevision: number;
  roomRevision: number;
  /** Bounded reference to private activity; the stream never embeds activity snapshots. */
  activityId: string | null;
};

/** Directly applicable, bounded awareness transport; never contains canvas state. */
export type PresenceDeltaRoomEventPayload = Omit<RoomPresenceDelta, "roomId"> & {
  schemaVersion: 4;
  kind: "presence.delta";
};

export type LegacyRoomEventPayload = {
  /** Accepted during rolling deployment and while old stream entries age out. */
  room: RoomState;
  activity?: RoomActivitySummary | null;
};

export type RoomEventPayload =
  | CompactRoomEventPayload
  | CompactRoomEventPayloadV2
  | PresenceDeltaRoomEventPayload
  | LegacyRoomEventPayload;

export type RoomEvent = {
  id: string;
  roomId: string;
  /** Aggregate RoomState.stateRevision, not the durable document revision. */
  sequence: number;
  occurredAt: number;
  type:
    | "room.snapshot"
    | "room.updated"
    | "presence.updated"
    | "agent.activity"
    | "lease.updated"
    | "spotlight.updated";
  actor: ActorRef | null;
  payload: RoomEventPayload;
};

type CreateCanvasObjectBase<ObjectType extends CanvasObject> = Omit<
  ObjectType,
  | "revision"
  | "createdAt"
  | "updatedAt"
  | "createdBy"
  | "lastEditedBy"
  | "diagramIds"
  | (ObjectType extends ShapeObject ? "nodeType" | "nodeMetadata" : never)
> &
  (ObjectType extends ShapeObject
    ? { nodeType?: DiagramNodeType | null; nodeMetadata?: NodeMetadataInput | null }
    : object);

export type CreateCanvasObject = CanvasObject extends infer ObjectType
  ? ObjectType extends CanvasObject
    ? CreateCanvasObjectBase<ObjectType>
    : never
  : never;

export type ObjectPatch = CanvasObject extends infer ObjectType
  ? ObjectType extends CanvasObject
    ? Partial<
        Omit<
          ObjectType,
          | "id"
          | "kind"
          | "revision"
          | "createdAt"
          | "createdBy"
          | "updatedAt"
          | "lastEditedBy"
          | "diagramIds"
          | (ObjectType extends ShapeObject ? "nodeMetadata" : never)
        >
      > & (ObjectType extends ShapeObject ? { nodeMetadata?: NodeMetadataInput | null } : object)
    : never
  : never;

export type CanvasCommand =
  | { type: "create"; object: CreateCanvasObject }
  | {
      type: "update";
      objectId: string;
      expectedRevision: number;
      patch: ObjectPatch;
      leaseId?: string;
      operation: LeaseOperation;
    }
  | {
      type: "delete";
      targets: Array<{ objectId: string; expectedRevision: number; leaseId?: string }>;
    }
  | {
      type: "move";
      targets: Array<{
        objectId: string;
        expectedRevision: number;
        x: number;
        y: number;
        leaseId?: string;
      }>;
    }
  | {
      type: "group";
      targets: Array<{ objectId: string; expectedRevision: number; leaseId?: string }>;
      groupId: string | null;
    };

export type CreateDiagram = Omit<
  Diagram,
  "revision" | "createdAt" | "updatedAt" | "createdBy" | "lastEditedBy" | "bounds"
>;

export type DiagramPatch = Partial<
  Pick<
    Diagram,
    "title" | "description" | "diagramType" | "category" | "tags" | "memberObjectIds" | "connectorIds"
  >
>;

export type DiagramCommand =
  | { type: "diagram.create"; diagram: CreateDiagram }
  | {
      type: "diagram.update";
      diagramId: string;
      expectedRevision: number;
      patch: DiagramPatch;
    };

export type SemanticTransaction = {
  commands: CanvasCommand[];
  diagramCommands: DiagramCommand[];
  /** Optional post-create layout committed inside the same all-or-nothing transaction. */
  autoLayout?: LayoutCommand;
};

export type LayoutKind = "flow" | "grid" | "hierarchy";
export type LayoutDirection = "right" | "down";
export type LayoutDensity = "comfortable" | "compact";

export type LayoutCommand = {
  layout: LayoutKind;
  direction: LayoutDirection;
  density?: LayoutDensity;
  targets: Array<{
    objectId: string;
    expectedRevision: number;
    leaseId?: string;
  }>;
  origin?: Point;
  /** Optional caller minimum; density and connector-label clearance can make it larger. */
  primaryGap?: number;
  /** Optional caller minimum; density and connector-label clearance can make it larger. */
  secondaryGap?: number;
  columns?: number;
  diagramId?: string;
  expectedDiagramRevision?: number;
};

export type FollowTarget = {
  participantId: string;
  kind: ActorKind;
} | null;

export type ObjectBusyDetails = {
  objectId: string;
  actor: ActorRef;
  operation: LeaseOperation;
  currentRevision: number;
  expiresAt: number;
};
