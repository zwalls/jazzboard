import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SemanticSceneObject } from "@/lib/canvas/semantic-scene";
import type { ResolvedConnectorRoute } from "@/lib/domain/connector-routing";
import type { ActorRef, CanvasObjectBase, ConnectorObject, ShapeObject, Viewport } from "@/lib/domain/types";

import {
  SEMANTIC_RESIZE_HANDLES,
  SemanticSelectionControls,
  semanticSelectionActionBarPlacement,
  type SemanticSelectionControlsProps,
} from "./SemanticSelectionControls";
import { announceMobileSurfaceOpen } from "./mobile-surface-coordinator";

const actor: ActorRef = {
  participantId: "participant-1",
  displayName: "Ada",
  color: "#5965e8",
  kind: "human",
};

function base(id: string, kind: CanvasObjectBase["kind"]): CanvasObjectBase {
  return {
    id,
    kind,
    x: 140,
    y: 90,
    width: 120,
    height: 60,
    rotation: Math.PI / 6,
    zIndex: 2,
    revision: 4,
    groupId: null,
    diagramIds: [],
    createdAt: 1,
    updatedAt: 2,
    createdBy: actor,
    lastEditedBy: actor,
  };
}

const shape: ShapeObject = {
  ...base("shape-1", "shape"),
  kind: "shape",
  shape: "rectangle",
  nodeType: "service",
  label: "Room API",
  fill: "light-blue",
  stroke: "blue",
};

const secondShape: ShapeObject = {
  ...shape,
  id: "shape-2",
  x: 300,
  y: 180,
  width: 80,
  height: 70,
  rotation: 0,
  groupId: "group-auth",
};

const connector: ConnectorObject = {
  ...base("connector-1", "connector"),
  kind: "connector",
  x: 0,
  y: 0,
  width: 1,
  height: 1,
  rotation: 0,
  start: { x: 150, y: 120, objectId: "shape-1" },
  end: { x: 360, y: 230, objectId: "shape-2" },
  routing: { mode: "elbow", kind: "elbow", bend: 0, elbowMidPoint: 0.5, labelPosition: 0.5 },
  direction: "end",
  label: "request",
  color: "blue",
};

const connectorRoute: ResolvedConnectorRoute = {
  connectorId: connector.id,
  routing: connector.routing!,
  start: connector.start,
  end: connector.end,
  points: [connector.start, { x: 255, y: 120 }, { x: 255, y: 230 }, connector.end],
  arc: null,
  labelPoint: { x: 255, y: 175 },
  pathLength: 320,
  pathBounds: { x: 150, y: 120, width: 210, height: 110 },
  labelBounds: { x: 220, y: 165, width: 70, height: 20 },
  bounds: { x: 150, y: 120, width: 210, height: 110 },
  collisionObjectIds: [],
  crossingCount: 0,
  laneIndex: 0,
  candidateCount: 1,
};

const shapeScene: SemanticSceneObject = {
  object: shape,
  bounds: { x: 133, y: 64, width: 134, height: 112 },
};

const secondShapeScene: SemanticSceneObject = {
  object: secondShape,
  bounds: { x: 300, y: 180, width: 80, height: 70 },
};

const connectorScene: SemanticSceneObject = {
  object: connector,
  bounds: connectorRoute.bounds,
};

const viewport: Viewport = {
  x: 100,
  y: 50,
  width: 400,
  height: 300,
  zoom: 2,
};

