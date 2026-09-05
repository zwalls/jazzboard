import { afterEach, describe, expect, it, vi } from "vitest";

import type { RippleBody } from "./ripple-renderer";
import type { RippleWorkerRequest, RippleWorkerResponse } from "./ripple-renderer.worker";
import {
  requestRippleBody,
  resetRippleCacheForTests,
  rippleCacheInfo,
  rippleRasterSize,
} from "./ripple-body-cache";

class FakeWorker {
  onmessage: ((event: MessageEvent<RippleWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  requests: RippleWorkerRequest[] = [];
  terminate = vi.fn();

  postMessage(request: RippleWorkerRequest) {
    this.requests.push(request);
  }

  respond(index: number, body = fakeBody(this.requests[index].name, this.requests[index].size)) {
    const request = this.requests[index];
    this.onmessage?.({
      data: {
        id: request.id,
        body: { ...body, data: body.data.buffer },
      },
    } as MessageEvent<RippleWorkerResponse>);
  }
}

function fakeBody(name: string, size: number): RippleBody {
  return {
    name,
    width: size,
    height: size,
    data: new Uint8ClampedArray(size * size * 4),
    eyeGeometry: {
      centersX: [-0.12, 0.12],
      centerY: 0.1,
      halfWidth: 0.047,
      halfHeight: 0.14,
      cornerRadius: 0.043,
      maxLookOffset: 0.027,
    },
  };
}

afterEach(() => {
  resetRippleCacheForTests();
});

describe("ripple body cache", () => {
  it("deduplicates pending work and reuses the completed body", async () => {
    const worker = new FakeWorker();
    resetRippleCacheForTests(() => worker);

    const first = requestRippleBody("Mira", 64);
    const duplicate = requestRippleBody("Mira", 64);
    expect(duplicate).toBe(first);
    expect(worker.requests).toHaveLength(1);

    worker.respond(0);
    const rendered = await first;
    expect(await duplicate).toBe(rendered);
    expect(await requestRippleBody("Mira", 64)).toBe(rendered);
    expect(worker.requests).toHaveLength(1);
    expect(rippleCacheInfo()).toMatchObject({ entries: 1, pending: 0 });
  });

  it("resolves safely and disables enhancement when worker posting fails", async () => {
    const worker = new FakeWorker();
    worker.postMessage = () => {
      throw new Error("worker unavailable");
    };
    resetRippleCacheForTests(() => worker);

    await expect(requestRippleBody("Mira", 64)).resolves.toBeNull();
    expect(rippleCacheInfo()).toMatchObject({ pending: 0, unavailable: true });
    await expect(requestRippleBody("Kai", 64)).resolves.toBeNull();
  });

  it("bounds retained entries and chooses reusable DPR-aware raster buckets", async () => {
    const worker = new FakeWorker();
    resetRippleCacheForTests(() => worker);
    for (let index = 0; index < 33; index += 1) {
      const pending = requestRippleBody(`Agent ${index}`, 64);
      worker.respond(index);
      await pending;
    }

    expect(rippleCacheInfo()).toMatchObject({ entries: 32, maxEntries: 32 });
    expect(rippleRasterSize(32, 2)).toBe(64);
    expect(rippleRasterSize(63, 2)).toBe(128);
    expect(rippleRasterSize(120, 2)).toBe(192);

    const byteWorker = new FakeWorker();
    resetRippleCacheForTests(() => byteWorker);
    for (let index = 0; index < 30; index += 1) {
      const pending = requestRippleBody(`Large agent ${index}`, 192);
      byteWorker.respond(index);
      await pending;
    }
    const cache = rippleCacheInfo();
    expect(cache.bytes).toBeLessThanOrEqual(cache.maxBytes);
    expect(cache.entries).toBeLessThan(30);
  });
});
