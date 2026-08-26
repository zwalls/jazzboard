import { makePrivacyMarkdown } from "@/lib/agent-readiness/content";
import { markdownHeadResponse, markdownResponse } from "@/lib/agent-readiness/responses";

export function GET() {
  return markdownResponse(makePrivacyMarkdown(), "/privacy.md");
}

export function HEAD() {
  return markdownHeadResponse("/privacy.md");
}
