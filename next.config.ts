import type { NextConfig } from "next";

const webMcpOriginTrialToken = process.env.WEBMCP_ORIGIN_TRIAL_TOKEN?.trim();
const webMcpDocumentHeaders = [
  { key: "Origin-Agent-Cluster", value: "?1" },
  { key: "Permissions-Policy", value: "tools=(self)" },
  ...(webMcpOriginTrialToken
    ? [{ key: "Origin-Trial", value: webMcpOriginTrialToken }]
    : []),
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  agentRules: false,
  serverExternalPackages: ["ioredis", "ws"],
  async headers() {
    return [
      {
        source: "/",
        headers: [
          ...webMcpDocumentHeaders,
          {
            key: "Link",
            value:
              '</llms.txt>; rel="describedby"; type="text/plain", </index.md>; rel="alternate"; type="text/markdown"',
          },
          { key: "Vary", value: "Accept" },
        ],
      },
      {
        source: "/room/:path*",
        headers: [
          ...webMcpDocumentHeaders,
          {
            key: "Link",
            value: '</llms.txt>; rel="describedby"; type="text/plain"',
          },
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
        ],
      },
      {
        source: "/snapshot/:path*",
        headers: [
          ...webMcpDocumentHeaders,
          {
            key: "Link",
            value: '</llms.txt>; rel="describedby"; type="text/plain"',
          },
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
          { key: "Cache-Control", value: "private, no-store, max-age=0" },
        ],
      },
      {
        source: "/api/:path*",
        headers: [
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
        ],
      },
    ];
  },
  experimental: {
    optimizePackageImports: ["lucide-react"],
  },
};

export default nextConfig;
