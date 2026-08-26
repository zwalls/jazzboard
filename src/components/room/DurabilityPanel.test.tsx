import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { apiRequest } from "@/lib/client/api";
import { downloadTextFile } from "@/lib/client/download";
import type { RoomState } from "@/lib/domain/types";

import { buildArtifactUrl, DurabilityPanel } from "./DurabilityPanel";

vi.mock("@/lib/client/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client/api")>();
  return { ...actual, apiRequest: vi.fn() };
});

vi.mock("@/lib/client/download", () => ({
  downloadTextFile: vi.fn(),
  downloadPngFromSvg: vi.fn(),
  svgDownloadDimensions: vi.fn(() => ({ width: 800, height: 600 })),
}));

const actor = {
  participantId: "person_1",
  displayName: "Ari",
  color: "#5965e8",
  kind: "human" as const,
};

const room: RoomState = {
  id: "room/a b",
  code: "1234",
  title: "Architecture",
  roomRevision: 9,
  createdAt: 1,
  updatedAt: 2,
  participants: {},
  objects: {},
  diagrams: {
    auth: {
      id: "auth",
      title: "Authentication request flow",
      description: "Signed guest session flow",
      diagramType: "flow",
      category: "security",
      tags: ["auth"],
      memberObjectIds: [],
      connectorIds: [],
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      revision: 3,
      createdAt: 1,
      updatedAt: 2,
      createdBy: actor,
      lastEditedBy: actor,
    },
  },
  leases: {},
  spotlight: null,
  agentEditPolicy: "live",
  reviewProposals: [],
};

function renderPanel(role: "participant" | "spectator" = "spectator") {
  return render(
    <DurabilityPanel
      room={room}
      role={role}
      selection={[]}
      getImportOrigin={() => ({ x: 10, y: 20 })}
      acceptRoom={vi.fn()}
      onClose={vi.fn()}
      onAnnounce={vi.fn()}
    />,
  );
}

afterEach(cleanup);

describe("buildArtifactUrl", () => {
  it("encodes room IDs and produces stable, de-duplicated selection queries", () => {
    expect(buildArtifactUrl({
      roomId: "room/a b",
      format: "semantic_json",
      scope: "selection",
      selection: ["node z", "node/a", "node z"],
    })).toBe(
      "/api/rooms/room%2Fa%20b/artifacts?format=semantic_json&scope=selection&objectId=node+z&objectId=node%2Fa",
    );
  });
});

describe("DurabilityPanel", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps spectator sharing passive while exposing safe downloads", () => {
    renderPanel("spectator");

    expect(screen.getByRole("button", { name: "Semantic JSON" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Mermaid" })).toBeDisabled();
    expect(screen.queryByText("Reuse")).not.toBeInTheDocument();
    expect(screen.queryByText("Read-only snapshot")).not.toBeInTheDocument();
    expect(screen.getByText(/Spectators can download passive exports/)).toBeInTheDocument();
  });

  it("downloads the server-projected semantic artifact", async () => {
    vi.mocked(apiRequest).mockResolvedValue({
      ok: true,
      export: {
        format: "semantic_json",
        mediaType: "application/vnd.jazzboard.semantic+json",
        filename: "architecture.jazzboard.json",
        content: '{"schemaVersion":"1.0"}',
        warnings: [],
        sourceRoomRevision: 9,
        sourceDiagramRevision: null,
      },
    });
    renderPanel("spectator");

    fireEvent.click(screen.getByRole("button", { name: "Semantic JSON" }));

    await waitFor(() => expect(downloadTextFile).toHaveBeenCalledWith({
      content: '{"schemaVersion":"1.0"}',
      filename: "architecture.jazzboard.json",
      mimeType: "application/vnd.jazzboard.semantic+json",
    }));
    expect(apiRequest).toHaveBeenCalledWith(
      "/api/rooms/room%2Fa%20b/artifacts?format=semantic_json&scope=room",
    );
  });

  it("enables Diagram-only Mermaid and template workflows for participants", async () => {
    vi.mocked(apiRequest).mockResolvedValue({ ok: true, snapshots: [] });
    renderPanel("participant");

    fireEvent.click(screen.getByRole("button", { name: "Diagram" }));

    expect(screen.getByRole("button", { name: "Mermaid" })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Save diagram template/ })).toBeEnabled();
    expect(screen.getByText("Read-only snapshot")).toBeInTheDocument();
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith(
      "/api/rooms/room%2Fa%20b/snapshots",
      expect.objectContaining({ method: "GET" }),
    ));
  });
});
