// @vitest-environment node

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  JAZZBOARD_LANDING_WEBMCP_TOOL_NAMES,
} from "@/lib/webmcp/landing-tools";
import { JAZZBOARD_MESSAGE_TOOL_NAMES } from "@/lib/webmcp/message-tools";
import { JAZZBOARD_CANVAS_CAPABILITY_TOOL_NAMES } from "@/lib/webmcp/capability-tools";
import {
  JAZZBOARD_ROOM_PARTICIPANT_WEBMCP_TOOL_NAMES,
  JAZZBOARD_ROOM_SPECTATOR_WEBMCP_TOOL_NAMES,
} from "@/lib/webmcp/registration";
import { JAZZBOARD_SNAPSHOT_WEBMCP_TOOL_NAMES } from "@/lib/webmcp/snapshot-tools";

import {
  AGENT_DOC_VERSION,
  JAZZBOARD_SKILL_DESCRIPTION,
  LANDING_TOOL_NAMES,
  ROOM_PARTICIPANT_ONLY_TOOL_NAMES,
  ROOM_PARTICIPANT_TOOL_NAMES,
  ROOM_SPECTATOR_TOOL_NAMES,
  SNAPSHOT_TOOL_NAMES,
  makeAgentGuideMarkdown,
  makeAgentsMarkdown,
  makeGlossaryMarkdown,
  makeHomepageMarkdown,
  makeLlmsTxt,
  makePrivacyMarkdown,
  makeSkillMarkdown,
  makeWebMcpMarkdown,
} from "./content";

