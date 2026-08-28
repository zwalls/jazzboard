import {
  canonicalRoomAssetProxyPath,
  isRoomBlobPathname,
  isSupportedImageMimeType,
  parseRoomAssetProxyReference,
} from "@/lib/assets/policy";
import { roomBlobNamespace } from "@/lib/assets/private";
import { createCanvasObjectSchema } from "@/lib/domain/schemas";
import type {
  CreateCanvasObject,
  ImageObject,
  RoomState,
} from "@/lib/domain/types";

import type {
  SemanticCanvasAuthoritativeRecovery,
  SemanticCanvasGestureFinishRequestedEvent,
  SemanticCanvasGestureRecoverySettledEvent,
  SemanticCanvasGestureStartedEvent,
  SemanticCanvasObjectChange,
  SemanticCanvasObjectsChangedEvent,
} from "./semantic-edit-events";

export const SEMANTIC_IMAGE_LIMITS = Object.freeze({
  maxAltLength: 2_000,
  maxDimension: 100_000,
});

/**
 * Result of a successful, participant-authorized room upload/finalization.
 *
 * This pure engine verifies the room-local reference and its metadata but
 * cannot prove that bytes exist. The React host must first finish the existing
 * authorized upload flow, then pass its exact response through this boundary.
 */
export type AuthorizedRoomImageAsset = Readonly<{
  url: string;
  assetId: string | null;
  mimeType: string;
  /** Optional provenance only; it is never fetched by this engine. */
  sourceUrl: string | null;
}>;

export type SemanticImageCreateInput = Readonly<{
  roomId: string;
  id: string;
  asset: AuthorizedRoomImageAsset;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  zIndex: number;
  groupId?: string | null;
  alt: string;
  locked?: boolean;
}>;

export type SemanticImageUpdatePatch = Readonly<{
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  rotation?: number;
  zIndex?: number;
  groupId?: string | null;
  alt?: string;
  locked?: boolean;
}>;

export type SemanticImageUpdateInput = Readonly<{
  room: RoomState;
  objectId: string;
  expectedRevision: number;
  expectedCreatedAt: number;
  patch: SemanticImageUpdatePatch;
}>;

export type SemanticImageAnnotationDraft = Extract<
  CreateCanvasObject,
  { kind: "shape" | "text" | "draw" }
>;

export type SemanticImageAnnotationInput = Readonly<{
  room: RoomState;
  imageId: string;
  expectedRevision: number;
  expectedCreatedAt: number;
  /** Required when the image is not already grouped. */
  groupId?: string;
  annotations: readonly SemanticImageAnnotationDraft[];
}>;

export type SemanticImageSessionToken = Readonly<{
  sessionId: string;
  fence: number;
}>;

export type SemanticImageSessionMode = "create" | "update" | "annotate";
export type SemanticImageSessionPhase =
  | "prepared"
  | "active"
  | "recovery-pending"
  | "finished";

export type SemanticImageSession = Readonly<{
  token: SemanticImageSessionToken;
  gestureId: string;
  mode: SemanticImageSessionMode;
  phase: SemanticImageSessionPhase;
  imageId: string;
  objectIds: readonly string[];
  changes: readonly SemanticCanvasObjectChange[];
  startedObjects: SemanticCanvasGestureStartedEvent["objects"];
}>;

export type SemanticImagePrepared = Readonly<{
  status: "prepared";
  session: SemanticImageSession;
  command: null;
  lifecycleEvents: readonly [];
}>;

export type SemanticImagePublished = Readonly<{
  status: "published";
  session: SemanticImageSession;
  command: null;
  lifecycleEvents: readonly [
    SemanticCanvasGestureStartedEvent,
    SemanticCanvasObjectsChangedEvent,
  ];
}>;

export type SemanticImageFinished = Readonly<{
  status: "finished";
  session: SemanticImageSession;
  command: null;
  lifecycleEvents: readonly [SemanticCanvasGestureFinishRequestedEvent];
}>;

export type SemanticImageAbandoned = Readonly<{
  status: "abandoned";
  token: SemanticImageSessionToken;
  clearObjectIds: readonly string[];
  command: null;
  lifecycleEvents: readonly [];
}>;

export type SemanticImageRecoveryRequired = Readonly<{
  status: "recovery-required";
  session: SemanticImageSession;
  objectIds: readonly string[];
  command: null;
  lifecycleEvents: readonly [];
}>;

export type SemanticImageRecoverySettled = Readonly<{
  status: "recovery-settled";
  session: SemanticImageSession;
  command: null;
  lifecycleEvents: readonly [SemanticCanvasGestureRecoverySettledEvent];
}>;

