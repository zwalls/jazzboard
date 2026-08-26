import { makeHomepageMarkdown } from "@/lib/agent-readiness/content";
import { markdownHeadResponse, markdownResponse } from "@/lib/agent-readiness/responses";

export function GET() {
  return markdownResponse(makeHomepageMarkdown(), "/");
}

export function HEAD() {
  return markdownHeadResponse("/");
}
