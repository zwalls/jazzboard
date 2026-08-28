import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SEMANTIC_CANVAS_TOOLS,
  SEMANTIC_CONNECTOR_DIRECTIONS,
  SEMANTIC_CONNECTOR_ROUTING_MODES,
  SemanticToolPalette,
  type SemanticToolPaletteProps,
} from "./SemanticToolPalette";

const callbacks = {
  onToolChange: vi.fn(),
  onConnectorRoutingChange: vi.fn(),
  onConnectorDirectionChange: vi.fn(),
};

const defaultProps: SemanticToolPaletteProps = {
  activeTool: "select",
  connectorRouting: "auto",
  connectorDirection: "end",
  ...callbacks,
};

const toolLabels: Readonly<Record<(typeof SEMANTIC_CANVAS_TOOLS)[number], string>> = {
  select: "Select tool",
  hand: "Hand tool",
  draw: "Draw tool",
  text: "Text tool",
  rectangle: "Rectangle tool",
  ellipse: "Ellipse tool",
  diamond: "Diamond tool",
  connector: "Connector tool",
  image: "Image tool",
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SemanticToolPalette", () => {
  it("exposes every semantic tool as an accessible controlled button", () => {
    render(<SemanticToolPalette {...defaultProps} />);

    expect(screen.getByRole("toolbar", { name: "Canvas tools" })).toBeVisible();
    for (const tool of SEMANTIC_CANVAS_TOOLS) {
      const button = screen.getByRole("button", { name: toolLabels[tool] });
      expect(button).toHaveAttribute("data-tool", tool);
      expect(button).toHaveAttribute("aria-pressed", tool === "select" ? "true" : "false");
      expect(button.tagName).toBe("BUTTON");
    }
  });

  it("reports exact tool intent, including image, without doing host work itself", () => {
    render(<SemanticToolPalette {...defaultProps} />);

    for (const tool of SEMANTIC_CANVAS_TOOLS) {
      fireEvent.click(screen.getByRole("button", { name: toolLabels[tool] }));
    }

    expect(callbacks.onToolChange.mock.calls).toEqual(
      SEMANTIC_CANVAS_TOOLS.map((tool) => [tool]),
    );
  });

  it("reflects active-tool changes exclusively from controlled props", () => {
    const { rerender } = render(<SemanticToolPalette {...defaultProps} />);
    const draw = screen.getByRole("button", { name: "Draw tool" });

    fireEvent.click(draw);
    expect(callbacks.onToolChange).toHaveBeenCalledWith("draw");
    expect(draw).toHaveAttribute("aria-pressed", "false");

    rerender(<SemanticToolPalette {...defaultProps} activeTool="draw" />);
    expect(screen.getByRole("button", { name: "Draw tool" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Select tool" })).toHaveAttribute("aria-pressed", "false");
  });

  it("offers compact, controlled connector routing and direction choices", () => {
    render(
      <SemanticToolPalette
        {...defaultProps}
        activeTool="connector"
        connectorRouting="curved"
        connectorDirection="both"
      />,
    );

    const toggle = screen.getByRole("button", { name: "Connector options" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveAttribute("aria-haspopup", "dialog");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("dialog", { name: "Connector options" })).toBeVisible();

    for (const routing of SEMANTIC_CONNECTOR_ROUTING_MODES) {
      const label = `${routing[0].toUpperCase()}${routing.slice(1)} connector routing`;
      expect(screen.getByRole("button", { name: label })).toHaveAttribute(
        "aria-pressed",
        routing === "curved" ? "true" : "false",
      );
    }
    expect(screen.getByRole("button", { name: "Both ends direction" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "Elbow connector routing" }));
    fireEvent.click(screen.getByRole("button", { name: "No arrows direction" }));
    expect(callbacks.onConnectorRoutingChange).toHaveBeenCalledWith("elbow");
    expect(callbacks.onConnectorDirectionChange).toHaveBeenCalledWith("none");
  });

  it("closes connector options with Escape, restores focus, and contains the shortcut", () => {
    const canvasKeyDown = vi.fn();
    render(
      <div onKeyDown={canvasKeyDown}>
        <SemanticToolPalette {...defaultProps} activeTool="connector" />
      </div>,
    );

    const toggle = screen.getByRole("button", { name: "Connector options" });
    fireEvent.click(toggle);
    const routing = screen.getByRole("button", { name: "Auto connector routing" });
    routing.focus();
    expect(fireEvent.keyDown(routing, { key: "Escape" })).toBe(false);

    expect(screen.queryByRole("dialog", { name: "Connector options" })).not.toBeInTheDocument();
    expect(toggle).toHaveFocus();
    expect(canvasKeyDown).not.toHaveBeenCalled();
  });

  it("dismisses connector options on pointer-away while preserving internal pointer interactions", () => {
    render(<SemanticToolPalette {...defaultProps} activeTool="connector" />);
    const toggle = screen.getByRole("button", { name: "Connector options" });
    fireEvent.click(toggle);
    const options = screen.getByRole("dialog", { name: "Connector options" });

    fireEvent.pointerDown(options);
    expect(options).toBeVisible();

    fireEvent.pointerDown(screen.getByRole("button", { name: "Rectangle tool" }));
    expect(screen.queryByRole("dialog", { name: "Connector options" })).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(screen.getByRole("dialog", { name: "Connector options" })).toBeVisible();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog", { name: "Connector options" })).not.toBeInTheDocument();
  });

  it("isolates pointer, click, wheel, context-menu, and keyboard traffic from the canvas", () => {
    const canvasEvents = {
      click: vi.fn(),
      contextMenu: vi.fn(),
      doubleClick: vi.fn(),
      keyDown: vi.fn(),
      pointerCancel: vi.fn(),
      pointerDown: vi.fn(),
      pointerMove: vi.fn(),
      pointerUp: vi.fn(),
      wheel: vi.fn(),
    };
    render(
      <div
        onClick={canvasEvents.click}
        onContextMenu={canvasEvents.contextMenu}
        onDoubleClick={canvasEvents.doubleClick}
        onKeyDown={canvasEvents.keyDown}
        onPointerCancel={canvasEvents.pointerCancel}
        onPointerDown={canvasEvents.pointerDown}
        onPointerMove={canvasEvents.pointerMove}
        onPointerUp={canvasEvents.pointerUp}
        onWheel={canvasEvents.wheel}
      >
        <SemanticToolPalette {...defaultProps} />
      </div>,
    );

    const button = screen.getByRole("button", { name: "Rectangle tool" });
    fireEvent.pointerDown(button, { pointerId: 3 });
    fireEvent.pointerMove(button, { pointerId: 3 });
    fireEvent.pointerUp(button, { pointerId: 3 });
    fireEvent.pointerCancel(button, { pointerId: 3 });
    fireEvent.click(button);
    fireEvent.doubleClick(button);
    fireEvent.contextMenu(button);
    fireEvent.wheel(button);
    fireEvent.keyDown(button, { key: "Tab" });

    for (const callback of Object.values(canvasEvents)) {
      expect(callback).not.toHaveBeenCalled();
    }
  });

  it("disables every host intent while preserving its controlled state", () => {
    render(<SemanticToolPalette {...defaultProps} activeTool="image" disabled />);

    for (const tool of SEMANTIC_CANVAS_TOOLS) {
      const button = screen.getByRole("button", { name: toolLabels[tool] });
      expect(button).toBeDisabled();
    }
    expect(screen.getByRole("button", { name: "Image tool" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Connector options" })).toBeDisabled();
    expect(callbacks.onToolChange).not.toHaveBeenCalled();
    expect(SEMANTIC_CONNECTOR_DIRECTIONS).toEqual(["none", "end", "both"]);
  });
});