export type SemanticImageStale = Readonly<{
  status: "stale";
  token: SemanticImageSessionToken;
}>;

export type SemanticImageNoop = Readonly<{
  status: "noop";
  command: null;
  lifecycleEvents: readonly [];
}>;

export class SemanticImageSessionError extends Error {
  constructor(
    readonly code:
      | "ACTIVE_SESSION"
      | "ASSET_NOT_ROOM_LOCAL"
      | "ASSET_METADATA_MISMATCH"
      | "IMAGE_LOCKED"
      | "INVALID_ANNOTATION"
      | "INVALID_ASSET"
      | "INVALID_DRAFT"
      | "INVALID_GROUP"
      | "INVALID_PHASE"
      | "OBJECT_NOT_FOUND"
      | "STALE_OBJECT",
    message: string,
  ) {
    super(message);
    this.name = "SemanticImageSessionError";
  }
}

type InternalSession = {
  snapshot: SemanticImageSession;
};

const EMPTY_EVENTS = Object.freeze([]) as readonly [];

function validateDraft(draft: CreateCanvasObject): CreateCanvasObject {
  const parsed = createCanvasObjectSchema.safeParse(draft);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    throw new SemanticImageSessionError(
      "INVALID_DRAFT",
      `Invalid semantic image draft. ${path}${issue?.message ?? "Unknown validation error."}`,
    );
  }
  if (parsed.data.kind === "draw") {
    return Object.freeze({
      ...parsed.data,
      points: Object.freeze(parsed.data.points.map((point) => Object.freeze({ ...point }))),
    }) as CreateCanvasObject;
  }
  return Object.freeze({ ...parsed.data }) as CreateCanvasObject;
}

function validateAuthorizedAsset(
  roomId: string,
  asset: AuthorizedRoomImageAsset,
): AuthorizedRoomImageAsset {
  if (!isSupportedImageMimeType(asset.mimeType)) {
    throw new SemanticImageSessionError(
      "INVALID_ASSET",
      "A first-party image must use an authorized JPEG, PNG, WebP, or GIF upload.",
    );
  }
  const reference = parseRoomAssetProxyReference(asset.url);
  if (!reference || reference.roomId !== roomId) {
    throw new SemanticImageSessionError(
      "ASSET_NOT_ROOM_LOCAL",
      "A first-party image must use this room's authorized asset proxy reference.",
    );
  }
  if (
    reference.pathname !== null &&
    !isRoomBlobPathname(roomBlobNamespace(roomId), reference.pathname)
  ) {
    throw new SemanticImageSessionError(
      "ASSET_NOT_ROOM_LOCAL",
      "The private image pathname does not belong to this room.",
    );
  }
  if (
    (reference.assetId !== null && asset.assetId !== reference.assetId) ||
    (reference.pathname !== null && asset.assetId !== null)
  ) {
    throw new SemanticImageSessionError(
      "ASSET_METADATA_MISMATCH",
      "The uploaded image asset ID must match its authorized room proxy reference.",
    );
  }
  if (asset.sourceUrl !== null) {
    try {
      const source = new URL(asset.sourceUrl);
      if (
        (source.protocol !== "https:" && source.protocol !== "http:") ||
        asset.sourceUrl.length > 8_192
      ) {
        throw new Error("unsupported source URL");
      }
    } catch {
      throw new SemanticImageSessionError(
        "INVALID_ASSET",
        "Image source provenance must be an HTTP(S) URL or null.",
      );
    }
  }
  return Object.freeze({
    ...asset,
    url: canonicalRoomAssetProxyPath(reference),
  });
}

function draftFromImage(image: ImageObject): Extract<CreateCanvasObject, { kind: "image" }> {
  return {
    id: image.id,
    kind: "image",
    x: image.x,
    y: image.y,
    width: image.width,
    height: image.height,
    rotation: image.rotation,
    zIndex: image.zIndex,
    groupId: image.groupId,
    url: image.url,
    assetId: image.assetId,
    alt: image.alt,
    mimeType: image.mimeType,
    sourceUrl: image.sourceUrl,
    locked: image.locked,
  };
}

function assertImageFence(
  room: RoomState,
  objectId: string,
  expectedRevision: number,
  expectedCreatedAt: number,
): ImageObject {
  const object = room.objects[objectId];
  if (!object || object.kind !== "image") {
    throw new SemanticImageSessionError(
      "OBJECT_NOT_FOUND",
      `Image ${objectId} does not exist in the authoritative room.`,
    );
  }
  if (
    object.revision !== expectedRevision ||
    object.createdAt !== expectedCreatedAt
  ) {
    throw new SemanticImageSessionError(
      "STALE_OBJECT",
      `Image ${objectId} changed since this edit session was prepared.`,
    );
  }
  return object;
}

