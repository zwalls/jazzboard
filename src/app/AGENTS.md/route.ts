import { makeAgentsMarkdown } from "@/lib/agent-readiness/content";
import { markdownHeadResponse, markdownResponse } from "@/lib/agent-readiness/responses";

export function GET() {
  return markdownResponse(makeAgentsMarkdown(), "/AGENTS.md");
}

export function HEAD() {
  return markdownHeadResponse("/AGENTS.md");
}
