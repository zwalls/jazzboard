import { handleActivityMutation } from "@/lib/server/activity-http";

type Context = { params: Promise<{ roomId: string; activityId: string }> };

export async function POST(request: Request, context: Context): Promise<Response> {
  return handleActivityMutation(request, context, "agent");
}