function sameImageDraft(
  image: ImageObject,
  draft: Extract<CreateCanvasObject, { kind: "image" }>,
): boolean {
  return (
    image.x === draft.x &&
    image.y === draft.y &&
    image.width === draft.width &&
    image.height === draft.height &&
    image.rotation === draft.rotation &&
    image.zIndex === draft.zIndex &&
    image.groupId === draft.groupId &&
    image.url === draft.url &&
    image.assetId === draft.assetId &&
    image.alt === draft.alt &&
    image.mimeType === draft.mimeType &&
    image.sourceUrl === draft.sourceUrl &&
    image.locked === draft.locked
  );
}

function operationForPatch(patch: SemanticImageUpdatePatch): "move" | "resize" | "edit" {
  if (
    patch.width !== undefined ||
    patch.height !== undefined ||
    patch.rotation !== undefined
  ) return "resize";
  if (patch.x !== undefined || patch.y !== undefined) return "move";
  return "edit";
}

function freezeStartedObject(
  objectId: string,
  baseRevision: number | null,
  baseCreatedAt: number | null,
  operation: SemanticCanvasGestureStartedEvent["objects"][number]["operation"],
): SemanticCanvasGestureStartedEvent["objects"][number] {
  return Object.freeze({ objectId, baseRevision, baseCreatedAt, operation });
}

