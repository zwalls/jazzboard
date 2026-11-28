// @vitest-environment node

import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { Client, StreamableHTTPClientTransport, type CallToolResult } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { POST, GET, DELETE } from "@/app/api/mcp/route";
import { GET as listConnections, POST as manageConnections } from "@/app/api/rooms/[roomId]/mcp-connections/route";
import { createCanvasObjectSchema } from "@/lib/domain/schemas";
import { createRemoteMcpGrant } from "./remote-mcp-auth";
import { getOrCreateGuestSession } from "./session";
import { getRoomStore } from "./room-store";
import { runCanvasCommand, runLeaseAction, setAgentEditPolicy } from "./room-service";

const nativePath = {
  type: "create",
  object: {
    id: "editable-test-path",
    kind: "path",
    x: 1, y: 2, width: 100, height: 80, zIndex: 1,
    groupId: "test-group",
    start: { x: 0.1, y: 0.2 },
    segments: [{ kind: "line", to: { x: 0.9, y: 0.8 } }],
    stroke: "#171922",
  },
};
const nativeEdit = {
  type: "update",
  objectId: "editable-test-path",
  expectedRevision: 1,
  operation: "move",
  patch: { x: 31 },
};

function content(result: CallToolResult) {
  const block = result.content?.find((block) => block.type === "text");
  if (!block || block.type !== "text") throw new Error("Expected an MCP text result.");
  try {
    return JSON.parse(block.text);
  } catch {
    throw new Error(block.text);
  }
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a loopback TCP port.");
  return `http://127.0.0.1:${address.port}`;
}

