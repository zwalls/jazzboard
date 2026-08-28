import { describe, expect, it } from "vitest";

import { blobAssetPathname, privateAssetProxyPath } from "@/lib/assets/policy";
import { roomBlobNamespace } from "@/lib/assets/private";

import {
  LEASE_DURATION_MS,
  acquireObjectLease,
  acquireObjectLeases,
  applyCanvasCommand,
  normalizeRoomSemanticState,
  pruneExpiredLeases,
  releaseObjectLease,
  releaseObjectLeases,
  renewObjectLease,
  renewObjectLeases,
  requireMutationRole,
  requireParticipant,
} from "./engine";
import { DomainError } from "./errors";
import type {
  ActorKind,
  ActorRef,
  CanvasCommand,
  CanvasObject,
  Participant,
  RoomRole,
  RoomState,
  TextObject,
} from "./types";

const START = 1_000_000;
const ASSET_UUID = "550e8400-e29b-41d4-a716-446655440000";

function presence(lastSeenAt = START) {
  return {
    cursor: null,
    viewport: null,
    lastSeenAt,
    activity: null,
  };
}

function participant(
  participantId: string,
  displayName: string,
  color: string,
  role: RoomRole = "participant",
): Participant {
  return {
    participantId,
    displayName,
    color,
    role,
    joinedAt: START,
    lastSeenAt: START,
    connected: true,
    agentActive: false,
    human: presence(),
    agent: presence(),
  };
}

const alice = participant("alice", "Alice", "#ef476f");
const bob = participant("bob", "Bob", "#118ab2");
const sam = participant("sam", "Sam", "#8b5cf6", "spectator");

function actor(owner: Participant, kind: ActorKind = "human"): ActorRef {
  return {
    participantId: owner.participantId,
    displayName: owner.displayName,
    color: owner.color,
    kind,
  };
}

function textObject(
  id: string,
  overrides: Partial<TextObject> = {},
): TextObject {
  return {
    id,
    kind: "text",
    x: 10,
    y: 20,
    width: 240,
    height: 80,
    rotation: 0,
    zIndex: 0,
    revision: 1,
    groupId: null,
    diagramIds: [],
    createdAt: START,
    updatedAt: START,
    createdBy: actor(alice),
    lastEditedBy: actor(alice),
    content: `Text for ${id}`,
    color: "black",
    size: "m",
    align: "start",
    ...overrides,
  };
}

function roomWith(...objects: CanvasObject[]): RoomState {
  return {
    id: "room-1",
    code: "2468",
    title: "Architecture room",
    roomRevision: 7,
    createdAt: START,
    updatedAt: START,
    participants: {
      [alice.participantId]: structuredClone(alice),
      [bob.participantId]: structuredClone(bob),
      [sam.participantId]: structuredClone(sam),
    },
    objects: Object.fromEntries(objects.map((object) => [object.id, object])),
    diagrams: {},
    leases: {},
    spotlight: null,
    agentEditPolicy: "live",
    reviewProposals: [],
  };
}

function domainError(run: () => unknown): DomainError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    return error as DomainError;
  }
  throw new Error("Expected a DomainError to be thrown.");
}

describe("room membership and mutation authorization", () => {
  it("returns members and rejects unknown guest sessions", () => {
    const room = roomWith();

    expect(requireParticipant(room, "alice")).toMatchObject({
      participantId: "alice",
      role: "participant",
    });

    const error = domainError(() => requireParticipant(room, "outsider"));
    expect(error).toMatchObject({
      code: "FORBIDDEN",
      message: "This guest session is not a member of the room.",
    });
  });

  it("allows participant humans and agents to mutate", () => {
    expect(() => requireMutationRole(alice, "human")).not.toThrow();
    expect(() => requireMutationRole(alice, "agent")).not.toThrow();
  });

  it.each(["human", "agent"] as const)(
    "rejects spectator %s mutations without changing source state",
    (actorKind) => {
      const source = roomWith();
      const before = structuredClone(source);

      const error = domainError(() =>
        applyCanvasCommand(
          source,
          "sam",
          actorKind,
          {
            type: "create",
            object: {
              id: "blocked",
              kind: "text",
              x: 0,
              y: 0,
              width: 100,
              height: 40,
              rotation: 0,
              zIndex: 0,
              groupId: null,
              content: "Nope",
              color: "black",
              size: "m",
              align: "start",
            },
          },
          START + 1,
        ),
      );

      expect(error.code).toBe("FORBIDDEN");
      expect(error.details).toEqual({ role: "spectator" });
      expect(source).toEqual(before);
    },
  );

  it("rejects spectator lease acquisition", () => {
    const source = roomWith(textObject("note"));
    const error = domainError(() =>
      acquireObjectLease(source, "sam", "human", "note", 1, "edit", START + 1),
    );

    expect(error.code).toBe("FORBIDDEN");
    expect(source.leases).toEqual({});
  });
});

