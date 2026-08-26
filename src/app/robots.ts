import type { MetadataRoute } from "next";

import { JAZZBOARD_ORIGIN } from "@/lib/agent-readiness/content";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: [
        "/",
        "/llms.txt",
        "/index.md",
        "/agent-guide.md",
        "/webmcp.md",
        "/privacy.md",
        "/glossary.md",
        "/sitemap.md",
        "/AGENTS.md",
        "/skills/",
      ],
      disallow: ["/api/", "/snapshot/"],
    },
    sitemap: `${JAZZBOARD_ORIGIN}/sitemap.xml`,
    host: JAZZBOARD_ORIGIN,
  };
}
