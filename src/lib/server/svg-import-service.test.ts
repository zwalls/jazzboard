// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importAuthorizedRoomSvgArtwork } from "./svg-import-service";
import { getRoomStore } from "./room-store";
import { setAgentEditPolicy } from "./room-service";
import * as roomService from "./room-service";
import { getAgentCanvasDraftStore, resetMemoryAgentCanvasDraftStoreForTests } from "./agent-draft-store";
import { createMutationContext, runWithMutationContext } from "./mutation-context";

const source = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80" viewBox="0 0 100 80">
  <path id="left-leaf" d="M10 20H30V40H10Z" fill="#70A979"/>
  <circle id="flower-center" cx="60" cy="40" r="10" fill="#6E4D49"/>
</svg>`;
describe("SVG import atomic collaboration boundary", () => {
  beforeEach(() => {
    vi.stubEnv("REDIS_URL", "");
    globalThis.__jazzboardRoomStore = undefined;
    globalThis.__jazzboardLocalState = undefined;
    globalThis.__jazzboardRedis = undefined;
    resetMemoryAgentCanvasDraftStoreForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    globalThis.__jazzboardRoomStore = undefined;
    globalThis.__jazzboardLocalState = undefined;
    globalThis.__jazzboardRedis = undefined;
    resetMemoryAgentCanvasDraftStoreForTests();
  });
  async function setup() {
    const room = await getRoomStore().createRoom({ participantId: "owner", displayName: "Owner", title: "Art spike" });
    return { roomId: room.id, participantId: "owner", actorKind: "agent" as const, expectedRoomRevision: room.roomRevision, source };
  }
  function idempotentImport(input: Awaited<ReturnType<typeof setup>>, key: string) {
    return runWithMutationContext(createMutationContext({
      request: new Request(`https://jazzboard.test/api/rooms/${input.roomId}/agent/artifacts`, {
        method: "POST", headers: { "idempotency-key": key },
      }),
      participantId: input.participantId,
      roomId: input.roomId,
      operation: "room.svg.import",
      actorKind: input.actorKind,
      parsedBody: { action: "import_svg_artwork", expectedRoomRevision: input.expectedRoomRevision, source: input.source },
    }), () => importAuthorizedRoomSvgArtwork(input));
  }
  it("persists independently named native parts and a composition in one revision", async () => {
    const input = await setup();
    const result = await importAuthorizedRoomSvgArtwork(input);
    expect(result.outcome).toBe("applied");
    expect(result.room.roomRevision).toBe(input.expectedRoomRevision + 1);
    expect(result.counts.parts).toBe(2);
    expect(result.idMap.parts.map(part => part.sourceName)).toContain("left-leaf");
    expect(result.changedDiagramIds).toHaveLength(1);
    expect(Object.values(result.room.objects).every(object => object.kind === "path")).toBe(true);
    expect(result.presentation).toMatchObject({
      status: "presenting",
      ownerParticipantId: input.participantId,
      baselineRoomRevision: input.expectedRoomRevision,
    });
    expect(result.presentation?.previewObjects.map(object => object.id)).toEqual(result.changedObjectIds);
    expect(result.presentation?.previewObjects.every(object => object.authority === "draft")).toBe(true);
    expect(result.presentation?.previewDiagrams.map(diagram => diagram.id)).toEqual(result.changedDiagramIds);
    expect(result.presentation).not.toHaveProperty("transaction");
    expect(result.presentation).not.toHaveProperty("committing");
    expect(result.presentation).not.toHaveProperty("authoritativeCommit");
    const storedPresentation = await getAgentCanvasDraftStore().get(input.roomId, result.presentation!.id);
    expect(storedPresentation).toMatchObject({
      status: "presenting",
      authoritativeCommit: { roomRevision: result.room.roomRevision },
      transaction: { commands: expect.any(Array), diagramCommands: expect.any(Array) },
    });
  });
  it("rejects stale import and unsupported content before creating parts", async () => {
    const input = await setup();
    await expect(importAuthorizedRoomSvgArtwork({ ...input, expectedRoomRevision: input.expectedRoomRevision + 1 })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    await expect(importAuthorizedRoomSvgArtwork({ ...input, source: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><image href="https://example.com/a.png"/></svg>' })).rejects.toMatchObject({ code: "INVALID_OPERATION" });
    const result = await importAuthorizedRoomSvgArtwork(input);
    expect(result.room.roomRevision).toBe(input.expectedRoomRevision + 1);
  });

  it("reports translated geometry bounds and preserves independently named parts", async () => {
    const input = await setup();
    const result = await importAuthorizedRoomSvgArtwork({ ...input, origin: { x: 120, y: -40 } });
    expect(result.bounds).toEqual({ x: 130, y: -20, width: 60, height: 30 });
    expect(result.idMap.parts.map(part => part.sourceName)).toEqual(["left-leaf", "flower-center"]);
    expect(new Set(result.idMap.parts.map(part => part.nativeObjectId)).size).toBe(2);
    expect(result.room.diagrams[result.changedDiagramIds[0]].bounds).toEqual(result.bounds);
    expect(Object.values(result.importTiming).every(value => Number.isFinite(value) && value >= 0)).toBe(true);
  });

  it.each(["human", "agent"] as const)("denies spectator imports through the %s actor path", async (actorKind) => {
    const input = await setup();
    const before = await getRoomStore().getRoom(input.roomId);
    const joined = await getRoomStore().joinRoom({
      code: before!.code, participantId: "spectator", displayName: "Spectator", role: "spectator",
    });
    await expect(importAuthorizedRoomSvgArtwork({
      ...input, actorKind, participantId: "spectator", expectedRoomRevision: joined.roomRevision,
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await getRoomStore().getRoom(input.roomId))?.objects).toEqual({});
    expect(await getAgentCanvasDraftStore().list(input.roomId)).toEqual([]);
  });

  it("rejects source and part limits without leaving a partial document", async () => {
    const input = await setup();
    const oversizedParts = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80" viewBox="0 0 100 80">${
      '<rect x="1" y="1" width="4" height="4"/>'.repeat(200)
    }</svg>`;
    for (const invalidSource of [" ".repeat(65_537), oversizedParts]) {
      await expect(importAuthorizedRoomSvgArtwork({ ...input, source: invalidSource }))
        .rejects.toMatchObject({ code: "INVALID_OPERATION" });
    }
    const persisted = await getRoomStore().getRoom(input.roomId);
    expect(persisted).toMatchObject({ roomRevision: input.expectedRoomRevision, objects: {}, diagrams: {} });
    expect(await getRoomStore().listActivities(input.roomId)).toEqual([]);
    expect(await getAgentCanvasDraftStore().list(input.roomId)).toEqual([]);

    const accepted = await importAuthorizedRoomSvgArtwork({
      ...input,
      source: oversizedParts.replace('<rect x="1" y="1" width="4" height="4"/>', ""),
    });
    expect(accepted.counts.parts).toBe(199);
    expect(accepted.changedObjectIds).toHaveLength(199);
    expect(accepted.room.roomRevision).toBe(input.expectedRoomRevision + 1);
  });

  it("rechecks the revision atomically when the board changes after SVG planning", async () => {
    const input = await setup();
    const applyTransaction = roomService.runSemanticTransaction;
    vi.spyOn(roomService, "runSemanticTransaction").mockImplementationOnce(async (transaction) => {
      await setAgentEditPolicy({ ...input, policy: "review" });
      return applyTransaction(transaction);
    });

    await expect(importAuthorizedRoomSvgArtwork(input)).rejects.toMatchObject({ code: "REVISION_CONFLICT" });

    const persisted = await getRoomStore().getRoom(input.roomId);
    expect(persisted).toMatchObject({
      roomRevision: input.expectedRoomRevision + 1,
      agentEditPolicy: "review",
      objects: {},
      diagrams: {},
      reviewProposals: [],
    });
    expect(await getAgentCanvasDraftStore().list(input.roomId)).toEqual([]);
  });
  it("preserves review policy instead of publishing directly", async () => {
    const input = await setup();
    const policy = await setAgentEditPolicy({ roomId: input.roomId, participantId: input.participantId, actorKind: "agent", policy: "review" });
    const result = await importAuthorizedRoomSvgArtwork({ ...input, expectedRoomRevision: policy.room.roomRevision });
    expect(result.outcome).toBe("proposed");
    expect(Object.keys(result.room.objects)).toHaveLength(0);
    expect(Object.keys(result.room.diagrams)).toHaveLength(0);
    expect(result.changedObjectIds).toEqual([]);
    expect(result.changedDiagramIds).toEqual([]);
    expect(result.presentation).toBeNull();
    expect(await getAgentCanvasDraftStore().list(input.roomId)).toEqual([]);
    const request = result.room.reviewProposals[0]?.request;
    expect(request?.kind).toBe("semantic_transaction");
    if (request?.kind !== "semantic_transaction") throw new Error("Expected SVG transaction proposal");
    const importedIds = result.idMap.parts.map(part => part.nativeObjectId);
    expect(request.transaction.commands.map(command => command.type === "create" ? command.object.id : null)).toEqual(importedIds);
    expect(request.transaction.diagramCommands).toEqual([
      expect.objectContaining({
        type: "diagram.create",
        diagram: expect.objectContaining({ memberObjectIds: importedIds }),
      }),
    ]);
  });

  it("keeps the authoritative import committed when its presentation cannot be saved", async () => {
    const input = await setup();
    const drafts = getAgentCanvasDraftStore();
    vi.spyOn(drafts, "create").mockRejectedValueOnce(new Error("Presentation store unavailable"));

    const result = await importAuthorizedRoomSvgArtwork(input);

    expect(result.outcome).toBe("applied");
    expect(result.presentation).toBeNull();
    const persisted = await getRoomStore().getRoom(input.roomId);
    expect(persisted?.roomRevision).toBe(input.expectedRoomRevision + 1);
    expect(Object.keys(persisted!.objects)).toEqual(result.idMap.parts.map(part => part.nativeObjectId));
    expect(Object.keys(persisted!.diagrams)).toEqual(result.changedDiagramIds);
    expect(await getRoomStore().listActivities(input.roomId)).toHaveLength(1);
    expect(await drafts.list(input.roomId)).toEqual([]);
  });

  it("reports a verified retry before stale-revision checks without duplicating artwork or presentation", async () => {
    const input = await setup();
    const createPresentation = vi.spyOn(getAgentCanvasDraftStore(), "create");
    const run = () => idempotentImport(input, "svg-import-replay-0001");

    const first = await run();
    await expect(run()).rejects.toMatchObject({
      code: "MUTATION_OUTCOME_UNKNOWN",
      details: { replayed: true, outcome: "applied", committedRoomRevision: first.room.roomRevision },
    });
    const persisted = await getRoomStore().getRoom(input.roomId);
    expect(persisted?.roomRevision).toBe(first.room.roomRevision);
    expect(Object.keys(persisted!.objects)).toEqual(first.idMap.parts.map(part => part.nativeObjectId));
    expect(Object.keys(persisted!.diagrams)).toEqual(first.changedDiagramIds);
    expect(await getRoomStore().listActivities(input.roomId)).toHaveLength(1);
    expect(createPresentation).toHaveBeenCalledTimes(1);
    expect(await getAgentCanvasDraftStore().list(input.roomId)).toHaveLength(1);
  });

  it("commits only one composition when same-key imports race after both pass preflight", async () => {
    const input = await setup();
    const applyTransaction = roomService.runSemanticTransaction;
    const createPresentation = vi.spyOn(getAgentCanvasDraftStore(), "create");
    let ready = 0;
    let release!: () => void;
    const bothPlanned = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(roomService, "runSemanticTransaction").mockImplementation(async transaction => {
      ready += 1;
      if (ready === 2) release();
      await bothPlanned;
      return applyTransaction(transaction);
    });

    const results = await Promise.allSettled([
      idempotentImport(input, "svg-import-concurrent-0001"),
      idempotentImport(input, "svg-import-concurrent-0001"),
    ]);

    expect(ready).toBe(2);
    const committed = results.filter(result => result.status === "fulfilled");
    const rejected = results.filter(result => result.status === "rejected");
    expect(committed).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const first = committed[0].value;
    expect(rejected[0].reason).toMatchObject({
      code: "MUTATION_OUTCOME_UNKNOWN",
      details: { replayed: true, outcome: "applied", committedRoomRevision: first.room.roomRevision },
    });
    const persisted = await getRoomStore().getRoom(input.roomId);
    expect(persisted?.roomRevision).toBe(input.expectedRoomRevision + 1);
    expect(persisted?.objects).toEqual(first.room.objects);
    expect(persisted?.diagrams).toEqual(first.room.diagrams);
    expect(await getRoomStore().listActivities(input.roomId)).toHaveLength(1);
    expect(createPresentation).toHaveBeenCalledTimes(1);
    expect(await getAgentCanvasDraftStore().list(input.roomId)).toHaveLength(1);
  });

  it("reports a verified proposed retry without publishing or duplicating its review proposal", async () => {
    const input = await setup();
    const policy = await setAgentEditPolicy({ ...input, policy: "review" });
    input.expectedRoomRevision = policy.room.roomRevision;
    const first = await idempotentImport(input, "svg-import-review-retry-0001");
    expect(first.outcome).toBe("proposed");

    await expect(idempotentImport(input, "svg-import-review-retry-0001")).rejects.toMatchObject({
      code: "MUTATION_OUTCOME_UNKNOWN",
      details: { replayed: true, outcome: "proposed", committedRoomRevision: first.room.roomRevision },
    });

    const persisted = await getRoomStore().getRoom(input.roomId);
    expect(persisted).toMatchObject({ roomRevision: first.room.roomRevision, objects: {}, diagrams: {} });
    expect(persisted?.reviewProposals).toEqual(first.room.reviewProposals);
    expect(persisted?.reviewProposals).toHaveLength(1);
    expect(await getRoomStore().listActivities(input.roomId)).toEqual([]);
    expect(await getAgentCanvasDraftStore().list(input.roomId)).toEqual([]);
  });
});