describe("canvas commands", () => {
  it("creates an attributed revision-one object without mutating the source", () => {
    const source = roomWith();
    const now = START + 100;

    const result = applyCanvasCommand(
      source,
      "alice",
      "human",
      {
        type: "create",
        object: {
          id: "new-note",
          kind: "text",
          x: 50,
          y: 60,
          width: 200,
          height: 70,
          rotation: 0,
          zIndex: 3,
          groupId: null,
          content: "Shared state",
          color: "black",
          size: "l",
          align: "start",
        },
      },
      now,
    );

    expect(source.objects).toEqual({});
    expect(source.roomRevision).toBe(7);
    expect(result.changedObjectIds).toEqual(["new-note"]);
    expect(result.room.objects["new-note"]).toMatchObject({
      id: "new-note",
      kind: "text",
      revision: 1,
      createdAt: now,
      updatedAt: now,
      createdBy: actor(alice),
      lastEditedBy: actor(alice),
    });
    expect(result.room).toMatchObject({ roomRevision: 8, updatedAt: now });
  });

  it("accepts only this room's exact private image namespace", () => {
    const source = roomWith();
    const imageObject = {
      id: "private-image",
      kind: "image" as const,
      x: 0,
      y: 0,
      width: 320,
      height: 180,
      rotation: 0,
      zIndex: 0,
      groupId: null,
      url: privateAssetProxyPath(
        source.id,
        blobAssetPathname(roomBlobNamespace(source.id), `${ASSET_UUID}-upload.png`),
      ),
      assetId: null,
      alt: "Private diagram",
      mimeType: "image/png",
      sourceUrl: null,
      locked: false,
    };

    expect(
      applyCanvasCommand(source, "alice", "human", { type: "create", object: imageObject }).room
        .objects[imageObject.id],
    ).toMatchObject({ url: imageObject.url });

    const absoluteUrl = `https://jazzboard-alias.example${imageObject.url}`;
    const canonicalized = applyCanvasCommand(source, "alice", "human", {
      type: "create",
      object: { ...imageObject, id: "absolute-private-image", url: absoluteUrl },
    });
    expect(canonicalized.room.objects["absolute-private-image"]).toMatchObject({
      url: imageObject.url,
    });

    const wrongRoom = domainError(() =>
      applyCanvasCommand(source, "alice", "human", {
        type: "create",
        object: {
          ...imageObject,
          id: "wrong-room-image",
          url: privateAssetProxyPath(
            "room-elsewhere",
            blobAssetPathname(roomBlobNamespace("room-elsewhere"), `${ASSET_UUID}-upload.png`),
          ),
        },
      }),
    );
    expect(wrongRoom).toMatchObject({ code: "INVALID_OPERATION" });

    const wrongNamespace = domainError(() =>
      applyCanvasCommand(source, "alice", "human", {
        type: "create",
        object: {
          ...imageObject,
          id: "wrong-namespace-image",
          url: privateAssetProxyPath(
            source.id,
            blobAssetPathname(roomBlobNamespace("room-elsewhere"), `${ASSET_UUID}-upload.png`),
          ),
        },
      }),
    );
    expect(wrongNamespace).toMatchObject({ code: "INVALID_OPERATION" });

    const wrongAbsoluteRoom = domainError(() =>
      applyCanvasCommand(source, "alice", "human", {
        type: "create",
        object: {
          ...imageObject,
          id: "wrong-absolute-room-image",
          url: `https://another-jazzboard-alias.example${privateAssetProxyPath(
            "room-elsewhere",
            blobAssetPathname(
              roomBlobNamespace("room-elsewhere"),
              `${ASSET_UUID}-upload.png`,
            ),
          )}`,
        },
      }),
    );
    expect(wrongAbsoluteRoom).toMatchObject({ code: "INVALID_OPERATION" });
    expect(source.objects).toEqual({});
  });

  it("updates through an agent, preserves immutable metadata, and activates that agent", () => {
    const original = textObject("note");
    const source = roomWith(original);
    const now = START + 200;

    const result = applyCanvasCommand(
      source,
      "alice",
      "agent",
      {
        type: "update",
        objectId: "note",
        expectedRevision: 1,
        operation: "edit",
        patch: {
          content: "Agent-authored update",
          color: "#ef476f",
        },
      },
      now,
    );

    expect(source.participants.alice.agentActive).toBe(false);
    expect(source.objects.note).toEqual(original);
    expect(result.room.objects.note).toMatchObject({
      id: "note",
      kind: "text",
      revision: 2,
      content: "Agent-authored update",
      color: "#ef476f",
      createdAt: START,
      createdBy: actor(alice),
      updatedAt: now,
      lastEditedBy: actor(alice, "agent"),
    });
    expect(result.room.participants.alice).toMatchObject({ agentActive: true });
    expect(result.room.participants.alice.agent.lastSeenAt).toBe(now);
  });

  it("rejects fields that do not belong to the stored semantic object kind", () => {
    const source = roomWith(textObject("note"));
    const error = domainError(() =>
      applyCanvasCommand(source, "alice", "agent", {
        type: "update",
        objectId: "note",
        expectedRevision: 1,
        operation: "edit",
        patch: { locked: true },
      }),
    );

    expect(error).toMatchObject({
      code: "INVALID_OPERATION",
      details: { objectId: "note", kind: "text", invalidFields: ["locked"] },
    });
    expect(source.objects.note).toMatchObject({ revision: 1, content: "Text for note" });
  });

  it("moves multiple objects atomically and increments each revision once", () => {
    const source = roomWith(textObject("a"), textObject("b", { x: 300 }));
    const result = applyCanvasCommand(
      source,
      "bob",
      "human",
      {
        type: "move",
        targets: [
          { objectId: "a", expectedRevision: 1, x: 100, y: 110 },
          { objectId: "b", expectedRevision: 1, x: 200, y: 210 },
        ],
      },
      START + 300,
    );

    expect(result.changedObjectIds).toEqual(["a", "b"]);
    expect(result.room.objects.a).toMatchObject({ x: 100, y: 110, revision: 2 });
    expect(result.room.objects.b).toMatchObject({ x: 200, y: 210, revision: 2 });
    expect(result.room.objects.a.lastEditedBy).toEqual(actor(bob));
    expect(result.room.roomRevision).toBe(source.roomRevision + 1);
    expect(result.room.stateRevision).toBe((source.stateRevision ?? source.roomRevision) + 1);
  });

  it("groups and ungroups multiple objects", () => {
    const source = roomWith(textObject("a"), textObject("b"));
    const grouped = applyCanvasCommand(
      source,
      "alice",
      "human",
      {
        type: "group",
        groupId: "image-annotations",
        targets: [
          { objectId: "a", expectedRevision: 1 },
          { objectId: "b", expectedRevision: 1 },
        ],
      },
      START + 400,
    ).room;

    expect(grouped.objects.a).toMatchObject({ groupId: "image-annotations", revision: 2 });
    expect(grouped.objects.b).toMatchObject({ groupId: "image-annotations", revision: 2 });

    const ungrouped = applyCanvasCommand(
      grouped,
      "alice",
      "human",
      {
        type: "group",
        groupId: null,
        targets: [
          { objectId: "a", expectedRevision: 2 },
          { objectId: "b", expectedRevision: 2 },
        ],
      },
      START + 500,
    ).room;

    expect(ungrouped.objects.a).toMatchObject({ groupId: null, revision: 3 });
    expect(ungrouped.objects.b).toMatchObject({ groupId: null, revision: 3 });
  });

  it("deletes all requested objects and their leases", () => {
    let source = roomWith(textObject("a"), textObject("b"));
    const leased = acquireObjectLease(source, "alice", "human", "a", 1, "delete", START + 10);
    source = leased.room;

    const result = applyCanvasCommand(
      source,
      "alice",
      "human",
      {
        type: "delete",
        targets: [
          { objectId: "a", expectedRevision: 1, leaseId: leased.lease.leaseId },
          { objectId: "b", expectedRevision: 1 },
        ],
      },
      START + 20,
    );

    expect(result.changedObjectIds).toEqual(["a", "b"]);
    expect(result.room.objects).toEqual({});
    expect(result.room.leases).toEqual({});
    expect(source.objects).toHaveProperty("a");
  });

  it("rejects duplicate object creation without changing the source", () => {
    const source = roomWith(textObject("note"));
    const before = structuredClone(source);
    const command: CanvasCommand = {
      type: "create",
      object: {
        id: "note",
        kind: "text",
        x: 0,
        y: 0,
        width: 100,
        height: 50,
        rotation: 0,
        zIndex: 0,
        groupId: null,
        content: "Duplicate",
        color: "black",
        size: "m",
        align: "start",
      },
    };

    const error = domainError(() => applyCanvasCommand(source, "alice", "human", command));
    expect(error.code).toBe("INVALID_OPERATION");
    expect(source).toEqual(before);
  });
});

