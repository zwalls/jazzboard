import { makeWebMcpMarkdown } from "@/lib/agent-readiness/content";
import { markdownHeadResponse, markdownResponse } from "@/lib/agent-readiness/responses";

export function GET() {
  return markdownResponse(makeWebMcpMarkdown(), "/webmcp.md");
}

export function HEAD() {
  return markdownHeadResponse("/webmcp.md");
}
