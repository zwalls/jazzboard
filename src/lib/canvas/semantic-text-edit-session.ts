import type {
  CanvasObject,
  ConnectorObject,
  CreateCanvasObject,
  ImageObject,
  NodeMetadata,
  NodeMetadataInput,
  ShapeObject,
  TextObject,
} from "@/lib/domain/types";

import type {
  SemanticCanvasEditEvent,
  SemanticCanvasGestureCancelRequestedEvent,
  SemanticCanvasGestureFinishRequestedEvent,
  SemanticCanvasGestureStartedEvent,
  SemanticCanvasObjectsChangedEvent,
} from "./semantic-edit-events";

/** The two authoritative string fields edited by the first-party canvas. */
export type SemanticTextEditField = "content" | "label" | "alt";

export type SemanticTextEditableObject = TextObject | ShapeObject | ConnectorObject | ImageObject;

/**
 * These limits intentionally mirror `createCanvasObjectSchema` and the canvas
 * update patch schema. Neither field has a minimum length, so an empty string
 * is a valid, durable value and must not be interpreted as cancellation.
 */
export const SEMANTIC_TEXT_EDIT_LIMITS = Object.freeze({
  content: 20_000,
  label: 10_000,
  alt: 2_000,
}) satisfies Readonly<Record<SemanticTextEditField, number>>;

/** Opaque, monotonically fenced identity for one edit attempt. */
export type SemanticTextEditSessionToken = Readonly<{
  sessionId: string;
  fence: number;
}>;

export type SemanticTextEditSession = Readonly<{
  token: SemanticTextEditSessionToken;
  gestureId: string;
  objectId: string;
  objectKind: SemanticTextEditableObject["kind"];
  field: SemanticTextEditField;
  /** Immutable optimistic-concurrency base captured when editing starts. */
  baseRevision: number;
  /** Immutable object identity fence captured alongside baseRevision. */
  baseCreatedAt: number;
  initialValue: string;
  /** Frame-immediate local value; it changes synchronously on `updateDraft`. */
  draftValue: string;
  dirty: boolean;
}>;

export type SemanticTextEditStaleResult = Readonly<{
  status: "stale";
  token: SemanticTextEditSessionToken;
}>;

export type SemanticTextEditDraftUpdated = Readonly<{
  status: "updated";
  session: SemanticTextEditSession;
  /** Absolute drafts feed the shared debounce/persistence lifecycle. */
  lifecycleEvents: readonly SemanticCanvasObjectsChangedEvent[];
}>;

export type SemanticTextEditCommitted = Readonly<{
  status: "committed";
  session: SemanticTextEditSession;
  /** Persistence is exclusively owned by the shared lifecycle driver. */
  command: null;
  lifecycleEvents: readonly SemanticCanvasEditEvent[];
}>;

/**
 * Engine-local cancellation signal. It must never be translated to text-blur
 * or text-commit. The paired dedicated lifecycle-cancel event keeps protection
 * active until the host fences work, reconciles authority, and releases the
 * lease before beginning another edit.
 */
export type SemanticTextEditCancelledSignal = Readonly<{
  type: "text-session.cancelled";
  gestureId: string;
  objectId: string;
  baseRevision: number;
  baseCreatedAt: number;
  restore: Readonly<{
    field: SemanticTextEditField;
    value: string;
  }>;
}>;

export type SemanticTextEditCancelled = Readonly<{
  status: "cancelled";
  /** A terminal snapshot whose draft has been restored to the base value. */
  session: SemanticTextEditSession;
  signal: SemanticTextEditCancelledSignal;
  command: null;
  /** Dedicated recovery path; this is never translated into a successful finish. */
  lifecycleEvents: readonly [SemanticCanvasGestureCancelRequestedEvent];
}>;

export type SemanticTextEditStarted = Readonly<{
  status: "started";
  session: SemanticTextEditSession;
  lifecycleEvent: SemanticCanvasGestureStartedEvent;
  /**
   * Starting while another session is active fences the former session and
   * returns the cancellation work the host must perform for it.
   */
  superseded: SemanticTextEditCancelled | null;
}>;

export class SemanticTextEditSessionError extends Error {
  constructor(
    readonly code: "INVALID_VALUE" | "NON_EDITABLE_OBJECT",
    message: string,
  ) {
    super(message);
    this.name = "SemanticTextEditSessionError";
  }
}

type InternalSession = {
  snapshot: SemanticTextEditSession;
  baseDraft: Extract<CreateCanvasObject, { kind: "text" | "shape" | "connector" | "image" }>;
};

