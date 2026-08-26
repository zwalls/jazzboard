import { makeSkillMarkdown } from "@/lib/agent-readiness/content";
import { markdownHeadResponse, markdownResponse } from "@/lib/agent-readiness/responses";

export function GET() {
  return markdownResponse(makeSkillMarkdown(), "/skills/jazzboard-webmcp/SKILL.md");
}

export function HEAD() {
  return markdownHeadResponse("/skills/jazzboard-webmcp/SKILL.md");
}
