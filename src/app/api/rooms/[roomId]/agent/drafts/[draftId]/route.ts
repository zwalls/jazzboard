import {
  handleDiscardAgentCanvasDraft,
  handleReplaceAgentCanvasDraft,
} from "@/lib/server/agent-draft-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const PUT = handleReplaceAgentCanvasDraft;
export const DELETE = handleDiscardAgentCanvasDraft;
