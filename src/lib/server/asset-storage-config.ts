import { get } from "@vercel/blob";
import { createHash } from "node:crypto";

import type { AssetStorageMode } from "@/lib/assets/policy";
export { roomBlobNamespace } from "@/lib/assets/private";

export type AssetStorageStatus = {
  mode: AssetStorageMode;
  blobConfigured: boolean;
  blobPrivateConfigured: boolean;
  redisFallbackEnabled: boolean;
};

type AssetStorageEnvironment = {
  JAZZBOARD_PRIVATE_READ_WRITE_TOKEN?: string;
  JAZZBOARD_BLOB_ACCESS?: string;
  JAZZBOARD_ALLOW_REDIS_ASSET_FALLBACK?: string;
  REDIS_URL?: string;
  VERCEL?: string;
};

type PrivateBlobProbeCacheEntry =
  | { expiresAt: number; value: boolean; inFlight?: never }
  | { expiresAt: number; value?: never; inFlight: Promise<boolean> };

const PRIVATE_BLOB_PROBE_SUCCESS_TTL_MS = 60_000;
const PRIVATE_BLOB_PROBE_FAILURE_TTL_MS = 10_000;
const PRIVATE_BLOB_PROBE_CACHE_MAX_ENTRIES = 8;

declare global {
  var __jazzboardPrivateBlobProbeCache:
    | Map<string, PrivateBlobProbeCacheEntry>
    | undefined;
}

function privateBlobProbeCache(): Map<string, PrivateBlobProbeCacheEntry> {
  globalThis.__jazzboardPrivateBlobProbeCache ??= new Map();
  return globalThis.__jazzboardPrivateBlobProbeCache;
}

function privateBlobProbeFingerprint(token: string): string {
  return createHash("sha256")
    .update(`jazzboard:private-blob-probe:v1\0${token}`)
    .digest("hex");
}

function prunePrivateBlobProbeCache(
  cache: Map<string, PrivateBlobProbeCacheEntry>,
  now: number,
): void {
  for (const [key, entry] of cache) {
    if (!entry.inFlight && entry.expiresAt <= now) cache.delete(key);
  }
  while (cache.size > PRIVATE_BLOB_PROBE_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    cache.delete(oldestKey);
  }
}

async function executePrivateBlobProbe(token: string): Promise<boolean> {
  try {
    const result = await get("jazzboard/__health__/private-store-probe-do-not-create", {
      access: "private",
      token,
      useCache: false,
      abortSignal: AbortSignal.timeout(3_000),
    });
    await result?.stream?.cancel();
    return true;
  } catch {
    return false;
  }
}

export function resetPrivateBlobProbeCacheForTests(): void {
  globalThis.__jazzboardPrivateBlobProbeCache = undefined;
}

export function privateBlobToken(
  environment: AssetStorageEnvironment = process.env as AssetStorageEnvironment,
): string | undefined {
  const token = environment.JAZZBOARD_PRIVATE_READ_WRITE_TOKEN?.trim();
  return token || undefined;
}

function configured(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

/**
 * Vercel Blob is the only normal deployed write path. Redis remains available
 * behind an explicit emergency flag so an operator can recover uploads without
 * changing code, and so previously issued Redis asset URLs stay readable.
 */
export function assetStorageStatus(
  environment: AssetStorageEnvironment = process.env as AssetStorageEnvironment,
): AssetStorageStatus {
  const blobTokenConfigured = Boolean(privateBlobToken(environment));
  const blobPrivateConfigured = environment.JAZZBOARD_BLOB_ACCESS === "private";
  // A token alone is insufficient: Vercel supports both public and private
  // stores, while Jazzboard persists only authenticated proxy URLs. Require an
  // explicit deployment marker so an accidentally connected public store fails
  // closed instead of being reported healthy.
  const blobConfigured = blobTokenConfigured && blobPrivateConfigured;
  const deployed = environment.VERCEL === "1";
  const redisFallbackEnabled =
    deployed &&
    configured(environment.REDIS_URL) &&
    environment.JAZZBOARD_ALLOW_REDIS_ASSET_FALLBACK === "1";

  return {
    mode: blobConfigured
      ? "vercel-blob"
      : redisFallbackEnabled
        ? "redis-fallback"
        : deployed
          ? "unavailable"
          : "local-memory",
    blobConfigured,
    blobPrivateConfigured,
    redisFallbackEnabled,
  };
}

/**
 * Probes a guaranteed-missing path using a private read. Public-store tokens
 * reject the `access: private` request, while a correctly connected private
 * store returns `null` without creating or mutating any provider object.
 */
export async function probePrivateBlobStorage(
  environment: AssetStorageEnvironment = process.env as AssetStorageEnvironment,
): Promise<boolean> {
  const token = privateBlobToken(environment);
  if (!token || environment.JAZZBOARD_BLOB_ACCESS !== "private") return false;
  const now = Date.now();
  const fingerprint = privateBlobProbeFingerprint(token);
  const cache = privateBlobProbeCache();
  const cached = cache.get(fingerprint);
  if (cached?.inFlight) return cached.inFlight;
  if (cached && cached.expiresAt > now) return cached.value;
  if (cached) cache.delete(fingerprint);

  const inFlight = executePrivateBlobProbe(token).then((value) => {
    const current = cache.get(fingerprint);
    if (current?.inFlight === inFlight) {
      cache.set(fingerprint, {
        value,
        expiresAt:
          Date.now() +
          (value ? PRIVATE_BLOB_PROBE_SUCCESS_TTL_MS : PRIVATE_BLOB_PROBE_FAILURE_TTL_MS),
      });
      prunePrivateBlobProbeCache(cache, Date.now());
    }
    return value;
  });
  cache.set(fingerprint, { inFlight, expiresAt: Number.POSITIVE_INFINITY });
  prunePrivateBlobProbeCache(cache, now);
  return inFlight;
}
