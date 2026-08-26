import { handleReadPublicSnapshot } from "@/lib/server/snapshot-http";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ token: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  return handleReadPublicSnapshot(request, context);
}
