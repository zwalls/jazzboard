import { handleAgentMessageReply } from "@/lib/server/agent-message-http";

type Context = { params: Promise<{ roomId: string; messageId: string }> };

export async function POST(request: Request, context: Context): Promise<Response> {
  return handleAgentMessageReply(request, context);
}