describe("decision and open-question lifecycle metadata", () => {
  const createDecision = {
    type: "create",
    object: {
      id: "decision-auth",
      kind: "shape",
      x: 20,
      y: 30,
      width: 240,
      height: 100,
      rotation: 0,
      zIndex: 1,
      groupId: null,
      shape: "diamond",
      nodeType: "decision",
      label: "Use signed guest sessions?",
      fill: "yellow",
      stroke: "orange",
    },
  } satisfies CanvasCommand;

  it("creates authoritative defaults for lifecycle node classifications", () => {
    const created = applyCanvasCommand(roomWith(), "alice", "human", createDecision, START + 10);
    expect(created.room.objects["decision-auth"]).toMatchObject({
      nodeType: "decision",
      nodeMetadata: {
        kind: "decision",
        status: "proposed",
        owner: null,
        resolution: null,
        resolvedAt: null,
      },
    });

    const migrated = normalizeRoomSemanticState({
      ...roomWith(),
      objects: {
        legacy: {
          ...(created.room.objects["decision-auth"] as Extract<CanvasObject, { kind: "shape" }>),
          id: "legacy",
          nodeMetadata: undefined,
        },
      },
    });
    expect(migrated.objects.legacy).toMatchObject({
      nodeMetadata: { kind: "decision", status: "proposed", resolvedAt: null },
    });
  });

  it("sets and preserves a server-managed resolution time, then clears it when reopened", () => {
    const created = applyCanvasCommand(roomWith(), "alice", "agent", createDecision, START + 10);
    const accepted = applyCanvasCommand(
      created.room,
      "alice",
      "agent",
      {
        type: "update",
        objectId: "decision-auth",
        expectedRevision: 1,
        operation: "edit",
        patch: {
          nodeMetadata: {
            kind: "decision",
            status: "accepted",
            owner: "Platform team",
            resolution: "Use HMAC-signed, HttpOnly guest-session cookies.",
          },
        },
      },
      START + 20,
    );
    expect(accepted.room.objects["decision-auth"]).toMatchObject({
      revision: 2,
      nodeMetadata: { status: "accepted", resolvedAt: START + 20 },
    });

    const restyled = applyCanvasCommand(
      accepted.room,
      "alice",
      "human",
      {
        type: "update",
        objectId: "decision-auth",
        expectedRevision: 2,
        operation: "edit",
        patch: { fill: "green" },
      },
      START + 30,
    );
    expect(restyled.room.objects["decision-auth"]).toMatchObject({
      nodeMetadata: { status: "accepted", resolvedAt: START + 20 },
    });

    const reopened = applyCanvasCommand(
      restyled.room,
      "alice",
      "human",
      {
        type: "update",
        objectId: "decision-auth",
        expectedRevision: 3,
        operation: "edit",
        patch: {
          nodeMetadata: {
            kind: "decision",
            status: "proposed",
            owner: "Platform team",
            resolution: null,
          },
        },
      },
      START + 40,
    );
    expect(reopened.room.objects["decision-auth"]).toMatchObject({
      nodeMetadata: { status: "proposed", resolution: null, resolvedAt: null },
    });
  });

  it("rejects incompatible metadata and unresolved terminal states atomically", () => {
    const source = roomWith();
    const before = structuredClone(source);
    const mismatch = domainError(() => applyCanvasCommand(
      source,
      "alice",
      "agent",
      {
        ...createDecision,
        object: {
          ...createDecision.object,
          nodeMetadata: {
            kind: "open_question",
            status: "open",
            owner: null,
            resolution: null,
          },
        },
      },
      START + 50,
    ));
    expect(mismatch.code).toBe("INVALID_OPERATION");
    expect(source).toEqual(before);

    const unresolved = domainError(() => applyCanvasCommand(
      source,
      "alice",
      "agent",
      {
        ...createDecision,
        object: {
          ...createDecision.object,
          nodeMetadata: {
            kind: "decision",
            status: "accepted",
            owner: null,
            resolution: null,
          },
        },
      },
      START + 60,
    ));
    expect(unresolved.code).toBe("INVALID_OPERATION");
    expect(source).toEqual(before);
  });
});

