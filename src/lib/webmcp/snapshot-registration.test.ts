/// <reference types="webmcp-types" />

import { describe, expect, it, vi } from "vitest";

import {
  JAZZBOARD_ARTIFACT_FORMAT,
  JAZZBOARD_ARTIFACT_SCHEMA_URL,
  JAZZBOARD_ARTIFACT_VERSION,
} from "@/lib/interchange/types";
import type { PublicReadonlySnapshot } from "@/lib/server/snapshot-service";

import { JazzboardSnapshotWebMcpRegistrar } from "./snapshot-registration";
import { JAZZBOARD_SNAPSHOT_WEBMCP_TOOL_NAMES } from "./snapshot-tools";

function snapshot(): PublicReadonlySnapshot {
  return {
    title: "Frozen board",
    createdAt: 1,
    expiresAt: 2,
    creator: { displayName: "Maya", kind: "human" },
    artifact: {
      $schema: JAZZBOARD_ARTIFACT_SCHEMA_URL,
      format: JAZZBOARD_ARTIFACT_FORMAT,
      version: JAZZBOARD_ARTIFACT_VERSION,
      kind: "snapshot",
      title: "Frozen board",
      description: "Read only",
      source: { roomRevision: 1, diagramId: null, diagramRevision: null },
      bounds: { x: 0, y: 0, width: 0, height: 0 },
      objects: [],
      diagrams: [],
      warnings: [],
    },
  };
}

describe("snapshot WebMCP registration", () => {
  it("registers once and aborts the entire read-only set on disposal", async () => {
    const registered: Array<{ tool: WebMCP.ModelContextTool; signal: AbortSignal }> = [];
    const modelContext = {
      registerTool: vi.fn(async (tool: WebMCP.ModelContextTool, options: { signal: AbortSignal }) => {
        registered.push({ tool, signal: options.signal });
      }),
    } as unknown as WebMCP.ModelContext;
    const registrar = new JazzboardSnapshotWebMcpRegistrar(() => modelContext);

    await expect(registrar.update(snapshot())).resolves.toEqual({
      supported: true,
      registeredToolNames: [...JAZZBOARD_SNAPSHOT_WEBMCP_TOOL_NAMES],
    });
    expect(registered.map(({ tool }) => tool.name)).toEqual(JAZZBOARD_SNAPSHOT_WEBMCP_TOOL_NAMES);
    expect(registered.every(({ signal }) => !signal.aborted)).toBe(true);

    registrar.dispose();
    expect(registered.every(({ signal }) => signal.aborted)).toBe(true);
  });

  it("reports unsupported without attempting registration", async () => {
    const registrar = new JazzboardSnapshotWebMcpRegistrar(() => undefined);
    await expect(registrar.update(snapshot())).resolves.toEqual({
      supported: false,
      registeredToolNames: [],
    });
  });
});
