// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StageAgentCanvasDraftRequest } from "@/lib/agent-drafts/types";
import { DomainError } from "@/lib/domain/errors";

import {
  AGENT_DRAFT_HARD_TTL_MS,
  AGENT_DRAFT_SLIDING_TTL_MS,
  type AgentCanvasDraftStore,
  MemoryAgentCanvasDraftStore,
  resetMemoryAgentCanvasDraftStoreForTests,
  setAgentCanvasDraftStoreForTests,
} from "./agent-draft-store";
import {
  commitAgentCanvasDraft,
  discardAgentCanvasDraft,
  keepaliveAgentCanvasDraft,
  listAgentCanvasDrafts,
  readAgentCanvasDraft,
  replaceAgentCanvasDraft,
  stageAgentCanvasDraft,
} from "./agent-draft-service";
import { getRoomStore } from "./room-store";
import {
  renameRoom,
  reviewAgentEditProposal,
  runCanvasCommand,
  setAgentEditPolicy,
} from "./room-service";

const NOW = new Date("2027-01-12T10:00:00.000Z").getTime();

function stageRequest(roomRevision: number): StageAgentCanvasDraftRequest {
  return {
    draftId: "draft_service",
    baselineRoomRevision: roomRevision,
    transaction: {
      commands: [{
        type: "create",
        object: {
          id: "draft_note",
          kind: "text",
          x: 20,
          y: 30,
          width: 220,
          height: 80,
          rotation: 0,
          zIndex: 0,
          groupId: null,
          content: "Progressive draft",
          color: "black",
          size: "m",
          align: "start",
        },
      }],
      diagramCommands: [],
    },
    temporaryReferences: { note: "draft_note" },
    metadata: { intent: "Show work progressively" },
  };
}

function overlappingDiagramStageRequest(roomRevision: number): StageAgentCanvasDraftRequest {
  const shape = (id: string, x: number) => ({
    id,
    kind: "shape" as const,
    x,
    y: 40,
    width: 180,
    height: 100,
    rotation: 0,
    zIndex: 1,
    groupId: null,
    shape: "rectangle" as const,
    nodeType: "service" as const,
    label: id,
    fill: "blue",
    stroke: "blue",
  });
  return {
    draftId: "draft_quality_gate",
    baselineRoomRevision: roomRevision,
    transaction: {
      commands: [
        { type: "create", object: shape("draft_left", 40) },
        { type: "create", object: shape("draft_right", 120) },
      ],
      diagramCommands: [{
        type: "diagram.create",
        diagram: {
          id: "draft_diagram_quality",
          title: "Deliberate overlap fixture",
          description: "Two overlapping objects for the commit-quality contract.",
          diagramType: "custom",
          category: null,
          tags: [],
          memberObjectIds: ["draft_left", "draft_right"],
          connectorIds: [],
        },
      }],
    },
    temporaryReferences: {
      left: "draft_left",
      right: "draft_right",
      diagram: "draft_diagram_quality",
    },
  };
}

async function seedRoom() {
  const store = getRoomStore();
  const created = await store.createRoom({
    participantId: "p_owner",
    displayName: "Owner",
    title: "Draft room",
  });
  const room = await store.joinRoom({
    participantId: "p_spectator",
    displayName: "Viewer",
    code: created.code,
    role: "spectator",
  });
  return { store, room };
}