describe("remote Jazzboard MCP over Streamable HTTP", () => {
  const clients: Client[] = [];
  let server: Server;
  let base: string;
  let endpoint: string;
  let roomId: string;
  let otherRoomId: string;
  let previewRoomId: string;
  let owner: string;
  let peer: string;
  let ownerCookie: string;
  let peerCookie: string;
  let visitorCookie: string;
  let outsiderCookie: string;
  let writerToken: string;
  let readerToken: string;
  let peerReaderToken: string;
  let visitorToken: string;
  let formerMemberToken: string;
  let previewToken: string;
  let removedPreviewToken: string;

  function guestSession() {
    const result = getOrCreateGuestSession(new Request("http://localhost"));
    if (!result.setCookie) throw new Error("Expected a signed guest cookie.");
    return { participantId: result.participantId, cookie: result.setCookie.split(";")[0] };
  }

  function manage(id: string, cookie?: string, input?: Record<string, unknown>, origin = base) {
    return fetch(`${base}/api/rooms/${id}/mcp-connections`, {
      method: input ? "POST" : "GET",
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(input ? { Origin: origin, "Content-Type": "application/json" } : {}) },
      ...(input ? { body: JSON.stringify(input) } : {}),
    });
  }

  async function issue(id: string, cookie: string, access: "read" | "write", label = "Local client") {
    const response = await manage(id, cookie, { action: "create", label, access });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    return (await response.json()).connection as { token: string; id: string };
  }

  async function connect(accessToken: string): Promise<Client> {
    const client = new Client({ name: "jazzboard-test", version: "1.0.0" });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
    }));
    return client;
  }

  async function read(client: Client, id = roomId, extra: Record<string, unknown> = {}) {
    return client.callTool({ name: "read_canvas", arguments: { roomId: id, ...extra } });
  }

  async function apply(client: Client, revision: number, commands: unknown[], key = randomUUID()) {
    return client.callTool({
      name: "apply_canvas_edits",
      arguments: { roomId, expectedRoomRevision: revision, commands, idempotencyKey: key },
    });
  }

  function request(headers: Record<string, string> = {}, body = "{}") {
    return fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });
  }

  beforeAll(async () => {
    vi.stubEnv("JAZZBOARD_REMOTE_MCP_ENABLED", "0");
    vi.stubEnv("REDIS_URL", "");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("VERCEL_ENV", "");
    globalThis.__jazzboardRoomStore = undefined;
    globalThis.__jazzboardLocalState = undefined;
    globalThis.__jazzboardLocalMcpGrants = undefined;
    const ownerSession = guestSession();
    const peerSession = guestSession();
    const visitorSession = guestSession();
    const outsiderSession = guestSession();
    owner = ownerSession.participantId;
    peer = peerSession.participantId;
    ownerCookie = ownerSession.cookie;
    peerCookie = peerSession.cookie;
    visitorCookie = visitorSession.cookie;
    outsiderCookie = outsiderSession.cookie;
    const visitor = visitorSession.participantId;
    const store = getRoomStore();
    const room = await store.createRoom({ participantId: owner, displayName: "Owner", title: "MCP test room" });
    roomId = room.id;
    await store.joinRoom({ code: room.code, participantId: peer, displayName: "Peer", role: "participant" });
    await store.joinRoom({ code: room.code, participantId: visitor, displayName: "Visitor", role: "spectator" });
    otherRoomId = (await store.createRoom({ participantId: owner, displayName: "Owner", title: "Other room" })).id;
    const previewRoom = await store.createRoom({ participantId: owner, displayName: "Owner", title: "Preview room" });
    previewRoomId = previewRoom.id;
    await store.joinRoom({ code: previewRoom.code, participantId: visitor, displayName: "Visitor", role: "spectator" });
    await runCanvasCommand({
      roomId: previewRoomId, participantId: owner, actorKind: "human",
      command: { type: "create", object: createCanvasObjectSchema.parse(nativePath.object) },
    });

    server = createServer(async (incoming, outgoing) => {
      try {
        const method = incoming.method ?? "GET";
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        }
        const chunks: Uint8Array[] = [];
        for await (const chunk of incoming) chunks.push(chunk);
        const request = new Request(new URL(incoming.url ?? "/", base), {
          method,
          headers,
          body: chunks.length ? Buffer.concat(chunks) : undefined,
        });
        const management = new URL(request.url).pathname.match(/^\/api\/rooms\/([^/]+)\/mcp-connections$/);
        const response = management
          ? await (method === "POST" ? manageConnections : listConnections)(request, { params: Promise.resolve({ roomId: management[1] }) })
          : await (method === "POST" ? POST : method === "DELETE" ? DELETE : GET)(request);
        outgoing.writeHead(response.status, Object.fromEntries(response.headers));
        if (response.body) {
          const reader = response.body.getReader();
          let frame = await reader.read();
          while (!frame.done) {
            outgoing.write(frame.value);
            frame = await reader.read();
          }
        }
        outgoing.end();
      } catch {
        outgoing.writeHead(500).end();
      }
    });
    base = await listen(server);
    endpoint = `${base}/api/mcp`;
    expect((await request()).status).toBe(404);
    expect((await manage(roomId, ownerCookie)).status).toBe(404);
    vi.stubEnv("JAZZBOARD_REMOTE_MCP_ENABLED", "1");
    vi.stubEnv("JAZZBOARD_REMOTE_MCP_RESOURCE", endpoint);
    writerToken = (await issue(roomId, ownerCookie, "write")).token;
    readerToken = (await issue(roomId, ownerCookie, "read")).token;
    peerReaderToken = (await issue(roomId, peerCookie, "read")).token;
    visitorToken = (await issue(roomId, visitorCookie, "read")).token;
    previewToken = (await issue(previewRoomId, visitorCookie, "read")).token;
    // Exercise a stored connection whose original member no longer exists.
    const resource = new URL(endpoint);
    const absentParticipant = { participantId: outsiderSession.participantId, label: "Former member", access: "read" } as const;
    formerMemberToken = (await createRemoteMcpGrant(resource, { roomId, ...absentParticipant })).token;
    removedPreviewToken = (await createRemoteMcpGrant(resource, { roomId: previewRoomId, ...absentParticipant })).token;
  }, 15_000);

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.close()));
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    globalThis.__jazzboardRoomStore = undefined;
    globalThis.__jazzboardLocalState = undefined;
    globalThis.__jazzboardLocalMcpGrants = undefined;
    vi.unstubAllEnvs();
  });

  it("requires a valid room token and rejects browser origins outside Jazzboard", async () => {
    const missingToken = await request();
    expect(missingToken.status).toBe(401);
    expect(missingToken.headers.get("www-authenticate")).toBe('Bearer realm="Jazzboard MCP"');
    expect(missingToken.headers.get("cache-control")).toBe("no-store");
    const invalid = "x" + writerToken.slice(1);
    const altered = writerToken.slice(0, -1) + (writerToken.endsWith("a") ? "b" : "a");
    for (const value of [invalid, altered, ownerCookie]) {
      expect((await request({ Authorization: `Bearer ${value}` })).status).toBe(401);
    }
    expect((await request({ Cookie: ownerCookie })).status).toBe(401);
    const authorization = `Bearer ${writerToken}`;
    expect((await request({ Authorization: authorization, Origin: "https://outside.example" })).status).toBe(403);
    expect((await request({ Authorization: authorization }, JSON.stringify("x".repeat(256 * 1024)))).status).toBe(413);
  });

  it("lets only same-origin room members create and manage their scoped connections", async () => {
    const input = { action: "create", access: "write", label: "Temporary connection" };
    expect((await manage(roomId, undefined, input)).status).toBe(401);
    expect((await manage(roomId, outsiderCookie, input)).status).toBe(403);
    expect((await manage(roomId, visitorCookie, input)).status).toBe(403);
    expect((await manage(roomId, ownerCookie, input, "https://outside.example")).status).toBe(403);
    const transient = await issue(roomId, ownerCookie, "read", "Temporary connection");
    const listed = await (await manage(roomId, ownerCookie)).json();
    expect(listed.connections).toContainEqual(expect.objectContaining({ id: transient.id, access: "read" }));
    expect(JSON.stringify(listed)).not.toContain(transient.token);
    expect(JSON.stringify(listed)).not.toContain("digest");
    expect((await (await manage(roomId, peerCookie)).json()).connections).not.toContainEqual(expect.objectContaining({ id: transient.id }));
    expect((await manage(roomId, peerCookie, { action: "revoke", id: transient.id })).status).toBe(403);
    expect((await manage(roomId, outsiderCookie, { action: "revoke", id: transient.id })).status).toBe(403);
    const client = await connect(transient.token);
    expect(content(await read(client))).toMatchObject({ roomId });
    expect((await manage(roomId, ownerCookie, { action: "revoke", id: transient.id })).status).toBe(200);
    await expect(read(client)).rejects.toThrow();
    expect((await request({ Authorization: `Bearer ${transient.token}` })).status).toBe(401);
  });

  it("isolates grants by endpoint and rejects expired credentials", async () => {
    const readGrant = await issue(roomId, ownerCookie, "read", "Expiry fixture");
    const parallelEndpoint = new URL("https://separate-jazzboard.example/api/mcp");
    const other = await createRemoteMcpGrant(parallelEndpoint, {
      roomId, participantId: owner, label: "Separate endpoint", access: "write",
    });
    expect((await request({ Authorization: `Bearer ${other.token}` })).status).toBe(401);
    const before = await (await manage(roomId, ownerCookie)).json();
    expect(before.connections).not.toContainEqual(expect.objectContaining({ id: other.id }));
    const expired = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31 * 24 * 60 * 60 * 1000);
    try {
      expect((await request({ Authorization: `Bearer ${readGrant.token}` })).status).toBe(401);
      const listed = await (await manage(roomId, ownerCookie)).json();
      expect(listed.connections).not.toContainEqual(expect.objectContaining({ id: readGrant.id }));
    } finally {
      expired.mockRestore();
    }
  });

  it("accepts the stable 2025 Streamable HTTP initialization handshake", async () => {
    const protocolVersion = "2025-06-18";
    const response = await request({
      Authorization: `Bearer ${writerToken}`,
      Accept: "application/json, text/event-stream",
    }, JSON.stringify({
      jsonrpc: "2.0", id: 7, method: "initialize",
      params: { protocolVersion, capabilities: {}, clientInfo: { name: "legacy-client", version: "1" } },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toContain(`"protocolVersion":"${protocolVersion}"`);
  });

  it("requires a matching room grant, connection permission, membership and mutation role on each call", async () => {
    const writer = await connect(writerToken);
    const scopeReader = await connect(readerToken);
    const mappingReader = await connect(peerReaderToken);
    const spectator = await connect(visitorToken);
    const formerMember = await connect(formerMemberToken);
    const start = content(await read(writer));
    expect(start).toMatchObject({ roomId, title: "MCP test room", objects: [] });
    expect(start).not.toHaveProperty("participants");
    expect(start).not.toHaveProperty("code");
    for (const reader of [scopeReader, mappingReader, spectator]) {
      expect(content(await read(reader))).toMatchObject({ roomId });
      const denial = await apply(reader, start.roomRevision, [nativePath]);
      expect(denial.isError).toBe(true);
      expect(content(denial)).toMatchObject({ error: { code: "FORBIDDEN" } });
    }
    for (const challenge of [
      await read(writer, otherRoomId),
      await read(formerMember),
      await read(writer, "room_00000000-0000-0000-0000-000000000001"),
    ]) {
      expect(challenge.isError).toBe(true);
      expect(content(challenge)).toMatchObject({ error: { code: "FORBIDDEN" } });
    }
  });

  it("applies native edits atomically, handles retries, and preserves concurrency and review safeguards", async () => {
    const writer = await connect(writerToken);
    const start = content(await read(writer));
    const revision = start.roomRevision;
    expect(content(await apply(writer, revision + 1, [nativePath]))).toMatchObject({ error: { code: "REVISION_CONFLICT" } });

    expect((await apply(writer, revision, [nativePath, { ...nativeEdit, objectId: "missing" }])).isError).toBe(true);
    expect(content(await read(writer))).toMatchObject({ roomRevision: revision, objects: [] });

    const imageCommand = {
      type: "create",
      object: { ...nativePath.object, kind: "image", id: "private-image", url: "https://example.net/private.png" },
    };
    expect(content(await apply(writer, revision, [imageCommand]))).toMatchObject({ error: { code: "INVALID_OPERATION" } });
    expect(content(await read(writer))).toMatchObject({ roomRevision: revision, objects: [] });

    const idempotencyKey = randomUUID();
    const created = content(await apply(writer, revision, [nativePath], idempotencyKey));
    expect(created).toMatchObject({ outcome: "applied", roomRevision: revision + 1, changedObjectIds: [nativePath.object.id] });
    expect(content(await apply(writer, revision, [nativePath], idempotencyKey))).toEqual({
      outcome: "already_committed", committedRoomRevision: revision + 1, readCanvasBeforeContinuing: true,
    });
    expect((await apply(writer, revision, [nativeEdit])).isError).toBe(true);

    const reading = content(await read(writer, roomId, { includeGeometry: true }));
    expect(reading.objects[0]).toMatchObject({ id: nativePath.object.id, kind: "path", revision: 1, segments: nativePath.object.segments });
    expect(reading.objects[0]).not.toHaveProperty("createdBy");
    expect((await read(writer, roomId, { offset: 1 })).isError).toBe(true);
    expect((await read(writer, roomId, { offset: 1, expectedRoomRevision: revision })).isError).toBe(true);
    expect(content(await read(writer, roomId, { offset: 1, expectedRoomRevision: revision + 1 }))).toMatchObject({ objects: [], nextOffset: null });

    const acquired = await runLeaseAction({
      roomId, objectId: nativePath.object.id, participantId: peer, actorKind: "human", action: "acquire",
      operation: "move", expectedRevision: 1,
    });
    const leasedRevision = content(await read(writer)).roomRevision;
    expect(content(await apply(writer, leasedRevision, [nativeEdit]))).toMatchObject({ error: { code: "OBJECT_BUSY" } });
    if (!acquired.lease) throw new Error("Expected the human lease.");
    await runLeaseAction({
      roomId, objectId: nativePath.object.id, participantId: peer, actorKind: "human", action: "release",
      leaseId: acquired.lease.leaseId,
    });
    const revisionAfterRelease = content(await read(writer)).roomRevision;
    expect(content(await apply(writer, revisionAfterRelease, [nativeEdit]))).toMatchObject({
      outcome: "applied", changedObjectIds: [nativePath.object.id],
    });
    expect(content(await read(writer, roomId, { includeGeometry: true })).objects[0]).toMatchObject({ x: 31, revision: 2 });
    await setAgentEditPolicy({ roomId, participantId: owner, actorKind: "human", policy: "review" });
    const reviewRevision = content(await read(writer)).roomRevision;
    const secondPath = { ...nativePath, object: { ...nativePath.object, id: "review-path" } };
    expect(content(await apply(writer, reviewRevision, [secondPath]))).toMatchObject({ outcome: "proposed", proposalId: expect.any(String) });
    expect(content(await read(writer)).objects.map(({ id }: { id: string }) => id)).toEqual([nativePath.object.id]);
  });

  it("returns private image bounds without its source or asset metadata", async () => {
    await runCanvasCommand({
      roomId, participantId: owner, actorKind: "human",
      command: {
        type: "create",
        object: {
          id: "private-image", kind: "image", x: 12, y: 22, width: 20, height: 40,
          rotation: 0, zIndex: 2, groupId: null, url: "https://example.net/private.png",
          sourceUrl: "https://example.net/source.png", assetId: "private-asset-id",
          alt: "private-image-label", mimeType: "image/png", locked: false,
        },
      },
    });
    const reader = await connect(readerToken);
    const objects = content(await read(reader, roomId, { includeGeometry: true })).objects;
    const image = objects.find(({ id }: { id: string }) => id === "private-image");
    expect(image).toMatchObject({ kind: "image", x: 12, width: 20, mediaOmitted: true });
    for (const key of ["url", "sourceUrl", "assetId", "alt", "mimeType", "createdBy"]) expect(image).not.toHaveProperty(key);
    const denied = await reader.callTool({
      name: "render_canvas_preview",
      arguments: { roomId, scope: { kind: "objects", targets: [{ objectId: "private-image", expectedRevision: image.revision }] } },
    });
    expect(denied.isError).toBe(true);
    expect(content(denied)).toMatchObject({ error: { code: "UNSUPPORTED_CONTENT" } });
    expect(denied.content?.every((block) => block.type !== "image")).toBe(true);
  });
  it("returns a scoped PNG to read-only members and denies invalid or unauthorized scopes", async () => {
    const reader = await connect(previewToken);
    const ungranted = await connect(readerToken);
    const removed = await connect(removedPreviewToken);
    const objectId = nativePath.object.id;
    const room = content(await read(reader, previewRoomId));
    const preview = (client: Client, scope?: Record<string, unknown>, requestedRoomId = previewRoomId) =>
      client.callTool({ name: "render_canvas_preview", arguments: { roomId: requestedRoomId, scope } });
    const objectScope = { kind: "objects", targets: [{ objectId, expectedRevision: 1 }] };
    const groupScope = { kind: "group", groupId: "test-group", expectedRoomRevision: room.roomRevision };
    const advertised = (await reader.listTools()).tools.find(({ name }) => name === "render_canvas_preview");
    expect(advertised?.annotations).toMatchObject({ readOnlyHint: true });

    for (const scope of [objectScope, groupScope]) {
      const rendered = await preview(reader, scope);
      expect(rendered.isError, JSON.stringify(rendered.content)).not.toBe(true);
      const image = rendered.content?.find((block) => block.type === "image");
      if (image?.type !== "image") throw new Error("Expected MCP image content.");
      expect(image.mimeType).toBe("image/png");
      const png = Buffer.from(image.data, "base64");
      expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(content(rendered)).toMatchObject({
        mimeType: "image/png", byteLength: png.length, roomRevision: room.roomRevision,
        objectRevisions: [{ objectId, revision: 1 }],
        width: png.readUInt32BE(16), height: png.readUInt32BE(20),
      });
    }

    const failures = [
      [await preview(ungranted, objectScope), "FORBIDDEN"],
      [await preview(removed, objectScope), "FORBIDDEN"],
      [await preview(reader, objectScope, otherRoomId), "FORBIDDEN"],
      [await preview(reader, { kind: "objects", targets: [{ objectId, expectedRevision: 2 }] }), "REVISION_MISMATCH"],
      [await preview(reader, { ...groupScope, expectedRoomRevision: room.roomRevision + 1 }), "REVISION_MISMATCH"],
    ] as const;
    for (const [denied, code] of failures) {
      expect(denied.isError).toBe(true);
      expect(content(denied)).toMatchObject({ error: { code } });
      expect(denied.content?.every((block) => block.type !== "image")).toBe(true);
    }
    const wholeRoom = await preview(reader);
    expect(wholeRoom.isError).toBe(true);
    expect(wholeRoom.content?.every((block) => block.type !== "image")).toBe(true);
    expect(content(await read(reader, previewRoomId))).toEqual(room);
  });
});
