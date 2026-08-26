import { makeLlmsTxt } from "@/lib/agent-readiness/content";
import { textHeadResponse, textResponse } from "@/lib/agent-readiness/responses";

export function GET() {
  return textResponse(makeLlmsTxt(), "/llms.txt");
}

export function HEAD() {
  return textHeadResponse("/llms.txt");
}
