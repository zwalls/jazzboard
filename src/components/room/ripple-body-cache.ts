import type { RippleBody } from "./ripple-renderer";
import type { RippleWorkerRequest, RippleWorkerResponse } from "./ripple-renderer.worker";

const MAX_CACHE_BYTES = 4 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 32;
const MAX_PENDING_REQUESTS = 64;
const RASTER_BUCKETS = [64, 96, 128, 192] as const;

type PendingRequest = {
  key: string;
  resolve: (body: RippleBody | null) => void;
};

type WorkerLike = Pick<Worker, "postMessage" | "terminate"> & {
  onmessage: ((event: MessageEvent<RippleWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
};

type WorkerFactory = () => WorkerLike;

const cache = new Map<string, RippleBody>();
const pendingByKey = new Map<string, Promise<RippleBody | null>>();
const requestsById = new Map<number, PendingRequest>();
let cacheBytes = 0;
let nextRequestId = 1;
let worker: WorkerLike | null = null;
let workerUnavailable = false;
let workerFactory: WorkerFactory = () =>
  new Worker(new URL("./ripple-renderer.worker.ts", import.meta.url), { type: "module" });

function cacheKey(name: string, size: number) {
  return `${name}\u0000${size}`;
}

function readCache(key: string) {
  const body = cache.get(key);
  if (!body) return null;
  cache.delete(key);
  cache.set(key, body);
  return body;
}

function writeCache(key: string, body: RippleBody) {
  const existing = cache.get(key);
  if (existing) cacheBytes -= existing.data.byteLength;
  cache.delete(key);
  cache.set(key, body);
  cacheBytes += body.data.byteLength;
  while (cache.size > MAX_CACHE_ENTRIES || cacheBytes > MAX_CACHE_BYTES) {
    const oldestKey = cache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    const oldest = cache.get(oldestKey);
    cache.delete(oldestKey);
    if (oldest) cacheBytes -= oldest.data.byteLength;
  }
}

function failWorker() {
  workerUnavailable = true;
  worker?.terminate();
  worker = null;
  for (const { key, resolve } of requestsById.values()) {
    pendingByKey.delete(key);
    resolve(null);
  }
  requestsById.clear();
}

function sharedWorker() {
  if (workerUnavailable) return null;
  if (worker) return worker;
  try {
    worker = workerFactory();
    worker.onmessage = (event) => {
      const pending = requestsById.get(event.data.id);
      if (!pending) return;
      requestsById.delete(event.data.id);
      pendingByKey.delete(pending.key);
      if ("error" in event.data) {
        pending.resolve(null);
        return;
      }
      try {
        const body: RippleBody = {
          ...event.data.body,
          data: new Uint8ClampedArray(event.data.body.data),
        };
        writeCache(pending.key, body);
        pending.resolve(body);
      } catch {
        pending.resolve(null);
      }
    };
    worker.onerror = failWorker;
    worker.onmessageerror = failWorker;
    return worker;
  } catch {
    failWorker();
    return null;
  }
}

export function rippleRasterSize(cssSize: number, devicePixelRatio = 1) {
  const desired = Math.max(16, cssSize) * Math.min(Math.max(devicePixelRatio, 1), 2);
  return RASTER_BUCKETS.find((bucket) => bucket >= desired) ?? 192;
}

export function requestRippleBody(name: string, size: number) {
  const key = cacheKey(name, size);
  const cached = readCache(key);
  if (cached) return Promise.resolve(cached);
  const pending = pendingByKey.get(key);
  if (pending) return pending;
  if (pendingByKey.size >= MAX_PENDING_REQUESTS) return Promise.resolve(null);
  const activeWorker = sharedWorker();
  if (!activeWorker) return Promise.resolve(null);
  const id = nextRequestId++;
  let resolveRequest: (body: RippleBody | null) => void = () => undefined;
  const promise = new Promise<RippleBody | null>((resolve) => {
    resolveRequest = resolve;
  });
  requestsById.set(id, { key, resolve: resolveRequest });
  pendingByKey.set(key, promise);
  try {
    const request: RippleWorkerRequest = { id, name, size };
    activeWorker.postMessage(request);
  } catch {
    failWorker();
  }
  return promise;
}

export function rippleCacheInfo() {
  return {
    bytes: cacheBytes,
    entries: cache.size,
    maxBytes: MAX_CACHE_BYTES,
    maxEntries: MAX_CACHE_ENTRIES,
    pending: pendingByKey.size,
    unavailable: workerUnavailable,
  };
}

export function resetRippleCacheForTests(factory?: WorkerFactory) {
  worker?.terminate();
  worker = null;
  workerUnavailable = false;
  workerFactory = factory ?? (() =>
    new Worker(new URL("./ripple-renderer.worker.ts", import.meta.url), { type: "module" }));
  cache.clear();
  pendingByKey.clear();
  requestsById.clear();
  cacheBytes = 0;
  nextRequestId = 1;
}
