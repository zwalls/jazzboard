import { z } from "zod";

import { parseRoomAssetProxyReference } from "@/lib/assets/policy";
import { computeAffectedConnectorIds } from "@/lib/domain/connector-dependencies";
import { createCanvasObjectSchema } from "@/lib/domain/schemas";
import type {
  CanvasObject,
  CreateCanvasObject,
  NodeMetadata,
  NodeMetadataInput,
  Point,
  RoomRole,
  RoomState,
} from "@/lib/domain/types";

import type {
  SemanticCanvasEditEvent,
  SemanticCanvasGestureDependenciesAddedEvent,
  SemanticCanvasGestureFinishRequestedEvent,
  SemanticCanvasGestureStartedEvent,
  SemanticCanvasObjectsChangedEvent,
} from "./semantic-edit-events";
import {
  planSemanticZOrder,
  SemanticZOrderError,
  type SemanticZOrderDirection,
} from "./semantic-z-order";

export const SEMANTIC_KEYBOARD_LIMITS = Object.freeze({
  maxOperations: 200,
  defaultPasteOffset: Object.freeze({ x: 24, y: 24 }),
  maxCoordinate: 1_000_000_000,
});

export const SEMANTIC_CANVAS_CLIPBOARD_FORMAT =
  "application/x-jazzboard-semantic-canvas+json" as const;

export type SemanticCanvasKeyboardEvent = Readonly<{
  key: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  defaultPrevented?: boolean;
  isComposing?: boolean;
  target?: unknown;
}>;

export type SemanticCanvasShortcut =
  | Readonly<{ type: "undo" }>
  | Readonly<{ type: "redo" }>
  | Readonly<{ type: "delete-selection" }>
  | Readonly<{ type: "select-all" }>
  | Readonly<{ type: "escape" }>
  | Readonly<{ type: "edit-text" }>
  | Readonly<{ type: "nudge"; delta: Readonly<Point> }>
  | Readonly<{ type: "copy" }>
  | Readonly<{ type: "cut" }>
  | Readonly<{ type: "paste" }>
  | Readonly<{ type: "duplicate" }>
  | Readonly<{ type: "group" }>
  | Readonly<{ type: "ungroup" }>
  | Readonly<{ type: "order-forward" }>
  | Readonly<{ type: "order-backward" }>;

export type SemanticClipboardEntry = Readonly<{
  sourceObjectId: string;
  draft: CreateCanvasObject;
}>;

/**
 * Clipboard payloads contain semantic create drafts only. They intentionally
 * omit object/diagram revisions, attribution, and Diagram reverse membership.
 */
export type SemanticCanvasClipboardPayload = Readonly<{
  format: typeof SEMANTIC_CANVAS_CLIPBOARD_FORMAT;
  version: 1;
  /** Private asset references make the payload valid in exactly one room. */
  roomId: string;
  objects: readonly SemanticClipboardEntry[];
}>;

export type SemanticKeyboardSelection = Readonly<{
  objectIds: readonly string[];
  groupIds?: readonly string[];
}>;

export type SemanticKeyboardSelectionReport = Readonly<{
  missingObjectIds: readonly string[];
  missingGroupIds: readonly string[];
  resolvedGroupIds: readonly string[];
  lockedImageObjectIds: readonly string[];
}>;

export type SemanticKeyboardCapture = Readonly<{
  objects: readonly CanvasObject[];
  objectIds: readonly string[];
  report: SemanticKeyboardSelectionReport;
}>;

export type SemanticClipboardCopyResult = Readonly<{
  status: "copied" | "noop";
  payload: SemanticCanvasClipboardPayload | null;
  capturedObjectIds: readonly string[];
  selectionReport: SemanticKeyboardSelectionReport;
}>;

export type SemanticKeyboardMutationResult = Readonly<{
  status: "finished" | "noop";
  gestureId: string | null;
  targetObjectIds: readonly string[];
  selectionReport: SemanticKeyboardSelectionReport;
  lifecycleEvents: readonly SemanticCanvasEditEvent[];
}>;

export type SemanticClipboardCutResult = Readonly<{
  status: "finished" | "noop";
  payload: SemanticCanvasClipboardPayload | null;
  mutation: SemanticKeyboardMutationResult;
}>;

export type SemanticClipboardPasteResult = Readonly<{
  status: "finished" | "noop";
  gestureId: string | null;
  createdObjectIds: readonly string[];
  objectIdMap: Readonly<Record<string, string>>;
  groupIdMap: Readonly<Record<string, string>>;
  drafts: readonly CreateCanvasObject[];
  lifecycleEvents: readonly SemanticCanvasEditEvent[];
}>;

export type SemanticObjectIdFactory = (
  sourceObjectId: string,
  index: number,
) => string;

export type SemanticGroupIdFactory = (
  sourceGroupId: string,
  index: number,
) => string;

export class SemanticKeyboardSessionError extends Error {
  constructor(
    readonly code:
      | "CROSS_ROOM_CLIPBOARD"
      | "ID_COLLISION"
      | "INVALID_CLIPBOARD"
      | "INVALID_FACTORY"
      | "INVALID_NUDGE"
      | "INVALID_SELECTION"
      | "OPERATION_LIMIT",
    message: string,
  ) {
    super(message);
    this.name = "SemanticKeyboardSessionError";
  }
}