const defaultProps: SemanticSelectionControlsProps = {
  selectedObjects: [shapeScene],
  viewport,
  editing: true,
  onTransformPointerStart: vi.fn(),
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function useMobileMediaQuery(): void {
  vi.stubGlobal("matchMedia", vi.fn().mockImplementation((query: string) => ({
    matches: query.includes("max-width"),
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })));
}

describe("SemanticSelectionControls", () => {
  it("moves the action bar below when its preferred position enters the top chrome safe zone", () => {
    expect(semanticSelectionActionBarPlacement(225, 80)).toBe("below");
    expect(semanticSelectionActionBarPlacement(226, 80)).toBe("above");
  });

  it("projects a rotated sole object's semantic geometry through pan and zoom", () => {
    render(<SemanticSelectionControls {...defaultProps} />);

    expect(screen.getByTestId("semantic-selection-frame")).toHaveStyle({
      left: "80px",
      top: "80px",
      width: "240px",
      height: "120px",
      transform: `rotate(${Math.PI / 6}rad)`,
      transformOrigin: "center center",
    });
    expect(screen.getByRole("group", { name: "1 selected canvas object" })).toBeVisible();
  });

  it("uses the engine's canonical rotated-object union for a stable multi-selection frame", () => {
    render(
      <SemanticSelectionControls
        {...defaultProps}
        selectedObjects={[shapeScene, secondShapeScene]}
      />,
    );

    expect(screen.getByTestId("semantic-selection-frame")).toHaveStyle({
      left: "66.07695154599998px",
      top: "28.038475771999998px",
      width: "493.923048454px",
      height: "371.961524228px",
      transform: "rotate(0rad)",
    });
    expect(screen.getByRole("group", { name: "2 selected canvas objects" })).toBeVisible();
  });

  it("renders eight accessible fixed-size resize handles and one rotation handle", () => {
    render(<SemanticSelectionControls {...defaultProps} />);

    for (const handle of SEMANTIC_RESIZE_HANDLES) {
      expect(screen.getByRole("button", { name: `Resize selection from ${handle}` })).toHaveAttribute(
        "data-transform-handle",
        `resize-${handle}`,
      );
    }
    expect(screen.getByRole("button", { name: "Rotate selection" })).toHaveAttribute(
      "data-transform-handle",
      "rotate",
    );
  });

  it("reports synchronous pointer coordinates, identity, and canonical selected IDs", () => {
    const onTransformPointerStart = vi.fn();
    render(
      <SemanticSelectionControls
        {...defaultProps}
        selectedObjects={[shapeScene, secondShapeScene]}
        onTransformPointerStart={onTransformPointerStart}
      />,
    );

    const dispatched = fireEvent.pointerDown(screen.getByRole("button", { name: "Resize selection from south-east" }), {
      pointerId: 42,
      clientX: 810,
      clientY: 615,
    });

    expect(dispatched).toBe(false);
    expect(onTransformPointerStart).toHaveBeenCalledTimes(1);
    expect(onTransformPointerStart).toHaveBeenCalledWith({
      objectIds: ["shape-1", "shape-2"],
      handle: { kind: "resize", handle: "south-east" },
      pointerId: 42,
      clientX: 810,
      clientY: 615,
    });
  });

  it("does not begin a transform or capture authority from a secondary-button press", () => {
    const onTransformPointerStart = vi.fn();
    render(
      <SemanticSelectionControls
        {...defaultProps}
        onTransformPointerStart={onTransformPointerStart}
      />,
    );

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Resize selection from south-east" }),
      { button: 2, pointerId: 42, clientX: 810, clientY: 615 },
    );

    expect(onTransformPointerStart).not.toHaveBeenCalled();
  });

  it("projects connector endpoint handles and reports endpoint intent", () => {
    const onTransformPointerStart = vi.fn();
    render(
      <SemanticSelectionControls
        {...defaultProps}
        selectedObjects={[connectorScene]}
        connectorRoute={connectorRoute}
        onTransformPointerStart={onTransformPointerStart}
      />,
    );

    const start = screen.getByRole("button", { name: "Move connector start endpoint" });
    const end = screen.getByRole("button", { name: "Move connector end endpoint" });
    expect(screen.queryByRole("button", { name: /Resize selection/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rotate selection" })).not.toBeInTheDocument();
    expect(start).toHaveStyle({ left: "100px", top: "140px" });
    expect(end).toHaveStyle({ left: "520px", top: "360px" });

    fireEvent.pointerDown(end, { pointerId: 9, clientX: 520, clientY: 360 });
    expect(onTransformPointerStart).toHaveBeenLastCalledWith({
      objectIds: ["connector-1"],
      handle: { kind: "connector-endpoint", endpoint: "end" },
      pointerId: 9,
      clientX: 520,
      clientY: 360,
    });
  });

  it("offers keyboard transform input without leaking canvas shortcuts", () => {
    const canvasKeyDown = vi.fn();
    const onTransformKeyboardInput = vi.fn();
    render(
      <div onKeyDown={canvasKeyDown}>
        <SemanticSelectionControls
          {...defaultProps}
          onTransformKeyboardInput={onTransformKeyboardInput}
        />
      </div>,
    );

    const handle = screen.getByRole("button", { name: "Rotate selection" });
    expect(fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true })).toBe(false);
    expect(onTransformKeyboardInput).toHaveBeenCalledWith({
      objectIds: ["shape-1"],
      handle: { kind: "rotate" },
      key: "ArrowRight",
      shiftKey: true,
      altKey: false,
    });
    expect(canvasKeyDown).not.toHaveBeenCalled();
  });

  it("stops handle pointer traffic before it reaches the canvas", () => {
    const canvasPointerDown = vi.fn();
    const canvasPointerMove = vi.fn();
    const canvasPointerUp = vi.fn();
    render(
      <div
        onPointerDown={canvasPointerDown}
        onPointerMove={canvasPointerMove}
        onPointerUp={canvasPointerUp}
      >
        <SemanticSelectionControls {...defaultProps} />
      </div>,
    );

    const handle = screen.getByRole("button", { name: "Resize selection from east" });
    fireEvent.pointerDown(handle, { pointerId: 3, clientX: 2, clientY: 4 });
    fireEvent.pointerMove(handle, { pointerId: 3 });
    fireEvent.pointerUp(handle, { pointerId: 3 });

    expect(canvasPointerDown).not.toHaveBeenCalled();
    expect(canvasPointerMove).not.toHaveBeenCalled();
    expect(canvasPointerUp).not.toHaveBeenCalled();
  });

  it("exposes selection actions and host-supplied style controls with exact IDs", () => {
    const callbacks = {
      onDelete: vi.fn(),
      onGroup: vi.fn(),
      onUngroup: vi.fn(),
      onBringForward: vi.fn(),
      onSendBackward: vi.fn(),
    };
    render(
      <SemanticSelectionControls
        {...defaultProps}
        selectedObjects={[shapeScene, secondShapeScene]}
        {...callbacks}
        styleControls={<button type="button">Fill color</button>}
      />,
    );

    expect(screen.getByRole("toolbar", { name: "Selection actions" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Fill color" }));
    fireEvent.click(screen.getByRole("button", { name: "Group" }));
    fireEvent.click(screen.getByRole("button", { name: "Ungroup" }));
    fireEvent.click(screen.getByRole("button", { name: "Bring forward" }));
    fireEvent.click(screen.getByRole("button", { name: "Send backward" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    for (const callback of Object.values(callbacks)) {
      expect(callback).toHaveBeenCalledWith({ objectIds: ["shape-1", "shape-2"] });
    }
  });

  it("moves the complete selection surface into a compact coordinated mobile sheet", () => {
    useMobileMediaQuery();
    const callbacks = {
      onDelete: vi.fn(),
      onGroup: vi.fn(),
      onUngroup: vi.fn(),
      onBringForward: vi.fn(),
      onSendBackward: vi.fn(),
    };
    render(
      <SemanticSelectionControls
        {...defaultProps}
        selectedObjects={[shapeScene, secondShapeScene]}
        {...callbacks}
        styleControls={<button type="button">Fill color</button>}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Style & actions" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("toolbar", { name: "Selection actions" })).not.toBeInTheDocument();

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("dialog", { name: "Selection style and actions" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close selection actions" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Fill color" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ungroup" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Group" }));
    expect(callbacks.onGroup).toHaveBeenCalledWith({ objectIds: ["shape-1", "shape-2"] });
    expect(screen.queryByRole("dialog", { name: "Selection style and actions" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("dismisses the mobile selection sheet by backdrop, Escape, or another mobile surface", () => {
    useMobileMediaQuery();
    render(<SemanticSelectionControls {...defaultProps} onDelete={vi.fn()} />);

    const trigger = screen.getByRole("button", { name: "Style & actions" });
    fireEvent.click(trigger);
    fireEvent.pointerDown(screen.getByTestId("mobile-selection-actions-backdrop"));
    expect(screen.queryByRole("dialog", { name: "Selection style and actions" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Selection style and actions" }), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Selection style and actions" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    fireEvent.click(trigger);
    act(() => announceMobileSurfaceOpen("canvas-tools"));
    expect(screen.queryByRole("dialog", { name: "Selection style and actions" })).not.toBeInTheDocument();
  });

  it("renders nothing for spectators or an empty selection", () => {
    const { rerender } = render(<SemanticSelectionControls {...defaultProps} editing={false} />);
    expect(screen.queryByTestId("semantic-selection-frame")).not.toBeInTheDocument();
    expect(screen.queryByRole("toolbar", { name: "Selection actions" })).not.toBeInTheDocument();

    rerender(<SemanticSelectionControls {...defaultProps} selectedObjects={[]} />);
    expect(screen.queryByTestId("semantic-selection-frame")).not.toBeInTheDocument();
  });
});
