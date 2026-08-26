/// <reference types="webmcp-types" />

import { describe, expect, it, vi } from "vitest";

import {
  createJazzboardSnapshotRoomWebMcpTools,
  JAZZBOARD_SNAPSHOT_ROOM_TOOL_NAMES,
} from "./snapshot-room-tools";
import type { JazzboardToolResult, JazzboardWebMcpBinding, WebMcpRequest } from "./types";

function binding(role: "participant" | "spectator" = "participant"): JazzboardWebMcpBinding {
  return {
    roomId: "room/a b",
    participantId: "p_owner",
    role,
    context: {
      getRoom: () => null,
      getSelection: () => [],
      getViewport: () => null,
      getFollowTarget: () => null,
      acceptRoom: () => undefined,
      setFollowTarget: () => undefined,
      setDeclinedSpotlight: () => undefined,
      leaveRoomView: () => undefined,
    },
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

describe("room snapshot WebMCP tools", () => {
  it("registers all lifecycle tools only for participants with truthful annotations", () => {
    const participantTools = createJazzboardSnapshotRoomWebMcpTools(binding());
    const spectatorTools = createJazzboardSnapshotRoomWebMcpTools(binding("spectator"));

    expect(participantTools.map((candidate) => candidate.name)).toEqual(JAZZBOARD_SNAPSHOT_ROOM_TOOL_NAMES);
    expect(spectatorTools).toEqual([]);
    expect(tool(participantTools, "list_readonly_snapshots").annotations).toEqual({
      readOnlyHint: true,
      untrustedContentHint: true,
    });
    expect(tool(participantTools, "create_readonly_snapshot").annotations).toEqual({
      untrustedContentHint: true,
    });
    expect(tool(participantTools, "revoke_readonly_snapshot").annotations).toEqual({
      untrustedContentHint: true,
    });
  });

  it("uses only the signed-session agent endpoint for create, list, and revoke", async () => {
    const request = vi.fn(async () => ({ ok: true })) as unknown as WebMcpRequest;
    const tools = createJazzboardSnapshotRoomWebMcpTools(binding(), { request });
    const url = "/api/rooms/room%2Fa%20b/agent/snapshots";

    await execute(tools, "create_readonly_snapshot", {
      expectedRoomRevision: 8,
      scope: { kind: "diagram", diagramId: "diagram_auth", expectedDiagramRevision: 3 },
      expiresInHours: 48,
    });
    expect(request).toHaveBeenLastCalledWith(url, {
      method: "POST",
      body: JSON.stringify({
        expectedRoomRevision: 8,
        scope: { kind: "diagram", diagramId: "diagram_auth", expectedDiagramRevision: 3 },
        expiresInHours: 48,
      }),
      signal: expect.any(AbortSignal),
    });

    await execute(tools, "list_readonly_snapshots", {});
    expect(request).toHaveBeenLastCalledWith(url, {
      method: "GET",
      signal: expect.any(AbortSignal),
    });

    const snapshotId = "snapshot_44444444-4444-4444-8444-444444444444";
    await execute(tools, "revoke_readonly_snapshot", { snapshotId });
    expect(request).toHaveBeenLastCalledWith(url, {
      method: "DELETE",
      body: JSON.stringify({ snapshotId }),
      signal: expect.any(AbortSignal),
    });
  });

  it("defaults expiration to 24 hours and rejects unsafe or ambiguous inputs locally", async () => {
    const request = vi.fn(async () => ({ ok: true })) as unknown as WebMcpRequest;
    const tools = createJazzboardSnapshotRoomWebMcpTools(binding(), { request });

    await execute(tools, "create_readonly_snapshot", {
      expectedRoomRevision: 8,
      scope: { kind: "room" },
    });
    expect(request).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      body: JSON.stringify({ expectedRoomRevision: 8, scope: { kind: "room" }, expiresInHours: 24 }),
    }));

    await expect(
      execute(tools, "create_readonly_snapshot", {
        expectedRoomRevision: 8,
        scope: { kind: "diagram", diagramId: "diagram_auth" },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "INVALID_TOOL_INPUT" } });
    await expect(
      execute(tools, "revoke_readonly_snapshot", { snapshotId: "room_private" }),
    ).resolves.toMatchObject({ ok: false, error: { code: "INVALID_TOOL_INPUT" } });
  });
});