function freezeChange(change: SemanticCanvasObjectChange): SemanticCanvasObjectChange {
  return Object.freeze(change);
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function freezeSession(
  session: Omit<SemanticImageSession, "token"> & { token: SemanticImageSessionToken },
): SemanticImageSession {
  return Object.freeze({
    ...session,
    objectIds: Object.freeze([...session.objectIds]),
    changes: Object.freeze([...session.changes]),
    startedObjects: Object.freeze([...session.startedObjects]),
  });
}

/**
 * Renderer-neutral image and annotation lifecycle state machine.
 *
 * It never uploads, fetches, decodes, paints, issues a CanvasCommand, or owns a
 * lease. All visible changes are complete semantic drafts emitted through the
 * shared edit lifecycle. Exact coordinates and z-indices are retained; this
 * engine intentionally performs no spacing, collision, or stacking policy.
 */
export class SemanticImageSessionEngine {
  private fence = 0;
  private active: InternalSession | null = null;

  prepareCreate(input: SemanticImageCreateInput): SemanticImagePrepared {
    this.assertIdle();
    const asset = validateAuthorizedAsset(input.roomId, input.asset);
    const draft = validateDraft({
      id: input.id,
      kind: "image",
      x: input.x,
      y: input.y,
      width: input.width,
      height: input.height,
      rotation: input.rotation ?? 0,
      zIndex: input.zIndex,
      groupId: input.groupId ?? null,
      url: asset.url,
      assetId: asset.assetId,
      alt: input.alt,
      mimeType: asset.mimeType,
      sourceUrl: asset.sourceUrl,
      locked: input.locked ?? false,
    });
    return this.install("create", input.id, [
      freezeStartedObject(input.id, null, null, null),
    ], [freezeChange({
      kind: "create",
      draft,
      baseRevision: null,
      baseCreatedAt: null,
    })]);
  }

  prepareUpdate(
    input: SemanticImageUpdateInput,
  ): SemanticImagePrepared | SemanticImageNoop {
    this.assertIdle();
    const image = assertImageFence(
      input.room,
      input.objectId,
      input.expectedRevision,
      input.expectedCreatedAt,
    );
    const entries = Object.entries(input.patch).filter(([, value]) => value !== undefined);
    if (!entries.length) {
      return Object.freeze({
        status: "noop",
        command: null,
        lifecycleEvents: EMPTY_EVENTS,
      });
    }
    if (image.locked) {
      const unlockOnly = entries.length === 1 && input.patch.locked === false;
      if (!unlockOnly) {
        throw new SemanticImageSessionError(
          "IMAGE_LOCKED",
          "Unlock the image before changing its geometry, alt text, grouping, or z-order.",
        );
      }
    }
    const draft = validateDraft({ ...draftFromImage(image), ...input.patch });
    if (draft.kind !== "image") {
      throw new SemanticImageSessionError("INVALID_DRAFT", "An image update must remain an image.");
    }
    if (sameImageDraft(image, draft)) {
      return Object.freeze({
        status: "noop",
        command: null,
        lifecycleEvents: EMPTY_EVENTS,
      });
    }
    const operation = operationForPatch(input.patch);
    return this.install("update", image.id, [
      freezeStartedObject(image.id, image.revision, image.createdAt, operation),
    ], [freezeChange({
      kind: "update",
      draft,
      baseRevision: image.revision,
      baseCreatedAt: image.createdAt,
      operation,
    })]);
  }

  prepareAnnotations(input: SemanticImageAnnotationInput): SemanticImagePrepared {
    this.assertIdle();
    const image = assertImageFence(
      input.room,
      input.imageId,
      input.expectedRevision,
      input.expectedCreatedAt,
    );
    if (!input.annotations.length) {
      throw new SemanticImageSessionError(
        "INVALID_ANNOTATION",
        "At least one semantic shape, text, or draw annotation is required.",
      );
    }
    const groupId = image.groupId ?? input.groupId;
    if (!groupId || groupId.length > 128) {
      throw new SemanticImageSessionError(
        "INVALID_GROUP",
        "An ungrouped image annotation requires a stable group ID of 1 to 128 characters.",
      );
    }
    if (image.groupId && input.groupId && image.groupId !== input.groupId) {
      throw new SemanticImageSessionError(
        "INVALID_GROUP",
        "Annotations must join the image's existing semantic group.",
      );
    }

    const seen = new Set<string>([image.id]);
    const annotationDrafts = input.annotations.map((annotation) => {
      if (
        (annotation.kind !== "shape" &&
          annotation.kind !== "text" &&
          annotation.kind !== "draw") ||
        seen.has(annotation.id) ||
        input.room.objects[annotation.id] ||
        (annotation.groupId !== null && annotation.groupId !== groupId)
      ) {
        throw new SemanticImageSessionError(
          "INVALID_ANNOTATION",
          `Annotation ${annotation.id} must have a fresh ID and use group ${groupId}.`,
        );
      }
      seen.add(annotation.id);
      return validateDraft({ ...annotation, groupId });
    });

    const startedObjects = [
      freezeStartedObject(image.id, image.revision, image.createdAt, "annotate"),
      ...annotationDrafts.map((draft) =>
        freezeStartedObject(draft.id, null, null, null)
      ),
    ];
    const changes: SemanticCanvasObjectChange[] = [];
    if (image.groupId === null) {
      const groupedImage = validateDraft({ ...draftFromImage(image), groupId });
      changes.push(freezeChange({
        kind: "update",
        draft: groupedImage,
        baseRevision: image.revision,
        baseCreatedAt: image.createdAt,
        operation: "annotate",
      }));
    }
    changes.push(...annotationDrafts.map((draft) => freezeChange({
      kind: "create" as const,
      draft,
      baseRevision: null,
      baseCreatedAt: null,
    })));
    return this.install("annotate", image.id, startedObjects, changes);
  }

  current(): SemanticImageSession | null {
    return this.active?.snapshot ?? null;
  }

  isCurrent(token: SemanticImageSessionToken): boolean {
    return Boolean(
      this.active &&
      this.active.snapshot.token.sessionId === token.sessionId &&
      this.active.snapshot.token.fence === token.fence,
    );
  }

  publish(token: SemanticImageSessionToken): SemanticImagePublished | SemanticImageStale {
    if (!this.isCurrent(token)) return Object.freeze({ status: "stale", token });
    const session = this.active!.snapshot;
    if (session.phase !== "prepared") {
      throw new SemanticImageSessionError(
        "INVALID_PHASE",
        "A semantic image session can be published only once.",
      );
    }
    const active = freezeSession({ ...session, phase: "active" });
    this.active!.snapshot = active;
    const started: SemanticCanvasGestureStartedEvent = Object.freeze({
      type: "gesture.started",
      gestureId: active.gestureId,
      source: "keyboard",
      objects: active.startedObjects,
    });
    const changed: SemanticCanvasObjectsChangedEvent = Object.freeze({
      type: "objects.changed",
      gestureId: active.gestureId,
      changes: active.changes,
    });
    return Object.freeze({
      status: "published",
      session: active,
      command: null,
      lifecycleEvents: Object.freeze([started, changed]) as SemanticImagePublished["lifecycleEvents"],
    });
  }

  finish(token: SemanticImageSessionToken): SemanticImageFinished | SemanticImageStale {
    if (!this.isCurrent(token)) return Object.freeze({ status: "stale", token });
    const session = this.active!.snapshot;
    if (session.phase !== "active") {
      throw new SemanticImageSessionError(
        "INVALID_PHASE",
        "Publish the semantic image edit before requesting its final flush.",
      );
    }
    const finished = freezeSession({ ...session, phase: "finished" });
    const event: SemanticCanvasGestureFinishRequestedEvent = Object.freeze({
      type: "gesture.finish-requested",
      gestureId: finished.gestureId,
      reason: "keyboard-idle",
    });
    this.active = null;
    return Object.freeze({
      status: "finished",
      session: finished,
      command: null,
      lifecycleEvents: Object.freeze([event]) as SemanticImageFinished["lifecycleEvents"],
    });
  }

  /** A prepared image has not entered the lifecycle and can be discarded. */
  abandon(token: SemanticImageSessionToken): SemanticImageAbandoned | SemanticImageStale {
    if (!this.isCurrent(token)) return Object.freeze({ status: "stale", token });
    const session = this.active!.snapshot;
    if (session.phase !== "prepared") {
      throw new SemanticImageSessionError(
        "INVALID_PHASE",
        "A published image edit requires authoritative recovery instead of abandon.",
      );
    }
    this.active = null;
    return Object.freeze({
      status: "abandoned",
      token,
      clearObjectIds: session.mode === "create" ? session.objectIds : EMPTY_EVENTS,
      command: null,
      lifecycleEvents: EMPTY_EVENTS,
    });
  }

  /**
   * Fences an already-published local edit. The host must stop persistence,
   * refresh authority, force-project these IDs, and release the cohort before
   * calling settleRecovery. No successful finish event is fabricated.
   */
  requestRecovery(
    token: SemanticImageSessionToken,
  ): SemanticImageRecoveryRequired | SemanticImageStale {
    if (!this.isCurrent(token)) return Object.freeze({ status: "stale", token });
    const session = this.active!.snapshot;
    if (session.phase !== "active") {
      throw new SemanticImageSessionError(
        "INVALID_PHASE",
        "Only an active semantic image edit can enter recovery.",
      );
    }
    const pending = freezeSession({ ...session, phase: "recovery-pending" });
    this.active!.snapshot = pending;
    return Object.freeze({
      status: "recovery-required",
      session: pending,
      objectIds: pending.objectIds,
      command: null,
      lifecycleEvents: EMPTY_EVENTS,
    });
  }

  settleRecovery(
    token: SemanticImageSessionToken,
    authoritative: readonly SemanticCanvasAuthoritativeRecovery[],
  ): SemanticImageRecoverySettled | SemanticImageStale {
    if (!this.isCurrent(token)) return Object.freeze({ status: "stale", token });
    const session = this.active!.snapshot;
    if (session.phase !== "recovery-pending") {
      throw new SemanticImageSessionError(
        "INVALID_PHASE",
        "Recovery must be requested before it is settled.",
      );
    }
    const recoveredIds = sortedUnique(authoritative.map((object) => object.objectId));
    if (
      recoveredIds.length !== session.objectIds.length ||
      recoveredIds.some((objectId, index) => objectId !== session.objectIds[index])
    ) {
      throw new SemanticImageSessionError(
        "STALE_OBJECT",
        "Authoritative recovery must cover the exact semantic image cohort.",
      );
    }
    const finished = freezeSession({ ...session, phase: "finished" });
    const event: SemanticCanvasGestureRecoverySettledEvent = Object.freeze({
      type: "gesture.recovery-settled",
      gestureId: session.gestureId,
      authoritative: Object.freeze(authoritative.map((object) => Object.freeze({ ...object }))),
    });
    this.active = null;
    return Object.freeze({
      status: "recovery-settled",
      session: finished,
      command: null,
      lifecycleEvents: Object.freeze([event]) as SemanticImageRecoverySettled["lifecycleEvents"],
    });
  }

  private install(
    mode: SemanticImageSessionMode,
    imageId: string,
    startedObjects: SemanticCanvasGestureStartedEvent["objects"],
    changes: readonly SemanticCanvasObjectChange[],
  ): SemanticImagePrepared {
    const fence = ++this.fence;
    const gestureId = `semantic-image:${mode}:${fence}:${imageId}`;
    const token = Object.freeze({ sessionId: gestureId, fence });
    const objectIds = sortedUnique(startedObjects.map((object) => object.objectId));
    const snapshot = freezeSession({
      token,
      gestureId,
      mode,
      phase: "prepared",
      imageId,
      objectIds,
      changes,
      startedObjects,
    });
    this.active = { snapshot };
    return Object.freeze({
      status: "prepared",
      session: snapshot,
      command: null,
      lifecycleEvents: EMPTY_EVENTS,
    });
  }

  private assertIdle(): void {
    if (!this.active) return;
    throw new SemanticImageSessionError(
      "ACTIVE_SESSION",
      "Finish, abandon, or recover the current semantic image session first.",
    );
  }
}
