import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CanvasRuntime } from "@/lib/canvas/runtime";
import { apiRequest } from "@/lib/client/api";
import { downloadCanvasPng, downloadTextFile } from "@/lib/client/download";
import type { RoomState } from "@/lib/domain/types";

import { buildArtifactUrl, DurabilityPanel } from "./DurabilityPanel";

vi.mock("@/lib/client/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client/api")>();
  return { ...actual, apiRequest: vi.fn() };
});

vi.mock("@/lib/client/download", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client/download")>();
  return {
    ...actual,
    downloadTextFile: vi.fn(),
    downloadCanvasPng: vi.fn().mockResolvedValue({
      filename: "architecture.png",
      width: 1600,
      height: 1200,
      byteLength: 42,
      warnings: [],
    }),
  };
});

const actor = {
  participantId: "person_1",
  displayName: "Ari",
  color: "#5965e8",
  kind: "human" as const,
};

const room: RoomState = {
  id: "room/a b",
  code: "ABC234",
  title: "Architecture",
  roomRevision: 9,
  createdAt: 1,
  updatedAt: 2,
  participants: {},
  objects: {
    "node-a": {
      id: "node-a",
      kind: "text",
      x: 40,
      y: 80,
      width: 240,
      height: 64,
      rotation: 0,
      zIndex: 1,
      groupId: null,
      diagramIds: ["auth"],
      revision: 1,
      createdAt: 1,
      updatedAt: 2,
      createdBy: actor,
      lastEditedBy: actor,
      content: "Architecture",
      color: "black",
      size: "m",
      align: "middle",
    },
    "node-b": {
      id: "node-b",
      kind: "text",
      x: 400,
      y: 80,
      width: 240,
      height: 64,
      rotation: 0,
      zIndex: 2,
      groupId: null,
      diagramIds: ["auth"],
      revision: 2,
      createdAt: 1,
      updatedAt: 2,
      createdBy: actor,
      lastEditedBy: actor,
      content: "Room API",
      color: "black",
      size: "m",
      align: "middle",
    },
    edge: {
      id: "edge",
      kind: "connector",
      x: 280,
      y: 112,
      width: 120,
      height: 1,
      rotation: 0,
      zIndex: 3,
      groupId: null,
      diagramIds: ["auth"],
      revision: 4,
      createdAt: 1,
      updatedAt: 2,
      createdBy: actor,
      lastEditedBy: actor,
      start: { x: 280, y: 112, objectId: "node-a" },
      end: { x: 400, y: 112, objectId: "node-b" },
      direction: "end",
      label: "authorizes",
      color: "black",
    },
    outside: {
      id: "outside",
      kind: "text",
      x: 40,
      y: 320,
      width: 240,
      height: 64,
      rotation: 0,
      zIndex: 4,
      groupId: null,
      diagramIds: [],
      revision: 1,
      createdAt: 1,
      updatedAt: 2,
      createdBy: actor,
      lastEditedBy: actor,
      content: "Outside diagram",
      color: "black",
      size: "m",
      align: "middle",
    },
  },
  diagrams: {
    auth: {
      id: "auth",
      title: "Authentication request flow",
      description: "Signed guest session flow",
      diagramType: "flow",
      category: "security",
      tags: ["auth"],
      memberObjectIds: ["node-a", "node-b"],
      connectorIds: ["edge"],
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

function renderPanel(
  role: "participant" | "spectator" = "spectator",
  mode: "share" | "export" = "export",
  onAnnounce = vi.fn(),
  options: {
    sourceRoom?: RoomState;
    selection?: string[];
    runtime?: CanvasRuntime | null;
  } = {},
) {
  const sourceRoom = options.sourceRoom ?? room;
  const selectedIds = [...new Set(options.selection ?? [])];
  const objectIds = Object.keys(sourceRoom.objects);
  const defaultRuntime = {
    rendererId: "jazzboard-semantic-v1",
    capabilities: { renderPng: true },
    getDocumentObjectIds: () => objectIds,
    getSelectedObjectIds: () => selectedIds,
    hasObject: (objectId: string) => objectIds.includes(objectId),
    onDocumentChange: vi.fn(() => vi.fn()),
  } as unknown as CanvasRuntime;
  return render(
    <DurabilityPanel
      mode={mode}
      room={sourceRoom}
      role={role}
      selection={options.selection ?? []}
      runtime={options.runtime === undefined ? defaultRuntime : options.runtime}
      getImportOrigin={() => ({ x: 10, y: 20 })}
      acceptRoom={vi.fn()}
      onClose={vi.fn()}
      onAnnounce={onAnnounce}
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
    expect(screen.queryByText("Share read-only")).not.toBeInTheDocument();
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

  it("downloads PNG directly from the active faithful canvas renderer without requesting redacted SVG", async () => {
    const onAnnounce = vi.fn();
    renderPanel("spectator", "export", onAnnounce);

    fireEvent.click(screen.getByRole("button", { name: "PNG" }));

    await waitFor(() => expect(downloadCanvasPng).toHaveBeenCalledWith({
      runtime: expect.anything(),
      objectIds: ["node-a", "node-b", "edge", "outside"],
      filename: "architecture.png",
      signal: expect.any(AbortSignal),
    }));
    expect(apiRequest).not.toHaveBeenCalled();
    expect(onAnnounce).toHaveBeenCalledWith("PNG downloaded.");
  });

  it("exports only the selected Diagram members and semantic connectors", async () => {
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Diagram" }));
    fireEvent.click(screen.getByRole("button", { name: "PNG" }));

    await waitFor(() => expect(downloadCanvasPng).toHaveBeenCalledWith({
      runtime: expect.anything(),
      objectIds: ["node-a", "node-b", "edge"],
      filename: "authentication-request-flow.png",
      signal: expect.any(AbortSignal),
    }));
  });

  it("exports only the exact current selection", async () => {
    renderPanel("spectator", "export", vi.fn(), { selection: ["outside", "node-a", "outside"] });

    fireEvent.click(screen.getByRole("button", { name: /Selection/ }));
    fireEvent.click(screen.getByRole("button", { name: "PNG" }));

    await waitFor(() => expect(downloadCanvasPng).toHaveBeenCalledWith({
      runtime: expect.anything(),
      objectIds: ["outside", "node-a"],
      filename: "architecture-selection.png",
      signal: expect.any(AbortSignal),
    }));
  });

  it("explains why PNG is unavailable for an empty board", () => {
    renderPanel("spectator", "export", vi.fn(), {
      sourceRoom: { ...room, objects: {}, diagrams: {} },
    });

    expect(screen.getByRole("button", { name: "PNG" })).toBeDisabled();
    expect(screen.getByText(/PNG becomes available when this scope contains a visible canvas object/)).toBeInTheDocument();
  });

  it("shows a PNG failure and allows a successful retry", async () => {
    const onAnnounce = vi.fn();
    vi.mocked(downloadCanvasPng).mockRejectedValueOnce(new Error("The image could not be rendered."));
    renderPanel("spectator", "export", onAnnounce);

    fireEvent.click(screen.getByRole("button", { name: "PNG" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The image could not be rendered.");

    fireEvent.click(screen.getByRole("button", { name: "PNG" }));
    await waitFor(() => expect(onAnnounce).toHaveBeenCalledWith("PNG downloaded."));
    expect(downloadCanvasPng).toHaveBeenCalledTimes(2);
  });

  it("cancels an in-flight PNG before the panel unmounts", async () => {
    let finishDownload!: () => void;
    vi.mocked(downloadCanvasPng).mockImplementationOnce(() => new Promise((resolve) => {
      finishDownload = () => resolve({
        filename: "architecture.png",
        width: 1600,
        height: 1200,
        byteLength: 42,
        warnings: [],
      });
    }));
    const onAnnounce = vi.fn();
    const panel = renderPanel("spectator", "export", onAnnounce);

    fireEvent.click(screen.getByRole("button", { name: "PNG" }));
    await waitFor(() => expect(downloadCanvasPng).toHaveBeenCalledOnce());
    const signal = vi.mocked(downloadCanvasPng).mock.calls[0][0].signal;
    expect(signal?.aborted).toBe(false);

    panel.unmount();
    expect(signal?.aborted).toBe(true);
    finishDownload();
    await Promise.resolve();
    expect(onAnnounce).not.toHaveBeenCalled();
  });

  it("enables Diagram-only Mermaid and template workflows for participants", async () => {
    renderPanel("participant");

    fireEvent.click(screen.getByRole("button", { name: "Diagram" }));

    expect(screen.getByRole("button", { name: "Mermaid" })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Save diagram template/ })).toBeEnabled();
    expect(screen.queryByText("Share read-only")).not.toBeInTheDocument();
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it("keeps live invitations separate from local exports", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const onAnnounce = vi.fn();
    renderPanel("participant", "share", onAnnounce);

    expect(screen.getByRole("complementary", { name: "Share board" })).toBeInTheDocument();
    expect(screen.getByText("Collaborate live")).toBeInTheDocument();
    expect(screen.queryByText("Share read-only")).not.toBeInTheDocument();
    expect(screen.getByText(/use Export → PNG/)).toBeInTheDocument();
    expect(screen.getByText("ABC-234")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Semantic JSON" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy invite" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("http://localhost:3000/#join=ABC234"),
    ));
    expect(onAnnounce).toHaveBeenCalledWith("Live collaboration invite copied.");
    expect(apiRequest).not.toHaveBeenCalled();
  });
});
