import {
  handleCreateReadonlySnapshot,
  handleListReadonlySnapshots,
  handleRevokeReadonlySnapshot,
} from "@/lib/server/snapshot-http";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ roomId: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  return handleListReadonlySnapshots(request, context, "human");
}

export async function POST(request: Request, context: Context): Promise<Response> {
  return handleCreateReadonlySnapshot(request, context, "human");
}

export async function DELETE(request: Request, context: Context): Promise<Response> {
  return handleRevokeReadonlySnapshot(request, context, "human");
}
