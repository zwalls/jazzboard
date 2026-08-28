// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@vercel/blob", () => ({
  get: vi.fn(async () => null),
}));

import { GET } from "./route";

describe("deployment health asset storage", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reports Redis-backed assets as operational but degraded when Blob is unavailable", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("REDIS_URL", "redis://example.test:6379");
    vi.stubEnv("JAZZBOARD_PRIVATE_READ_WRITE_TOKEN", "");
    vi.stubEnv("JAZZBOARD_BLOB_ACCESS", "");
    vi.stubEnv("JAZZBOARD_ALLOW_REDIS_ASSET_FALLBACK", "1");
    vi.stubEnv("SESSION_SECRET", "s".repeat(32));
    vi.stubEnv("CRON_SECRET", "c".repeat(32));

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      environment: "production",
      realtime: "vercel-websocket+redis-streams",
      assets: "redis-fallback",
      synchronization: {
        storage: "redis-three-plane-v3",
        documentRevision: "roomRevision",
        aggregateRevision: "stateRevision",
        mutationIdempotency: "participant-scoped-24h-receipts",
      },
      capacity: { mode: "warn", limits: { objects: 5_000, participants: 128 } },
      canvasRenderer: { id: "jazzboard-semantic-v1", ownership: "first-party" },
      checks: {
        redis: true,
        blob: false,
        blobPrivate: false,
        assetStorage: true,
        sessionSecret: true,
        cronSecret: true,
      },
      missing: [],
      warnings: ["blob"],
    });
  });

  it("keeps Blob as the preferred asset mode when both Blob and Redis are configured", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("REDIS_URL", "redis://example.test:6379");
    vi.stubEnv("JAZZBOARD_PRIVATE_READ_WRITE_TOKEN", "blob-token");
    vi.stubEnv("JAZZBOARD_BLOB_ACCESS", "private");
    vi.stubEnv("SESSION_SECRET", "s".repeat(32));
    vi.stubEnv("CRON_SECRET", "c".repeat(32));

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      assets: "vercel-blob",
      canvasRenderer: { id: "jazzboard-semantic-v1", ownership: "first-party" },
      checks: { redis: true, blob: true, blobPrivate: true, assetStorage: true },
      missing: [],
      warnings: [],
    });
  });

  it("does not misreport Blob as missing when the session secret is absent", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("REDIS_URL", "redis://example.test:6379");
    vi.stubEnv("JAZZBOARD_PRIVATE_READ_WRITE_TOKEN", "");
    vi.stubEnv("JAZZBOARD_BLOB_ACCESS", "");
    vi.stubEnv("JAZZBOARD_ALLOW_REDIS_ASSET_FALLBACK", "1");
    vi.stubEnv("SESSION_SECRET", "");
    vi.stubEnv("CRON_SECRET", "c".repeat(32));

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      ok: false,
      assets: "redis-fallback",
      canvasRenderer: { id: "jazzboard-semantic-v1", ownership: "first-party" },
      checks: { assetStorage: true },
      missing: ["sessionSecret"],
      warnings: ["blob"],
    });
    expect(body.missing).not.toContain("blob");
    expect(body.missing).not.toContain("assetStorage");
  });

  it("reports missing deployed asset storage when Blob is disconnected and fallback is not enabled", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("REDIS_URL", "redis://example.test:6379");
    vi.stubEnv("JAZZBOARD_PRIVATE_READ_WRITE_TOKEN", "");
    vi.stubEnv("JAZZBOARD_BLOB_ACCESS", "");
    vi.stubEnv("JAZZBOARD_ALLOW_REDIS_ASSET_FALLBACK", "");
    vi.stubEnv("SESSION_SECRET", "s".repeat(32));
    vi.stubEnv("CRON_SECRET", "c".repeat(32));

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      ok: false,
      assets: "unavailable",
      checks: { redis: true, blob: false, assetStorage: false },
      missing: ["assetStorage"],
      warnings: [],
    });
  });

  it("fails closed when a Blob token exists without the private-store assertion", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("REDIS_URL", "redis://example.test:6379");
    vi.stubEnv("JAZZBOARD_PRIVATE_READ_WRITE_TOKEN", "public-store-token");
    vi.stubEnv("JAZZBOARD_BLOB_ACCESS", "");
    vi.stubEnv("JAZZBOARD_ALLOW_REDIS_ASSET_FALLBACK", "");
    vi.stubEnv("SESSION_SECRET", "s".repeat(32));
    vi.stubEnv("CRON_SECRET", "c".repeat(32));

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      ok: false,
      assets: "unavailable",
      checks: { blob: false, blobPrivate: false, assetStorage: false },
      missing: ["assetStorage"],
    });
  });

  it("requires the cleanup credential in production but not preview", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("REDIS_URL", "redis://example.test:6379");
    vi.stubEnv("JAZZBOARD_PRIVATE_READ_WRITE_TOKEN", "blob-token");
    vi.stubEnv("JAZZBOARD_BLOB_ACCESS", "private");
    vi.stubEnv("SESSION_SECRET", "s".repeat(32));
    vi.stubEnv("CRON_SECRET", "");

    const production = await GET();
    expect(production.status).toBe(503);
    expect(await production.json()).toMatchObject({ missing: ["cronSecret"] });

    vi.stubEnv("VERCEL_ENV", "preview");
    const preview = await GET();
    expect(preview.status).toBe(200);
  });
});
