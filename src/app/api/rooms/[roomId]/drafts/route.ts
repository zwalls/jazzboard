import { handleListAgentCanvasDrafts } from "@/lib/server/agent-draft-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handleListAgentCanvasDrafts;
