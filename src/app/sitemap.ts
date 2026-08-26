import type { MetadataRoute } from "next";

import {
  AGENT_DOC_LAST_UPDATED,
  AGENT_MARKDOWN_PATHS,
  JAZZBOARD_ORIGIN,
} from "@/lib/agent-readiness/content";

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date(`${AGENT_DOC_LAST_UPDATED}T00:00:00.000Z`);
  return [
    {
      url: `${JAZZBOARD_ORIGIN}/`,
      lastModified,
      changeFrequency: "weekly",
      priority: 1,
    },
    ...AGENT_MARKDOWN_PATHS.map((path) => ({
      url: `${JAZZBOARD_ORIGIN}${path}`,
      lastModified,
      changeFrequency: "monthly" as const,
      priority: path === "/agent-guide.md" || path === "/webmcp.md" ? 0.8 : 0.6,
    })),
  ];
}
