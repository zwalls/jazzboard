// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  consumeAssetUploadGrant: vi.fn(),
  deletePrivateBlobAssetRegistration: vi.fn(),
  finalizePrivateBlobAsset: vi.fn(),
  getCommittedPrivateBlobAsset: vi.fn(),
  getPrivateBlob: vi.fn(),
  getRedisRoomAsset: vi.fn(),
  handleUpload: vi.fn(),
  putRedisRoomAsset: vi.fn(),
  readAuthorizedRoom: vi.fn(),
  reservePrivateBlobAssetWithOutcome: vi.fn(),
  requireGuestParticipantId: vi.fn(),
}));

vi.mock("@/lib/server/asset-upload-limiter", () => ({
  consumeAssetUploadGrant: mocks.consumeAssetUploadGrant,
}));

vi.mock("@vercel/blob/client", () => ({
  handleUpload: mocks.handleUpload,
}));
vi.mock("@/lib/server/blob-asset-registry", () => ({
  deletePrivateBlobAssetRegistration: mocks.deletePrivateBlobAssetRegistration,
  getCommittedPrivateBlobAsset: mocks.getCommittedPrivateBlobAsset,
  reservePrivateBlobAssetWithOutcome: mocks.reservePrivateBlobAssetWithOutcome,
}));
vi.mock("@/lib/server/private-blob-assets", () => ({
  finalizePrivateBlobAsset: mocks.finalizePrivateBlobAsset,
  getPrivateBlob: mocks.getPrivateBlob,
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
const MULTIPART_ALLOWANCE = 64 * 1024;
const ASSET_UUID = "550e8400-e29b-41d4-a716-446655440000";
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

function assetRequest(roomId: string, assetId?: string, pathname?: string): Request {
  const url = new URL(`https://jazzboard.example/api/rooms/${roomId}/assets`);
  if (assetId) url.searchParams.set("assetId", assetId);
  if (pathname) url.searchParams.set("pathname", pathname);
  return new Request(url, { headers: { cookie: "jazzboard_guest=signed" } });
}

describe("room asset route storage modes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("REDIS_URL", "redis://example.test:6379");
    vi.stubEnv("JAZZBOARD_PRIVATE_READ_WRITE_TOKEN", "");
    vi.stubEnv("JAZZBOARD_BLOB_ACCESS", "private");
    vi.stubEnv("JAZZBOARD_ALLOW_REDIS_ASSET_FALLBACK", "1");
    mocks.requireGuestParticipantId.mockReturnValue("p_member");
    mocks.readAuthorizedRoom.mockImplementation(async (roomId: string, participantId: string) => ({
      id: roomId,
      roomRevision: 11,
      objects: {},
      participants: { [participantId]: { role: "participant" } },
    }));
    mocks.putRedisRoomAsset.mockResolvedValue({ assetId: "asset_redis" });
    mocks.getRedisRoomAsset.mockResolvedValue(null);
    mocks.getCommittedPrivateBlobAsset.mockResolvedValue(null);
    mocks.reservePrivateBlobAssetWithOutcome.mockResolvedValue({
      registration: { status: "reserved", createdAt: 1_787_826_000_000 },
      created: true,
    });
    mocks.deletePrivateBlobAssetRegistration.mockResolvedValue(null);
    mocks.finalizePrivateBlobAsset.mockResolvedValue({ status: "committed" });
    mocks.consumeAssetUploadGrant.mockResolvedValue({
      allowed: true,
      limit: 12,
      remaining: 11,
      retryAfterSeconds: 0,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prefers Vercel Blob when a Blob token exists", async () => {
    vi.stubEnv("JAZZBOARD_PRIVATE_READ_WRITE_TOKEN", "blob-token");
    mocks.handleUpload.mockResolvedValue({
      type: "blob.generate-client-token",
      clientToken: "client-token",
    });

    const configResponse = await GET(assetRequest("room_alpha"), context());
    const config = await configResponse.json();
    const pathname = `jazzboard/${config.uploadNamespace}/${ASSET_UUID}-pixel.png`;
    const uploadBody = {
      type: "blob.generate-client-token",
      payload: { pathname, multipart: false, clientPayload: null },
    };
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
    expect(config).toMatchObject({
      ok: true,
      mode: "vercel-blob",
      maximumSizeInBytes: TEN_MIB,
      uploadNamespace: expect.stringMatching(/^[a-f0-9]{48}$/),
    });
    expect(config.uploadNamespace).not.toContain("room_alpha");
    expect(uploadResponse.status).toBe(200);
    expect(mocks.handleUpload).toHaveBeenCalledOnce();
    expect(mocks.handleUpload.mock.calls[0]?.[0]).toMatchObject({
      body: uploadBody,
      token: "blob-token",
    });
    const onBeforeGenerateToken = mocks.handleUpload.mock.calls[0]?.[0].onBeforeGenerateToken;
    await expect(onBeforeGenerateToken(pathname)).resolves.toMatchObject({
      allowedContentTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"],
      maximumSizeInBytes: TEN_MIB,
      addRandomSuffix: false,
      allowOverwrite: false,
      validUntil: expect.any(Number),
    });
    expect(mocks.consumeAssetUploadGrant).toHaveBeenCalledWith(
      "room_alpha",
      "p_member",
      pathname,
    );
    expect(mocks.reservePrivateBlobAssetWithOutcome).toHaveBeenCalledWith({
      pathname,
      roomId: "room_alpha",
      participantId: "p_member",
    });
    expect(mocks.reservePrivateBlobAssetWithOutcome.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.handleUpload.mock.invocationCallOrder[0],
    );
    await expect(onBeforeGenerateToken(`jazzboard/${"b".repeat(48)}/${ASSET_UUID}-private.png`)).rejects.toThrow(
      "upload path is invalid",
    );
    await expect(
      onBeforeGenerateToken(`jazzboard/${config.uploadNamespace}/folder/${ASSET_UUID}-private.png`),
    ).rejects.toThrow("upload path is invalid");
    expect(mocks.putRedisRoomAsset).not.toHaveBeenCalled();
  });

  it("streams a private Blob only through the authorized room proxy", async () => {
    vi.stubEnv("JAZZBOARD_PRIVATE_READ_WRITE_TOKEN", "private-blob-token");
    const config = await (await GET(assetRequest("room_alpha"), context())).json();
    const pathname = `jazzboard/${config.uploadNamespace}/${ASSET_UUID}-pixel-private.png`;
    mocks.getCommittedPrivateBlobAsset.mockResolvedValue({
      pathname,
      roomId: "room_alpha",
      status: "committed",
    });
    mocks.getPrivateBlob.mockResolvedValue({
      statusCode: 200,
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue(PNG_BYTES);
          controller.close();
        },
      }),
      headers: new Headers(),
      blob: {
        url: "https://store.private.blob.vercel-storage.com/private",
        downloadUrl: "https://store.private.blob.vercel-storage.com/private?download=1",
        pathname,
        contentDisposition: "attachment",
        cacheControl: "public, max-age=0",
        uploadedAt: new Date(),
        etag: '"etag-private"',
        contentType: "image/png",
        size: PNG_BYTES.length,
      },
    });

    const response = await GET(
      assetRequest("room_alpha", undefined, pathname),
      context(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-cache");
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG_BYTES);
    expect(mocks.getPrivateBlob).toHaveBeenCalledWith(pathname, {
      ifNoneMatch: undefined,
    });

    mocks.getPrivateBlob.mockClear();
    mocks.getCommittedPrivateBlobAsset.mockClear();
    const wrongRoom = await GET(
      assetRequest("room_beta", undefined, pathname),
      context("room_beta"),
    );
    expect(wrongRoom.status).toBe(404);
    expect(mocks.getCommittedPrivateBlobAsset).not.toHaveBeenCalled();
    expect(mocks.getPrivateBlob).not.toHaveBeenCalled();
  });

  it("fails closed for a valid but unregistered private Blob pathname", async () => {
    vi.stubEnv("JAZZBOARD_PRIVATE_READ_WRITE_TOKEN", "private-blob-token");
    const config = await (await GET(assetRequest("room_alpha"), context())).json();
    const pathname = `jazzboard/${config.uploadNamespace}/${ASSET_UUID}-unregistered.png`;

    const response = await GET(assetRequest("room_alpha", undefined, pathname), context());

    expect(response.status).toBe(404);
    expect(mocks.getCommittedPrivateBlobAsset).toHaveBeenCalledWith("room_alpha", pathname);
    expect(mocks.getPrivateBlob).not.toHaveBeenCalled();
  });

  it("finalizes an authenticated participant upload from provider head metadata", async () => {
    vi.stubEnv("JAZZBOARD_PRIVATE_READ_WRITE_TOKEN", "private-blob-token");
    const config = await (await GET(assetRequest("room_alpha"), context())).json();
    const pathname = `jazzboard/${config.uploadNamespace}/${ASSET_UUID}-finalize.png`;
    mocks.finalizePrivateBlobAsset.mockResolvedValue({
      pathname,
      roomId: "room_alpha",
      status: "committed",
    });

    const response = await POST(
      new Request("https://jazzboard.example/api/rooms/room_alpha/assets", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: "jazzboard_guest=signed" },
        body: JSON.stringify({
          type: "jazzboard.asset-finalize",
          payload: { pathname },
        }),
      }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(mocks.finalizePrivateBlobAsset).toHaveBeenCalledWith({
      pathname,
      roomId: "room_alpha",
    });
  });

  it("lets the signed provider callback finalize without a guest cookie", async () => {
    vi.stubEnv("JAZZBOARD_PRIVATE_READ_WRITE_TOKEN", "private-blob-token");
    const config = await (await GET(assetRequest("room_alpha"), context())).json();
    const pathname = `jazzboard/${config.uploadNamespace}/${ASSET_UUID}-callback.png`;
    mocks.requireGuestParticipantId.mockClear();
    mocks.handleUpload.mockImplementation(async (options) => {
      await options.onUploadCompleted({ blob: { pathname } });
      return { type: "blob.upload-completed", response: "ok" };
    });
    const callbackBody = {
      type: "blob.upload-completed",
      payload: { blob: { pathname }, tokenPayload: null },
    };

    const response = await POST(
      new Request("https://jazzboard.example/api/rooms/room_alpha/assets", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-vercel-signature": "provider-signature",
        },
        body: JSON.stringify(callbackBody),
      }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(mocks.requireGuestParticipantId).not.toHaveBeenCalled();
    expect(mocks.handleUpload).toHaveBeenCalledWith(
      expect.objectContaining({ body: callbackBody, token: "private-blob-token" }),
    );
    expect(mocks.finalizePrivateBlobAsset).toHaveBeenCalledWith({ pathname });
  });

  it("bounds the private Blob token-exchange JSON before invoking the provider", async () => {
    vi.stubEnv("JAZZBOARD_PRIVATE_READ_WRITE_TOKEN", "private-blob-token");
    const oversized = "x".repeat(1024 * 1024 + 1);
    const response = await POST(
      new Request("https://jazzboard.example/api/rooms/room_alpha/assets", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(oversized.length),
          cookie: "jazzboard_guest=signed",
        },
        body: oversized,
      }),
      context(),
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: { code: "REQUEST_TOO_LARGE" },
    });
    expect(mocks.handleUpload).not.toHaveBeenCalled();
  });

  it("rate-limits short-lived Blob capability grants before provider token issuance", async () => {
    vi.stubEnv("JAZZBOARD_PRIVATE_READ_WRITE_TOKEN", "private-blob-token");
    const config = await (await GET(assetRequest("room_alpha"), context())).json();
    const pathname = `jazzboard/${config.uploadNamespace}/${ASSET_UUID}-limited.png`;
    mocks.consumeAssetUploadGrant.mockResolvedValue({
      allowed: false,
      limit: 12,
      remaining: 0,
      retryAfterSeconds: 37,
    });
    const response = await POST(
      new Request("https://jazzboard.example/api/rooms/room_alpha/assets", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: "jazzboard_guest=signed" },
        body: JSON.stringify({
          type: "blob.generate-client-token",
          payload: { pathname, multipart: false, clientPayload: null },
        }),
      }),
      context(),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("37");
    expect(await response.json()).toMatchObject({
      error: { code: "ASSET_UPLOAD_RATE_LIMITED" },
    });
    expect(mocks.handleUpload).not.toHaveBeenCalled();
    expect(mocks.reservePrivateBlobAssetWithOutcome).not.toHaveBeenCalled();
  });

  it("releases a newly-created reservation when provider token generation fails", async () => {
    vi.stubEnv("JAZZBOARD_PRIVATE_READ_WRITE_TOKEN", "private-blob-token");
    const config = await (await GET(assetRequest("room_alpha"), context())).json();
    const pathname = `jazzboard/${config.uploadNamespace}/${ASSET_UUID}-provider-error.png`;
    mocks.handleUpload.mockRejectedValue(new Error("provider unavailable"));

    const response = await POST(
      new Request("https://jazzboard.example/api/rooms/room_alpha/assets", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: "jazzboard_guest=signed" },
        body: JSON.stringify({
          type: "blob.generate-client-token",
          payload: { pathname, multipart: false, clientPayload: null },
        }),
      }),
      context(),
    );

    expect(response.status).toBe(500);
    expect(mocks.deletePrivateBlobAssetRegistration).toHaveBeenCalledWith({
      pathname,
      expectedStatus: "reserved",
      expectedCreatedAt: expect.any(Number),
    });
  });

  it("does not release a pre-existing reservation when a retried token response fails", async () => {
    vi.stubEnv("JAZZBOARD_PRIVATE_READ_WRITE_TOKEN", "private-blob-token");
    const config = await (await GET(assetRequest("room_alpha"), context())).json();
    const pathname = `jazzboard/${config.uploadNamespace}/${ASSET_UUID}-retry-error.png`;
    mocks.reservePrivateBlobAssetWithOutcome.mockResolvedValue({
      registration: { status: "reserved", createdAt: 1_787_826_000_000 },
      created: false,
    });
    mocks.handleUpload.mockRejectedValue(new Error("provider unavailable"));

    await POST(
      new Request("https://jazzboard.example/api/rooms/room_alpha/assets", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: "jazzboard_guest=signed" },
        body: JSON.stringify({
          type: "blob.generate-client-token",
          payload: { pathname, multipart: false, clientPayload: null },
        }),
      }),
      context(),
    );

    expect(mocks.deletePrivateBlobAssetRegistration).not.toHaveBeenCalled();
  });

  it("fails deployed uploads closed when Blob is disconnected and fallback is not explicitly enabled", async () => {
    vi.stubEnv("JAZZBOARD_ALLOW_REDIS_ASSET_FALLBACK", "");

    const configResponse = await GET(assetRequest("room_alpha"), context());
    const uploadResponse = await POST(
      multipartRequest("room_alpha", new File([PNG_BYTES], "pixel.png", { type: "image/png" })),
      context(),
    );

    expect(await configResponse.json()).toEqual({
      ok: true,
      mode: "unavailable",
      maximumSizeInBytes: 0,
    });
    expect(uploadResponse.status).toBe(503);
    expect(await uploadResponse.json()).toMatchObject({
      ok: false,
      error: { code: "ASSET_STORAGE_UNAVAILABLE" },
    });
    expect(mocks.putRedisRoomAsset).not.toHaveBeenCalled();
    expect(mocks.handleUpload).not.toHaveBeenCalled();
  });

  it("rejects an oversized declared fallback multipart request before parsing it", async () => {
    const response = await POST(
      new Request("https://jazzboard.example/api/rooms/room_alpha/assets", {
        method: "POST",
        headers: {
          "content-type": "multipart/form-data; boundary=jazzboard-test",
          "content-length": String(FOUR_MIB + MULTIPART_ALLOWANCE + 1),
          cookie: "jazzboard_guest=signed",
        },
        body: "--jazzboard-test--\r\n",
      }),
      context(),
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: {
        code: "REQUEST_TOO_LARGE",
        details: { maximumBytes: FOUR_MIB + MULTIPART_ALLOWANCE },
      },
    });
    expect(mocks.putRedisRoomAsset).not.toHaveBeenCalled();
  });

  it("bounds the actual fallback stream when extra multipart fields omit a reliable total", async () => {
    const formData = new FormData();
    formData.set("file", new File([PNG_BYTES], "pixel.png", { type: "image/png" }));
    formData.set("extra", "x".repeat(FOUR_MIB + MULTIPART_ALLOWANCE));
    const request = new Request("https://jazzboard.example/api/rooms/room_alpha/assets", {
      method: "POST",
      headers: { cookie: "jazzboard_guest=signed" },
      body: formData,
    });
    expect(request.headers.get("content-length")).toBeNull();

    const response = await POST(request, context());

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: { code: "REQUEST_TOO_LARGE" },
    });
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
      url: "/api/rooms/room_alpha/assets?assetId=asset_redis",
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
    expect(response.headers.get("content-disposition")).toBe(
      'inline; filename="pixel.png"; filename*=UTF-8\'\'pixel.png',
    );
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG_BYTES);
    expect(mocks.requireGuestParticipantId).toHaveBeenCalledOnce();
    expect(mocks.readAuthorizedRoom).toHaveBeenCalledWith("room_alpha", "p_member");
    expect(mocks.getRedisRoomAsset).toHaveBeenCalledWith("room_alpha", "asset_redis");
  });

  it("keeps legacy Redis image URLs readable after Blob becomes the primary write path", async () => {
    vi.stubEnv("JAZZBOARD_PRIVATE_READ_WRITE_TOKEN", "blob-token");
    mocks.getRedisRoomAsset.mockResolvedValue({
      name: "legacy.png",
      mimeType: "image/png",
      bytes: PNG_BYTES,
    });

    const response = await GET(assetRequest("room_alpha", "asset_redis"), context());

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG_BYTES);
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

  it("serves Unicode filenames with an ASCII-safe header and UTF-8 filename parameter", async () => {
    mocks.getRedisRoomAsset.mockResolvedValue({
      name: "diagram-🎷.png",
      mimeType: "image/png",
      bytes: PNG_BYTES,
    });

    const response = await GET(assetRequest("room_alpha", "asset_unicode"), context());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe(
      'inline; filename="diagram-__.png"; filename*=UTF-8\'\'diagram-%F0%9F%8E%B7.png',
    );
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
      label: "scriptable SVG images",
      file: () => new File(["<svg/>"], "vector.svg", { type: "image/svg+xml" }),
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
