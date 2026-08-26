import { createHash } from "node:crypto";

import {
  JAZZBOARD_ORIGIN,
  JAZZBOARD_SKILL_DESCRIPTION,
  makeSkillMarkdown,
} from "@/lib/agent-readiness/content";
import { jsonHeadResponse, jsonResponse } from "@/lib/agent-readiness/responses";

const PATH = "/.well-known/agent-skills/index.json";

function manifest() {
  const skill = makeSkillMarkdown();
  return {
    $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
    skills: [
      {
        name: "jazzboard-webmcp",
        type: "skill-md",
        description: JAZZBOARD_SKILL_DESCRIPTION,
        url: `${JAZZBOARD_ORIGIN}/skills/jazzboard-webmcp/SKILL.md`,
        digest: `sha256:${createHash("sha256").update(skill, "utf8").digest("hex")}`,
      },
    ],
  };
}

export function GET() {
  return jsonResponse(manifest(), PATH);
}

export function HEAD() {
  return jsonHeadResponse(PATH);
}
