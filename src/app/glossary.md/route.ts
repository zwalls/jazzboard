import { makeGlossaryMarkdown } from "@/lib/agent-readiness/content";
import { markdownHeadResponse, markdownResponse } from "@/lib/agent-readiness/responses";

export function GET() {
  return markdownResponse(makeGlossaryMarkdown(), "/glossary.md");
}

export function HEAD() {
  return markdownHeadResponse("/glossary.md");
}
