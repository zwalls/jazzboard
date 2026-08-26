import { handleActivityGet } from "@/lib/server/activity-http";

type Context = { params: Promise<{ roomId: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  return handleActivityGet(request, context);
}