const clipboardEntrySchema = z.object({
  sourceObjectId: z.string().min(1).max(128),
  draft: createCanvasObjectSchema,
}).strict();

const clipboardPayloadSchema = z.object({
  format: z.literal(SEMANTIC_CANVAS_CLIPBOARD_FORMAT),
  version: z.literal(1),
  roomId: z.string().min(1).max(128),
  objects: z.array(clipboardEntrySchema).max(SEMANTIC_KEYBOARD_LIMITS.maxOperations),
}).strict();

const EMPTY_IDS = Object.freeze([]) as readonly string[];
const EMPTY_EVENTS = Object.freeze([]) as readonly SemanticCanvasEditEvent[];
const EMPTY_RECORD = Object.freeze({}) as Readonly<Record<string, string>>;

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

/**
 * A group is a relationship between at least two objects. Persisted rooms can
 * temporarily retain a groupId on the final survivor after another member is
 * deleted, and older clipboard payloads may contain the same stale identity.
 * Treat those singleton IDs as dissolved instead of manufacturing a new
 * singleton group on copy/paste.
 */
function retainedGroupIds(
  drafts: Iterable<Readonly<{ groupId: string | null }>>,
): ReadonlySet<string> {
  const counts = new Map<string, number>();
  for (const draft of drafts) {
    if (draft.groupId) counts.set(draft.groupId, (counts.get(draft.groupId) ?? 0) + 1);
  }
  return new Set(
    [...counts].flatMap(([groupId, count]) => count >= 2 ? [groupId] : []),
  );
}

function orderedObjects(objects: Iterable<CanvasObject>): CanvasObject[] {
  return [...objects].sort(
    (left, right) => left.zIndex - right.zIndex || left.id.localeCompare(right.id),
  );
}

function freezePoint(point: Point): Readonly<Point> {
  return Object.freeze({ x: point.x, y: point.y });
}

function freezeReport(
  report: SemanticKeyboardSelectionReport,
): SemanticKeyboardSelectionReport {
  return Object.freeze({
    missingObjectIds: Object.freeze([...report.missingObjectIds]),
    missingGroupIds: Object.freeze([...report.missingGroupIds]),
    resolvedGroupIds: Object.freeze([...report.resolvedGroupIds]),
    lockedImageObjectIds: Object.freeze([...report.lockedImageObjectIds]),
  });
}

function nodeMetadataInput(
  metadata: NodeMetadata | null | undefined,
): NodeMetadataInput | null | undefined {
  if (metadata === undefined || metadata === null) return metadata;
  const { kind, status, owner, resolution } = metadata;
  return { kind, status, owner, resolution } as NodeMetadataInput;
}

/** Converts authoritative state into an exact create payload, stripping server fields. */
export function semanticCreateDraftFromObject(
  object: CanvasObject,
): CreateCanvasObject {
  const {
    revision: _revision,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    createdBy: _createdBy,
    lastEditedBy: _lastEditedBy,
    diagramIds: _diagramIds,
    ...candidate
  } = object;
  void _revision;
  void _createdAt;
  void _updatedAt;
  void _createdBy;
  void _lastEditedBy;
  void _diagramIds;

  let draft: CreateCanvasObject;
  if (candidate.kind === "shape") {
    draft = {
      ...candidate,
      nodeMetadata: nodeMetadataInput(candidate.nodeMetadata),
    };
  } else if (candidate.kind === "draw") {
    draft = { ...candidate, points: candidate.points.map((point) => ({ ...point })) };
  } else if (candidate.kind === "connector") {
    draft = {
      ...candidate,
      start: {
        ...candidate.start,
        normalizedAnchor: candidate.start.normalizedAnchor
          ? { ...candidate.start.normalizedAnchor }
          : candidate.start.normalizedAnchor,
      },
      end: {
        ...candidate.end,
        normalizedAnchor: candidate.end.normalizedAnchor
          ? { ...candidate.end.normalizedAnchor }
          : candidate.end.normalizedAnchor,
      },
      routing: candidate.routing ? { ...candidate.routing } : undefined,
    };
  } else {
    draft = { ...candidate };
  }
  const parsed = createCanvasObjectSchema.safeParse(draft);
  if (!parsed.success) {
    throw new SemanticKeyboardSessionError(
      "INVALID_SELECTION",
      parsed.error.issues[0]?.message ?? `Object ${object.id} cannot be copied.`,
    );
  }
  return parsed.data;
}

function targetProperty(target: unknown, key: string): unknown {
  if (!target || (typeof target !== "object" && typeof target !== "function")) return undefined;
  return (target as Record<string, unknown>)[key];
}

