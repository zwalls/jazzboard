import { handleSemanticRequest } from "@/lib/server/semantic-http";

type Context = { params: Promise<{ roomId: string }> };

export async function POST(request: Request, context: Context): Promise<Response> {
  return handleSemanticRequest(request, context, "agent");
}
