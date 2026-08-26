import { makeAgentGuideMarkdown } from "@/lib/agent-readiness/content";
import { markdownHeadResponse, markdownResponse } from "@/lib/agent-readiness/responses";

export function GET() {
  return markdownResponse(makeAgentGuideMarkdown(), "/agent-guide.md");
}

export function HEAD() {
  return markdownHeadResponse("/agent-guide.md");
}