function faultInjectingStore(
  delegate: AgentCanvasDraftStore,
  failures: { remove?: number; markAwaitingReview?: number },
): AgentCanvasDraftStore {
  let removeFailures = failures.remove ?? 0;
  let markFailures = failures.markAwaitingReview ?? 0;
  return new Proxy(delegate, {
    get(target, property) {
      if (property === "remove") {
        return async (...args: Parameters<AgentCanvasDraftStore["remove"]>) => {
          if (removeFailures > 0) {
            removeFailures -= 1;
            throw new Error("Injected draft removal failure");
          }
          return target.remove(...args);
        };
      }
      if (property === "markAwaitingReview") {
        return async (...args: Parameters<AgentCanvasDraftStore["markAwaitingReview"]>) => {
          if (markFailures > 0) {
            markFailures -= 1;
            throw new Error("Injected awaiting-review transition failure");
          }
          return target.markAwaitingReview(...args);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("agent canvas draft service", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubEnv("REDIS_URL", "");
    globalThis.__jazzboardRoomStore = undefined;
    globalThis.__jazzboardLocalState = undefined;
    globalThis.__jazzboardRedis = undefined;
    resetMemoryAgentCanvasDraftStoreForTests();
  });

  afterEach(() => {
    globalThis.__jazzboardRoomStore = undefined;
    globalThis.__jazzboardLocalState = undefined;
    globalThis.__jazzboardRedis = undefined;
    resetMemoryAgentCanvasDraftStoreForTests();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("previews create-only work without changing room planes, leases, or history", async () => {
    const { store, room } = await seedRoom();
    const before = await store.getRoom(room.id);
    const beforeActivities = await store.listActivities(room.id);

    const draft = await stageAgentCanvasDraft({
      roomId: room.id,
      participantId: "p_owner",
      request: stageRequest(room.roomRevision),
      now: NOW + 1,
    });
    const after = await store.getRoom(room.id);

    expect(draft).toMatchObject({
      id: "draft_service",
      revision: 1,
      status: "active",
      temporaryReferences: { note: "draft_note" },
      previewObjects: [{ id: "draft_note", authority: "draft", revision: 1 }],
    });
    expect(draft).not.toHaveProperty("transaction");
    expect(draft).not.toHaveProperty("committing");
    expect(draft).not.toHaveProperty("authoritativeCommit");
    expect(after?.roomRevision).toBe(before?.roomRevision);
    expect(after?.stateRevision).toBe(before?.stateRevision);
    expect(after?.objects).toEqual(before?.objects);
    expect(after?.leases).toEqual(before?.leases);
    expect(await store.listActivities(room.id)).toEqual(beforeActivities);
  });

  it("allows authorized spectators to list and read, while denying spectator writes", async () => {
    const { room } = await seedRoom();
    await stageAgentCanvasDraft({
      roomId: room.id,
      participantId: "p_owner",
      request: stageRequest(room.roomRevision),
    });

    await expect(listAgentCanvasDrafts({ roomId: room.id, participantId: "p_spectator" }))
      .resolves.toMatchObject({ drafts: [{ id: "draft_service" }] });
    await expect(readAgentCanvasDraft({
      roomId: room.id,
      draftId: "draft_service",
      participantId: "p_spectator",
    })).resolves.toMatchObject({ draft: { id: "draft_service" } });
    await expect(stageAgentCanvasDraft({
      roomId: room.id,
      participantId: "p_spectator",
      request: { ...stageRequest(room.roomRevision), draftId: "draft_spectator" },
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects non-create operations and invalid temp-ref candidate identities", async () => {
    const { room } = await seedRoom();
    const invalidUpdate = stageRequest(room.roomRevision);
    invalidUpdate.transaction = {
      commands: [{
        type: "update",
        objectId: "existing",
        expectedRevision: 1,
        operation: "edit",
        patch: { color: "red" },
      }],
      diagramCommands: [],
    };
    await expect(stageAgentCanvasDraft({
      roomId: room.id,
      participantId: "p_owner",
      request: invalidUpdate,
    })).rejects.toMatchObject({ code: "INVALID_OPERATION" });

    await expect(stageAgentCanvasDraft({
      roomId: room.id,
      participantId: "p_owner",
      request: { ...stageRequest(room.roomRevision), temporaryReferences: { missing: "not_created" } },
    })).rejects.toMatchObject({ code: "INVALID_OPERATION" });
  });

  it("re-previews with exact CAS and commits once through the authoritative transaction", async () => {
    const { store, room } = await seedRoom();
    const first = await stageAgentCanvasDraft({
      roomId: room.id,
      participantId: "p_owner",
      request: stageRequest(room.roomRevision),
    });
    const replacement = stageRequest(room.roomRevision);
    replacement.transaction.commands[0] = {
      ...replacement.transaction.commands[0],
      object: {
        ...(replacement.transaction.commands[0] as { type: "create"; object: Record<string, unknown> }).object,
        content: "Refined draft",
      },
    } as typeof replacement.transaction.commands[number];
    const second = await replaceAgentCanvasDraft({
      roomId: room.id,
      draftId: first.id,
      participantId: "p_owner",
      request: {
        expectedDraftRevision: first.revision,
        baselineRoomRevision: room.roomRevision,
        transaction: replacement.transaction,
        temporaryReferences: replacement.temporaryReferences,
      },
    });
    expect(second).toMatchObject({ revision: 2, previewObjects: [{ content: "Refined draft" }] });

    const committed = await commitAgentCanvasDraft({
      roomId: room.id,
      draftId: first.id,
      participantId: "p_owner",
      request: { expectedDraftRevision: second.revision },
    });
    expect(committed).toMatchObject({ outcome: "applied", draft: null });
    expect((await store.getRoom(room.id))?.objects.draft_note).toMatchObject({ content: "Refined draft" });
    expect((await listAgentCanvasDrafts({ roomId: room.id, participantId: "p_owner" })).drafts).toEqual([]);
  });

  it("rejects unresolved fail findings without mutating authority and returns exact correction evidence", async () => {
    const { store, room } = await seedRoom();
    const staged = await stageAgentCanvasDraft({
      roomId: room.id,
      participantId: "p_owner",
      request: overlappingDiagramStageRequest(room.roomRevision),
    });

    await expect(commitAgentCanvasDraft({
      roomId: room.id,
      draftId: staged.id,
      participantId: "p_owner",
      request: { expectedDraftRevision: staged.revision },
    })).rejects.toMatchObject({
      code: "UNRESOLVED_DRAFT_FINDINGS",
      details: {
        stateChanged: false,
        currentDraftRevision: 1,
        failFindingCount: 1,
        missingFindingKeys: [expect.stringMatching(/^diagram:member_object_overlap:/)],
        unknownFindingKeys: [],
        findings: [{
          findingKey: expect.stringMatching(/^diagram:member_object_overlap:/),
          code: "MEMBER_OBJECT_OVERLAP",
          objectIds: ["draft_left", "draft_right"],
        }],
        requiredAction: expect.stringMatching(/patch unintended.*deliberate freeform.*no user confirmation/i),
      },
    });

    expect((await store.getRoom(room.id))?.objects.draft_left).toBeUndefined();
    await expect(readAgentCanvasDraft({
      roomId: room.id,
      draftId: staged.id,
      participantId: "p_owner",
    })).resolves.toMatchObject({ draft: { status: "active", revision: 1 } });
  });

  it("commits deliberate geometry only after exact per-finding acknowledgement", async () => {
    const { store, room } = await seedRoom();
    const staged = await stageAgentCanvasDraft({
      roomId: room.id,
      participantId: "p_owner",
      request: overlappingDiagramStageRequest(room.roomRevision),
    });
    let findingKey = "";
    try {
      await commitAgentCanvasDraft({
        roomId: room.id,
        draftId: staged.id,
        participantId: "p_owner",
        request: { expectedDraftRevision: staged.revision },
      });
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      const missing = error.details && "missingFindingKeys" in error.details
        ? error.details.missingFindingKeys
        : null;
      if (!Array.isArray(missing) || typeof missing[0] !== "string") throw error;
      findingKey = missing[0];
    }

    const committed = await commitAgentCanvasDraft({
      roomId: room.id,
      draftId: staged.id,
      participantId: "p_owner",
      request: {
        expectedDraftRevision: staged.revision,
        intentionalFindingAcknowledgements: {
          [findingKey]: "The requested illustration deliberately layers these two components.",
        },
      },
    });

    expect(committed.qualityDisposition).toEqual({
      status: "intentional_failures_acknowledged",
      failFindingCount: 1,
      acknowledgedFindingCount: 1,
      acknowledgedOmittedFindingCount: 0,
    });
    expect((await store.getRoom(room.id))?.objects).toMatchObject({
      draft_left: { id: "draft_left" },
      draft_right: { id: "draft_right" },
    });
  });

  it("rejects stale finding acknowledgements after the exact draft revision changes", async () => {
    const { room } = await seedRoom();
    const initial = overlappingDiagramStageRequest(room.roomRevision);
    const staged = await stageAgentCanvasDraft({
      roomId: room.id,
      participantId: "p_owner",
      request: initial,
    });
    let staleFindingKey = "";
    try {
      await commitAgentCanvasDraft({
        roomId: room.id,
        draftId: staged.id,
        participantId: "p_owner",
        request: { expectedDraftRevision: staged.revision },
      });
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      const missing = error.details && "missingFindingKeys" in error.details
        ? error.details.missingFindingKeys
        : null;
      if (!Array.isArray(missing) || typeof missing[0] !== "string") throw error;
      staleFindingKey = missing[0];
    }
    const right = initial.transaction.commands[1];
    if (right?.type !== "create" || right.object.kind !== "shape") throw new Error("Expected shape.");
    right.object.x = 320;
    const patched = await replaceAgentCanvasDraft({
      roomId: room.id,
      draftId: staged.id,
      participantId: "p_owner",
      request: {
        expectedDraftRevision: staged.revision,
        updateMode: "patch",
        baselineRoomRevision: room.roomRevision,
        transaction: { commands: [right], diagramCommands: [] },
        temporaryReferences: { right: "draft_right" },
      },
    });

    await expect(commitAgentCanvasDraft({
      roomId: room.id,
      draftId: staged.id,
      participantId: "p_owner",
      request: {
        expectedDraftRevision: patched.revision,
        intentionalFindingAcknowledgements: {
          [staleFindingKey]: "This acknowledgement belongs to the prior candidate revision.",
        },
      },
    })).rejects.toMatchObject({
      code: "UNRESOLVED_DRAFT_FINDINGS",
      details: {
        failFindingCount: 0,
        missingFindingKeys: [],
        unknownFindingKeys: [staleFindingKey],
      },
    });
  });

  it("does not require acknowledgement for warning-only conventional evidence", async () => {
    const { store, room } = await seedRoom();
    const request = overlappingDiagramStageRequest(room.roomRevision);
    const right = request.transaction.commands[1];
    if (right?.type !== "create" || right.object.kind !== "shape") throw new Error("Expected shape.");
    right.object.x = 230;
    const staged = await stageAgentCanvasDraft({
      roomId: room.id,
      participantId: "p_owner",
      request,
    });

    const committed = await commitAgentCanvasDraft({
      roomId: room.id,
      draftId: staged.id,
      participantId: "p_owner",
      request: { expectedDraftRevision: staged.revision },
    });

    expect(committed.qualityDisposition).toEqual({
      status: "passed",
      failFindingCount: 0,
      acknowledgedFindingCount: 0,
      acknowledgedOmittedFindingCount: 0,
    });
    expect((await store.getRoom(room.id))?.objects.draft_right).toBeDefined();
  });

  it("keeps high-complexity deliberate overlap possible with bounded exact evidence", async () => {
    const { store, room } = await seedRoom();
    const request = overlappingDiagramStageRequest(room.roomRevision);
    const left = request.transaction.commands[0];
    if (left?.type !== "create" || left.object.kind !== "shape") throw new Error("Expected shape.");
    const overlapCommands = Array.from({ length: 5 }, (_, index) => ({
      type: "create" as const,
      object: {
        ...structuredClone(left.object),
        id: `draft_overlap_${index}`,
        label: `Layer ${index}`,
        zIndex: index,
      },
    }));
    request.transaction.commands = overlapCommands;
    const diagramCommand = request.transaction.diagramCommands[0];
    if (!diagramCommand || diagramCommand.type !== "diagram.create") throw new Error("Expected Diagram.");
    diagramCommand.diagram.memberObjectIds = overlapCommands.map((command) => command.object.id);
    request.temporaryReferences = Object.fromEntries([
      ...overlapCommands.map((command, index) => [`layer_${index}`, command.object.id]),
      ["diagram", diagramCommand.diagram.id],
    ]);
    const staged = await stageAgentCanvasDraft({
      roomId: room.id,
      participantId: "p_owner",
      request,
    });
    let findings: Array<{ findingKey: string }> = [];
    let omittedFailFindingCount = 0;
    try {
      await commitAgentCanvasDraft({
        roomId: room.id,
        draftId: staged.id,
        participantId: "p_owner",
        request: { expectedDraftRevision: staged.revision },
      });
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      const details = error.details as Record<string, unknown>;
      findings = details.findings as Array<{ findingKey: string }>;
      omittedFailFindingCount = details.omittedFailFindingCount as number;
    }
    expect(findings).toHaveLength(8);
    expect(omittedFailFindingCount).toBe(2);

    const committed = await commitAgentCanvasDraft({
      roomId: room.id,
      draftId: staged.id,
      participantId: "p_owner",
      request: {
        expectedDraftRevision: staged.revision,
        intentionalFindingAcknowledgements: Object.fromEntries(findings.map(({ findingKey }) => [
          findingKey,
          "The user requested these five illustration layers to occupy the same silhouette.",
        ])),
        intentionalOmittedFindingsAcknowledgement:
          "The omitted pairwise overlaps are part of the same requested layered silhouette.",
      },
    });

    expect(committed.qualityDisposition).toMatchObject({
      status: "intentional_failures_acknowledged",
      failFindingCount: 10,
      acknowledgedFindingCount: 8,
      acknowledgedOmittedFindingCount: 2,
    });
    expect(Object.keys((await store.getRoom(room.id))?.objects ?? {})).toEqual(
      expect.arrayContaining(overlapCommands.map((command) => command.object.id)),
    );
  });

  it("patches only affected stable candidate IDs while preserving the rest of the draft", async () => {
    const { store, room } = await seedRoom();
    const initial = stageRequest(room.roomRevision);
    initial.transaction.commands.push({
      type: "create",
      object: {
        id: "draft_second",
        kind: "text",
        x: 300,
        y: 30,
        width: 220,
        height: 80,
        rotation: 0,
        zIndex: 1,
        groupId: null,
        content: "Second candidate",
        color: "black",
        size: "m",
        align: "start",
      },
    });
    initial.temporaryReferences.second = "draft_second";
    const staged = await stageAgentCanvasDraft({
      roomId: room.id,
      participantId: "p_owner",
      request: initial,
    });
    const secondCommand = structuredClone(initial.transaction.commands[1]);
    if (secondCommand?.type !== "create" || secondCommand.object.kind !== "text") {
      throw new Error("Expected a text candidate to patch.");
    }
    secondCommand.object.content = "Second candidate repaired";

    const patched = await replaceAgentCanvasDraft({
      roomId: room.id,
      draftId: staged.id,
      participantId: "p_owner",
      request: {
        expectedDraftRevision: staged.revision,
        updateMode: "patch",
        baselineRoomRevision: room.roomRevision,
        transaction: {
          commands: [secondCommand],
          diagramCommands: [],
        },
        temporaryReferences: { second: "draft_second" },
      },
    });

    expect(patched.previewObjects).toEqual([
      expect.objectContaining({ id: "draft_note", content: "Progressive draft" }),
      expect.objectContaining({ id: "draft_second", content: "Second candidate repaired" }),
    ]);
    expect(patched.temporaryReferences).toEqual({ note: "draft_note", second: "draft_second" });
    await commitAgentCanvasDraft({
      roomId: room.id,
      draftId: staged.id,
      participantId: "p_owner",
      request: { expectedDraftRevision: patched.revision },
    });
    expect((await store.getRoom(room.id))?.objects).toMatchObject({
      draft_note: { content: "Progressive draft" },
      draft_second: { content: "Second candidate repaired" },
    });
  });

  it("replaces one stable unpublished Diagram create candidate in patch mode", async () => {
    const { store, room } = await seedRoom();
    const initial = stageRequest(room.roomRevision);
    initial.transaction.diagramCommands = [{
      type: "diagram.create",
      diagram: {
        id: "draft_diagram",
        title: "Initial draft Diagram",
        description: "One progressive draft object.",
        diagramType: "architecture",
        category: null,
        tags: [],
        memberObjectIds: ["draft_note"],
        connectorIds: [],
      },
    }];
    initial.temporaryReferences.diagram = "draft_diagram";
    const staged = await stageAgentCanvasDraft({
      roomId: room.id,
      participantId: "p_owner",
      request: initial,
    });

    const patched = await replaceAgentCanvasDraft({
      roomId: room.id,
      draftId: staged.id,
      participantId: "p_owner",
      request: {
        expectedDraftRevision: staged.revision,
        updateMode: "patch",
        baselineRoomRevision: room.roomRevision,
        transaction: {
          commands: [],
          diagramCommands: [{
            type: "diagram.create",
            diagram: {
              id: "draft_diagram",
              title: "Refined draft Diagram",
              description: "One progressive draft object.",
              diagramType: "architecture",
              category: null,
              tags: ["refined"],
              memberObjectIds: ["draft_note"],
              connectorIds: [],
            },
          }],
        },
        temporaryReferences: { diagram: "draft_diagram" },
      },
    });

    expect(patched).toMatchObject({
      revision: 2,
      previewDiagrams: [{
        id: "draft_diagram",
        title: "Refined draft Diagram",
        tags: ["refined"],
        memberObjectIds: ["draft_note"],
      }],
    });
    await commitAgentCanvasDraft({
      roomId: room.id,
      draftId: staged.id,
      participantId: "p_owner",
      request: { expectedDraftRevision: patched.revision },
    });
    expect((await store.getRoom(room.id))?.diagrams?.draft_diagram).toMatchObject({
      title: "Refined draft Diagram",
      tags: ["refined"],
      memberObjectIds: ["draft_note"],
    });
  });

  it("keeps an owner draft alive without mutating the canvas or draft revision", async () => {
    const { store, room } = await seedRoom();
    const staged = await stageAgentCanvasDraft({
      roomId: room.id,
      participantId: "p_owner",
      request: stageRequest(room.roomRevision),
      now: NOW,
    });
    await store.joinRoom({
      participantId: "p_other",
      displayName: "Other participant",
      code: room.code,
      role: "participant",
    });
    const roomBefore = await store.getRoom(room.id);
    const touchedAt = NOW + 4 * 60_000;
    const keptAlive = await keepaliveAgentCanvasDraft({
      roomId: room.id,
      draftId: staged.id,
      participantId: "p_owner",
      request: { expectedDraftRevision: staged.revision },
      now: touchedAt,
    });
    const roomAfter = await store.getRoom(room.id);

    expect(keptAlive).toMatchObject({
      serverTime: touchedAt,
      draft: {
        revision: staged.revision,
        baselineRoomRevision: staged.baselineRoomRevision,
        updatedAt: staged.updatedAt,
        expiresAt: touchedAt + AGENT_DRAFT_SLIDING_TTL_MS,
        hardExpiresAt: staged.hardExpiresAt,
      },
    });
    expect(roomAfter).toEqual(roomBefore);
    await expect(keepaliveAgentCanvasDraft({
      roomId: room.id,
      draftId: staged.id,
      participantId: "p_other",
      request: { expectedDraftRevision: staged.revision },
      now: touchedAt + 1,
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(keepaliveAgentCanvasDraft({
      roomId: room.id,
      draftId: staged.id,
      participantId: "p_owner",
      request: { expectedDraftRevision: staged.revision + 1 },
      now: touchedAt + 1,
    })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  });

  it("renews the hard deadline only for a meaningful replacement revision", async () => {
    const { room } = await seedRoom();
    const staged = await stageAgentCanvasDraft({
      roomId: room.id,
      participantId: "p_owner",
      request: stageRequest(room.roomRevision),
      now: NOW,
    });
    const replacement = stageRequest(room.roomRevision);
    const create = replacement.transaction.commands[0];
    if (create?.type !== "create" || create.object.kind !== "text") {
      throw new Error("Expected a text create command.");
    }
    create.object.content = "Meaningfully revised";
    const replacedAt = NOW + 60_000;
    const replaced = await replaceAgentCanvasDraft({
      roomId: room.id,
      draftId: staged.id,
      participantId: "p_owner",
      request: {
        expectedDraftRevision: staged.revision,
        baselineRoomRevision: room.roomRevision,
        transaction: replacement.transaction,
        temporaryReferences: replacement.temporaryReferences,
      },
      now: replacedAt,
    });

    expect(replaced).toMatchObject({
      revision: staged.revision + 1,
      expiresAt: replacedAt + AGENT_DRAFT_SLIDING_TTL_MS,
      hardExpiresAt: replacedAt + AGENT_DRAFT_HARD_TTL_MS,
    });
    expect(replaced.hardExpiresAt).toBeGreaterThan(staged.hardExpiresAt);
  });

  it("reserves temporary-reference identities across omitted and reintroduced candidates", async () => {
    const { room } = await seedRoom();
    const initial = stageRequest(room.roomRevision);
    initial.transaction.commands.push({
      type: "create",
      object: {
        id: "draft_second",
        kind: "text",
        x: 300,
        y: 30,
        width: 220,
        height: 80,
        rotation: 0,
        zIndex: 1,
        groupId: null,
        content: "Second candidate",
        color: "black",
        size: "m",
        align: "start",
      },
    });
    initial.temporaryReferences.second = "draft_second";
    const staged = await stageAgentCanvasDraft({
      roomId: room.id,
      participantId: "p_owner",
      request: initial,
    });

    const omitted = await replaceAgentCanvasDraft({
      roomId: room.id,
      draftId: staged.id,
      participantId: "p_owner",
      request: {
        expectedDraftRevision: staged.revision,
        baselineRoomRevision: room.roomRevision,
        transaction: stageRequest(room.roomRevision).transaction,
        temporaryReferences: { note: "draft_note" },
      },
    });
    expect(omitted.temporaryReferences).toEqual({ note: "draft_note", second: "draft_second" });
    expect(omitted.previewObjects.map((object) => object.id)).toEqual(["draft_note"]);

    const reintroduced = await replaceAgentCanvasDraft({
      roomId: room.id,
      draftId: staged.id,
      participantId: "p_owner",
      request: {
        expectedDraftRevision: omitted.revision,
        baselineRoomRevision: room.roomRevision,
        transaction: initial.transaction,
        temporaryReferences: { second: "draft_second" },
      },
    });
    expect(reintroduced.temporaryReferences).toEqual({ note: "draft_note", second: "draft_second" });
    expect(reintroduced.previewObjects.map((object) => object.id)).toEqual(["draft_note", "draft_second"]);

    const remapped = structuredClone(initial.transaction);
    const second = remapped.commands[1];
    if (second?.type !== "create") throw new Error("Expected the second create command.");
    second.object.id = "draft_remapped";
    await expect(replaceAgentCanvasDraft({
      roomId: room.id,
      draftId: staged.id,
      participantId: "p_owner",
      request: {
        expectedDraftRevision: reintroduced.revision,
        baselineRoomRevision: room.roomRevision,
        transaction: remapped,
        temporaryReferences: { second: "draft_remapped" },
      },
    })).rejects.toMatchObject({ code: "INVALID_OPERATION" });
  });

  it("restores an editable draft at a newer revision after an authoritative conflict", async () => {
    const { room } = await seedRoom();
    const staged = await stageAgentCanvasDraft({
      roomId: room.id,
      participantId: "p_owner",
      request: stageRequest(room.roomRevision),
    });
    await renameRoom(room.id, "p_owner", "Changed room", room.title);

    await expect(commitAgentCanvasDraft({
      roomId: room.id,
      draftId: staged.id,
      participantId: "p_owner",
      request: { expectedDraftRevision: staged.revision },
    })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });

    const restored = await readAgentCanvasDraft({
      roomId: room.id,
      draftId: staged.id,
      participantId: "p_owner",
    });
    expect(restored.draft).toMatchObject({ status: "active", revision: 3 });
  });

  it("uses persisted commit evidence after cleanup failure even when the canonical object is deleted", async () => {
    const { store, room } = await seedRoom();
    const sidecar = new MemoryAgentCanvasDraftStore();
    setAgentCanvasDraftStoreForTests(faultInjectingStore(sidecar, { remove: 1 }));
    const staged = await stageAgentCanvasDraft({
      roomId: room.id,
      participantId: "p_owner",
      request: stageRequest(room.roomRevision),
    });

    const committed = await commitAgentCanvasDraft({
      roomId: room.id,
      draftId: staged.id,
      participantId: "p_owner",
      request: { expectedDraftRevision: staged.revision },
    });
    expect(committed).toMatchObject({
      outcome: "applied",
      draft: null,
      sidecarStatus: "cleanup_pending",
    });
    expect((await store.getRoom(room.id))?.objects.draft_note).toBeDefined();
    await expect(sidecar.get(room.id, staged.id)).resolves.toMatchObject({
      status: "committing",
      authoritativeCommit: {
        roomRevision: committed.mutation.room.roomRevision,
      },
    });

    await runCanvasCommand({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "human",
      command: {
        type: "delete",
        targets: [{ objectId: "draft_note", expectedRevision: 1 }],
      },
    });
    expect((await store.getRoom(room.id))?.objects.draft_note).toBeUndefined();

    await expect(listAgentCanvasDrafts({ roomId: room.id, participantId: "p_owner" }))
      .resolves.toMatchObject({ drafts: [] });
    await expect(sidecar.get(room.id, staged.id)).resolves.toBeNull();

    const currentRoom = await store.getRoom(room.id);
    if (!currentRoom) throw new Error("Expected the reconciled room.");
    const next = stageRequest(currentRoom.roomRevision);
    next.draftId = "draft_after_cleanup";
    const create = next.transaction.commands[0];
    if (create?.type !== "create") throw new Error("Expected a create command.");
    create.object.id = "draft_note_after_cleanup";
    next.temporaryReferences = { note: "draft_note_after_cleanup" };
    await expect(stageAgentCanvasDraft({
      roomId: room.id,
      participantId: "p_owner",
      request: next,
    })).resolves.toMatchObject({ id: "draft_after_cleanup" });
  });

  it("returns canonical proposed success and heals a failed awaiting-review transition", async () => {
    const { room } = await seedRoom();
    const review = await setAgentEditPolicy({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "human",
      policy: "review",
    });
    const sidecar = new MemoryAgentCanvasDraftStore();
    setAgentCanvasDraftStoreForTests(faultInjectingStore(sidecar, { markAwaitingReview: 1 }));
    const staged = await stageAgentCanvasDraft({
      roomId: room.id,
      participantId: "p_owner",
      request: stageRequest(review.room.roomRevision),
    });

    const committed = await commitAgentCanvasDraft({
      roomId: room.id,
      draftId: staged.id,
      participantId: "p_owner",
      request: { expectedDraftRevision: staged.revision },
    });
    expect(committed).toMatchObject({
      outcome: "proposed",
      sidecarStatus: "cleanup_pending",
      draft: {
        status: "awaiting_review",
        revision: 3,
        expiresAt: staged.hardExpiresAt,
      },
    });
    if (committed.mutation.outcome !== "proposed") throw new Error("Expected a proposal.");
    await expect(sidecar.get(room.id, staged.id)).resolves.toMatchObject({ status: "committing", revision: 2 });

    const reconciled = await listAgentCanvasDrafts({ roomId: room.id, participantId: "p_owner" });
    expect(reconciled.drafts).toMatchObject([{
      status: "awaiting_review",
      revision: 3,
      awaitingReview: { proposalId: committed.mutation.proposal.id },
    }]);
    await expect(sidecar.get(room.id, staged.id)).resolves.toMatchObject({
      status: "awaiting_review",
      revision: 3,
      awaitingReview: { proposalId: committed.mutation.proposal.id },
    });
  });

  it("keeps a proposed draft visible and immutable while it awaits review", async () => {
    const { room } = await seedRoom();
    const review = await setAgentEditPolicy({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "human",
      policy: "review",
    });
    const staged = await stageAgentCanvasDraft({
      roomId: room.id,
      participantId: "p_owner",
      request: stageRequest(review.room.roomRevision),
    });
    const committed = await commitAgentCanvasDraft({
      roomId: room.id,
      draftId: staged.id,
      participantId: "p_owner",
      request: { expectedDraftRevision: staged.revision },
    });

    expect(committed).toMatchObject({
      outcome: "proposed",
      draft: {
        status: "awaiting_review",
        revision: 3,
        awaitingReview: { proposalId: expect.stringMatching(/^proposal_/) },
      },
    });
    await expect(replaceAgentCanvasDraft({
      roomId: room.id,
      draftId: staged.id,
      participantId: "p_owner",
      request: {
        expectedDraftRevision: 3,
        baselineRoomRevision: committed.mutation.room.roomRevision,
        transaction: stageRequest(1).transaction,
        temporaryReferences: { note: "draft_note" },
      },
    })).rejects.toBeInstanceOf(DomainError);
    await expect(discardAgentCanvasDraft({
      roomId: room.id,
      draftId: staged.id,
      participantId: "p_owner",
      request: { expectedDraftRevision: 3 },
    })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  });

  it.each([
    ["approve", "applied"],
    ["reject", "rejected"],
  ] as const)("passively removes an awaiting draft after review is %s", async (action, expectedOutcome) => {
    const { room } = await seedRoom();
    const review = await setAgentEditPolicy({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "human",
      policy: "review",
    });
    const staged = await stageAgentCanvasDraft({
      roomId: room.id,
      participantId: "p_owner",
      request: stageRequest(review.room.roomRevision),
    });
    const proposed = await commitAgentCanvasDraft({
      roomId: room.id,
      draftId: staged.id,
      participantId: "p_owner",
      request: { expectedDraftRevision: staged.revision },
    });
    if (proposed.mutation.outcome !== "proposed") throw new Error("Expected a review proposal.");

    const reviewed = await reviewAgentEditProposal({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "human",
      proposalId: proposed.mutation.proposal.id,
      expectedProposalRevision: proposed.mutation.proposal.revision,
      action,
    });
    expect(reviewed.outcome).toBe(expectedOutcome);

    await expect(listAgentCanvasDrafts({ roomId: room.id, participantId: "p_owner" }))
      .resolves.toMatchObject({ drafts: [] });
    await expect(readAgentCanvasDraft({
      roomId: room.id,
      draftId: staged.id,
      participantId: "p_owner",
    })).rejects.toMatchObject({ code: "INVALID_OPERATION" });
  });
});
