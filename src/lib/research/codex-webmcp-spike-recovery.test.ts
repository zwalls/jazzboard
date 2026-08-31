// @vitest-environment node

import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  exp0001aCodexSpikeRecoveryEvidenceSchema,
  verifyExp0001aCodexSpikeBrowserTrace,
} from "./codex-webmcp-spike-recovery";

const INVITE = "https://www.jazzboard.xyz/#join=ABC234";
const BOOTSTRAP = `
const { setupBrowserRuntime } = await import("/Users/test/.codex/plugins/cache/openai-bundled/browser/26.825.51511/scripts/browser-client.mjs");
const agent = await setupBrowserRuntime();
const browser = await agent.browsers.get("iab");
const tab = await browser.tabs.new();
await tab.goto("${INVITE}");
const landingCapability = await tab.capabilities.get("webmcp");
const landingTools = await landingCapability.fetchTools();
`;
const JOIN = `
const joinResult = await landingTools.call("join_room", {code:"ABC234", displayName:"Isolated Spike Author", role:"participant"});
if (!joinResult.ok) throw new Error("join_room failed");
const joinedParticipantId = joinResult.data.participantId;
const roomCapability = await tab.capabilities.get("webmcp");
const roomTools = await roomCapability.fetchTools();
`;
const READ = `
const roomResult = await roomTools.call("read_room_state", {});
if (!roomResult.ok) { throw new Error("read_room_state failed"); }
`;

function verify(codeBlocks: readonly string[]) {
  return verifyExp0001aCodexSpikeBrowserTrace({ codeBlocks, roomUrl: INVITE });
}

describe("raw Codex Browser/WebMCP spike trace verification", () => {
  it("accepts one fresh invite tab and immediate fail-closed top-level WebMCP calls", () => {
    expect(verify([BOOTSTRAP, JOIN, READ])).toEqual(["join_room", "read_room_state"]);
  });

  it("accepts one post-join navigation wait without treating it as a direct request", () => {
    const joined = JOIN.replace(
      "const roomCapability",
      'await tab.playwright.waitForURL("https://www.jazzboard.xyz/room/**", {waitUntil:"domcontentloaded", timeoutMs:15000});\nconst roomCapability',
    );
    expect(verify([BOOTSTRAP, joined, READ])).toEqual(["join_room", "read_room_state"]);
  });

  it.each([
    ["reused tabs", `${BOOTSTRAP}\nconst reused = await browser.tabs.list();`, /forbidden|new tab/i],
    ["extra package import", `${BOOTSTRAP}\nconst sharp = await import("sharp");`, /only the frozen browser client/i],
    ["direct HTTP", `${BOOTSTRAP}\nconst response = await fetch("${INVITE}");`, /forbidden/i],
    ["Node built-in filesystem escape", `${BOOTSTRAP}\nconst leaked = process.getBuiltinModule("fs").readFileSync("/tmp/private", "utf8");`, /forbidden (?:Node )?capability/i],
    ["computed provider request escape", `${BOOTSTRAP}\nconst req = process.getBuiltinModule("https").request({hostname:["api","openai","com"].join("."),path:"/v1/models"});`, /forbidden (?:Node )?capability/i],
    ["computed dynamic import", `${BOOTSTRAP}\nconst fs = await import(["node", "fs"].join(":"));`, /frozen browser client/i],
    ["WebMCP call monkey patch", `${BOOTSTRAP}\nlandingTools.call = async () => ({ok:true,data:{}});`, /may not mutate/i],
    ["WebMCP Object.assign monkey patch", `${BOOTSTRAP}\nObject.assign(landingTools, {call: async () => ({ok:true,data:{}})});`, /forbidden capability member/i],
    ["post-join URL before join", `${BOOTSTRAP}\nawait tab.playwright.waitForURL("https://www.jazzboard.xyz/room/**");`, /join transition/i],
    ["executable outer tool access", `${BOOTSTRAP}\nconst patch = await tools.apply_patch("x");`, /non-browser tool surface/i],
    ["missing fail-closed guard", JOIN.replace(/if \(!joinResult\.ok\)[^\n]+\n/, ""), /immediately fail closed/i],
    ["caught call", `try { ${READ} } catch {}`, /catch or suppress|control-flow-hidden/i],
    ["hidden call", `if (false) { ${READ} }`, /control-flow-hidden/i],
    ["computed tool", READ.replace('"read_room_state"', "toolName"), /computed or invalid/i],
  ])("rejects %s", (_label, mutation, expected) => {
    const blocks = mutation.includes(BOOTSTRAP)
      ? [mutation, JOIN, READ]
      : mutation.includes("joinResult")
        ? [BOOTSTRAP, mutation, READ]
        : [BOOTSTRAP, JOIN, mutation];
    expect(() => verify(blocks)).toThrow(expected);
  });

  it("does not mistake comments or strings for executed WebMCP calls", () => {
    const noise = `
// const fake = await roomTools.call("delete_objects", {});
const harmless = '.call("update_object", {})';
const documentationExample = ']\\nCall tools.call';
nodeRepl.write(harmless);
`;
    expect(verify([BOOTSTRAP, JOIN, READ, noise])).toEqual(["join_room", "read_room_state"]);
  });

  it("rejects a direct-room URL even when browser code otherwise looks valid", () => {
    expect(() => verifyExp0001aCodexSpikeBrowserTrace({
      codeBlocks: [BOOTSTRAP, JOIN, READ],
      roomUrl: "https://www.jazzboard.xyz/room/room_12345678",
    })).toThrow(/private Jazzboard invite/i);
  });

  it("keeps every PNG or exported-byte claim outside the strict v2 transport evidence", async () => {
    const retained = JSON.parse(await readFile(path.join(
      process.cwd(),
      "research/data/exp0001a-codex-webmcp-spike-public-v2.json",
    ), "utf8")) as Record<string, unknown>;
    expect(exp0001aCodexSpikeRecoveryEvidenceSchema.parse(retained)).not.toHaveProperty("image");
    expect(exp0001aCodexSpikeRecoveryEvidenceSchema.safeParse({
      ...retained,
      image: { mimeType: "image/png", sha256: `sha256:${"0".repeat(64)}` },
    }).success).toBe(false);
    expect(exp0001aCodexSpikeRecoveryEvidenceSchema.safeParse({
      ...retained,
      rawAuthority: {
        ...(retained.rawAuthority as Record<string, unknown>),
        exportedPngDigest: `sha256:${"0".repeat(64)}`,
      },
    }).success).toBe(false);
  });

  it("publishes only commitments for private Codex task and turn identities", async () => {
    const retained = JSON.parse(await readFile(path.join(
      process.cwd(),
      "research/data/exp0001a-codex-webmcp-spike-public-v2.json",
    ), "utf8")) as { task: Record<string, unknown> };
    const parsed = exp0001aCodexSpikeRecoveryEvidenceSchema.parse(retained);

    expect(parsed.task.taskIdentityDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(parsed.task.turnIdentityDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(parsed.task).not.toHaveProperty("taskId");
    expect(parsed.task).not.toHaveProperty("turnId");
    expect(parsed.task).not.toHaveProperty("hostId");
    expect(exp0001aCodexSpikeRecoveryEvidenceSchema.safeParse({
      ...retained,
      task: { ...retained.task, taskId: "private-task-id" },
    }).success).toBe(false);
  });
});
