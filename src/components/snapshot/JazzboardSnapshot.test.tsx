/// <reference types="webmcp-types" />

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  JAZZBOARD_ARTIFACT_FORMAT,
  JAZZBOARD_ARTIFACT_SCHEMA_URL,
  JAZZBOARD_ARTIFACT_VERSION,
} from "@/lib/interchange/types";
import type { PublicReadonlySnapshot } from "@/lib/server/snapshot-service";

import { JazzboardSnapshot } from "./JazzboardSnapshot";

function snapshot(): PublicReadonlySnapshot {
  const attribution = { displayName: "Maya", kind: "agent" as const };
  return {
    title: "Authentication request flow",
    createdAt: Date.parse("2026-08-26T12:00:00.000Z"),
    expiresAt: Date.parse("2026-08-27T12:00:00.000Z"),
    creator: attribution,
    artifact: {
      $schema: JAZZBOARD_ARTIFACT_SCHEMA_URL,
      format: JAZZBOARD_ARTIFACT_FORMAT,
      version: JAZZBOARD_ARTIFACT_VERSION,
      kind: "snapshot",
      title: "Authentication request flow",
      description: "Shows the browser-to-API authorization path.",
      source: { roomRevision: 8, diagramId: "diagram_auth", diagramRevision: 2 },
      bounds: { x: 0, y: 0, width: 240, height: 100 },
      objects: [
        {
          id: "room-api",
          kind: "shape",
          x: 0,
          y: 0,
          width: 240,
          height: 100,
          rotation: 0,
          zIndex: 1,
          groupId: null,
          revision: 2,
          createdAt: 1,
          updatedAt: 2,
          createdBy: attribution,
          lastEditedBy: attribution,
          shape: "rectangle",
          nodeType: "service",
          nodeMetadata: null,
          label: "Room API",
          fill: "blue",
          stroke: "blue",
        },
      ],
      diagrams: [
        {
          id: "diagram_auth",
          title: "Authentication request flow",
          description: "One service for the fixture.",
          diagramType: "flow",
          category: "security",
          tags: ["authorization"],
          memberObjectIds: ["room-api"],
          connectorIds: [],
          bounds: { x: 0, y: 0, width: 240, height: 100 },
          revision: 2,
          createdAt: 1,
          updatedAt: 2,
          createdBy: attribution,
          lastEditedBy: attribution,
        },
      ],
      warnings: [],
    },
  };
}

describe("JazzboardSnapshot", () => {
  afterEach(() => {
    cleanup();
    Object.defineProperty(document, "modelContext", { configurable: true, value: undefined });
  });

  it("renders a frozen semantic view and registers only the four snapshot tools", async () => {
    const registered: Array<{ tool: WebMCP.ModelContextTool; signal: AbortSignal }> = [];
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: {
        registerTool: vi.fn(async (tool: WebMCP.ModelContextTool, options?: { signal?: AbortSignal }) => {
          registered.push({ tool, signal: options?.signal ?? new AbortController().signal });
        }),
      } as unknown as WebMCP.ModelContext,
    });

    const view = render(<JazzboardSnapshot snapshot={snapshot()} />);

    expect(screen.getByRole("heading", { level: 1, name: "Authentication request flow" })).toBeVisible();
    expect(screen.getByText("Frozen and immutable")).toBeVisible();
    expect(screen.getByRole("img", { name: "Frozen canvas: Authentication request flow" })).toBeVisible();
    expect(screen.getByText("Room API")).toBeVisible();
    expect(screen.getByRole("link", { name: "Semantic JSON" })).toHaveAttribute("download");
    expect(screen.getByRole("link", { name: "Safe SVG" })).toHaveAttribute("download");
    expect(screen.getByRole("link", { name: "Mermaid" })).toHaveAttribute("download");

    await waitFor(() => expect(registered).toHaveLength(4));
    expect(registered.map(({ tool }) => tool.name)).toEqual([
      "read_snapshot_state",
      "query_snapshot_objects",
      "read_snapshot_diagram",
      "export_snapshot_artifact",
    ]);
    expect(registered.every(({ tool }) => tool.annotations?.readOnlyHint === true)).toBe(true);
    expect(document.body.textContent).not.toContain("participantId");
    expect(document.body.textContent).not.toContain("room_private");

    view.unmount();
    expect(registered.every(({ signal }) => signal.aborted)).toBe(true);
  });
});
