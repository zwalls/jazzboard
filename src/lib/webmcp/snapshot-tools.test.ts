/// <reference types="webmcp-types" />

import { describe, expect, it } from "vitest";

import {
  JAZZBOARD_ARTIFACT_FORMAT,
  JAZZBOARD_ARTIFACT_SCHEMA_URL,
  JAZZBOARD_ARTIFACT_VERSION,
  type JazzboardSemanticArtifactV1,
} from "@/lib/interchange/types";
import type { PublicReadonlySnapshot } from "@/lib/server/snapshot-service";

import {
  createJazzboardSnapshotWebMcpTools,
  JAZZBOARD_SNAPSHOT_WEBMCP_TOOL_NAMES,
} from "./snapshot-tools";
import type { JazzboardToolResult } from "./types";

const attribution = { displayName: "Maya", kind: "agent" as const };
const base = {
  y: 100,
  width: 180,
  height: 80,
  rotation: 0,
  zIndex: 1,
  groupId: null,
  revision: 2,
  createdAt: 1_000,
  updatedAt: 2_000,
  createdBy: attribution,
  lastEditedBy: attribution,
};

function artifact(): JazzboardSemanticArtifactV1 {
  return {
    $schema: JAZZBOARD_ARTIFACT_SCHEMA_URL,
    format: JAZZBOARD_ARTIFACT_FORMAT,
    version: JAZZBOARD_ARTIFACT_VERSION,
    kind: "snapshot",
    title: "Authentication request flow",
    description: "Shows how the web client, room API, authorization, and Redis interact.",
    source: { roomRevision: 12, diagramId: "diagram_auth", diagramRevision: 4 },
    bounds: { x: 40, y: 100, width: 700, height: 80 },
    objects: [
      {
        ...base,
        id: "web-client",
        kind: "shape",
        x: 40,
        shape: "rectangle",
        nodeType: "component",
        nodeMetadata: null,
        label: "Web client",
        fill: "blue",
        stroke: "blue",
      },
      {
        ...base,
        id: "room-api",
        kind: "shape",
        x: 520,
        shape: "rectangle",
        nodeType: "service",
        nodeMetadata: null,
        label: "Room API",
        fill: "green",
        stroke: "green",
      },
      {
        ...base,
        id: "client-to-api",
        kind: "connector",
        x: 220,
        width: 300,
        height: 1,
        start: { x: 220, y: 140, objectId: "web-client" },
        end: { x: 520, y: 140, objectId: "room-api" },
        direction: "end",
        label: "authorized request",
        color: "black",
      },
      {
        ...base,
        id: "unrelated-note",
        kind: "text",
        x: 1_200,
        content: "Not part of the diagram",
        color: "black",
        size: "m",
        align: "start",
      },
    ],
    diagrams: [
      {
        id: "diagram_auth",
        title: "Authentication request flow",
        description: "Browser to authorized room API",
        diagramType: "flow",
        category: "security",
        tags: ["authorization"],
        memberObjectIds: ["web-client", "room-api"],
        connectorIds: ["client-to-api"],
        bounds: { x: 40, y: 100, width: 660, height: 80 },
        revision: 4,
        createdAt: 1_000,
        updatedAt: 2_000,
        createdBy: attribution,
        lastEditedBy: attribution,
      },
    ],
    warnings: [],
  };
}

function snapshot(): PublicReadonlySnapshot {
  return {
    title: "Authentication request flow",
    createdAt: 1_000,
    expiresAt: 10_000,
    creator: attribution,
    artifact: artifact(),
  };
}

