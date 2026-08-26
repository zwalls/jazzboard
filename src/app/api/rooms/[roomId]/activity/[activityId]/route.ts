import { handleActivityRead } from "@/lib/server/activity-http";

type Context = { params: Promise<{ roomId: string; activityId: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  return handleActivityRead(request, context);
}
