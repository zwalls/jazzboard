// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";

describe("deployment health asset storage", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reports Redis-backed assets as operational but degraded when Blob is unavailable", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("REDIS_URL", "redis://example.test:6379");
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    vi.stubEnv("SESSION_SECRET", "s".repeat(32));

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      environment: "production",
      realtime: "vercel-websocket+redis-streams",
      assets: "redis-fallback",
      tldraw: { version: "3.15.6", licenseMode: "built-in-watermark" },
      checks: {
        redis: true,
        blob: false,
        assetStorage: true,
        sessionSecret: true,
      },
      missing: [],
      warnings: ["blob"],
    });
  });

  it("keeps Blob as the preferred asset mode when both Blob and Redis are configured", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("REDIS_URL", "redis://example.test:6379");
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "blob-token");
    vi.stubEnv("SESSION_SECRET", "s".repeat(32));

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      assets: "vercel-blob",
      tldraw: { version: "3.15.6", licenseMode: "built-in-watermark" },
      checks: { redis: true, blob: true, assetStorage: true },
      missing: [],
      warnings: [],
    });
  });

  it("does not require a key for watermarked tldraw and does not misreport Blob as missing", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("REDIS_URL", "redis://example.test:6379");
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    vi.stubEnv("SESSION_SECRET", "");
    vi.stubEnv("NEXT_PUBLIC_TLDRAW_LICENSE_KEY", "");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      ok: false,
      assets: "redis-fallback",
      tldraw: { version: "3.15.6", licenseMode: "built-in-watermark" },
      checks: { assetStorage: true },
      missing: ["sessionSecret"],
      warnings: ["blob"],
    });
    expect(body.missing).not.toContain("blob");
    expect(body.missing).not.toContain("assetStorage");
  });
});
