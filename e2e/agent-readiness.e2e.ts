import { expect, test } from "@playwright/test";

async function installStrictWebMcpShim(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    const tools = new Map<string, WebMCP.ModelContextTool>();
    const registrationStates: DocumentReadyState[] = [];
    const browserWindow = window as Window & {
      __jazzboardEarlyWebMcp?: {
        tools: Map<string, WebMCP.ModelContextTool>;
        registrationStates: DocumentReadyState[];
      };
    };
    browserWindow.__jazzboardEarlyWebMcp = { tools, registrationStates };
    const modelContext = new EventTarget() as WebMCP.ModelContext;
    modelContext.ontoolchange = null;
    modelContext.registerTool = async (tool, options) => {
      if (tools.has(tool.name)) {
        throw new DOMException(`Tool ${tool.name} is already registered.`, "InvalidStateError");
      }
      tools.set(tool.name, tool);
      registrationStates.push(document.readyState);
      modelContext.dispatchEvent(new Event("toolchange"));
      options?.signal?.addEventListener(
        "abort",
        () => {
          if (tools.get(tool.name) !== tool) return;
          tools.delete(tool.name);
          modelContext.dispatchEvent(new Event("toolchange"));
        },
        { once: true },
      );
    };
    Object.defineProperty(document, "modelContext", { configurable: true, value: modelContext });
  });
}

test("registers all landing lifecycle tools before React hydration", async ({ page }) => {
  await installStrictWebMcpShim(page);
  const response = await page.goto("/", { waitUntil: "domcontentloaded" });
  expect(response?.status()).toBe(200);

  const readFirstContact = () => page.evaluate(() => {
    const state = (window as Window & {
      __jazzboardEarlyWebMcp?: {
        tools: Map<string, WebMCP.ModelContextTool>;
        registrationStates: DocumentReadyState[];
      };
    }).__jazzboardEarlyWebMcp;
    return {
      names: [...(state?.tools.keys() ?? [])],
      registrationStates: state?.registrationStates ?? [],
    };
  });

  const expectedNames = [
    "create_room",
    "join_room",
    "list_recent_rooms",
    "open_recent_room",
    "remove_recent_room",
  ];
  await page.waitForLoadState("load");
  const firstContact = await readFirstContact();
  expect(firstContact.names).toEqual(expectedNames);
  expect(firstContact.registrationStates).toHaveLength(5);
  expect(firstContact.registrationStates.every((state) => state !== "complete")).toBe(true);
  await expect(page.getByTitle("Browser-exposed WebMCP lifecycle tools")).toContainText(
    "Agent ready · 5 tools",
  );
});

test("publishes agent discovery before client hydration without changing the visual page", async ({
  page,
  request,
}) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);

  await expect(page.locator('link[rel="describedby"][href="/llms.txt"]')).toHaveCount(1);
  await expect(
    page.locator('link[rel="alternate"][type="text/markdown"][href$="/index.md"]'),
  ).toHaveCount(1);
  await expect(page.locator('script[type="application/ld+json"]')).toHaveCount(1);
  await expect(page).toHaveTitle("Jazzboard — Think together, live");
  await expect(page.getByRole("heading", { name: "Make room for every idea." })).toBeVisible();

  const llms = await request.get("/llms.txt");
  expect(llms.status()).toBe(200);
  expect(llms.headers()["content-type"]).toContain("text/plain");
  expect(await llms.text()).toContain(
    "discover the currently loaded page's tools before DOM inspection",
  );

  const markdown = await request.get("/", {
    headers: { Accept: "text/markdown" },
  });
  expect(markdown.status()).toBe(200);
  expect(markdown.headers()["content-type"]).toContain("text/markdown");
  expect(await markdown.text()).toContain("## Sitemap");
});

test("serves the skill, crawler controls, and both sitemap formats", async ({ request }) => {
  for (const path of [
    "/AGENTS.md",
    "/agent-guide.md",
    "/webmcp.md",
    "/privacy.md",
    "/glossary.md",
    "/sitemap.md",
    "/skills/jazzboard-webmcp/SKILL.md",
  ]) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(200);
    expect(response.headers()["content-type"], path).toContain("text/markdown");
  }

  const skillIndex = await request.get("/.well-known/agent-skills/index.json");
  expect(skillIndex.status()).toBe(200);
  expect((await skillIndex.json()).skills[0]).toMatchObject({
    name: "jazzboard-webmcp",
    type: "skill-md",
  });

  const robots = await request.get("/robots.txt");
  expect(await robots.text()).toContain("Disallow: /api/");
  const sitemap = await request.get("/sitemap.xml");
  const sitemapBody = await sitemap.text();
  expect(sitemap.status()).toBe(200);
  expect(sitemapBody).toContain("<lastmod>");
  expect(sitemapBody).not.toContain("/room/");
});