/** Suppresses canvas shortcuts for native or ARIA text-entry descendants. */
export function isSemanticTextEntryTarget(target: unknown): boolean {
  let current = target;
  for (let depth = 0; current && depth < 12; depth += 1) {
    const tagName = String(targetProperty(current, "tagName") ?? "").toLowerCase();
    if (tagName === "input" || tagName === "textarea" || tagName === "select") return true;
    if (targetProperty(current, "isContentEditable") === true) return true;

    const getAttribute = targetProperty(current, "getAttribute");
    if (typeof getAttribute === "function") {
      const attribute = getAttribute.call(current, "contenteditable");
      if (attribute !== null && String(attribute).toLowerCase() !== "false") return true;
      const role = String(getAttribute.call(current, "role") ?? "").toLowerCase();
      if (role === "textbox" || role === "searchbox" || role === "combobox") return true;
    } else {
      const role = String(targetProperty(current, "role") ?? "").toLowerCase();
      if (role === "textbox" || role === "searchbox" || role === "combobox") return true;
    }
    current = targetProperty(current, "parentElement") ?? null;
  }
  return false;
}

/**
 * Maps platform keyboard input into canvas intent. It never calls
 * preventDefault; the presentation host does so only after receiving an action.
 */
export function normalizeSemanticCanvasShortcut(input: Readonly<{
  event: SemanticCanvasKeyboardEvent;
  role: RoomRole;
}>): SemanticCanvasShortcut | null {
  const { event } = input;
  if (
    input.role !== "participant" ||
    event.defaultPrevented ||
    event.isComposing ||
    isSemanticTextEntryTarget(event.target)
  ) return null;

  const key = event.key.toLowerCase();
  const primary = Boolean(event.metaKey || event.ctrlKey);
  const shift = Boolean(event.shiftKey);
  const alt = Boolean(event.altKey);
  if (alt) return null;

  if (primary) {
    if (key === "z") return Object.freeze({ type: shift ? "redo" : "undo" });
    if (key === "a" && !shift) return Object.freeze({ type: "select-all" });
    if (key === "c" && !shift) return Object.freeze({ type: "copy" });
    if (key === "x" && !shift) return Object.freeze({ type: "cut" });
    if (key === "v" && !shift) return Object.freeze({ type: "paste" });
    if (key === "d" && !shift) return Object.freeze({ type: "duplicate" });
    if (key === "g") return Object.freeze({ type: shift ? "ungroup" : "group" });
    if (event.code === "BracketRight" || key === "]" || key === "}") {
      return Object.freeze({ type: "order-forward" });
    }
    if (event.code === "BracketLeft" || key === "[" || key === "{") {
      return Object.freeze({ type: "order-backward" });
    }
    return null;
  }

  if (key === "delete" || key === "backspace") {
    return Object.freeze({ type: "delete-selection" });
  }
  if (key === "escape") return Object.freeze({ type: "escape" });
  if ((key === "f2" || key === "enter") && !shift) {
    return Object.freeze({ type: "edit-text" });
  }

  const distance = shift ? 10 : 1;
  if (key === "arrowleft") return Object.freeze({ type: "nudge", delta: freezePoint({ x: -distance, y: 0 }) });
  if (key === "arrowright") return Object.freeze({ type: "nudge", delta: freezePoint({ x: distance, y: 0 }) });
  if (key === "arrowup") return Object.freeze({ type: "nudge", delta: freezePoint({ x: 0, y: -distance }) });
  if (key === "arrowdown") return Object.freeze({ type: "nudge", delta: freezePoint({ x: 0, y: distance }) });
  return null;
}

export function selectAllSemanticObjectIds(room: RoomState): readonly string[] {
  return Object.freeze(orderedObjects(Object.values(room.objects)).map((object) => object.id));
}

function resolveSelection(
  room: RoomState,
  selection: SemanticKeyboardSelection,
  options: Readonly<{ excludeDirectLockedImages: boolean }>,
): SemanticKeyboardCapture {
  const directIds = new Set(selection.objectIds);
  const roomGroups = new Set(
    Object.values(room.objects).flatMap((object) => object.groupId ? [object.groupId] : []),
  );
  const resolvedGroupIds = new Set(
    (selection.groupIds ?? []).filter((groupId) => roomGroups.has(groupId)),
  );
  for (const objectId of directIds) {
    const groupId = room.objects[objectId]?.groupId;
    if (groupId) resolvedGroupIds.add(groupId);
  }

  const lockedImageObjectIds: string[] = [];
  const objects = orderedObjects(Object.values(room.objects).filter((object) => {
    const viaGroup = Boolean(object.groupId && resolvedGroupIds.has(object.groupId));
    if (!directIds.has(object.id) && !viaGroup) return false;
    if (
      options.excludeDirectLockedImages &&
      object.kind === "image" &&
      object.locked &&
      !viaGroup
    ) {
      lockedImageObjectIds.push(object.id);
      return false;
    }
    return true;
  }));

  const report = freezeReport({
    missingObjectIds: sortedUnique(selection.objectIds.filter((id) => !room.objects[id])),
    missingGroupIds: sortedUnique((selection.groupIds ?? []).filter((id) => !roomGroups.has(id))),
    resolvedGroupIds: sortedUnique(resolvedGroupIds),
    lockedImageObjectIds: sortedUnique(lockedImageObjectIds),
  });
  if (objects.length > SEMANTIC_KEYBOARD_LIMITS.maxOperations) {
    throw new SemanticKeyboardSessionError(
      "OPERATION_LIMIT",
      `A keyboard transaction may affect at most ${SEMANTIC_KEYBOARD_LIMITS.maxOperations} objects.`,
    );
  }
  return Object.freeze({
    objects: Object.freeze(objects),
    objectIds: Object.freeze(objects.map((object) => object.id)),
    report,
  });
}

