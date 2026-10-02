import { afterEach, describe, expect, it, vi } from "vitest";

import { GUEST_BOOTSTRAP_HEADER } from "@/lib/guest-bootstrap";
import { apiRequest } from "./api";

function installLocks() {
  let tail = Promise.resolve();
  const request = vi.fn((_name: string, options: LockOptions, callback: () => Promise<unknown>) => {
    const result = tail.then(() => {
      if (options.signal?.aborted) throw new DOMException("Cancelled before entry", "AbortError");
      return callback();
    });
    tail = result.then(() => undefined, () => undefined);
    return result;
  });
  vi.stubGlobal("navigator", { locks: { request } });
  return request;
}

const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200 });
afterEach(() => vi.unstubAllGlobals());

describe("same-origin guest session coordination", () => {
  it("keeps a second bootstrap request queued until the first response completes", async () => {
    const requestLock = installLocks();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const fetchMock = vi.fn(async () => {
      if (fetchMock.mock.calls.length === 1) await gate;
      return ok();
    });
    vi.stubGlobal("fetch", fetchMock);
    const first = apiRequest("/api/rooms", { method: "POST", body: '{"action":"create"}' });
    const second = apiRequest("/api/rooms", { method: "POST", body: '{"action":"join"}' });
    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(requestLock).toHaveBeenCalledTimes(2);
      expect(requestLock.mock.calls[0][0]).toBe(requestLock.mock.calls[1][0]);
    } finally { finish(); await Promise.all([first, second]); }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retains the lock and request identity across an ambiguous retry", async () => {
    const requestLock = installLocks();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const identities: Array<{ key: string | null; proof: string | null }> = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      identities.push({ key: headers.get("idempotency-key"), proof: headers.get(GUEST_BOOTSTRAP_HEADER) });
      if (identities.length === 1) throw new TypeError("Synthetic lost response");
      if (identities.length === 2) await gate;
      return ok();
    });
    vi.stubGlobal("fetch", fetchMock);
    const first = apiRequest("/api/rooms", { method: "POST", body: "{}" });
    const second = apiRequest("/api/rooms", { method: "POST", body: "{}" });
    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      expect(identities[1]).toEqual(identities[0]);
      expect(requestLock).toHaveBeenCalledTimes(2);
    } finally { finish(); await Promise.all([first, second]); }
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(identities[2].key).not.toBe(identities[0].key);
  });

  it("never dispatches a cancelled queued room entry and releases the queue", async () => {
    installLocks();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const fetchMock = vi.fn(async () => {
      if (fetchMock.mock.calls.length === 1) await gate;
      return ok();
    });
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const first = apiRequest("/api/rooms", { method: "POST", body: "{}" });
    const cancelled = apiRequest("/api/rooms", { method: "POST", body: "{}", signal: controller.signal });
    const rejected = expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
      controller.abort();
    } finally { finish(); await first; }
    await rejected;
    expect(fetchMock).toHaveBeenCalledOnce();
    await apiRequest("/api/rooms", { method: "POST", body: "{}" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not coordinate reads, other mutations or other origins", async () => {
    const requestLock = installLocks();
    const fetchMock = vi.fn(async () => ok());
    vi.stubGlobal("fetch", fetchMock);
    await apiRequest("/api/rooms");
    await apiRequest("/api/rooms/room-a/commands", { method: "POST", body: "{}" });
    await apiRequest("https://example.invalid/api/rooms", { method: "POST", body: "{}" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(requestLock).not.toHaveBeenCalled();
  });

  it("still permits entry when browser policy blocks the lock-manager getter", async () => {
    const blockedNavigator = Object.defineProperty({}, "locks", { get() {
      throw new DOMException("Synthetic blocked getter", "SecurityError");
    } });
    vi.stubGlobal("navigator", blockedNavigator);
    const fetchMock = vi.fn(async () => ok());
    vi.stubGlobal("fetch", fetchMock);
    await apiRequest("/api/rooms", { method: "POST", body: "{}" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
