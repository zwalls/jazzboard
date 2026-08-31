// @vitest-environment node

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("Vercel export-route source inclusion", () => {
  it("ignores only the root artifact output directory, not application routes named artifacts", () => {
    const rules = readFileSync(".vercelignore", "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));

    expect(rules).toContain("/artifacts/");
    expect(rules).not.toContain("artifacts/");
    expect(rules).not.toContain("**/artifacts/");

    const artifactDirectoryRules = rules.filter((rule) => rule.replace(/^\//, "").startsWith("artifacts/"));
    const isExcludedByArtifactRule = (target: string) => artifactDirectoryRules.some((rule) => {
      const normalizedRule = rule.replace(/^\//, "").replace(/\/$/, "");
      const normalizedTarget = target.replace(/^\//, "");
      if (rule.startsWith("/")) {
        return normalizedTarget === normalizedRule || normalizedTarget.startsWith(`${normalizedRule}/`);
      }
      return normalizedTarget.split("/").includes(normalizedRule);
    });

    expect(isExcludedByArtifactRule("artifacts/launch-video.mp4")).toBe(true);
    expect(isExcludedByArtifactRule("src/app/api/rooms/[roomId]/artifacts/route.ts")).toBe(false);
    expect(isExcludedByArtifactRule("src/app/api/rooms/[roomId]/agent/artifacts/route.ts")).toBe(false);
  });
});