function sanitizeConnectorForClipboard(
  draft: CreateCanvasObject,
  capturedIds: ReadonlySet<string>,
): CreateCanvasObject {
  if (draft.kind !== "connector") return draft;
  const sanitizeEndpoint = (endpoint: typeof draft.start) => {
    if (endpoint.objectId === null || capturedIds.has(endpoint.objectId)) {
      return { ...endpoint };
    }
    return {
      ...endpoint,
      objectId: null,
      normalizedAnchor: null,
      isPrecise: null,
      isExact: null,
      snap: null,
    };
  };
  return {
    ...draft,
    start: sanitizeEndpoint(draft.start),
    end: sanitizeEndpoint(draft.end),
  };
}

function freezePayload(
  payload: SemanticCanvasClipboardPayload,
): SemanticCanvasClipboardPayload {
  return Object.freeze({
    ...payload,
    objects: Object.freeze(payload.objects.map((entry) => Object.freeze({
      sourceObjectId: entry.sourceObjectId,
      draft: Object.freeze(entry.draft),
    }))),
  });
}

function validateClipboardPayload(
  payload: unknown,
  expectedRoomId?: string,
): SemanticCanvasClipboardPayload {
  const parsed = clipboardPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new SemanticKeyboardSessionError(
      "INVALID_CLIPBOARD",
      parsed.error.issues[0]?.message ?? "The semantic canvas clipboard is invalid.",
    );
  }
  if (expectedRoomId !== undefined && parsed.data.roomId !== expectedRoomId) {
    throw new SemanticKeyboardSessionError(
      "CROSS_ROOM_CLIPBOARD",
      "Canvas clipboard contents are private to the room where they were copied.",
    );
  }

  const sourceIds = new Set<string>();
  for (const entry of parsed.data.objects) {
    if (entry.sourceObjectId !== entry.draft.id || sourceIds.has(entry.sourceObjectId)) {
      throw new SemanticKeyboardSessionError(
        "INVALID_CLIPBOARD",
        "Clipboard source IDs must be unique and match their semantic draft IDs.",
      );
    }
    sourceIds.add(entry.sourceObjectId);
  }
  for (const entry of parsed.data.objects) {
    if (entry.draft.kind !== "connector") continue;
    for (const endpoint of [entry.draft.start, entry.draft.end]) {
      if (endpoint.objectId !== null && !sourceIds.has(endpoint.objectId)) {
        throw new SemanticKeyboardSessionError(
          "INVALID_CLIPBOARD",
          "Clipboard connectors may bind only to objects in the same payload.",
        );
      }
    }
  }
  for (const entry of parsed.data.objects) {
    if (entry.draft.kind !== "image") continue;
    const reference = parseRoomAssetProxyReference(entry.draft.url);
    if (reference && reference.roomId !== parsed.data.roomId) {
      throw new SemanticKeyboardSessionError(
        "CROSS_ROOM_CLIPBOARD",
        "Private image references cannot cross Jazzboard rooms.",
      );
    }
  }
  return freezePayload(parsed.data);
}

export function encodeSemanticCanvasClipboard(
  payload: SemanticCanvasClipboardPayload,
): string {
  return JSON.stringify(validateClipboardPayload(payload));
}

export function decodeSemanticCanvasClipboard(
  serialized: string,
  expectedRoomId: string,
): SemanticCanvasClipboardPayload {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new SemanticKeyboardSessionError(
      "INVALID_CLIPBOARD",
      "The semantic canvas clipboard is not valid JSON.",
    );
  }
  return validateClipboardPayload(value, expectedRoomId);
}

function startedEvent(
  gestureId: string,
  objects: readonly CanvasObject[],
  operation: "move" | "edit" | "delete",
): SemanticCanvasGestureStartedEvent {
  return Object.freeze({
    type: "gesture.started",
    gestureId,
    source: "keyboard",
    objects: Object.freeze(objects.map((object) => Object.freeze({
      objectId: object.id,
      baseRevision: object.revision,
      baseCreatedAt: object.createdAt,
      operation,
    }))),
  });
}

function createStartedEvent(
  gestureId: string,
  drafts: readonly CreateCanvasObject[],
): SemanticCanvasGestureStartedEvent {
  return Object.freeze({
    type: "gesture.started",
    gestureId,
    source: "keyboard",
    objects: Object.freeze(drafts.map((draft) => Object.freeze({
      objectId: draft.id,
      baseRevision: null,
      baseCreatedAt: null,
      operation: null,
    }))),
  });
}

function finishEvent(gestureId: string): SemanticCanvasGestureFinishRequestedEvent {
  return Object.freeze({
    type: "gesture.finish-requested",
    gestureId,
    reason: "keyboard-idle",
  });
}

function changedCreateEvent(
  gestureId: string,
  drafts: readonly CreateCanvasObject[],
): SemanticCanvasObjectsChangedEvent {
  return Object.freeze({
    type: "objects.changed",
    gestureId,
    changes: Object.freeze(drafts.map((draft) => Object.freeze({
      kind: "create" as const,
      draft,
      baseRevision: null,
      baseCreatedAt: null,
    }))),
  });
}

