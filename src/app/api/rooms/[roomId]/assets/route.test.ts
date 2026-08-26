// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRedisRoomAsset: vi.fn(),
  handleUpload: vi.fn(),
  putRedisRoomAsset: vi.fn(),
  readAuthorizedRoom: vi.fn(),
  requireGuestParticipantId: vi.fn(),
}));

vi.mock("@vercel/blob/client", () => ({
  handleUpload: mocks.handleUpload,
}));
vi.mock("@/lib/server/asset-store", () => ({
  getRedisRoomAsset: mocks.getRedisRoomAsset,
  putRedisRoomAsset: mocks.putRedisRoomAsset,
}));
vi.mock("@/lib/server/room-service", () => ({
  readAuthorizedRoom: mocks.readAuthorizedRoom,
}));
vi.mock("@/lib/server/session", () => ({
  requireGuestParticipantId: mocks.requireGuestParticipantId,
}));

import { GET, POST } from "./route";

const FOUR_MIB = 4 * 1024 * 1024;
const TEN_MIB = 10 * 1024 * 1024;
const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 255]);

function context(roomId = "room_alpha") {
  return { params: Promise.resolve({ roomId }) };
}

function multipartRequest(roomId: string, file: File): Request {
  const formData = new FormData();
  formData.set("file", file);
  return new Request(`https://jazzboard.example/api/rooms/${roomId}/assets`, {
    method: "POST",
    headers: { cookie: "jazzboard_guest=signed" },
    body: formData,
  });
}

function assetRequest(roomId: string, assetId?: string): Request {
  const url = new URL(`https://jazzboard.example/api/rooms/${roomId}/assets`);
  if (assetId) url.searchParams.set("assetId", assetId);
  return new Request(url, { headers: { cookie: "jazzboard_guest=signed" } });
}