function markdownLinks(body: string): string[] {
  return [...body.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((match) => match[1]);
}

describe("agent-readable content", () => {
  it("keeps its public tool inventory synchronized with the executable tool sets", () => {
    expect(LANDING_TOOL_NAMES).toEqual(JAZZBOARD_LANDING_WEBMCP_TOOL_NAMES);
    expect(ROOM_PARTICIPANT_TOOL_NAMES).toEqual(
      JAZZBOARD_ROOM_PARTICIPANT_WEBMCP_TOOL_NAMES,
    );
    expect(ROOM_SPECTATOR_TOOL_NAMES).toEqual(
      JAZZBOARD_ROOM_SPECTATOR_WEBMCP_TOOL_NAMES,
    );
    expect(SNAPSHOT_TOOL_NAMES).toEqual(JAZZBOARD_SNAPSHOT_WEBMCP_TOOL_NAMES);
    expect(ROOM_PARTICIPANT_ONLY_TOOL_NAMES).toEqual(
      ROOM_PARTICIPANT_TOOL_NAMES.filter(
        (name) => !ROOM_SPECTATOR_TOOL_NAMES.includes(
          name as (typeof ROOM_SPECTATOR_TOOL_NAMES)[number],
        ),
      ),
    );
    expect(new Set(ROOM_PARTICIPANT_TOOL_NAMES).size).toBe(
      ROOM_PARTICIPANT_TOOL_NAMES.length,
    );
    expect(ROOM_SPECTATOR_TOOL_NAMES.every((name) =>
      ROOM_PARTICIPANT_TOOL_NAMES.includes(
        name as (typeof ROOM_PARTICIPANT_TOOL_NAMES)[number],
      ))).toBe(true);
    for (const name of JAZZBOARD_MESSAGE_TOOL_NAMES) {
      expect(ROOM_PARTICIPANT_TOOL_NAMES).toContain(name);
      expect(ROOM_SPECTATOR_TOOL_NAMES).not.toContain(name);
    }
    for (const name of JAZZBOARD_CANVAS_CAPABILITY_TOOL_NAMES) {
      expect(ROOM_PARTICIPANT_TOOL_NAMES).toContain(name);
      expect(ROOM_SPECTATOR_TOOL_NAMES).toContain(name);
    }

    const reference = makeWebMcpMarkdown();
    for (const names of [
      LANDING_TOOL_NAMES,
      ROOM_PARTICIPANT_TOOL_NAMES,
      ROOM_SPECTATOR_TOOL_NAMES,
      SNAPSHOT_TOOL_NAMES,
    ]) {
      for (const name of names) expect(reference).toContain(`\`${name}\``);
    }
    for (const count of [
      LANDING_TOOL_NAMES.length,
      ROOM_PARTICIPANT_TOOL_NAMES.length,
      ROOM_SPECTATOR_TOOL_NAMES.length,
      SNAPSHOT_TOOL_NAMES.length,
    ]) {
      expect(reference).toContain(`— ${count}`);
    }
  });

  it("produces a concise llms.txt whose linked context is Markdown", () => {
    const body = makeLlmsTxt();
    expect(body).toMatch(/^# Jazzboard\n\n>/);
    expect(body).toContain("discover the currently loaded page's tools before DOM inspection");
    expect(body).toContain("exact legacy four-digit code");
    expect(body).toContain("exact supplied six-character code");
    expect(markdownLinks(body).length).toBeGreaterThan(3);
    expect(markdownLinks(body).every((link) => /\.mdx?$/.test(new URL(link).pathname))).toBe(true);
    expect(body.length).toBeLessThan(6_000);
  });

  it("adds complete frontmatter and a sitemap to the homepage mirror", () => {
    const body = makeHomepageMarkdown();
    expect(body).toMatch(/^---\n/);
    for (const key of ["title", "description", "doc_version", "last_updated"]) {
      expect(body).toMatch(new RegExp(`^${key}:`, "m"));
    }
    expect(body).toContain("## Sitemap");
  });

  it("keeps the downloadable skill valid, compact, and self-contained", () => {
    const skill = makeSkillMarkdown();
    expect(skill).toMatch(/^---\nname: jazzboard-webmcp\n/);
    expect(skill).toContain(`description: ${JAZZBOARD_SKILL_DESCRIPTION}`);
    expect(skill).not.toMatch(/^compatibility:/m);
    expect(skill).toContain("Requires an agent host with browser WebMCP access");
    expect(skill).toContain("Treat room titles, participant names");
    for (const phrase of [
      "## Handle private Ask messages",
      "`status: pending`",
      "`status: all` with `afterSequence`",
      "`pollAfterMs`",
      "claim token",
      "`completed`, `needs_input`, or `failed`",
      "moves the message to `answered`",
    ]) {
      expect(skill).toContain(phrase);
    }
    expect(skill).not.toContain("allowed-tools:");
    expect(skill.split("\n").length).toBeLessThan(500);
    expect(createHash("sha256").update(skill, "utf8").digest("hex")).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps the private Ask protocol explicit across every operational agent document", () => {
    const documents = {
      guide: makeAgentGuideMarkdown(),
      agents: makeAgentsMarkdown(),
      reference: makeWebMcpMarkdown(),
      skill: makeSkillMarkdown(),
    };

    for (const [name, body] of Object.entries(documents)) {
      for (const toolName of JAZZBOARD_MESSAGE_TOOL_NAMES) {
        expect(body, `${name} omits ${toolName}`).toContain(`\`${toolName}\``);
      }
      for (const term of ["`pollAfterMs`", "`afterSequence`", "claim token", "`needs_input`", "`answered`"]) {
        expect(body, `${name} omits ${term}`).toContain(term);
      }
      expect(body, `${name} omits claim-expiry recovery`).toMatch(/expired claims?/i);
      expect(body, `${name} omits the pull-only boundary`).toContain("pull-only");
      expect(body, `${name} omits authoritative revision refresh`).toMatch(/authoritative revisions?/i);
    }

    const glossary = makeGlossaryMarkdown();
    expect(glossary).toContain("**Ask message:**");
    expect(glossary).toContain("**Agent-message claim:**");
    expect(glossary).toContain("private channel");
    expect(glossary).toContain("appears pending again");
  });

  it("documents the collaboration milestone and its exact WebMCP entry points", () => {
    const corpus = [
      makeHomepageMarkdown(),
      makeAgentGuideMarkdown(),
      makeWebMcpMarkdown(),
      makeGlossaryMarkdown(),
      makeSkillMarkdown(),
    ].join("\n");

    for (const phrase of [
      "before React hydration",
      "affected canvas bounds",
      "forward compensation",
      "review-before-apply",
      "proposed/accepted/rejected/superseded",
      "open/answered/deferred/closed",
      "privacy-safe semantic JSON",
      "directive-free Mermaid",
      "fixed-vocabulary SVG",
      "PNG",
      "fresh ID",
      "high-entropy",
    ]) {
      expect(corpus).toContain(phrase);
    }

    for (const toolName of [
      "list_activity",
      "read_activity",
      "revert_activity",
      "list_agent_edit_proposals",
      "read_agent_edit_proposal",
      "enable_agent_review",
      "list_agent_messages",
      "claim_agent_message",
      "reply_to_agent_message",
      "export_canvas_artifact",
      "export_canvas_png",
      "create_diagram_template",
      "instantiate_diagram_template",
      "read_snapshot_state",
      "query_snapshot_objects",
      "read_snapshot_diagram",
      "export_snapshot_artifact",
    ]) {
      expect(corpus).toContain(`\`${toolName}\``);
    }

    for (const retiredToolName of [
      "create_readonly_snapshot",
      "list_readonly_snapshots",
      "revoke_readonly_snapshot",
    ]) {
      expect(corpus).not.toContain(`\`${retiredToolName}\``);
    }

    expect(corpus).toContain("image-faithful PNG");
    expect(corpus).toContain("Jazzboard issues no new hosted snapshot URLs");
    expect(corpus).toContain("neither returned by WebMCP nor persisted");
  });

  it("documents authoritative connector routing and visual verification", () => {
    expect(AGENT_DOC_VERSION).toBe("1.16.0");

    const guide = makeAgentGuideMarkdown();
    const reference = makeWebMcpMarkdown();
    const skill = makeSkillMarkdown();
    const corpus = [
      makeHomepageMarkdown(),
      guide,
      reference,
      makeGlossaryMarkdown(),
      makeAgentsMarkdown(),
      skill,
    ].join("\n");

    for (const phrase of [
      "delegates route selection",
      "Generated singleton endpoints",
      "naturally sharing one side",
      "intent-unaware",
      "`straight`",
      "`curved`",
      "`elbow`",
      "`normalizedAnchor`",
      "`isPrecise`",
      "`isExact`",
      "`snap`",
      "`port.side`",
      "`port.position`",
      "`port.exact`",
      "deliberate overlap",
      "freeform",
      "illustration",
      "Diagram membership",
      "graph-aware",
      "`analyze_diagram_layout`",
      "`render_canvas_preview`",
      "boundary, container, plane, region, zone, or background",
    ]) {
      expect(corpus).toContain(phrase);
    }

    expect(guide).toContain("`routing.mode`");
    expect(guide).toContain("`routing.kind`");
    expect(guide).toContain("## Close the diagram-quality loop");
    expect(reference).toContain("Mermaid remains topology-only");
    expect(skill).toContain("Routing and endpoint metadata survive Diagram membership");
    expect(skill).toContain("SVG renders resolved route geometry and labels");
  });

  it("documents the genuine progressive draft lifecycle and its authority boundary", () => {
    const guide = makeAgentGuideMarkdown();
    const reference = makeWebMcpMarkdown();
    const skill = makeSkillMarkdown();
    const corpus = [guide, reference, skill].join("\n");

    for (const phrase of [
      "`delivery.mode`",
      "complete cumulative",
      "create-only",
      "`read_canvas_drafts`",
      "`finish_canvas_draft`",
      "non-authoritative",
      "Spectators",
      "existing-Diagram edits",
      "awaiting review",
      "reserved for the draft's lifetime",
      "reintroducing",
      "`recommendedDraftCorrection`",
      "`update_draft_connector`",
      "only agent-chosen fields",
    ]) {
      expect(corpus).toContain(phrase);
    }
    expect(reference).toContain("not simulated animation");
    expect(skill).toContain("omitted from committed-state queries and exports");
  });

  it("defines the agent-facing canvas coordinate, style, and capability contract", () => {
    const guide = makeAgentGuideMarkdown();
    const reference = makeWebMcpMarkdown();
    const skill = makeSkillMarkdown();
    const corpus = [
      makeLlmsTxt(),
      makeHomepageMarkdown(),
      guide,
      reference,
      makeAgentsMarkdown(),
      skill,
    ].join("\n");

    for (const phrase of [
      "`get_canvas_capabilities`",
      "x increases right",
      "y increases down",
      "unrotated top-left",
      "rotation is in radians",
      "clockwise",
      "Higher `zIndex`",
      "#RRGGBBAA",
      "transparent",
      "saturated ink",
      "pastel",
      "absolute canvas points",
      "object-local points",
      "`create_drawing`",
      "`create_path`",
      "`create_polygon`",
      "line/quadratic/cubic",
      "including `[]`",
      "`inspect_canvas_scope`",
    ]) {
      expect(corpus).toContain(phrase);
    }

    expect(guide).toContain("`Math.PI / 2`");
    expect(guide).toContain("18, 24, 36, and 44 canvas units");
    expect(guide).toContain("3, 4.5, and 6 units");
    expect(reference).toContain("## Canvas authoring contract");
    expect(skill).toContain("do not guess units");
  });

  it("directs new work through one compact fast path without preloading bundles", () => {
    const documents = {
      llms: makeLlmsTxt(),
      homepage: makeHomepageMarkdown(),
      guide: makeAgentGuideMarkdown(),
      reference: makeWebMcpMarkdown(),
      agents: makeAgentsMarkdown(),
      skill: makeSkillMarkdown(),
    };

    for (const [name, body] of Object.entries(documents)) {
      expect(body, `${name} omits architecture quickstart`).toContain("quickstart_architecture");
      expect(body, `${name} omits illustration quickstart`).toContain("quickstart_illustration");
      expect(body, `${name} does not discourage context preloading`).toMatch(/do not preload/i);
      expect(body, `${name} treats bundle guidance as authority`).toMatch(
        /bundles? (?:are|guide)[^\n]*(?:not|never grant) permissions/i,
      );
    }

    for (const [name, body] of Object.entries({
      guide: documents.guide,
      reference: documents.reference,
      skill: documents.skill,
    })) {
      for (const bundle of [
        "authoring",
        "architecture",
        "illustration",
        "inspection",
      ]) {
        expect(body, `${name} omits ${bundle}`).toContain(bundle);
      }
    }

    expect(makeAgentGuideMarkdown()).toContain(
      '`{ "bundle": "quickstart_architecture" }`',
    );
  });

  it("documents semantic identity, compact responses, and scene-context v2 inspection", () => {
    const guide = makeAgentGuideMarkdown();
    const reference = makeWebMcpMarkdown();
    const skill = makeSkillMarkdown();
    const documents = {
      llms: makeLlmsTxt(),
      homepage: makeHomepageMarkdown(),
      guide,
      reference,
      agents: makeAgentsMarkdown(),
      skill,
    };

    for (const [name, body] of Object.entries(documents)) {
      expect(body, `${name} omits semanticName`).toContain("`semanticName`");
      expect(body, `${name} omits semanticRole`).toContain("`semanticRole`");
      expect(body, `${name} omits recommended inspection`).toContain(
        "`recommendedInspection`",
      );
      expect(body, `${name} omits whole-room composition inspection`).toContain(
        "`recommendedCompositionInspection`",
      );
      expect(body, `${name} omits bounded loop termination`).toContain(
        "bounded stagnation",
      );
      expect(body, `${name} lets validation replace creative judgment`).toMatch(
        /creative (?:authority|judgment)/i,
      );
    }

    for (const body of [guide, reference]) {
      for (const phrase of [
        "`responseDetail: concise`",
        "`responseDetail: detailed`",
        "`detail: summary`",
        "`sceneContext`",
        "`schemaVersion: 2`",
        "`overview`",
        "`working_set`",
        "`focus`",
        "`visualContract`",
        "`findingKeys`",
        "`previousFindingKeys`",
        "`boundsOverlaps`",
        "`composition`",
      ]) {
        expect(body).toContain(phrase);
      }
      expect(body).toMatch(/(?:request|opt into) `full` only/i);
      expect(body).toMatch(/overlap[^\n]*(?:not proof|never proof)/i);
      expect(body).toMatch(/exact room/i);
      expect(body).toMatch(/center distance is not edge clearance/i);
      expect(body).toMatch(
        /never a defect verdict|not proof of a defect|never automatic defects|never proof[^\n]*defect/i,
      );
    }

    for (const phrase of [
      "`findingComparison.basis`",
      "`caller_supplied_unverified`",
      "`observedFindingKeysNotSupplied`",
      "`callerSuppliedFindingKeysObservedAgain`",
      "`callerSuppliedSameScopeKeysNotObserved`",
      "`currentFindingCoverageComplete`",
      "`sceneContext.pixels.delivery: host_capture_required`",
      "`nativeImageResultSupported: false`",
      "`visualInspectionStatus: not_performed`",
    ]) {
      expect(guide).toContain(phrase);
    }
  });

  it("requires intent-led geometry interpretation and actual pixel inspection as separate steps", () => {
    const documents = {
      llms: makeLlmsTxt(),
      homepage: makeHomepageMarkdown(),
      guide: makeAgentGuideMarkdown(),
      reference: makeWebMcpMarkdown(),
      agents: makeAgentsMarkdown(),
      skill: makeSkillMarkdown(),
    };

    for (const [name, body] of Object.entries(documents)) {
      expect(body, `${name} omits geometry analysis`).toContain("`analyze_diagram_layout`");
      expect(body, `${name} omits intent limits`).toMatch(/intent-unaware|requested intent/i);
      expect(body, `${name} omits freeform preservation`).toMatch(/freeform|deliberate geometry/i);
      expect(body, `${name} omits preview framing`).toContain("`render_canvas_preview`");
      expect(body, `${name} omits screenshot capture`).toContain("`screenshotClip`");
      expect(body, `${name} omits pixel inspection`).toMatch(/inspect[^\n]*pixels|pixel inspection/i);
      expect(body, `${name} conflates framing and inspection`).toMatch(
        /(?:rendering|framing|validation)[^\n]*(?:not|isn't|does not|do not)[^\n]*(?:inspection|visual QA)|render[^\n]*not[^\n]*visual inspection/i,
      );
    }

    const guide = documents.guide;
    expect(guide).toContain("status as permission to redesign");
    expect(guide).toContain("correct every unintended finding");
    expect(guide).toContain("keep intentional geometry");
    expect(guide).toContain("visualInspectionStatus: not_performed");
    expect(guide).toContain("existing live canvas");
    expect(guide).toContain("without painting a duplicate modal or temporary image surface");
    expect(guide).toMatch(/viewport, browser-window, or scoped-revision change makes the handoff stale/i);
    expect(guide).toContain("persists no image");
    expect(guide).toContain("exposes no preview URL");
    expect(guide).toContain("graph-aware hierarchy layout");
    expect(guide).toContain("explicit ports");
    expect(guide).toMatch(/edit[^\n]*repeat/i);
  });

  it("states the privacy and runtime-authority boundaries across detailed guidance", () => {
    const corpus = [
      makeAgentGuideMarkdown(),
      makeAgentsMarkdown(),
      makeWebMcpMarkdown(),
      makePrivacyMarkdown(),
    ].join("\n");

    expect(corpus).toContain("untrusted");
    expect(corpus).toContain("signed guest session");
    expect(corpus).toContain("server-trusted network scope on Vercel");
    expect(corpus).toContain("stores no raw IP address");
    expect(corpus).toContain("no room- or code-specific rate-limit bucket");
    expect(corpus).toContain("spectator");
    expect(corpus).toContain("live page's registered tool list is authoritative");
    expect(corpus).toContain("no WebMCP tool");
    expect(corpus).toContain("approve or reject");
    expect(corpus).toContain("loosen review mode back to live");
    expect(corpus).toContain("upgrade a spectator");
    expect(corpus).toContain("creating or recovering a hosted snapshot URL");
    expect(corpus).toContain("Jazzboard cannot issue a replacement");
    expect(corpus).toContain("pull-only");
    expect(corpus).toContain("does not wake");
    expect(corpus).toContain("private participant");
    expect(corpus).toContain("submission-time snapshot");
    expect(corpus).not.toMatch(/(?<![\d-])\d{4}(?![\d-])/);
  });

  it("makes progressive completion autonomous and gives agents actionable failure recovery", () => {
    const documents = {
      llms: makeLlmsTxt(),
      guide: makeAgentGuideMarkdown(),
      agents: makeAgentsMarkdown(),
      skill: makeSkillMarkdown(),
    };
    for (const [name, body] of Object.entries(documents)) {
      expect(body, `${name} conflates progressive delivery with review`).toMatch(
        /progressive[^\n]*(?:not human review|not a review request|not human approval|not review)/i,
      );
      expect(body, `${name} omits autonomous finish`).toMatch(
        /finish_canvas_draft[^\n]*(?:without|do not ask|yourself|itself|autonomous)/i,
      );
      expect(body, `${name} omits the real review boundary`).toContain("`outcome: proposed`");
      expect(body, `${name} omits structured recovery`).toContain("`error.recovery`");
      expect(body, `${name} permits unchanged retry`).toMatch(
        /never repeat|do not repeat|rather than repeating|instead of repeating/i,
      );
    }
    for (const code of [
      "INVALID_TOOL_INPUT",
      "REVISION_CONFLICT",
      "OBJECT_BUSY",
      "FORBIDDEN",
      "REQUEST_TOO_LARGE",
      "MUTATION_OUTCOME_UNKNOWN",
    ]) {
      expect(documents.skill).toContain(`\`${code}\``);
    }
    expect(documents.skill).toMatch(/draft baseline conflict[^\n]*cannot be repaired in place/i);
    expect(documents.skill).toMatch(/do not steal the lease/i);
    expect(documents.skill).toMatch(/never use DOM or direct-API bypasses/i);
  });
});
