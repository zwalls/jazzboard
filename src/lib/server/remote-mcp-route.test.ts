// @vitest-environment node

import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { Client, StreamableHTTPClientTransport, type CallToolResult } from "@modelcontextprotocol/client";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { POST, GET, DELETE } from "@/app/api/mcp/route";
import { GET as metadata } from "@/app/.well-known/oauth-protected-resource/api/mcp/route";
import { MCP_METADATA_PATH } from "./remote-mcp-auth";
import { getRoomStore } from "./room-store";
import { runCanvasCommand, runLeaseAction, setAgentEditPolicy } from "./room-service";

const owner = "p_remote_mcp_owner_fixture";
const peer = "p_remote_mcp_second_fixture";
const visitor = "p_remote_mcp_spectator_fixture";
const missing = "p_remote_mcp_missing_fixture";
const subject = "fixture-subject";
const clientId = "fixture-client";
const readScope = "room:read";
const writeScope = "room:read room:write";

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
  let privateKey: CryptoKey;
  let roomId: string;
  let otherRoomId: string;

  async function token(options: { sub?: string; scope?: string; audience?: string | string[]; issuer?: string; typ?: string; exp?: number; client?: string } = {}) {
    return new SignJWT({ client_id: options.client ?? clientId, scope: options.scope ?? writeScope })
      .setProtectedHeader({ alg: "RS256", typ: options.typ ?? "at+jwt", kid: "test-key" })
      .setIssuer(options.issuer ?? base)
      .setAudience(options.audience ?? endpoint)
      .setSubject(options.sub ?? subject)
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime(options.exp ?? "5m")
      .sign(privateKey);
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
    const store = getRoomStore();
    const room = await store.createRoom({ participantId: owner, displayName: "Owner", title: "MCP test room" });
    roomId = room.id;
    await store.joinRoom({ code: room.code, participantId: peer, displayName: "Peer", role: "participant" });
    await store.joinRoom({ code: room.code, participantId: visitor, displayName: "Visitor", role: "spectator" });
    otherRoomId = (await store.createRoom({ participantId: owner, displayName: "Owner", title: "Other room" })).id;

    const pair = await generateKeyPair("RS256");
    privateKey = pair.privateKey;
    const publicJwk = { ...await exportJWK(pair.publicKey), alg: "RS256", kid: "test-key" };
    server = createServer(async (incoming, outgoing) => {
      try {
        if (incoming.url === "/jwks") {
          outgoing.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ keys: [publicJwk] }));
          return;
        }
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
        const route = incoming.url === MCP_METADATA_PATH
          ? metadata
          : method === "POST" ? POST : method === "DELETE" ? DELETE : GET;
        const response = await route(request);
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
    expect((await fetch(base + MCP_METADATA_PATH)).status).toBe(404);

    vi.stubEnv("JAZZBOARD_REMOTE_MCP_ENABLED", "1");
    vi.stubEnv("JAZZBOARD_REMOTE_MCP_RESOURCE", endpoint);
    vi.stubEnv("JAZZBOARD_REMOTE_MCP_ISSUER", base);
    vi.stubEnv("JAZZBOARD_REMOTE_MCP_JWKS_URL", `${base}/jwks`);
    vi.stubEnv("JAZZBOARD_REMOTE_MCP_ROOM_GRANTS", JSON.stringify([
      { subject, clientId, roomId, participantId: owner, access: "write" },
      { subject: "map-read-only", clientId, roomId, participantId: peer, access: "read" },
      { subject: "spectator", clientId, roomId, participantId: visitor, access: "write" },
      { subject: "former-member", clientId, roomId, participantId: missing, access: "write" },
    ]));
  }, 15_000);

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.close()));
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    globalThis.__jazzboardRoomStore = undefined;
    globalThis.__jazzboardLocalState = undefined;
    vi.unstubAllEnvs();
  });

  it("advertises the exact OAuth resource, rejects invalid tokens and rejects foreign Origin", async () => {
    const missingToken = await request();
    expect(missingToken.status).toBe(401);
    expect(missingToken.headers.get("www-authenticate")).toContain(`resource_metadata="${base + MCP_METADATA_PATH}"`);
    const discovery = await fetch(base + MCP_METADATA_PATH);
    expect(discovery.headers.get("cache-control")).toBe("no-store");
    expect(await discovery.json()).toMatchObject({
      resource: endpoint,
      authorization_servers: [base],
      scopes_supported: ["room:read", "room:write"],
    });
    const signed = (await token()).split(".");
    const changedSignature = (signed[2][0] === "A" ? "B" : "A") + signed[2].slice(1);
    const invalid = [
      "malformed.token",
      [signed[0], signed[1], changedSignature].join("."),
      await token({ audience: base }),
      await token({ audience: [endpoint, base] }),
      await token({ issuer: `${base}/different` }),
      await token({ exp: Math.floor(Date.now() / 1000) - 30 }),
      await token({ typ: "JWT" }),
    ];
    for (const value of invalid) expect((await request({ Authorization: `Bearer ${value}` })).status).toBe(401);
    const authorization = `Bearer ${await token()}`;
    expect((await request({ Authorization: authorization, Origin: "https://outside.example" })).status).toBe(403);
    expect((await request({ Authorization: `Bearer ${await token({ scope: "room:write" })}` })).status).toBe(403);
    expect((await request({ Authorization: authorization }, JSON.stringify("x".repeat(256 * 1024)))).status).toBe(413);
  });

  it("accepts the stable 2025 Streamable HTTP initialization handshake", async () => {
    const protocolVersion = "2025-06-18";
    const response = await request({
      Authorization: `Bearer ${await token()}`,
      Accept: "application/json, text/event-stream",
    }, JSON.stringify({
      jsonrpc: "2.0", id: 7, method: "initialize",
      params: { protocolVersion, capabilities: {}, clientInfo: { name: "legacy-client", version: "1" } },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toContain(`"protocolVersion":"${protocolVersion}"`);
  });

  it("requires a matching room grant, OAuth scope, membership and mutation role on each call", async () => {
    const writer = await connect(await token());
    const scopeReader = await connect(await token({ scope: readScope }));
    const mappingReader = await connect(await token({ sub: "map-read-only" }));
    const spectator = await connect(await token({ sub: "spectator" }));
    const wrongClient = await connect(await token({ client: "ungranted-client" }));
    const formerMember = await connect(await token({ sub: "former-member" }));
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
      await read(wrongClient),
      await read(formerMember),
      await read(writer, "room_00000000-0000-0000-0000-000000000001"),
    ]) {
      expect(challenge.isError).toBe(true);
      expect(content(challenge)).toMatchObject({ error: { code: "FORBIDDEN" } });
    }
  });

  it("applies native edits atomically, handles retries, and preserves concurrency and review safeguards", async () => {
    const writer = await connect(await token());
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
    const reader = await connect(await token({ scope: readScope }));
    const objects = content(await read(reader, roomId, { includeGeometry: true })).objects;
    const image = objects.find(({ id }: { id: string }) => id === "private-image");
    expect(image).toMatchObject({ kind: "image", x: 12, width: 20, mediaOmitted: true });
    for (const key of ["url", "sourceUrl", "assetId", "alt", "mimeType", "createdBy"]) expect(image).not.toHaveProperty(key);
  });
});