describe("room asset route storage modes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("REDIS_URL", "redis://example.test:6379");
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    mocks.requireGuestParticipantId.mockReturnValue("p_member");
    mocks.readAuthorizedRoom.mockImplementation(async (roomId: string, participantId: string) => ({
      id: roomId,
      roomRevision: 11,
      objects: {},
      participants: { [participantId]: { role: "participant" } },
    }));
    mocks.putRedisRoomAsset.mockResolvedValue({ assetId: "asset_redis" });
    mocks.getRedisRoomAsset.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prefers Vercel Blob when a Blob token exists", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "blob-token");
    mocks.handleUpload.mockResolvedValue({
      type: "blob.generate-client-token",
      clientToken: "client-token",
    });

    const configResponse = await GET(assetRequest("room_alpha"), context());
    const config = await configResponse.json();
    const uploadBody = { type: "blob.generate-client-token", payload: { pathname: "pixel.png" } };
    const uploadResponse = await POST(
      new Request("https://jazzboard.example/api/rooms/room_alpha/assets", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "jazzboard_guest=signed",
        },
        body: JSON.stringify(uploadBody),
      }),
      context(),
    );

    expect(configResponse.status).toBe(200);
    expect(config).toEqual({ ok: true, mode: "vercel-blob", maximumSizeInBytes: TEN_MIB });
    expect(uploadResponse.status).toBe(200);
    expect(mocks.handleUpload).toHaveBeenCalledOnce();
    expect(mocks.handleUpload.mock.calls[0]?.[0]).toMatchObject({ body: uploadBody });
    expect(mocks.putRedisRoomAsset).not.toHaveBeenCalled();
  });

  it("stores a participant PNG outside room state and returns a guarded room URL", async () => {
    const room = {
      id: "room_alpha",
      roomRevision: 11,
      objects: {},
      participants: { p_member: { role: "participant" } },
    };
    mocks.readAuthorizedRoom.mockResolvedValue(room);
    const roomBeforeUpload = structuredClone(room);
    const file = new File([PNG_BYTES], "pixel.png", { type: "image/png" });

    const response = await POST(multipartRequest("room_alpha", file), context());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      assetId: "asset_redis",
      url: "https://jazzboard.example/api/rooms/room_alpha/assets?assetId=asset_redis",
    });
    expect(mocks.putRedisRoomAsset).toHaveBeenCalledOnce();
    expect(mocks.putRedisRoomAsset.mock.calls[0]?.[0]).toMatchObject({
      roomId: "room_alpha",
      file: expect.objectContaining({ name: "pixel.png", type: "image/png", size: PNG_BYTES.length }),
    });
    expect(room).toEqual(roomBeforeUpload);
  });

  it("serves exact Redis bytes and content type only after room authorization", async () => {
    mocks.getRedisRoomAsset.mockResolvedValue({
      name: "pixel.png",
      mimeType: "image/png",
      bytes: PNG_BYTES,
    });

    const response = await GET(assetRequest("room_alpha", "asset_redis"), context());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-disposition")).toBe('inline; filename="pixel.png"');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG_BYTES);
    expect(mocks.requireGuestParticipantId).toHaveBeenCalledOnce();
    expect(mocks.readAuthorizedRoom).toHaveBeenCalledWith("room_alpha", "p_member");
    expect(mocks.getRedisRoomAsset).toHaveBeenCalledWith("room_alpha", "asset_redis");
  });

  it("allows an authorized spectator to render a room image without granting upload access", async () => {
    mocks.readAuthorizedRoom.mockResolvedValue({
      id: "room_alpha",
      participants: { p_member: { role: "spectator" } },
    });
    mocks.getRedisRoomAsset.mockResolvedValue({
      name: "spectator-view.png",
      mimeType: "image/png",
      bytes: PNG_BYTES,
    });

    const readResponse = await GET(assetRequest("room_alpha", "asset_redis"), context());
    const uploadResponse = await POST(
      multipartRequest("room_alpha", new File([PNG_BYTES], "pixel.png", { type: "image/png" })),
      context(),
    );

    expect(readResponse.status).toBe(200);
    expect(new Uint8Array(await readResponse.arrayBuffer())).toEqual(PNG_BYTES);
    expect(uploadResponse.status).toBe(403);
    expect(mocks.getRedisRoomAsset).toHaveBeenCalledWith("room_alpha", "asset_redis");
    expect(mocks.putRedisRoomAsset).not.toHaveBeenCalled();
  });

  it("returns 404 for a missing asset and for an asset requested through another room", async () => {
    mocks.getRedisRoomAsset.mockImplementation(async (roomId: string, assetId: string) =>
      roomId === "room_alpha" && assetId === "asset_exists"
        ? { name: "pixel.png", mimeType: "image/png", bytes: PNG_BYTES }
        : null,
    );

    const missing = await GET(assetRequest("room_alpha", "asset_missing"), context("room_alpha"));
    const wrongRoom = await GET(assetRequest("room_beta", "asset_exists"), context("room_beta"));

    for (const response of [missing, wrongRoom]) {
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { code: "ASSET_NOT_FOUND" },
      });
    }
    expect(mocks.getRedisRoomAsset).toHaveBeenNthCalledWith(1, "room_alpha", "asset_missing");
    expect(mocks.getRedisRoomAsset).toHaveBeenNthCalledWith(2, "room_beta", "asset_exists");
  });

  it.each([
    {
      label: "non-image files",
      file: () => new File(["not an image"], "notes.txt", { type: "text/plain" }),
    },
    {
      label: "images above the Redis fallback limit",
      file: () => new File([new Uint8Array(FOUR_MIB + 1)], "large.png", { type: "image/png" }),
    },
  ])("rejects $label", async ({ file }) => {
    const response = await POST(multipartRequest("room_alpha", file()), context());

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "INVALID_ASSET" },
    });
    expect(mocks.putRedisRoomAsset).not.toHaveBeenCalled();
  });

  it("advertises the smaller Redis fallback limit", async () => {
    const response = await GET(assetRequest("room_alpha"), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      mode: "redis-fallback",
      maximumSizeInBytes: FOUR_MIB,
    });
  });

  it("forbids spectator uploads before reading or storing the multipart body", async () => {
    mocks.readAuthorizedRoom.mockResolvedValue({
      id: "room_alpha",
      participants: { p_member: { role: "spectator" } },
    });

    const response = await POST(
      multipartRequest("room_alpha", new File([PNG_BYTES], "pixel.png", { type: "image/png" })),
      context(),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
    expect(mocks.putRedisRoomAsset).not.toHaveBeenCalled();
  });

  it("requires a guest session to dereference the returned asset URL", async () => {
    mocks.requireGuestParticipantId.mockImplementation(() => {
      throw new Error("AUTH_REQUIRED");
    });

    const response = await GET(assetRequest("room_alpha", "asset_redis"), context());

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "AUTH_REQUIRED" },
    });
    expect(mocks.getRedisRoomAsset).not.toHaveBeenCalled();
  });
});