function changedUpdateEvent(
  gestureId: string,
  pairs: readonly Readonly<{ object: CanvasObject; draft: CreateCanvasObject }>[],
  operation: "move" | "edit",
): SemanticCanvasObjectsChangedEvent {
  return Object.freeze({
    type: "objects.changed",
    gestureId,
    changes: Object.freeze(pairs.map(({ object, draft }) => Object.freeze({
      kind: "update" as const,
      draft,
      baseRevision: object.revision,
      baseCreatedAt: object.createdAt,
      operation,
    }))),
  });
}

function startedMixedUpdateEvent(
  gestureId: string,
  pairs: readonly Readonly<{
    object: CanvasObject;
    operation: "move" | "connect";
  }>[],
): SemanticCanvasGestureStartedEvent {
  return Object.freeze({
    type: "gesture.started",
    gestureId,
    source: "keyboard",
    objects: Object.freeze(pairs.map(({ object, operation }) => Object.freeze({
      objectId: object.id,
      baseRevision: object.revision,
      baseCreatedAt: object.createdAt,
      operation,
    }))),
  });
}

function changedMixedUpdateEvent(
  gestureId: string,
  pairs: readonly Readonly<{
    object: CanvasObject;
    draft: CreateCanvasObject;
    operation: "move" | "connect";
  }>[],
): SemanticCanvasObjectsChangedEvent {
  return Object.freeze({
    type: "objects.changed",
    gestureId,
    changes: Object.freeze(pairs.map(({ object, draft, operation }) => Object.freeze({
      kind: "update" as const,
      draft,
      baseRevision: object.revision,
      baseCreatedAt: object.createdAt,
      operation,
    }))),
  });
}

function changedDeleteEvent(
  gestureId: string,
  objects: readonly CanvasObject[],
): SemanticCanvasObjectsChangedEvent {
  return Object.freeze({
    type: "objects.changed",
    gestureId,
    changes: Object.freeze(objects.map((object) => Object.freeze({
      kind: "delete" as const,
      objectId: object.id,
      baseRevision: object.revision,
      baseCreatedAt: object.createdAt,
      operation: "delete" as const,
    }))),
  });
}

function dependencyEvent(
  gestureId: string,
  dependencies: readonly CanvasObject[],
): SemanticCanvasGestureDependenciesAddedEvent {
  return Object.freeze({
    type: "gesture.dependencies-added",
    gestureId,
    objects: Object.freeze(dependencies.map((object) => Object.freeze({
      objectId: object.id,
      baseRevision: object.revision,
      baseCreatedAt: object.createdAt,
      operation: "connect" as const,
    }))),
  });
}

function validateFactoryId(
  id: string,
  kind: "object" | "group",
): void {
  if (!id || id.length > 128) {
    throw new SemanticKeyboardSessionError(
      "INVALID_FACTORY",
      `A ${kind} ID factory must return 1 to 128 characters.`,
    );
  }
}

function assertFiniteCoordinate(value: number, label: string): void {
  if (!Number.isFinite(value) || Math.abs(value) > SEMANTIC_KEYBOARD_LIMITS.maxCoordinate) {
    throw new SemanticKeyboardSessionError(
      "INVALID_NUDGE",
      `${label} must be a finite canvas coordinate.`,
    );
  }
}

function offsetEndpoint<T extends Readonly<Point>>(endpoint: T, offset: Point): T {
  return { ...endpoint, x: endpoint.x + offset.x, y: endpoint.y + offset.y };
}

function offsetDraft(draft: CreateCanvasObject, offset: Point): CreateCanvasObject {
  const x = draft.x + offset.x;
  const y = draft.y + offset.y;
  assertFiniteCoordinate(x, "Pasted x");
  assertFiniteCoordinate(y, "Pasted y");
  if (draft.kind === "connector") {
    return {
      ...draft,
      x,
      y,
      start: offsetEndpoint(draft.start, offset),
      end: offsetEndpoint(draft.end, offset),
    };
  }
  return { ...draft, x, y };
}

function cloneRecord(entries: Iterable<readonly [string, string]>): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(entries));
}

/** Pure semantic keyboard/clipboard transaction builder. */
export class SemanticKeyboardSessionEngine {
  private nextFence = 0;

  capture(
    room: RoomState,
    selection: SemanticKeyboardSelection,
    options: Readonly<{ excludeDirectLockedImages?: boolean }> = {},
  ): SemanticKeyboardCapture {
    return resolveSelection(room, selection, {
      excludeDirectLockedImages: options.excludeDirectLockedImages ?? false,
    });
  }

  copy(input: Readonly<{
    room: RoomState;
    selection: SemanticKeyboardSelection;
  }>): SemanticClipboardCopyResult {
    const capture = this.capture(input.room, input.selection);
    if (!capture.objects.length) {
      return Object.freeze({
        status: "noop",
        payload: null,
        capturedObjectIds: EMPTY_IDS,
        selectionReport: capture.report,
      });
    }
    const payload = this.payloadForCapture(input.room.id, capture);
    return Object.freeze({
      status: "copied",
      payload,
      capturedObjectIds: capture.objectIds,
      selectionReport: capture.report,
    });
  }

