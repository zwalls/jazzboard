import { timingSafeEqual } from "node:crypto";

import { cleanupPrivateBlobAssets } from "@/lib/server/blob-asset-cleanup";
import { errorResponse, json } from "@/lib/server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function authorizedCronRequest(request: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  const authorization = request.headers.get("authorization");
  if (!secret || !authorization?.startsWith("Bearer ")) return false;
  const supplied = authorization.slice("Bearer ".length);
  const expectedBytes = Buffer.from(secret, "utf8");
  const suppliedBytes = Buffer.from(supplied, "utf8");
  return (
    expectedBytes.length === suppliedBytes.length &&
    timingSafeEqual(expectedBytes, suppliedBytes)
  );
}

export async function GET(request: Request): Promise<Response> {
  if (!authorizedCronRequest(request)) {
    return json(
      { ok: false, error: { code: "AUTH_REQUIRED", message: "Cron authorization is required." } },
      { status: 401 },
    );
  }
  try {
    const summary = await cleanupPrivateBlobAssets();
    return json({ ok: true, summary });
  } catch (error) {
    return errorResponse(error);
  }
}
