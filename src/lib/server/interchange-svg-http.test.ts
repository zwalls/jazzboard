// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActorKind } from "@/lib/domain/types";

import { getAgentCanvasDraftStore, resetMemoryAgentCanvasDraftStoreForTests } from "./agent-draft-store";
import { handleAuthorizedTemplateInstantiation } from "./interchange-http";
import { getRoomStore } from "./room-store";
import { setAgentEditPolicy } from "./room-service";
import { getOrCreateGuestSession } from "./session";

const source = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80" viewBox="0 0 100 80"><rect id="panel" x="10" y="20" width="30" height="40" fill="red"/></svg>';

function guest() {
  const session = getOrCreateGuestSession(new Request("https://jazzboard.test/api/rooms"));
  return { participantId: session.participantId, cookie: session.setCookie!.split(";")[0] };
}

async function setup() {
  const owner = guest();
  const room = await getRoomStore().createRoom({ ...owner, displayName: "SVG author", title: "SVG HTTP boundary" });
  return { owner, room, body: { action: "import_svg_artwork", expectedRoomRevision: room.roomRevision, source } };
}

async function send(input: {
  roomId: string;
  cookie?: string;
  body: unknown;
  actorKind?: ActorKind;
  idempotencyKey?: string;
}) {
  const headers = new Headers({ "content-type": "application/json" });
  if (input.cookie) headers.set("cookie", input.cookie);
  if (input.idempotencyKey) headers.set("idempotency-key", input.idempotencyKey);
  return handleAuthorizedTemplateInstantiation(new Request(
    `https://jazzboard.test/api/rooms/${input.roomId}/agent/artifacts`,
    { method: "POST", headers, body: JSON.stringify(input.body) },
  ), { params: Promise.resolve({ roomId: input.roomId }) }, input.actorKind ?? "agent");
}

describe("authorized SVG import HTTP boundary", () => {
  beforeEach(() => {
    vi.stubEnv("REDIS_URL", "");
    vi.stubEnv("SESSION_SECRET", "svg-http-test-session-secret-at-least-32-characters");
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

  it.each(["human", "agent"] as const)("imports as %s with a private presentation snapshot and translated bounds", async (actorKind) => {
    const { owner, room, body } = await setup();
    const response = await send({
      roomId: room.id, cookie: owner.cookie, actorKind,
      body: { ...body, origin: { x: 100, y: -50 }, title: "Named artwork", intent: "Import a panel" },
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const result = await response.json();
    expect(result).toMatchObject({
      ok: true, outcome: "applied", counts: { parts: 1, paths: 1 },
      bounds: { x: 110, y: -30, width: 30, height: 40 },
      presentation: { status: "presenting", author: { kind: actorKind } },
    });
    expect(Object.values(result.room.diagrams)).toEqual([expect.objectContaining({ title: "Named artwork" })]);
    expect(result.presentation).not.toHaveProperty("transaction");
    expect(result.presentation).not.toHaveProperty("committing");
    expect(result.presentation).not.toHaveProperty("authoritativeCommit");
    expect(result.presentation.previewObjects[0]).toMatchObject({ authority: "draft", fill: "#ff0000" });
  });

  it("requires a guest session and room membership before importing", async () => {
    const { room, body } = await setup();
    const anonymous = await send({ roomId: room.id, body });
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toMatchObject({ ok: false, error: { code: "AUTH_REQUIRED" } });
    const outsider = await send({ roomId: room.id, body, cookie: guest().cookie });
    expect(outsider.status).toBe(403);
    expect(await outsider.json()).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect((await getRoomStore().getRoom(room.id))?.objects).toEqual({});
  });

  it("returns a spectator denial without creating artwork or a proposal", async () => {
    const { room, body } = await setup();
    const spectator = guest();
    const joined = await getRoomStore().joinRoom({ ...spectator, code: room.code, displayName: "Spectator", role: "spectator" });
    const response = await send({
      roomId: room.id, cookie: spectator.cookie, body: { ...body, expectedRoomRevision: joined.roomRevision },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect((await getRoomStore().getRoom(room.id))?.reviewProposals).toEqual([]);
  });

  it.each([
    { source: "x".repeat(65_537) },
    { expectedRoomRevision: 0 },
    { origin: { x: null, y: 0 } },
    { grouping: "boxed" },
    { unexpected: true },
  ])("rejects an invalid bounded SVG request %#", async (invalidFields) => {
    const { owner, room, body } = await setup();
    const response = await send({ roomId: room.id, cookie: owner.cookie, body: { ...body, ...invalidFields } });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    expect((await getRoomStore().getRoom(room.id))?.objects).toEqual({});
    expect(await getAgentCanvasDraftStore().list(room.id)).toEqual([]);
  });

  it("maps parser failures and stale revisions without a partial import", async () => {
    const { owner, room, body } = await setup();
    const invalid = await send({
      roomId: room.id, cookie: owner.cookie,
      body: { ...body, source: source.replace("<rect", "<image") },
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ ok: false, error: { code: "INVALID_OPERATION" } });
    const stale = await send({
      roomId: room.id, cookie: owner.cookie, body: { ...body, expectedRoomRevision: room.roomRevision + 1 },
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ ok: false, error: { code: "REVISION_CONFLICT" } });
    expect((await getRoomStore().getRoom(room.id))?.roomRevision).toBe(room.roomRevision);
    expect(await getRoomStore().listActivities(room.id)).toEqual([]);
  });

  it("honors review mode for agents and still allows direct human imports", async () => {
    const { owner, room, body } = await setup();
    const policy = await setAgentEditPolicy({ roomId: room.id, participantId: owner.participantId, actorKind: "human", policy: "review" });
    const proposed = await send({
      roomId: room.id, cookie: owner.cookie, body: { ...body, expectedRoomRevision: policy.room.roomRevision },
    });
    expect(proposed.status).toBe(201);
    const proposal = await proposed.json();
    expect(proposal).toMatchObject({ ok: true, outcome: "proposed", presentation: null, room: { objects: {}, diagrams: {} } });
    expect(proposal.room.reviewProposals).toHaveLength(1);
    const human = await send({
      roomId: room.id, cookie: owner.cookie, actorKind: "human",
      body: { ...body, expectedRoomRevision: proposal.room.roomRevision },
    });
    expect(human.status).toBe(201);
    expect(await human.json()).toMatchObject({ ok: true, outcome: "applied" });
  });

  it("reports an exact committed retry and rejects key reuse with a changed SVG", async () => {
    const { owner, room, body } = await setup();
    const request = { roomId: room.id, cookie: owner.cookie, body, idempotencyKey: "svg-http-retry-0001" };
    const firstResponse = await send(request);
    expect(firstResponse.status).toBe(201);
    const first = await firstResponse.json();
    const retry = await send(request);
    expect(retry.status).toBe(503);
    expect(await retry.json()).toMatchObject({
      ok: false, error: { code: "MUTATION_OUTCOME_UNKNOWN", details: { replayed: true, committedRoomRevision: first.room.roomRevision } },
    });
    const changed = await send({ ...request, body: { ...body, source: source.replace("red", "blue") } });
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ ok: false, error: { code: "IDEMPOTENCY_CONFLICT" } });
    expect((await getRoomStore().getRoom(room.id))?.roomRevision).toBe(first.room.roomRevision);
    expect(await getRoomStore().listActivities(room.id)).toHaveLength(1);
    expect(await getAgentCanvasDraftStore().list(room.id)).toHaveLength(1);
  });
});