  cut(input: Readonly<{
    room: RoomState;
    selection: SemanticKeyboardSelection;
  }>): SemanticClipboardCutResult {
    const capture = this.capture(input.room, input.selection, {
      excludeDirectLockedImages: true,
    });
    if (!capture.objects.length) {
      return Object.freeze({
        status: "noop",
        payload: null,
        mutation: this.noop(capture.report),
      });
    }
    const payload = this.payloadForCapture(input.room.id, capture);
    const gestureId = this.gestureId("cut");
    const events: readonly SemanticCanvasEditEvent[] = Object.freeze([
      startedEvent(gestureId, capture.objects, "delete"),
      changedDeleteEvent(gestureId, capture.objects),
      finishEvent(gestureId),
    ]);
    return Object.freeze({
      status: "finished",
      payload,
      mutation: Object.freeze({
        status: "finished",
        gestureId,
        targetObjectIds: capture.objectIds,
        selectionReport: capture.report,
        lifecycleEvents: events,
      }),
    });
  }

  deleteSelection(input: Readonly<{
    room: RoomState;
    selection: SemanticKeyboardSelection;
  }>): SemanticKeyboardMutationResult {
    const capture = this.capture(input.room, input.selection, {
      excludeDirectLockedImages: true,
    });
    if (!capture.objects.length) return this.noop(capture.report);
    const gestureId = this.gestureId("delete");
    return Object.freeze({
      status: "finished",
      gestureId,
      targetObjectIds: capture.objectIds,
      selectionReport: capture.report,
      lifecycleEvents: Object.freeze([
        startedEvent(gestureId, capture.objects, "delete"),
        changedDeleteEvent(gestureId, capture.objects),
        finishEvent(gestureId),
      ]),
    });
  }

  paste(input: Readonly<{
    room: RoomState;
    payload: SemanticCanvasClipboardPayload;
    objectIdFactory: SemanticObjectIdFactory;
    groupIdFactory: SemanticGroupIdFactory;
    offset?: Point;
  }>): SemanticClipboardPasteResult {
    const payload = validateClipboardPayload(input.payload, input.room.id);
    if (!payload.objects.length) {
      return Object.freeze({
        status: "noop",
        gestureId: null,
        createdObjectIds: EMPTY_IDS,
        objectIdMap: EMPTY_RECORD,
        groupIdMap: EMPTY_RECORD,
        drafts: Object.freeze([]),
        lifecycleEvents: EMPTY_EVENTS,
      });
    }
    const objectIdMap = new Map<string, string>();
    payload.objects.forEach((entry, index) => {
      const id = input.objectIdFactory(entry.sourceObjectId, index);
      validateFactoryId(id, "object");
      if (input.room.objects[id] || [...objectIdMap.values()].includes(id)) {
        throw new SemanticKeyboardSessionError(
          "ID_COLLISION",
          `The object ID factory produced a collision for ${id}.`,
        );
      }
      objectIdMap.set(entry.sourceObjectId, id);
    });

    const roomGroupIds = new Set(
      Object.values(input.room.objects).flatMap((object) => object.groupId ? [object.groupId] : []),
    );
    const retainedPayloadGroupIds = retainedGroupIds(payload.objects.map((entry) => entry.draft));
    const sourceGroupIds = sortedUnique(payload.objects.flatMap((entry) =>
      entry.draft.groupId && retainedPayloadGroupIds.has(entry.draft.groupId)
        ? [entry.draft.groupId]
        : [],
    ));
    const groupIdMap = new Map<string, string>();
    sourceGroupIds.forEach((sourceGroupId, index) => {
      const groupId = input.groupIdFactory(sourceGroupId, index);
      validateFactoryId(groupId, "group");
      if (roomGroupIds.has(groupId) || [...groupIdMap.values()].includes(groupId)) {
        throw new SemanticKeyboardSessionError(
          "ID_COLLISION",
          `The group ID factory produced a collision for ${groupId}.`,
        );
      }
      groupIdMap.set(sourceGroupId, groupId);
    });

    const offset = input.offset ?? SEMANTIC_KEYBOARD_LIMITS.defaultPasteOffset;
    assertFiniteCoordinate(offset.x, "Paste offset x");
    assertFiniteCoordinate(offset.y, "Paste offset y");
    const maxZ = Math.max(-1, ...Object.values(input.room.objects).map((object) => object.zIndex));
    const firstZ = Math.max(
      0,
      Math.min(1_000_000 - payload.objects.length + 1, maxZ + 1),
    );
    const drafts = payload.objects.map((entry, index) => {
      let draft = offsetDraft({
        ...entry.draft,
        id: objectIdMap.get(entry.sourceObjectId)!,
        groupId:
          entry.draft.groupId && retainedPayloadGroupIds.has(entry.draft.groupId)
            ? groupIdMap.get(entry.draft.groupId)!
            : null,
        zIndex: firstZ + index,
      }, offset);
      if (draft.kind === "connector") {
        draft = {
          ...draft,
          start: {
            ...draft.start,
            objectId: draft.start.objectId
              ? objectIdMap.get(draft.start.objectId) ?? null
              : null,
          },
          end: {
            ...draft.end,
            objectId: draft.end.objectId
              ? objectIdMap.get(draft.end.objectId) ?? null
              : null,
          },
        };
      }
      const parsed = createCanvasObjectSchema.safeParse(draft);
      if (!parsed.success) {
        throw new SemanticKeyboardSessionError(
          "INVALID_FACTORY",
          parsed.error.issues[0]?.message ?? `Pasted object ${entry.sourceObjectId} is invalid.`,
        );
      }
      return parsed.data;
    });

    const gestureId = this.gestureId("paste");
    return Object.freeze({
      status: "finished",
      gestureId,
      createdObjectIds: Object.freeze(drafts.map((draft) => draft.id)),
      objectIdMap: cloneRecord(objectIdMap),
      groupIdMap: cloneRecord(groupIdMap),
      drafts: Object.freeze(drafts),
      lifecycleEvents: Object.freeze([
        createStartedEvent(gestureId, drafts),
        changedCreateEvent(gestureId, drafts),
        finishEvent(gestureId),
      ]),
    });
  }

