// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ cleanupPrivateBlobAssets: vi.fn() }));

vi.mock("@/lib/server/blob-asset-cleanup", () => ({
  cleanupPrivateBlobAssets: mocks.cleanupPrivateBlobAssets,
}));

import { GET } from "./route";

describe("private Blob cleanup cron route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("CRON_SECRET", "a-long-cron-secret");
    mocks.cleanupPrivateBlobAssets.mockResolvedValue({ deletedRegistered: 2 });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("runs only with the exact Vercel cron bearer secret", async () => {
    const response = await GET(
      new Request("https://jazzboard.example/api/cron/assets/cleanup", {
        headers: { authorization: "Bearer a-long-cron-secret" },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      summary: { deletedRegistered: 2 },
    });
    expect(mocks.cleanupPrivateBlobAssets).toHaveBeenCalledOnce();
  });

  it.each([
    ["missing", undefined],
    ["wrong", "Bearer wrong-secret"],
    ["wrong scheme", "Basic a-long-cron-secret"],
  ])("rejects %s authorization", async (_label, authorization) => {
    const headers = authorization ? { authorization } : undefined;
    const response = await GET(
      new Request("https://jazzboard.example/api/cron/assets/cleanup", { headers }),
    );
    expect(response.status).toBe(401);
    expect(mocks.cleanupPrivateBlobAssets).not.toHaveBeenCalled();
  });

  it("fails closed when the deployment secret is missing", async () => {
    vi.stubEnv("CRON_SECRET", "");
    const response = await GET(
      new Request("https://jazzboard.example/api/cron/assets/cleanup", {
        headers: { authorization: "Bearer a-long-cron-secret" },
      }),
    );
    expect(response.status).toBe(401);
    expect(mocks.cleanupPrivateBlobAssets).not.toHaveBeenCalled();
  });
});
