// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

import { DomainError } from "@/lib/domain/errors";

const mocks = vi.hoisted(() => ({ readPublicSnapshot: vi.fn() }));

vi.mock("@/lib/server/snapshot-service", () => ({
  createReadonlySnapshot: vi.fn(),
  listReadonlySnapshots: vi.fn(),
  revokeReadonlySnapshot: vi.fn(),
  readPublicSnapshot: mocks.readPublicSnapshot,
}));

import { GET } from "./route";

const token = "A".repeat(43);
const context = { params: Promise.resolve({ token }) };

describe("public snapshot route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readPublicSnapshot.mockResolvedValue({
      title: "Frozen architecture",
      createdAt: 1,
      expiresAt: 2,
      creator: { displayName: "Maya", kind: "agent" },
      artifact: { kind: "snapshot", objects: [], diagrams: [] },
    });
  });

  it("returns only the privacy-safe public projection with non-cacheable indexing headers", async () => {
    const response = await GET(
      new Request(`https://jazzboard.example/api/snapshots/${token}`),
      context,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
    expect(await response.json()).toEqual({
      ok: true,
      snapshot: {
        title: "Frozen architecture",
        createdAt: 1,
        expiresAt: 2,
        creator: { displayName: "Maya", kind: "agent" },
        artifact: { kind: "snapshot", objects: [], diagrams: [] },
      },
    });
    expect(mocks.readPublicSnapshot).toHaveBeenCalledWith(token);
  });

  it("returns the same generic 404 for invalid, expired, or revoked tokens", async () => {
    mocks.readPublicSnapshot.mockRejectedValue(
      new DomainError("SNAPSHOT_NOT_FOUND", "That snapshot is unavailable."),
    );

    const response = await GET(
      new Request("https://jazzboard.example/api/snapshots/not-a-token"),
      { params: Promise.resolve({ token: "not-a-token" }) },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      ok: false,
      error: {
        code: "SNAPSHOT_NOT_FOUND",
        message: "That snapshot is unavailable.",
        details: null,
      },
    });
  });
});