function freezeToken(sessionId: string, fence: number): SemanticTextEditSessionToken {
  return Object.freeze({ sessionId, fence });
}

function freezeSession(
  session: Omit<SemanticTextEditSession, "token"> & {
    token: SemanticTextEditSessionToken;
  },
): SemanticTextEditSession {
  return Object.freeze({ ...session });
}

function valueFor(object: SemanticTextEditableObject): string {
  if (object.kind === "text") return object.content;
  if (object.kind === "image") return object.alt;
  return object.label;
}

function fieldFor(object: SemanticTextEditableObject): SemanticTextEditField {
  if (object.kind === "text") return "content";
  if (object.kind === "image") return "alt";
  return "label";
}

function nodeMetadataInput(metadata: NodeMetadata | null | undefined): NodeMetadataInput | null | undefined {
  if (metadata === undefined || metadata === null) return metadata;
  const { kind, status, owner, resolution } = metadata;
  return { kind, status, owner, resolution } as NodeMetadataInput;
}

function createDraftFromObject(
  object: SemanticTextEditableObject,
): Extract<CreateCanvasObject, { kind: "text" | "shape" | "connector" | "image" }> {
  const {
    revision: _revision,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    createdBy: _createdBy,
    lastEditedBy: _lastEditedBy,
    diagramIds: _diagramIds,
    ...draft
  } = object;
  void _revision;
  void _createdAt;
  void _updatedAt;
  void _createdBy;
  void _lastEditedBy;
  void _diagramIds;

  if (draft.kind === "shape") return Object.freeze({
    ...draft,
    nodeMetadata: nodeMetadataInput(draft.nodeMetadata),
  });
  if (draft.kind === "connector") return Object.freeze({
    ...draft,
    start: { ...draft.start, normalizedAnchor: draft.start.normalizedAnchor ? { ...draft.start.normalizedAnchor } : draft.start.normalizedAnchor },
    end: { ...draft.end, normalizedAnchor: draft.end.normalizedAnchor ? { ...draft.end.normalizedAnchor } : draft.end.normalizedAnchor },
    routing: draft.routing ? { ...draft.routing } : undefined,
  });
  return Object.freeze({ ...draft });
}

function withDraftValue(
  baseDraft: InternalSession["baseDraft"],
  value: string,
): InternalSession["baseDraft"] {
  if (baseDraft.kind === "text") return Object.freeze({ ...baseDraft, content: value });
  if (baseDraft.kind === "image") return Object.freeze({ ...baseDraft, alt: value });
  return Object.freeze({ ...baseDraft, label: value });
}

function assertEditableObject(object: CanvasObject): asserts object is SemanticTextEditableObject {
  if (object.kind === "image" && object.locked) {
    throw new SemanticTextEditSessionError("NON_EDITABLE_OBJECT", "Unlock the image before editing its alt text.");
  }
  if (object.kind === "text" || object.kind === "shape" || object.kind === "connector" || object.kind === "image") return;
  throw new SemanticTextEditSessionError(
    "NON_EDITABLE_OBJECT",
    `A ${object.kind} object does not expose first-party text editing.`,
  );
}

function assertDraftValue(field: SemanticTextEditField, value: string): void {
  const maxLength = SEMANTIC_TEXT_EDIT_LIMITS[field];
  if (value.length <= maxLength) return;
  throw new SemanticTextEditSessionError(
    "INVALID_VALUE",
    `${field} must contain at most ${maxLength} characters.`,
  );
}

function changedEventFor(
  internal: InternalSession,
): SemanticCanvasObjectsChangedEvent {
  const { snapshot } = internal;
  return Object.freeze({
    type: "objects.changed",
    gestureId: snapshot.gestureId,
    changes: Object.freeze([
      Object.freeze({
        kind: "update",
        draft: withDraftValue(internal.baseDraft, snapshot.draftValue),
        baseRevision: snapshot.baseRevision,
        baseCreatedAt: snapshot.baseCreatedAt,
        operation: "edit",
      }),
    ]),
  });
}

function finishEventFor(session: SemanticTextEditSession): SemanticCanvasGestureFinishRequestedEvent {
  return Object.freeze({
    type: "gesture.finish-requested",
    gestureId: session.gestureId,
    reason: "text-commit",
  });
}