describe("object revision and atomicity rules", () => {
  it.each([
    {
      name: "update",
      command: {
        type: "update",
        objectId: "a",
        expectedRevision: 1,
        operation: "edit",
        patch: { content: "stale" },
      } satisfies CanvasCommand,
    },
    {
      name: "move",
      command: {
        type: "move",
        targets: [{ objectId: "a", expectedRevision: 1, x: 500, y: 500 }],
      } satisfies CanvasCommand,
    },
    {
      name: "group",
      command: {
        type: "group",
        groupId: "group-a",
        targets: [{ objectId: "a", expectedRevision: 1 }],
      } satisfies CanvasCommand,
    },
    {
      name: "delete",
      command: {
        type: "delete",
        targets: [{ objectId: "a", expectedRevision: 1 }],
      } satisfies CanvasCommand,
    },
  ])("rejects a stale revision for $name", ({ command }) => {
    const source = roomWith(textObject("a", { revision: 2 }));
    const before = structuredClone(source);
    const error = domainError(() =>
      applyCanvasCommand(source, "alice", "human", command, START + 600),
    );

    expect(error.code).toBe("REVISION_CONFLICT");
    expect(error.details).toEqual({
      objectId: "a",
      expectedRevision: 1,
      currentRevision: 2,
    });
    expect(source).toEqual(before);
  });

  it.each(["move", "group", "delete"] as const)(
    "applies no part of a multi-object %s when a later target is stale",
    (type) => {
      const source = roomWith(textObject("a"), textObject("b", { revision: 2 }));
      const before = structuredClone(source);
      const targets = [
        { objectId: "a", expectedRevision: 1 },
        { objectId: "b", expectedRevision: 1 },
      ];
      const command: CanvasCommand =
        type === "move"
          ? {
              type,
              targets: targets.map((target, index) => ({
                ...target,
                x: 100 + index,
                y: 200 + index,
              })),
            }
          : type === "group"
            ? { type, targets, groupId: "group-a" }
            : { type, targets };

      const error = domainError(() =>
        applyCanvasCommand(source, "alice", "human", command, START + 700),
      );

      expect(error.code).toBe("REVISION_CONFLICT");
      expect(source).toEqual(before);
    },
  );
});

