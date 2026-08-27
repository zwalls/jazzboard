import { afterEach, describe, expect, it, vi } from "vitest";

import { GUEST_BOOTSTRAP_HEADER } from "@/lib/guest-bootstrap";
import {
  CLIENT_CAPABILITIES_HEADER,
  SPLIT_STATE_CLIENT_CAPABILITY,
} from "@/lib/realtime/protocol";

import { apiRequest } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("apiRequest mutation identity", () => {
  it("advertises split-state support on authoritative reads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        expect(new Headers(init?.headers).get(CLIENT_CAPABILITIES_HEADER)).toBe(
          SPLIT_STATE_CLIENT_CAPABILITY,
        );
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );

    await apiRequest("/api/rooms/room-a");
  });

  it("adds one valid idempotency key to a mutating request", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("idempotency-key")).toMatch(/^[a-f0-9-]{36}$/);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await apiRequest("/api/rooms/room-a/commands", {
      method: "POST",
      body: JSON.stringify({ command: { type: "delete", targets: [] } }),
    });

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("preserves a caller-supplied key and leaves reads unkeyed", async () => {
    const seen: Array<string | null> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        seen.push(new Headers(init?.headers).get("idempotency-key"));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );

    await apiRequest("/api/read");
    await apiRequest("/api/write", {
      method: "PATCH",
      headers: { "idempotency-key": "logical-mutation-0001" },
      body: "{}",
    });

    expect(seen).toEqual([null, "logical-mutation-0001"]);
  });

  it("reuses the exact key for one bounded ambiguous transport retry", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        seen.push(new Headers(init?.headers).get("idempotency-key")!);
        if (seen.length === 1) throw new TypeError("connection reset after send");
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );

    await apiRequest("/api/rooms/room-a/commands", {
      method: "POST",
      body: "{}",
    });

    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe(seen[0]);
  });

  it("reuses one high-entropy guest bootstrap proof with the room idempotency key", async () => {
    const seen: Array<{ idempotency: string | null; bootstrap: string | null }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        seen.push({
          idempotency: headers.get("idempotency-key"),
          bootstrap: headers.get(GUEST_BOOTSTRAP_HEADER),
        });
        if (seen.length === 1) throw new TypeError("response lost after commit");
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );

    await apiRequest("/api/rooms", {
      method: "POST",
      body: JSON.stringify({ action: "create", displayName: "Maya" }),
    });

    expect(seen).toHaveLength(2);
    expect(seen[0].idempotency).toMatch(/^[a-f0-9-]{36}$/);
    expect(seen[0].bootstrap).toMatch(/^gb1_[0-9a-z]{8,12}_[a-f0-9]{64}$/);
    expect(seen[1]).toEqual(seen[0]);
  });

  it("does not disclose a guest bootstrap proof to other routes or origins", async () => {
    const seen: Array<string | null> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        seen.push(new Headers(init?.headers).get(GUEST_BOOTSTRAP_HEADER));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );

    await apiRequest("/api/rooms/room-a/commands", { method: "POST", body: "{}" });
    await apiRequest("https://example.invalid/api/rooms", { method: "POST", body: "{}" });

    expect(seen).toEqual([null, null]);
  });

  it("retries an interrupted response body with the same bootstrap identity", async () => {
    const seen: Array<{ idempotency: string | null; bootstrap: string | null }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        seen.push({
          idempotency: headers.get("idempotency-key"),
          bootstrap: headers.get(GUEST_BOOTSTRAP_HEADER),
        });
        if (seen.length === 1) {
          return {
            ok: true,
            status: 200,
            json: async () => {
              throw new TypeError("response body stream terminated");
            },
          } as unknown as Response;
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );

    await apiRequest("/api/rooms", { method: "POST", body: "{}" });

    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual(seen[0]);
  });
});