function cancellationFor(session: SemanticTextEditSession): SemanticTextEditCancelled {
  const restored = freezeSession({
    ...session,
    draftValue: session.initialValue,
    dirty: false,
  });
  return Object.freeze({
    status: "cancelled",
    session: restored,
    signal: Object.freeze({
      type: "text-session.cancelled",
      gestureId: restored.gestureId,
      objectId: restored.objectId,
      baseRevision: restored.baseRevision,
      baseCreatedAt: restored.baseCreatedAt,
      restore: Object.freeze({ field: restored.field, value: restored.initialValue }),
    }),
    command: null,
    lifecycleEvents: Object.freeze([
      Object.freeze({
        type: "gesture.cancel-requested",
        gestureId: restored.gestureId,
        reason: "text-cancel",
      }),
    ] as const),
  });
}

/**
 * Renderer-neutral, synchronous state machine for one active text edit.
 *
 * It deliberately owns no DOM state, animation-frame scheduling, lease I/O,
 * command dispatch, or renderer records. The host renders `draftValue`
 * immediately and routes its lifecycle events through the shared persistence
 * driver. Commit is only a final-flush boundary; it never creates a command.
 */
export class SemanticTextEditSessionEngine {
  private nextFence = 0;
  private active: InternalSession | null = null;

  begin(object: CanvasObject): SemanticTextEditStarted {
    assertEditableObject(object);

    const superseded = this.active ? cancellationFor(this.active.snapshot) : null;
    const fence = ++this.nextFence;
    const sessionId = `semantic-text:${fence}:${object.id}`;
    const token = freezeToken(sessionId, fence);
    const initialValue = valueFor(object);
    assertDraftValue(fieldFor(object), initialValue);
    const snapshot = freezeSession({
      token,
      gestureId: sessionId,
      objectId: object.id,
      objectKind: object.kind,
      field: fieldFor(object),
      baseRevision: object.revision,
      baseCreatedAt: object.createdAt,
      initialValue,
      draftValue: initialValue,
      dirty: false,
    });
    this.active = { snapshot, baseDraft: createDraftFromObject(object) };

    return Object.freeze({
      status: "started",
      session: snapshot,
      lifecycleEvent: Object.freeze({
        type: "gesture.started",
        gestureId: snapshot.gestureId,
        source: "text",
        objects: Object.freeze([
          Object.freeze({
            objectId: snapshot.objectId,
            baseRevision: snapshot.baseRevision,
            baseCreatedAt: snapshot.baseCreatedAt,
            operation: "edit",
          }),
        ]),
      }),
      superseded,
    });
  }

  current(): SemanticTextEditSession | null {
    return this.active?.snapshot ?? null;
  }

  isCurrent(token: SemanticTextEditSessionToken): boolean {
    return this.matches(token);
  }

  updateDraft(
    token: SemanticTextEditSessionToken,
    value: string,
  ): SemanticTextEditDraftUpdated | SemanticTextEditStaleResult {
    if (!this.matches(token)) return Object.freeze({ status: "stale", token });
    const active = this.active!;
    const previousValue = active.snapshot.draftValue;
    assertDraftValue(active.snapshot.field, value);
    active.snapshot = freezeSession({
      ...active.snapshot,
      draftValue: value,
      dirty: value !== active.snapshot.initialValue,
    });
    return Object.freeze({
      status: "updated",
      session: active.snapshot,
      lifecycleEvents: previousValue === value
        ? Object.freeze([])
        : Object.freeze([changedEventFor(active)]),
    });
  }

  commit(
    token: SemanticTextEditSessionToken,
  ): SemanticTextEditCommitted | SemanticTextEditStaleResult {
    if (!this.matches(token)) return Object.freeze({ status: "stale", token });
    const active = this.active!;
    const finish = finishEventFor(active.snapshot);
    this.active = null;
    const lifecycleEvents: readonly SemanticCanvasEditEvent[] = Object.freeze([finish]);
    return Object.freeze({
      status: "committed",
      session: active.snapshot,
      command: null,
      lifecycleEvents,
    });
  }

  cancel(
    token: SemanticTextEditSessionToken,
  ): SemanticTextEditCancelled | SemanticTextEditStaleResult {
    if (!this.matches(token)) return Object.freeze({ status: "stale", token });
    const cancelled = cancellationFor(this.active!.snapshot);
    this.active = null;
    return cancelled;
  }

  private matches(token: SemanticTextEditSessionToken): boolean {
    const current = this.active?.snapshot.token;
    return current?.fence === token.fence && current.sessionId === token.sessionId;
  }
}
