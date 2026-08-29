import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { announceMobileSurfaceOpen } from "./mobile-surface-coordinator";
import { MobileCanvasDock, type MobileCanvasDockProps } from "./MobileCanvasDock";

function renderDock(overrides: Partial<MobileCanvasDockProps> = {}) {
  const props: MobileCanvasDockProps = {
    activeTool: "select",
    canRedo: true,
    canUndo: true,
    connectorDirection: "end",
    connectorRouting: "auto",
    editing: true,
    zoomPercent: 125,
    onConnectorDirectionChange: vi.fn(),
    onConnectorRoutingChange: vi.fn(),
    onFitBoard: vi.fn(),
    onRedo: vi.fn(),
    onToolChange: vi.fn(),
    onUndo: vi.fn(),
    ...overrides,
  };
  render(<MobileCanvasDock {...props} />);
  return props;
}

describe("MobileCanvasDock", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("keeps the compact camera and history controls available", () => {
    const props = renderDock({ canRedo: false, zoomPercent: 87 });
    const dock = screen.getByRole("toolbar", { name: "Mobile canvas controls" });

    expect(within(dock).getByRole("button", { name: /Select active/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(within(dock).getByLabelText("Canvas zoom 87%")).toBeInTheDocument();
    expect(within(dock).getByRole("button", { name: "Redo" })).toBeDisabled();

    fireEvent.click(within(dock).getByRole("button", { name: "Undo" }));
    fireEvent.click(within(dock).getByRole("button", { name: "Fit board" }));
    expect(props.onUndo).toHaveBeenCalledOnce();
    expect(props.onFitBoard).toHaveBeenCalledOnce();
  });

  it("exposes every canvas tool in one coordinated sheet and closes on its backdrop", async () => {
    renderDock();
    const launcher = screen.getByRole("button", { name: /Select active/ });
    fireEvent.click(launcher);

    const sheet = screen.getByRole("dialog", { name: "Canvas tools" });
    const tools = within(sheet).getByRole("toolbar", { name: "All canvas tools" });
    for (const label of [
      "Select and move",
      "Pan canvas",
      "Draw freehand",
      "Add text",
      "Add rectangle",
      "Add ellipse",
      "Add diamond",
      "Connect objects",
      "Add image",
    ]) {
      expect(within(tools).getByRole("button", { name: label })).toBeInTheDocument();
    }

    fireEvent.pointerDown(screen.getByTestId("mobile-tools-backdrop"));
    expect(screen.queryByRole("dialog", { name: "Canvas tools" })).not.toBeInTheDocument();
    await waitFor(() => expect(launcher).toHaveFocus());
  });

  it("keeps connector semantics editable without closing the sheet", () => {
    const props = renderDock({ activeTool: "connector" });
    fireEvent.click(screen.getByRole("button", { name: /Connector active/ }));

    const sheet = screen.getByRole("dialog", { name: "Canvas tools" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Elbow" }));
    fireEvent.click(within(sheet).getByRole("button", { name: "Both ends" }));

    expect(props.onConnectorRoutingChange).toHaveBeenCalledWith("elbow");
    expect(props.onConnectorDirectionChange).toHaveBeenCalledWith("both");
    expect(sheet).toBeInTheDocument();
  });

  it("hands off to another mobile surface and hides mutation controls for spectators", () => {
    const { rerender } = render(
      <MobileCanvasDock
        activeTool="select"
        canRedo={false}
        canUndo={false}
        connectorDirection="end"
        connectorRouting="auto"
        editing
        zoomPercent={100}
        onConnectorDirectionChange={vi.fn()}
        onConnectorRoutingChange={vi.fn()}
        onFitBoard={vi.fn()}
        onRedo={vi.fn()}
        onToolChange={vi.fn()}
        onUndo={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Select active/ }));
    act(() => announceMobileSurfaceOpen("collaboration"));
    expect(screen.queryByRole("dialog", { name: "Canvas tools" })).not.toBeInTheDocument();

    rerender(
      <MobileCanvasDock
        activeTool="select"
        canRedo={false}
        canUndo={false}
        connectorDirection="end"
        connectorRouting="auto"
        editing={false}
        zoomPercent={100}
        onConnectorDirectionChange={vi.fn()}
        onConnectorRoutingChange={vi.fn()}
        onFitBoard={vi.fn()}
        onRedo={vi.fn()}
        onToolChange={vi.fn()}
        onUndo={vi.fn()}
      />,
    );

    const spectatorDock = screen.getByRole("toolbar", { name: "Mobile canvas controls" });
    expect(within(spectatorDock).queryByRole("button", { name: /canvas tool/i })).not.toBeInTheDocument();
    expect(within(spectatorDock).queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
    expect(within(spectatorDock).queryByRole("button", { name: "Redo" })).not.toBeInTheDocument();
    expect(within(spectatorDock).getByRole("button", { name: "Fit board" })).toBeInTheDocument();
  });
});
