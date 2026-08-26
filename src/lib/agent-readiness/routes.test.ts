// @vitest-environment node

import { createHash } from "node:crypto";

import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { GET as getAgents, HEAD as headAgents } from "@/app/AGENTS.md/route";
import { GET as getAgentGuide } from "@/app/agent-guide.md/route";
import { GET as getSkillIndex } from "@/app/.well-known/agent-skills/index.json/route";
import { GET as getGlossary } from "@/app/glossary.md/route";
import { GET as getIndex, HEAD as headIndex } from "@/app/index.md/route";
import { GET as getLlms, HEAD as headLlms } from "@/app/llms.txt/route";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import { GET as getSitemapMarkdown } from "@/app/sitemap.md/route";
import { GET as getSkill } from "@/app/skills/jazzboard-webmcp/SKILL.md/route";
import { GET as getWebMcp } from "@/app/webmcp.md/route";
import { JAZZBOARD_SKILL_DESCRIPTION, makeSkillMarkdown } from "@/lib/agent-readiness/content";
import { proxy } from "@/proxy";

describe("agent discovery routes", () => {
  it("serves llms.txt as public plain text with canonical discovery headers", async () => {
    const response = getLlms();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("link")).toContain('rel="canonical"');
    expect(response.headers.get("link")).toContain('rel="describedby"');
    expect(await response.text()).toContain("# Jazzboard");

    const head = headLlms();
    expect(head.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await head.text()).toBe("");
  });

  it("serves every Markdown resource with a canonical header and HEAD support", async () => {
    const responses = [
      getIndex(),
      getAgentGuide(),
      getWebMcp(),
      getGlossary(),
      getAgents(),
      getSitemapMarkdown(),
      getSkill(),
    ];
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
      expect(response.headers.get("link")).toContain('rel="canonical"');
      expect((await response.text()).length).toBeGreaterThan(100);
    }

    expect(await headIndex().text()).toBe("");
    expect(await headAgents().text()).toBe("");
  });

  it("publishes a draft skill-discovery manifest with an exact content digest", async () => {
    const response = getSkillIndex();
    const body = await response.json();
    const expectedDigest = createHash("sha256")
      .update(makeSkillMarkdown(), "utf8")
      .digest("hex");

    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(body.$schema).toBe("https://schemas.agentskills.io/discovery/0.2.0/schema.json");
    expect(body.skills).toEqual([
      expect.objectContaining({
        name: "jazzboard-webmcp",
        type: "skill-md",
        description: JAZZBOARD_SKILL_DESCRIPTION,
        digest: `sha256:${expectedDigest}`,
      }),
    ]);
  });

  it("keeps private room, snapshot, and API paths out of crawler discovery", () => {
    const robotsFile = robots();
    const entries = sitemap();
    expect(robotsFile.rules).toMatchObject({
      userAgent: "*",
      disallow: ["/api/", "/snapshot/"],
    });
    expect(entries.every((entry) => entry.lastModified instanceof Date)).toBe(true);
    expect(entries.some((entry) => entry.url.endsWith("/"))).toBe(true);
    expect(entries.every((entry) => !entry.url.includes("/room/"))).toBe(true);
    expect(entries.every((entry) => !entry.url.includes("/snapshot/"))).toBe(true);
    expect(entries.every((entry) => !entry.url.includes("/api/"))).toBe(true);
  });

  it("rewrites only explicit Markdown negotiation at the homepage", () => {
    const markdown = proxy(
      new NextRequest("https://jazzboard-rho.vercel.app/", {
        headers: { accept: "text/markdown, text/html;q=0.5" },
      }),
    );
    expect(markdown.headers.get("x-middleware-rewrite")).toBe(
      "https://jazzboard-rho.vercel.app/index.md",
    );

    const html = proxy(
      new NextRequest("https://jazzboard-rho.vercel.app/", {
        headers: { accept: "text/html,application/xhtml+xml" },
      }),
    );
    expect(html.headers.get("x-middleware-rewrite")).toBeNull();
    expect(html.headers.get("vary")).toContain("Accept");

    const rejectedMarkdown = proxy(
      new NextRequest("https://jazzboard-rho.vercel.app/", {
        headers: { accept: "text/markdown;q=0, text/html" },
      }),
    );
    expect(rejectedMarkdown.headers.get("x-middleware-rewrite")).toBeNull();
  });
});
