import { makeSitemapMarkdown } from "@/lib/agent-readiness/content";
import { markdownHeadResponse, markdownResponse } from "@/lib/agent-readiness/responses";

export function GET() {
  return markdownResponse(makeSitemapMarkdown(), "/sitemap.md");
}

export function HEAD() {
  return markdownHeadResponse("/sitemap.md");
}
