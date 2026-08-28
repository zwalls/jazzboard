import { describe, expect, it } from "vitest";

import {
  blobAssetPathname,
  legacyAssetProxyPath,
  privateAssetProxyPath,
} from "@/lib/assets/policy";
import { roomBlobNamespace } from "@/lib/assets/private";
import type {
  ActorRef,
  CanvasObject,
  ImageObject,
  RoomState,
} from "@/lib/domain/types";

import { SemanticCanvasEditLifecycleController } from "./semantic-edit-lifecycle";
import {
  SemanticImageSessionEngine,
  SemanticImageSessionError,
  type SemanticImageCreateInput,
} from "./semantic-image-session";
import { CanvasObjectSyncCoordinator } from "./sync-coordinator";

const ROOM_ID = "room-images";
const ASSET_UUID = "550e8400-e29b-41d4-a716-446655440000";
const AUTHOR: ActorRef = {
  participantId: "human-1",
  displayName: "Human",
  color: "blue",
  kind: "human",
};

function assetPath(roomId = ROOM_ID): string {
  return privateAssetProxyPath(
    roomId,
    blobAssetPathname(
      roomBlobNamespace(roomId),
      `${ASSET_UUID}-architecture.png`,
    ),
  );
}

function imageObject(overrides: Partial<ImageObject> = {}): ImageObject {
  return {
    id: "image-1",
    kind: "image",
    x: 100,
    y: 80,
    width: 640,
    height: 360,
    rotation: 0,
    zIndex: 10,
    revision: 4,
    groupId: null,
    diagramIds: [],
    createdAt: 1_000,
    updatedAt: 2_000,
    createdBy: AUTHOR,
    lastEditedBy: AUTHOR,
    url: assetPath(),
    assetId: null,
    alt: "Architecture reference",
    mimeType: "image/png",
    sourceUrl: "https://example.com/reference.png",
    locked: false,
    ...overrides,
  };
}

function room(objects: readonly CanvasObject[] = [imageObject()]): RoomState {
  return {
    id: ROOM_ID,
    code: "IMAGES",
    title: "Image annotations",
    stateRevision: 9,
    roomRevision: 8,
    createdAt: 100,
    updatedAt: 200,
    participants: {},
    objects: Object.fromEntries(objects.map((object) => [object.id, object])),
    diagrams: {},
    leases: {},
    spotlight: null,
    agentEditPolicy: "live",
    reviewProposals: [],
  };
}

function createInput(
  overrides: Partial<SemanticImageCreateInput> = {},
): SemanticImageCreateInput {
  return {
    roomId: ROOM_ID,
    id: "image-new",
    asset: {
      url: assetPath(),
      assetId: null,
      mimeType: "image/png",
      sourceUrl: "https://example.com/original.png",
    },
    x: 20,
    y: 40,
    width: 320,
    height: 180,
    rotation: 0.25,
    zIndex: 21,
    groupId: null,
    alt: "System overview",
    locked: true,
    ...overrides,
  };
}

function expectSessionError(
  callback: () => unknown,
  code: SemanticImageSessionError["code"],
): void {
  try {
    callback();
    throw new Error("Expected SemanticImageSessionError.");
  } catch (error) {
    expect(error).toBeInstanceOf(SemanticImageSessionError);
    expect(error).toMatchObject({ code });
  }
}

