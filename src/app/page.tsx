import type { Metadata } from "next";

import { HomeExperience } from "@/components/home/HomeExperience";

export const metadata: Metadata = {
  alternates: {
    canonical: "/",
    types: {
      "text/markdown": "/index.md",
    },
  },
};

const structuredData = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebApplication",
      "@id": "https://jazzboard-rho.vercel.app/#application",
      name: "Jazzboard",
      url: "https://jazzboard-rho.vercel.app/",
      description:
        "A private multiplayer architecture canvas with page-scoped browser WebMCP tools for people and participant-owned agents.",
      applicationCategory: "CollaborationApplication",
      browserRequirements: "A modern browser; agent operation requires browser WebMCP support.",
      featureList: [
        "Browser-native WebMCP tool discovery",
        "Private exact-code rooms",
        "Multiplayer semantic canvas",
        "First-class semantic diagrams",
        "Role-scoped participant and spectator tools",
        "Conflict-safe revision checks and active-object leases",
      ],
      isAccessibleForFree: true,
      dateModified: "2026-08-26",
    },
    {
      "@type": "BreadcrumbList",
      itemListElement: [
        {
          "@type": "ListItem",
          position: 1,
          name: "Jazzboard",
          item: "https://jazzboard-rho.vercel.app/",
        },
      ],
    },
  ],
};

export default function HomePage() {
  return (
    <>
      <script
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData).replaceAll("<", "\\u003c") }}
        type="application/ld+json"
      />
      <nav aria-label="Agent resources" className="sr-only">
        <a href="/agent-guide.md">Agent guide</a>
        <a href="/webmcp.md">WebMCP reference</a>
        <a href="/glossary.md">Terminology glossary</a>
      </nav>
      <HomeExperience />
    </>
  );
}
