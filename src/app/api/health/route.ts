import { json } from "@/lib/server/http";
import {
  assetStorageStatus,
  probePrivateBlobStorage,
} from "@/lib/server/asset-storage-config";
import { capacityModeFromEnvironment, DEFAULT_CAPACITY_LIMITS } from "@/lib/server/capacity";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const deployed = process.env.VERCEL === "1";
  const production = deployed && process.env.VERCEL_ENV === "production";
  const storage = assetStorageStatus();
  const privateBlobOperational =
    storage.mode === "vercel-blob" && (await probePrivateBlobStorage());
  const effectiveAssetMode =
    storage.mode === "vercel-blob" && !privateBlobOperational
      ? "unavailable"
      : storage.mode;
  const checks = {
    redis: Boolean(process.env.REDIS_URL),
    blob: privateBlobOperational,
    blobConfigured: storage.blobConfigured,
    blobPrivate: privateBlobOperational,
    sessionSecret: Boolean(process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32),
    cronSecret: Boolean(process.env.CRON_SECRET && process.env.CRON_SECRET.length >= 32),
  };
  const assetStorage = effectiveAssetMode !== "unavailable";
  const missing = deployed
    ? [
        ...(checks.redis ? [] : ["redis"]),
        ...(checks.sessionSecret ? [] : ["sessionSecret"]),
        ...(assetStorage ? [] : ["assetStorage"]),
        ...(production && !checks.cronSecret ? ["cronSecret"] : []),
      ]
    : [];
  const warnings = deployed && effectiveAssetMode === "redis-fallback" ? ["blob"] : [];

  return json(
    {
      ok: missing.length === 0,
      environment: deployed ? process.env.VERCEL_ENV ?? "vercel" : "local-development",
      realtime: checks.redis ? "vercel-websocket+redis-streams" : "polling+process-memory",
      assets: effectiveAssetMode === "local-memory" ? "process-memory" : effectiveAssetMode,
      assetPrivacy:
        effectiveAssetMode === "vercel-blob" ? "private-authenticated-room-proxy" : null,
      synchronization: {
        storage: checks.redis ? "redis-three-plane-v3" : "process-memory-three-plane-v3",
        documentRevision: "roomRevision",
        aggregateRevision: "stateRevision",
        mutationIdempotency: "participant-scoped-24h-receipts",
      },
      capacity: {
        mode: capacityModeFromEnvironment(),
        limits: DEFAULT_CAPACITY_LIMITS,
      },
      tldraw: { version: "3.15.6", licenseMode: "built-in-watermark" },
      checks: { ...checks, assetStorage },
      missing,
      warnings,
    },
    { status: missing.length ? 503 : 200 },
  );
}