describe("SemanticImageSessionEngine", () => {
  it("accepts a finalized room-local private image and publishes complete create lifecycle events", () => {
    const engine = new SemanticImageSessionEngine();
    const prepared = engine.prepareCreate(createInput());

    expect(prepared).toMatchObject({
      status: "prepared",
      command: null,
      lifecycleEvents: [],
      session: {
        mode: "create",
        phase: "prepared",
        imageId: "image-new",
        objectIds: ["image-new"],
        changes: [{
          kind: "create",
          draft: {
            id: "image-new",
            kind: "image",
            x: 20,
            y: 40,
            width: 320,
            height: 180,
            rotation: 0.25,
            zIndex: 21,
            alt: "System overview",
            locked: true,
          },
        }],
      },
    });
    expect(Object.isFrozen(prepared.session)).toBe(true);
    expect(Object.isFrozen(prepared.session.changes)).toBe(true);

    const published = engine.publish(prepared.session.token);
    expect(published.status).toBe("published");
    if (published.status !== "published") throw new Error("Expected publish.");
    expect(published.lifecycleEvents).toEqual([
      {
        type: "gesture.started",
        gestureId: published.session.gestureId,
        source: "keyboard",
        objects: [{
          objectId: "image-new",
          baseRevision: null,
          baseCreatedAt: null,
          operation: null,
        }],
      },
      {
        type: "objects.changed",
        gestureId: published.session.gestureId,
        changes: published.session.changes,
      },
    ]);

    const coordinator = new CanvasObjectSyncCoordinator();
    const lifecycle = new SemanticCanvasEditLifecycleController(coordinator);
    expect(lifecycle.dispatch(published.lifecycleEvents[0])).toEqual([]);
    const intents = lifecycle.dispatch(published.lifecycleEvents[1]);
    expect(intents).toMatchObject([{
      type: "sync.schedule",
      objectIds: ["image-new"],
      edits: [{ kind: "create", objectId: "image-new" }],
    }]);
    expect(coordinator.get("image-new")).toMatchObject({
      interactionActive: true,
      baseRevision: null,
    });
  });

  it("canonicalizes an absolute same-room proxy URL and preserves source provenance", () => {
    const engine = new SemanticImageSessionEngine();
    const prepared = engine.prepareCreate(createInput({
      asset: {
        url: `https://jazzboard.example${assetPath()}`,
        assetId: null,
        mimeType: "image/webp",
        sourceUrl: "https://images.example/source.webp?version=2",
      },
    }));
    const change = prepared.session.changes[0];
    expect(change.kind === "create" ? change.draft : null).toMatchObject({
      url: assetPath(),
      mimeType: "image/webp",
      sourceUrl: "https://images.example/source.webp?version=2",
    });
  });

  it("accepts a legacy room asset only when its assetId metadata matches", () => {
    const engine = new SemanticImageSessionEngine();
    const url = legacyAssetProxyPath(ROOM_ID, "asset-legacy");
    const prepared = engine.prepareCreate(createInput({
      asset: {
        url,
        assetId: "asset-legacy",
        mimeType: "image/gif",
        sourceUrl: null,
      },
    }));
    const change = prepared.session.changes[0];
    expect(change.kind === "create" ? change.draft : null).toMatchObject({
      url,
      assetId: "asset-legacy",
      mimeType: "image/gif",
    });

    engine.abandon(prepared.session.token);
    expectSessionError(() => engine.prepareCreate(createInput({
      asset: {
        url,
        assetId: "asset-other",
        mimeType: "image/gif",
        sourceUrl: null,
      },
    })), "ASSET_METADATA_MISMATCH");
  });

  it.each([
    {
      label: "public external image",
      asset: {
        url: "https://images.example/public.png",
        assetId: null,
        mimeType: "image/png",
        sourceUrl: null,
      },
      code: "ASSET_NOT_ROOM_LOCAL" as const,
    },
    {
      label: "other room proxy",
      asset: {
        url: assetPath("room-other"),
        assetId: null,
        mimeType: "image/png",
        sourceUrl: null,
      },
      code: "ASSET_NOT_ROOM_LOCAL" as const,
    },
    {
      label: "scriptable SVG",
      asset: {
        url: assetPath(),
        assetId: null,
        mimeType: "image/svg+xml",
        sourceUrl: null,
      },
      code: "INVALID_ASSET" as const,
    },
    {
      label: "non-HTTP provenance",
      asset: {
        url: assetPath(),
        assetId: null,
        mimeType: "image/png",
        sourceUrl: "file:///private/image.png",
      },
      code: "INVALID_ASSET" as const,
    },
  ])("rejects $label before any lifecycle state exists", ({ asset, code }) => {
    const engine = new SemanticImageSessionEngine();
    expectSessionError(
      () => engine.prepareCreate(createInput({ asset })),
      code,
    );
    expect(engine.current()).toBeNull();
  });

  it("validates dimensions and accessible alt length with the domain schema", () => {
    const engine = new SemanticImageSessionEngine();
    expectSessionError(
      () => engine.prepareCreate(createInput({ width: 0 })),
      "INVALID_DRAFT",
    );
    expectSessionError(
      () => engine.prepareCreate(createInput({ alt: "x".repeat(2_001) })),
      "INVALID_DRAFT",
    );
  });

  it("updates image geometry, alt text, and lock state behind exact identity fences", () => {
    const engine = new SemanticImageSessionEngine();
    const source = room();
    const prepared = engine.prepareUpdate({
      room: source,
      objectId: "image-1",
      expectedRevision: 4,
      expectedCreatedAt: 1_000,
      patch: {
        x: 220,
        y: 160,
        width: 800,
        height: 450,
        rotation: 0.5,
        zIndex: 30,
        alt: "Updated system overview",
        locked: true,
      },
    });
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") throw new Error("Expected prepared update.");
    expect(prepared.session.startedObjects).toEqual([{
      objectId: "image-1",
      baseRevision: 4,
      baseCreatedAt: 1_000,
      operation: "resize",
    }]);
    expect(prepared.session.changes).toMatchObject([{
      kind: "update",
      baseRevision: 4,
      baseCreatedAt: 1_000,
      operation: "resize",
      draft: {
        id: "image-1",
        x: 220,
        y: 160,
        width: 800,
        height: 450,
        rotation: 0.5,
        zIndex: 30,
        alt: "Updated system overview",
        locked: true,
        url: assetPath(),
        mimeType: "image/png",
      },
    }]);
    expect(source.objects["image-1"]).toEqual(imageObject());
  });

  it("returns no-op for equivalent patches and classifies a pure move lease", () => {
    const engine = new SemanticImageSessionEngine();
    expect(engine.prepareUpdate({
      room: room(),
      objectId: "image-1",
      expectedRevision: 4,
      expectedCreatedAt: 1_000,
      patch: { alt: "Architecture reference" },
    })).toEqual({ status: "noop", command: null, lifecycleEvents: [] });

    const moved = engine.prepareUpdate({
      room: room(),
      objectId: "image-1",
      expectedRevision: 4,
      expectedCreatedAt: 1_000,
      patch: { x: 101 },
    });
    expect(moved.status === "prepared" ? moved.session.startedObjects : []).toMatchObject([
      { operation: "move" },
    ]);
  });

  it("blocks edits to locked images but permits an explicit unlock-only edit", () => {
    const engine = new SemanticImageSessionEngine();
    const lockedRoom = room([imageObject({ locked: true })]);
    expectSessionError(() => engine.prepareUpdate({
      room: lockedRoom,
      objectId: "image-1",
      expectedRevision: 4,
      expectedCreatedAt: 1_000,
      patch: { x: 200 },
    }), "IMAGE_LOCKED");
    expectSessionError(() => engine.prepareUpdate({
      room: lockedRoom,
      objectId: "image-1",
      expectedRevision: 4,
      expectedCreatedAt: 1_000,
      patch: { locked: false, alt: "Sneaky combined edit" },
    }), "IMAGE_LOCKED");

    const unlock = engine.prepareUpdate({
      room: lockedRoom,
      objectId: "image-1",
      expectedRevision: 4,
      expectedCreatedAt: 1_000,
      patch: { locked: false },
    });
    expect(unlock.status === "prepared" ? unlock.session.changes : []).toMatchObject([
      { kind: "update", operation: "edit", draft: { locked: false } },
    ]);
  });

  it("rejects revision and incarnation mismatches before publishing pixels", () => {
    const engine = new SemanticImageSessionEngine();
    expectSessionError(() => engine.prepareUpdate({
      room: room(),
      objectId: "image-1",
      expectedRevision: 3,
      expectedCreatedAt: 1_000,
      patch: { alt: "Stale" },
    }), "STALE_OBJECT");
    expectSessionError(() => engine.prepareUpdate({
      room: room(),
      objectId: "image-1",
      expectedRevision: 4,
      expectedCreatedAt: 999,
      patch: { alt: "Recreated object" },
    }), "STALE_OBJECT");
  });

  it("creates non-destructive overlapping annotations as ordinary grouped semantic objects", () => {
    const engine = new SemanticImageSessionEngine();
    const prepared = engine.prepareAnnotations({
      room: room([imageObject({ locked: true })]),
      imageId: "image-1",
      expectedRevision: 4,
      expectedCreatedAt: 1_000,
      groupId: "group-image-annotations",
      annotations: [
        {
          id: "annotation-box",
          kind: "shape",
          x: 120,
          y: 100,
          width: 240,
          height: 120,
          rotation: 0,
          zIndex: 11,
          groupId: null,
          shape: "rectangle",
          nodeType: null,
          label: "Important region",
          fill: "none",
          stroke: "red",
        },
        {
          id: "annotation-label",
          kind: "text",
          x: 125,
          y: 105,
          width: 150,
          height: 30,
          rotation: 0,
          zIndex: 12,
          groupId: null,
          content: "Check this",
          color: "red",
          size: "m",
          align: "start",
        },
        {
          id: "annotation-draw",
          kind: "draw",
          x: 130,
          y: 120,
          width: 60,
          height: 40,
          rotation: 0,
          zIndex: 13,
          groupId: null,
          points: [{ x: 0, y: 0 }, { x: 60, y: 40 }],
          color: "red",
          size: "m",
        },
      ],
    });

    expect(prepared.session.objectIds).toEqual([
      "annotation-box",
      "annotation-draw",
      "annotation-label",
      "image-1",
    ]);
    expect(prepared.session.startedObjects).toContainEqual({
      objectId: "image-1",
      baseRevision: 4,
      baseCreatedAt: 1_000,
      operation: "annotate",
    });
    expect(prepared.session.changes).toHaveLength(4);
    expect(prepared.session.changes[0]).toMatchObject({
      kind: "update",
      operation: "annotate",
      draft: { id: "image-1", groupId: "group-image-annotations", locked: true },
    });
    expect(prepared.session.changes.slice(1)).toMatchObject([
      {
        kind: "create",
        draft: {
          id: "annotation-box",
          x: 120,
          y: 100,
          zIndex: 11,
          groupId: "group-image-annotations",
        },
      },
      {
        kind: "create",
        draft: {
          id: "annotation-label",
          x: 125,
          y: 105,
          zIndex: 12,
          groupId: "group-image-annotations",
        },
      },
      {
        kind: "create",
        draft: {
          id: "annotation-draw",
          x: 130,
          y: 120,
          zIndex: 13,
          groupId: "group-image-annotations",
        },
      },
    ]);
  });

  it("reuses an existing image group without rewriting image pixels or metadata", () => {
    const engine = new SemanticImageSessionEngine();
    const prepared = engine.prepareAnnotations({
      room: room([imageObject({ groupId: "group-existing", locked: true })]),
      imageId: "image-1",
      expectedRevision: 4,
      expectedCreatedAt: 1_000,
      annotations: [{
        id: "label-new",
        kind: "text",
        x: 100,
        y: 80,
        width: 200,
        height: 40,
        rotation: 0,
        zIndex: 10,
        groupId: null,
        content: "Intentional exact overlap",
        color: "black",
        size: "m",
        align: "middle",
      }],
    });
    expect(prepared.session.changes).toHaveLength(1);
    expect(prepared.session.changes.some((change) =>
      change.kind === "update" && change.draft.id === "image-1"
    )).toBe(false);
    expect(prepared.session.changes[0]).toMatchObject({
      kind: "create",
      draft: {
        id: "label-new",
        x: 100,
        y: 80,
        zIndex: 10,
        groupId: "group-existing",
      },
    });
    expect(prepared.session.startedObjects[0]).toMatchObject({
      objectId: "image-1",
      operation: "annotate",
    });
  });

  it("rejects duplicate IDs and conflicting annotation groups", () => {
    const duplicate = new SemanticImageSessionEngine();
    expectSessionError(() => duplicate.prepareAnnotations({
      room: room(),
      imageId: "image-1",
      expectedRevision: 4,
      expectedCreatedAt: 1_000,
      groupId: "annotations",
      annotations: [{
        id: "image-1",
        kind: "text",
        x: 0,
        y: 0,
        width: 100,
        height: 40,
        rotation: 0,
        zIndex: 1,
        groupId: null,
        content: "duplicate",
        color: "black",
        size: "m",
        align: "start",
      }],
    }), "INVALID_ANNOTATION");

    const conflicting = new SemanticImageSessionEngine();
    expectSessionError(() => conflicting.prepareAnnotations({
      room: room([imageObject({ groupId: "existing" })]),
      imageId: "image-1",
      expectedRevision: 4,
      expectedCreatedAt: 1_000,
      groupId: "different",
      annotations: [{
        id: "new-label",
        kind: "text",
        x: 0,
        y: 0,
        width: 100,
        height: 40,
        rotation: 0,
        zIndex: 1,
        groupId: null,
        content: "conflict",
        color: "black",
        size: "m",
        align: "start",
      }],
    }), "INVALID_GROUP");

    const unsupported = new SemanticImageSessionEngine();
    expectSessionError(() => unsupported.prepareAnnotations({
      room: room(),
      imageId: "image-1",
      expectedRevision: 4,
      expectedCreatedAt: 1_000,
      groupId: "annotations",
      annotations: [{
        id: "connector-not-an-annotation",
        kind: "connector",
        x: 0,
        y: 0,
        width: 100,
        height: 1,
        rotation: 0,
        zIndex: 1,
        groupId: null,
        start: { x: 0, y: 0, objectId: null },
        end: { x: 100, y: 0, objectId: null },
        direction: "end",
        label: "unsupported",
        color: "black",
      } as never],
    }), "INVALID_ANNOTATION");
  });

  it("finishes through the shared settle boundary and makes old tokens stale", () => {
    const engine = new SemanticImageSessionEngine();
    const prepared = engine.prepareCreate(createInput());
    engine.publish(prepared.session.token);
    const finished = engine.finish(prepared.session.token);
    expect(finished.status).toBe("finished");
    if (finished.status !== "finished") throw new Error("Expected finish.");
    expect(finished.lifecycleEvents).toEqual([{
      type: "gesture.finish-requested",
      gestureId: prepared.session.gestureId,
      reason: "keyboard-idle",
    }]);
    expect(engine.publish(prepared.session.token)).toEqual({
      status: "stale",
      token: prepared.session.token,
    });
  });

  it("abandons an unpublished create without pretending it was saved", () => {
    const engine = new SemanticImageSessionEngine();
    const prepared = engine.prepareCreate(createInput());
    expect(engine.abandon(prepared.session.token)).toEqual({
      status: "abandoned",
      token: prepared.session.token,
      clearObjectIds: ["image-new"],
      command: null,
      lifecycleEvents: [],
    });
    expect(engine.current()).toBeNull();
  });

  it("uses explicit authoritative recovery for a published edit and fences incomplete recovery", () => {
    const engine = new SemanticImageSessionEngine();
    const prepared = engine.prepareUpdate({
      room: room(),
      objectId: "image-1",
      expectedRevision: 4,
      expectedCreatedAt: 1_000,
      patch: { alt: "Optimistic alt" },
    });
    if (prepared.status !== "prepared") throw new Error("Expected prepared update.");
    const published = engine.publish(prepared.session.token);
    if (published.status !== "published") throw new Error("Expected publish.");

    const coordinator = new CanvasObjectSyncCoordinator();
    const lifecycle = new SemanticCanvasEditLifecycleController(coordinator);
    lifecycle.dispatch(published.lifecycleEvents[0]);
    lifecycle.dispatch(published.lifecycleEvents[1]);

    const recovery = engine.requestRecovery(prepared.session.token);
    expect(recovery).toMatchObject({
      status: "recovery-required",
      objectIds: ["image-1"],
      lifecycleEvents: [],
    });
    expectSessionError(() => engine.settleRecovery(prepared.session.token, []), "STALE_OBJECT");

    // The host owns the recovery work: fence queued edits, refresh and install
    // authority, force-project, and release the cohort before emitting settle.
    coordinator.beginRecovery("image-1");
    coordinator.completeRecovery("image-1", 4, 1_000);
    const settled = engine.settleRecovery(prepared.session.token, [{
      objectId: "image-1",
      revision: 4,
      createdAt: 1_000,
    }]);
    expect(settled.status).toBe("recovery-settled");
    if (settled.status !== "recovery-settled") throw new Error("Expected recovery.");
    expect(settled.lifecycleEvents).toEqual([{
      type: "gesture.recovery-settled",
      gestureId: prepared.session.gestureId,
      authoritative: [{ objectId: "image-1", revision: 4, createdAt: 1_000 }],
    }]);
    expect(lifecycle.dispatch(settled.lifecycleEvents[0])).toEqual([]);
    expect(coordinator.get("image-1")).toMatchObject({
      interactionActive: false,
      awaitingRecovery: false,
      baseRevision: 4,
      baseCreatedAt: 1_000,
    });
    expect(engine.current()).toBeNull();
  });
});