  duplicate(input: Readonly<{
    room: RoomState;
    selection: SemanticKeyboardSelection;
    objectIdFactory: SemanticObjectIdFactory;
    groupIdFactory: SemanticGroupIdFactory;
    offset?: Point;
  }>): SemanticClipboardPasteResult {
    const copied = this.copy(input);
    if (!copied.payload) {
      return Object.freeze({
        status: "noop",
        gestureId: null,
        createdObjectIds: EMPTY_IDS,
        objectIdMap: EMPTY_RECORD,
        groupIdMap: EMPTY_RECORD,
        drafts: Object.freeze([]),
        lifecycleEvents: EMPTY_EVENTS,
      });
    }
    return this.paste({ ...input, payload: copied.payload });
  }

  nudge(input: Readonly<{
    room: RoomState;
    selection: SemanticKeyboardSelection;
    delta: Point;
  }>): SemanticKeyboardMutationResult {
    assertFiniteCoordinate(input.delta.x, "Nudge x");
    assertFiniteCoordinate(input.delta.y, "Nudge y");
    if (
      input.delta.x === 0 && input.delta.y === 0 ||
      ![0, 1, -1, 10, -10].includes(input.delta.x) ||
      ![0, 1, -1, 10, -10].includes(input.delta.y)
    ) {
      throw new SemanticKeyboardSessionError(
        "INVALID_NUDGE",
        "Keyboard nudges use an exact 1 or 10 canvas-unit delta on one or both axes.",
      );
    }
    const capture = this.capture(input.room, input.selection, {
      excludeDirectLockedImages: true,
    });
    if (!capture.objects.length) return this.noop(capture.report);
    const capturedIds = new Set(capture.objectIds);
    const pairs = capture.objects.flatMap((object) => {
      const base = semanticCreateDraftFromObject(object);
      let draft: CreateCanvasObject;
      if (base.kind === "connector") {
        const startMoves = base.start.objectId === null || capturedIds.has(base.start.objectId);
        const endMoves = base.end.objectId === null || capturedIds.has(base.end.objectId);
        const start = startMoves ? offsetEndpoint(base.start, input.delta) : base.start;
        const end = endMoves ? offsetEndpoint(base.end, input.delta) : base.end;
        if (!startMoves && !endMoves) return [];
        draft = {
          ...base,
          start,
          end,
          x: Math.min(start.x, end.x),
          y: Math.min(start.y, end.y),
          width: Math.max(1, Math.abs(end.x - start.x)),
          height: Math.max(1, Math.abs(end.y - start.y)),
        };
      } else {
        draft = { ...base, x: base.x + input.delta.x, y: base.y + input.delta.y };
      }
      const parsed = createCanvasObjectSchema.safeParse(draft);
      if (!parsed.success) {
        throw new SemanticKeyboardSessionError(
          "INVALID_NUDGE",
          parsed.error.issues[0]?.message ?? `Object ${object.id} cannot be nudged.`,
        );
      }
      return [{
        object,
        draft: parsed.data,
        operation: base.kind === "connector" ? "connect" as const : "move" as const,
      }];
    });
    if (!pairs.length) return this.noop(capture.report);

    const nextObjects = { ...input.room.objects };
    for (const { object, draft } of pairs) {
      nextObjects[object.id] = { ...object, ...draft } as CanvasObject;
    }
    const affectedConnectors = computeAffectedConnectorIds({
      baseline: input.room,
      current: { ...input.room, objects: nextObjects },
      touchedObjectIds: new Set(pairs.map(({ object }) => object.id)),
    });
    const pairIds = new Set(pairs.map(({ object }) => object.id));
    const dependencies = orderedObjects([...affectedConnectors].flatMap((id) => {
      const object = input.room.objects[id];
      return object?.kind === "connector" && !pairIds.has(id) ? [object] : [];
    }));
    const gestureId = this.gestureId("nudge");
    const lifecycleEvents: SemanticCanvasEditEvent[] = [
      startedMixedUpdateEvent(gestureId, pairs),
    ];
    if (dependencies.length) lifecycleEvents.push(dependencyEvent(gestureId, dependencies));
    lifecycleEvents.push(changedMixedUpdateEvent(gestureId, pairs), finishEvent(gestureId));
    return Object.freeze({
      status: "finished",
      gestureId,
      targetObjectIds: Object.freeze(pairs.map(({ object }) => object.id)),
      selectionReport: capture.report,
      lifecycleEvents: Object.freeze(lifecycleEvents),
    });
  }

