import {
  handleAgentMessageCreate,
  handleAgentMessageList,
} from "@/lib/server/agent-message-http";

type Context = { params: Promise<{ roomId: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  return handleAgentMessageList(request, context, "newest");
}

export async function POST(request: Request, context: Context): Promise<Response> {
  return handleAgentMessageCreate(request, context);
}
