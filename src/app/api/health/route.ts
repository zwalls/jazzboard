import { json } from "@/lib/server/http";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const deployed = process.env.VERCEL === "1";
  const checks = {
    redis: Boolean(process.env.REDIS_URL),
    blob: Boolean(process.env.BLOB_READ_WRITE_TOKEN),
    sessionSecret: Boolean(process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32),
  };
  const assetStorage = checks.blob || checks.redis;
  const missing = deployed
    ? [
        ...(checks.redis ? [] : ["redis"]),
        ...(checks.sessionSecret ? [] : ["sessionSecret"]),
        ...(assetStorage ? [] : ["assetStorage"]),
      ]
    : [];
  const warnings = deployed && !checks.blob && checks.redis ? ["blob"] : [];

  return json(
    {
      ok: missing.length === 0,
      environment: deployed ? process.env.VERCEL_ENV ?? "vercel" : "local-development",
      realtime: checks.redis ? "vercel-websocket+redis-streams" : "polling+process-memory",
      assets: checks.blob ? "vercel-blob" : checks.redis ? "redis-fallback" : "process-memory",
      tldraw: { version: "3.15.6", licenseMode: "built-in-watermark" },
      checks: { ...checks, assetStorage },
      missing,
      warnings,
    },
    { status: missing.length ? 503 : 200 },
  );
}