  group(input: Readonly<{
    room: RoomState;
    selection: SemanticKeyboardSelection;
    groupIdFactory: SemanticGroupIdFactory;
  }>): SemanticKeyboardMutationResult {
    const capture = this.capture(input.room, input.selection);
    if (capture.objects.length < 2) return this.noop(capture.report);
    const groupId = input.groupIdFactory(capture.report.resolvedGroupIds[0] ?? "group", 0);
    validateFactoryId(groupId, "group");
    const roomGroups = new Set(Object.values(input.room.objects).flatMap((object) => object.groupId ? [object.groupId] : []));
    if (roomGroups.has(groupId)) {
      throw new SemanticKeyboardSessionError("ID_COLLISION", `Group ${groupId} already exists.`);
    }
    return this.updateObjects("group", capture, capture.objects.map((object) => ({
      object,
      draft: { ...semanticCreateDraftFromObject(object), groupId },
    })));
  }

  ungroup(input: Readonly<{
    room: RoomState;
    selection: SemanticKeyboardSelection;
  }>): SemanticKeyboardMutationResult {
    const capture = this.capture(input.room, input.selection);
    const pairs = capture.objects.flatMap((object) => object.groupId === null ? [] : [{
      object,
      draft: { ...semanticCreateDraftFromObject(object), groupId: null } as CreateCanvasObject,
    }]);
    return this.updateObjects("ungroup", capture, pairs);
  }

  order(input: Readonly<{
    room: RoomState;
    selection: SemanticKeyboardSelection;
    direction: SemanticZOrderDirection;
  }>): SemanticKeyboardMutationResult {
    const capture = this.capture(input.room, input.selection, {
      excludeDirectLockedImages: true,
    });
    let plan;
    try {
      plan = planSemanticZOrder({
        objects: Object.values(input.room.objects),
        selectedObjectIds: capture.objectIds,
        direction: input.direction,
        maxUpdates: SEMANTIC_KEYBOARD_LIMITS.maxOperations,
      });
    } catch (error) {
      if (error instanceof SemanticZOrderError) {
        throw new SemanticKeyboardSessionError(
          error.code === "OPERATION_LIMIT" ? "OPERATION_LIMIT" : "INVALID_SELECTION",
          error.message,
        );
      }
      throw error;
    }
    const pairs = plan.updates.map(({ object, zIndex }) => ({
      object,
      draft: { ...semanticCreateDraftFromObject(object), zIndex } as CreateCanvasObject,
    }));
    return this.updateObjects(`order-${input.direction}`, capture, pairs);
  }

  private updateObjects(
    label: string,
    capture: SemanticKeyboardCapture,
    pairs: readonly Readonly<{ object: CanvasObject; draft: CreateCanvasObject }>[],
  ): SemanticKeyboardMutationResult {
    if (!pairs.length) return this.noop(capture.report);
    const validated = pairs.map(({ object, draft }) => {
      const parsed = createCanvasObjectSchema.safeParse(draft);
      if (!parsed.success) {
        throw new SemanticKeyboardSessionError(
          "INVALID_SELECTION",
          parsed.error.issues[0]?.message ?? `Object ${object.id} cannot be updated.`,
        );
      }
      return Object.freeze({ object, draft: parsed.data });
    });
    const gestureId = this.gestureId(label);
    return Object.freeze({
      status: "finished",
      gestureId,
      targetObjectIds: Object.freeze(validated.map(({ object }) => object.id)),
      selectionReport: capture.report,
      lifecycleEvents: Object.freeze([
        startedEvent(gestureId, validated.map(({ object }) => object), "edit"),
        changedUpdateEvent(gestureId, validated, "edit"),
        finishEvent(gestureId),
      ]),
    });
  }

  private payloadForCapture(
    roomId: string,
    capture: SemanticKeyboardCapture,
  ): SemanticCanvasClipboardPayload {
    const capturedIds = new Set(capture.objectIds);
    const retainedCaptureGroupIds = retainedGroupIds(capture.objects);
    return freezePayload({
      format: SEMANTIC_CANVAS_CLIPBOARD_FORMAT,
      version: 1,
      roomId,
      objects: capture.objects.map((object) => Object.freeze({
        sourceObjectId: object.id,
        draft: sanitizeConnectorForClipboard({
          ...semanticCreateDraftFromObject(object),
          groupId:
            object.groupId && retainedCaptureGroupIds.has(object.groupId)
              ? object.groupId
              : null,
        }, capturedIds),
      })),
    });
  }

  private noop(report: SemanticKeyboardSelectionReport): SemanticKeyboardMutationResult {
    return Object.freeze({
      status: "noop",
      gestureId: null,
      targetObjectIds: EMPTY_IDS,
      selectionReport: report,
      lifecycleEvents: EMPTY_EVENTS,
    });
  }

  private gestureId(label: string): string {
    return `semantic-keyboard:${label}:${++this.nextFence}`;
  }
}