function tool(tools: WebMCP.ModelContextTool[], name: string) {
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing ${name}`);
  return found;
}

async function execute(
  tools: WebMCP.ModelContextTool[],
  name: string,
  input: Record<string, unknown>,
): Promise<JazzboardToolResult> {
  return (await tool(tools, name).execute(input, {
    signal: new AbortController().signal,
  })) as JazzboardToolResult;
}

describe("snapshot WebMCP tools", () => {
  it("exposes exactly four truthfully read-only tools", () => {
    const tools = createJazzboardSnapshotWebMcpTools({ snapshot: snapshot() });

    expect(tools.map((candidate) => candidate.name)).toEqual(JAZZBOARD_SNAPSHOT_WEBMCP_TOOL_NAMES);
    for (const candidate of tools) {
      expect(candidate.annotations).toEqual({ readOnlyHint: true, untrustedContentHint: true });
    }
  });

  it("reads the frozen semantic artifact without any room session identifiers", async () => {
    const tools = createJazzboardSnapshotWebMcpTools({ snapshot: snapshot() });
    const result = await execute(tools, "read_snapshot_state", {});
    const serialized = JSON.stringify(result);

    expect(result).toMatchObject({
      ok: true,
      data: {
        snapshot: { title: "Authentication request flow", creator: attribution },
        artifact: { kind: "snapshot", source: { roomRevision: 12 } },
      },
    });
    for (const forbidden of ["room_private", "4242", "participantId", "sourceUrl"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("queries by semantic text, classification, Diagram membership, and region", async () => {
    const tools = createJazzboardSnapshotWebMcpTools({ snapshot: snapshot() });
    const result = await execute(tools, "query_snapshot_objects", {
      text: "api",
      kinds: ["shape"],
      nodeTypes: ["service"],
      diagramId: "diagram_auth",
      region: { x: 500, y: 50, width: 300, height: 200 },
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        totalMatched: 1,
        returned: 1,
        objects: [{ id: "room-api", nodeType: "service" }],
        frozen: true,
      },
    });
  });

  it("reads one Diagram neighborhood without unrelated objects", async () => {
    const tools = createJazzboardSnapshotWebMcpTools({ snapshot: snapshot() });
    const result = await execute(tools, "read_snapshot_diagram", { diagramId: "diagram_auth" });

    expect(result).toMatchObject({
      ok: true,
      data: {
        diagram: { id: "diagram_auth", revision: 4 },
        members: [{ id: "web-client" }, { id: "room-api" }],
        connectors: [{ id: "client-to-api" }],
        frozen: true,
      },
    });
    expect(JSON.stringify(result)).not.toContain("unrelated-note");
  });

  it("exports canonical JSON, Mermaid, and safe SVG without side effects", async () => {
    const tools = createJazzboardSnapshotWebMcpTools({ snapshot: snapshot() });

    await expect(execute(tools, "export_snapshot_artifact", { format: "semantic_json" })).resolves.toMatchObject({
      ok: true,
      data: {
        filename: "authentication-request-flow.jazzboard.json",
        mimeType: "application/vnd.jazzboard.semantic+json",
        content: expect.stringContaining('"kind": "snapshot"'),
      },
    });
    await expect(
      execute(tools, "export_snapshot_artifact", { format: "mermaid", diagramId: "diagram_auth" }),
    ).resolves.toMatchObject({
      ok: true,
      data: { mimeType: "text/vnd.mermaid", content: expect.stringContaining("flowchart LR") },
    });
    await expect(execute(tools, "export_snapshot_artifact", { format: "svg" })).resolves.toMatchObject({
      ok: true,
      data: { mimeType: "image/svg+xml", content: expect.stringContaining("<svg") },
    });
  });

  it("returns semantic failures for unknown diagrams and invalid schemas", async () => {
    const tools = createJazzboardSnapshotWebMcpTools({ snapshot: snapshot() });

    await expect(
      execute(tools, "read_snapshot_diagram", { diagramId: "diagram_missing" }),
    ).resolves.toMatchObject({ ok: false, error: { code: "DIAGRAM_NOT_FOUND" } });
    await expect(execute(tools, "query_snapshot_objects", { limit: 201 })).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_TOOL_INPUT" },
    });
  });
});