describe("active-object leases", () => {
  it("acquires a multi-object lease batch atomically with one coordination revision", () => {
    const source = roomWith(textObject("a"), textObject("b", { revision: 3 }));
    const result = acquireObjectLeases(
      source,
      "alice",
      "human",
      [
        { objectId: "a", expectedRevision: 1, operation: "move" },
        { objectId: "b", expectedRevision: 3, operation: "resize" },
      ],
      START + 10,
    );

    expect(source.leases).toEqual({});
    expect(result.leases.map((lease) => lease.objectId)).toEqual(["a", "b"]);
    expect(result.room.leases).toMatchObject({
      a: { operation: "move", objectRevision: 1 },
      b: { operation: "resize", objectRevision: 3 },
    });
    expect(result.room.roomRevision).toBe(source.roomRevision);
    expect(result.room.stateRevision).toBe((source.stateRevision ?? source.roomRevision) + 1);
  });

  it("applies no part of a lease batch when a later target is stale", () => {
    const source = roomWith(textObject("a"), textObject("b", { revision: 3 }));
    const before = structuredClone(source);
    const error = domainError(() =>
      acquireObjectLeases(
        source,
        "alice",
        "human",
        [
          { objectId: "a", expectedRevision: 1, operation: "move" },
          { objectId: "b", expectedRevision: 2, operation: "move" },
        ],
        START + 10,
      ),
    );

    expect(error.code).toBe("REVISION_CONFLICT");
    expect(source).toEqual(before);
    expect(source.leases).toEqual({});
  });

  it("renews and releases lease batches atomically with one revision per changed batch", () => {
    const acquired = acquireObjectLeases(
      roomWith(textObject("a"), textObject("b")),
      "alice",
      "human",
      [
        { objectId: "a", expectedRevision: 1, operation: "move" },
        { objectId: "b", expectedRevision: 1, operation: "move" },
      ],
      START + 10,
    );
    const targets = acquired.leases.map(({ objectId, leaseId }) => ({ objectId, leaseId }));
    const renewed = renewObjectLeases(acquired.room, "alice", "human", targets, START + 100);

    expect(renewed.leases.map((lease) => lease.expiresAt)).toEqual([
      START + 100 + LEASE_DURATION_MS,
      START + 100 + LEASE_DURATION_MS,
    ]);
    expect(renewed.room.stateRevision).toBe(acquired.room.stateRevision! + 1);

    const released = releaseObjectLeases(renewed.room, "alice", "human", targets, START + 110);
    expect(released.leases).toEqual([]);
    expect(released.room.leases).toEqual({});
    expect(released.room.stateRevision).toBe(renewed.room.stateRevision! + 1);
  });

  it("does not partially renew or release a batch with a wrong token", () => {
    const acquired = acquireObjectLeases(
      roomWith(textObject("a"), textObject("b")),
      "alice",
      "human",
      [
        { objectId: "a", expectedRevision: 1, operation: "move" },
        { objectId: "b", expectedRevision: 1, operation: "move" },
      ],
      START + 10,
    );
    const invalidTargets = [
      { objectId: "a", leaseId: acquired.leases[0].leaseId },
      { objectId: "b", leaseId: "wrong-token" },
    ];
    const before = structuredClone(acquired.room);

    expect(domainError(() => renewObjectLeases(acquired.room, "alice", "human", invalidTargets, START + 100)).code)
      .toBe("LEASE_NOT_FOUND");
    expect(domainError(() => releaseObjectLeases(acquired.room, "alice", "human", invalidTargets, START + 100)).code)
      .toBe("LEASE_NOT_FOUND");
    expect(acquired.room).toEqual(before);
  });

  it("acquires a revision-bound lease with the configured expiry", () => {
    const source = roomWith(textObject("note"));
    const result = acquireObjectLease(source, "alice", "human", "note", 1, "edit", START + 10);

    expect(source.leases).toEqual({});
    expect(result.lease).toMatchObject({
      objectId: "note",
      actor: actor(alice),
      operation: "edit",
      objectRevision: 1,
      acquiredAt: START + 10,
      expiresAt: START + 10 + LEASE_DURATION_MS,
    });
    expect(result.lease.leaseId).toMatch(/[0-9a-f-]{36}/);
    expect(result.room.leases.note).toEqual(result.lease);
    expect(result.room.roomRevision).toBe(source.roomRevision);
    expect(result.room.stateRevision).toBe((source.stateRevision ?? source.roomRevision) + 1);
  });

  it("reacquires for the same actor by extending the same lease", () => {
    const first = acquireObjectLease(
      roomWith(textObject("note")),
      "alice",
      "human",
      "note",
      1,
      "edit",
      START + 10,
    );
    const second = acquireObjectLease(
      first.room,
      "alice",
      "human",
      "note",
      1,
      "resize",
      START + 20,
    );

    expect(second.lease).toMatchObject({
      leaseId: first.lease.leaseId,
      acquiredAt: first.lease.acquiredAt,
      operation: "resize",
      expiresAt: START + 20 + LEASE_DURATION_MS,
    });
  });

  it("renews only the exact actor and lease token", () => {
    const acquired = acquireObjectLease(
      roomWith(textObject("note")),
      "alice",
      "human",
      "note",
      1,
      "edit",
      START + 10,
    );
    const renewed = renewObjectLease(
      acquired.room,
      "alice",
      "human",
      "note",
      acquired.lease.leaseId,
      START + 100,
    );

    expect(renewed.lease.expiresAt).toBe(START + 100 + LEASE_DURATION_MS);
    expect(renewed.lease.leaseId).toBe(acquired.lease.leaseId);

    const wrongKind = domainError(() =>
      renewObjectLease(
        acquired.room,
        "alice",
        "agent",
        "note",
        acquired.lease.leaseId,
        START + 100,
      ),
    );
    expect(wrongKind.code).toBe("LEASE_NOT_FOUND");

    const wrongToken = domainError(() =>
      renewObjectLease(acquired.room, "alice", "human", "note", "wrong-token", START + 100),
    );
    expect(wrongToken.code).toBe("LEASE_NOT_FOUND");
  });

  it("releases only the exact actor and lease token", () => {
    const acquired = acquireObjectLease(
      roomWith(textObject("note")),
      "alice",
      "human",
      "note",
      1,
      "edit",
      START + 10,
    );

    const wrongOwner = domainError(() =>
      releaseObjectLease(
        acquired.room,
        "bob",
        "human",
        "note",
        acquired.lease.leaseId,
        START + 20,
      ),
    );
    expect(wrongOwner.code).toBe("LEASE_NOT_FOUND");
    expect(acquired.room.leases.note).toEqual(acquired.lease);

    const released = releaseObjectLease(
      acquired.room,
      "alice",
      "human",
      "note",
      acquired.lease.leaseId,
      START + 20,
    );
    expect(released.leases).toEqual({});
    expect(released.roomRevision).toBe(acquired.room.roomRevision);
    expect(released.stateRevision).toBe(
      (acquired.room.stateRevision ?? acquired.room.roomRevision) + 1,
    );
  });

  it("prunes leases at the exact expiry boundary", () => {
    const acquired = acquireObjectLease(
      roomWith(textObject("note")),
      "alice",
      "human",
      "note",
      1,
      "edit",
      START,
    );
    const beforeExpiry = structuredClone(acquired.room);
    pruneExpiredLeases(beforeExpiry, START + LEASE_DURATION_MS - 1);
    expect(beforeExpiry.leases).toHaveProperty("note");

    pruneExpiredLeases(beforeExpiry, START + LEASE_DURATION_MS);
    expect(beforeExpiry.leases).toEqual({});
  });

  it("lets a competing actor mutate after expiry and removes the stale lease", () => {
    const acquired = acquireObjectLease(
      roomWith(textObject("note")),
      "alice",
      "human",
      "note",
      1,
      "edit",
      START,
    );
    const result = applyCanvasCommand(
      acquired.room,
      "bob",
      "human",
      {
        type: "update",
        objectId: "note",
        expectedRevision: 1,
        operation: "edit",
        patch: { content: "Edited after expiry" },
      },
      START + LEASE_DURATION_MS,
    );

    expect(result.room.leases).toEqual({});
    expect(result.room.objects.note).toMatchObject({
      content: "Edited after expiry",
      revision: 2,
      lastEditedBy: actor(bob),
    });
  });

  it("rejects renewing an expired lease", () => {
    const acquired = acquireObjectLease(
      roomWith(textObject("note")),
      "alice",
      "human",
      "note",
      1,
      "edit",
      START,
    );
    const error = domainError(() =>
      renewObjectLease(
        acquired.room,
        "alice",
        "human",
        "note",
        acquired.lease.leaseId,
        START + LEASE_DURATION_MS,
      ),
    );

    expect(error.code).toBe("LEASE_NOT_FOUND");
  });

  it("allows the exact lease holder to mutate with its token", () => {
    const acquired = acquireObjectLease(
      roomWith(textObject("note")),
      "alice",
      "human",
      "note",
      1,
      "edit",
      START + 10,
    );
    const result = applyCanvasCommand(
      acquired.room,
      "alice",
      "human",
      {
        type: "update",
        objectId: "note",
        expectedRevision: 1,
        operation: "edit",
        leaseId: acquired.lease.leaseId,
        patch: { content: "Lease holder edit" },
      },
      START + 20,
    );

    expect(result.room.objects.note).toMatchObject({ content: "Lease holder edit", revision: 2 });
  });

  it("treats a participant's human and agent as competing actors", () => {
    const acquired = acquireObjectLease(
      roomWith(textObject("note")),
      "alice",
      "human",
      "note",
      1,
      "edit",
      START + 10,
    );
    const error = domainError(() =>
      applyCanvasCommand(
        acquired.room,
        "alice",
        "agent",
        {
          type: "update",
          objectId: "note",
          expectedRevision: 1,
          operation: "annotate",
          patch: { content: "Conflicting agent edit" },
        },
        START + 20,
      ),
    );

    expect(error.code).toBe("OBJECT_BUSY");
    expect(error.details).toEqual({
      objectId: "note",
      actor: actor(alice),
      operation: "edit",
      currentRevision: 1,
      expiresAt: START + 10 + LEASE_DURATION_MS,
    });
    expect(acquired.room.participants.alice.agentActive).toBe(false);
  });

  it("returns complete OBJECT_BUSY context for another participant", () => {
    const acquired = acquireObjectLease(
      roomWith(textObject("note", { revision: 4 })),
      "bob",
      "agent",
      "note",
      4,
      "resize",
      START + 10,
    );
    const error = domainError(() =>
      applyCanvasCommand(
        acquired.room,
        "alice",
        "human",
        {
          type: "move",
          targets: [{ objectId: "note", expectedRevision: 4, x: 10, y: 10 }],
        },
        START + 20,
      ),
    );

    expect(error.code).toBe("OBJECT_BUSY");
    expect(error.message).toContain("Bob");
    expect(error.message).toBe("Bob is currently resizing this object.");
    expect(error.details).toEqual({
      objectId: "note",
      actor: actor(bob, "agent"),
      operation: "resize",
      currentRevision: 4,
      expiresAt: START + 10 + LEASE_DURATION_MS,
    });
  });

  it("reports OBJECT_BUSY before a stale revision for commands", () => {
    const acquired = acquireObjectLease(
      roomWith(textObject("note", { revision: 4 })),
      "bob",
      "human",
      "note",
      4,
      "edit",
      START + 10,
    );
    const error = domainError(() =>
      applyCanvasCommand(
        acquired.room,
        "alice",
        "agent",
        {
          type: "update",
          objectId: "note",
          expectedRevision: 1,
          operation: "edit",
          patch: { content: "Stale and busy" },
        },
        START + 20,
      ),
    );

    expect(error.code).toBe("OBJECT_BUSY");
    expect(error.details).toMatchObject({ currentRevision: 4 });
  });

  it("reports OBJECT_BUSY before a stale revision while acquiring", () => {
    const acquired = acquireObjectLease(
      roomWith(textObject("note", { revision: 4 })),
      "alice",
      "human",
      "note",
      4,
      "edit",
      START + 10,
    );
    const error = domainError(() =>
      acquireObjectLease(
        acquired.room,
        "alice",
        "agent",
        "note",
        1,
        "annotate",
        START + 20,
      ),
    );

    expect(error.code).toBe("OBJECT_BUSY");
    expect(error.details).toMatchObject({
      actor: actor(alice),
      currentRevision: 4,
      operation: "edit",
    });
  });

  it("applies no part of a multi-object command when one target is busy", () => {
    const source = roomWith(textObject("a"), textObject("b"));
    const acquired = acquireObjectLease(source, "bob", "human", "b", 1, "resize", START + 10);
    const before = structuredClone(acquired.room);
    const error = domainError(() =>
      applyCanvasCommand(
        acquired.room,
        "alice",
        "human",
        {
          type: "move",
          targets: [
            { objectId: "a", expectedRevision: 1, x: 100, y: 100 },
            { objectId: "b", expectedRevision: 1, x: 200, y: 200 },
          ],
        },
        START + 20,
      ),
    );

    expect(error.code).toBe("OBJECT_BUSY");
    expect(error.details).toMatchObject({ objectId: "b", operation: "resize" });
    expect(acquired.room).toEqual(before);
  });

  it("uses a grammatical delete lease conflict message", () => {
    const acquired = acquireObjectLease(
      roomWith(textObject("note")),
      "bob",
      "human",
      "note",
      1,
      "delete",
      START + 10,
    );
    const error = domainError(() =>
      applyCanvasCommand(
        acquired.room,
        "alice",
        "human",
        {
          type: "update",
          objectId: "note",
          expectedRevision: 1,
          operation: "edit",
          patch: { content: "Blocked edit" },
        },
        START + 20,
      ),
    );

    expect(error.code).toBe("OBJECT_BUSY");
    expect(error.message).toBe("Bob is currently deleting this object.");
  });
});
