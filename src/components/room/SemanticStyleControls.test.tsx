import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ActorRef,
  CanvasObject,
  CanvasObjectBase,
  ConnectorObject,
  DrawObject,
  ImageObject,
  ShapeObject,
  TextObject,
} from "@/lib/domain/types";

import {
  SemanticStyleControls,
  type SemanticStyleControlsProps,
} from "./SemanticStyleControls";

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
    x: 100,
    y: 80,
    width: 160,
    height: 80,
    rotation: 0,
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

function text(overrides: Partial<TextObject> = {}): TextObject {
  return {
    ...base("text-1", "text"),
    kind: "text",
    content: "Architecture",
    color: "black",
    size: "m",
    align: "start",
    ...overrides,
  };
}

function shape(overrides: Partial<ShapeObject> = {}): ShapeObject {
  return {
    ...base("shape-1", "shape"),
    kind: "shape",
    shape: "rectangle",
    nodeType: "service",
    label: "Room API",
    fill: "light-blue",
    stroke: "blue",
    ...overrides,
  };
}

function connector(overrides: Partial<ConnectorObject> = {}): ConnectorObject {
  return {
    ...base("connector-1", "connector"),
    kind: "connector",
    start: { x: 100, y: 100, objectId: "shape-1" },
    end: { x: 400, y: 100, objectId: null },
    routing: {
      mode: "straight",
      kind: "straight",
      bend: 0,
      elbowMidPoint: 0.5,
      labelPosition: 0.35,
    },
    direction: "end",
    label: "request",
    color: "black",
    ...overrides,
  };
}

function draw(overrides: Partial<DrawObject> = {}): DrawObject {
  return {
    ...base("draw-1", "draw"),
    kind: "draw",
    points: [{ x: 0, y: 0 }, { x: 20, y: 20 }],
    color: "red",
    size: "m",
    ...overrides,
  };
}

function image(overrides: Partial<ImageObject> = {}): ImageObject {
  return {
    ...base("image-1", "image"),
    kind: "image",
    url: "/api/rooms/room-1/assets/asset-1",
    assetId: "asset-1",
    alt: "System map",
    mimeType: "image/png",
    sourceUrl: null,
    locked: false,
    ...overrides,
  };
}

const callbacks = {
  onStylePatch: vi.fn<SemanticStyleControlsProps["onStylePatch"]>(),
  onEditRequest: vi.fn<SemanticStyleControlsProps["onEditRequest"]>(),
};

function renderControls(
  selectedObjects: readonly CanvasObject[],
  overrides: Partial<SemanticStyleControlsProps> = {},
) {
  return render(
    <SemanticStyleControls
      selectedObjects={selectedObjects}
      editing
      {...callbacks}
      {...overrides}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SemanticStyleControls", () => {
  it("reflects text fields and emits exact color, size, alignment, and content-edit intent", () => {
    const { rerender } = renderControls([text()]);

    expect(screen.getByRole("toolbar", { name: "Text styles for 1 selected object" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Text color: black" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("combobox", { name: "Text size" })).toHaveValue("m");
    expect(screen.getByRole("button", { name: "Align left" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "Text color: black" }));
    fireEvent.click(screen.getByRole("button", { name: "Violet text color" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Text size" }), { target: { value: "xl" } });
    fireEvent.click(screen.getByRole("button", { name: "Align center" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit text" }));

    expect(callbacks.onStylePatch.mock.calls).toEqual([
      [{ kind: "text", color: "violet" }],
      [{ kind: "text", size: "xl" }],
      [{ kind: "text", align: "middle" }],
    ]);
    expect(callbacks.onEditRequest).toHaveBeenCalledWith({
      objectKind: "text",
      field: "content",
      objectIds: ["text-1"],
    });

    rerender(
      <SemanticStyleControls
        selectedObjects={[text({ color: "violet", size: "xl", align: "middle" })]}
        editing
        {...callbacks}
      />,
    );
    expect(screen.getByRole("button", { name: "Text color: violet" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Text size" })).toHaveValue("xl");
    expect(screen.getByRole("button", { name: "Align center" })).toHaveAttribute("aria-pressed", "true");
  });

  it("exposes shape fill, stroke, explicit node classification, and label editing", () => {
    renderControls([shape()]);

    fireEvent.click(screen.getByRole("button", { name: "Fill: light-blue" }));
    fireEvent.click(screen.getByRole("button", { name: "No fill" }));
    fireEvent.click(screen.getByRole("button", { name: "Stroke: blue" }));
    fireEvent.click(screen.getByRole("button", { name: "Red stroke" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Node type" }), {
      target: { value: "decision" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Edit label" }));

    expect(callbacks.onStylePatch.mock.calls).toEqual([
      [{ kind: "shape", fill: "none" }],
      [{ kind: "shape", stroke: "red" }],
      [{ kind: "shape", nodeType: "decision" }],
    ]);
    expect(callbacks.onEditRequest).toHaveBeenCalledWith({
      objectKind: "shape",
      field: "label",
      objectIds: ["shape-1"],
    });
  });

  it("emits connector color, deterministic routing intent, direction, and label requests", () => {
    renderControls([connector()]);

    fireEvent.click(screen.getByRole("button", { name: "Line color: black" }));
    fireEvent.click(screen.getByRole("button", { name: "Green line color" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Connector routing" }), {
      target: { value: "curved" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Both ends" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit label" }));

    expect(callbacks.onStylePatch.mock.calls).toEqual([
      [{ kind: "connector", color: "green" }],
      [{ kind: "connector", routing: { mode: "curved", bend: 64, labelPosition: 0.35 } }],
      [{ kind: "connector", direction: "both" }],
    ]);
    expect(callbacks.onEditRequest).toHaveBeenCalledWith({
      objectKind: "connector",
      field: "label",
      objectIds: ["connector-1"],
    });
  });

  it("styles freehand drawings without exposing unrelated controls", () => {
    renderControls([draw()]);

    expect(screen.queryByRole("button", { name: "Edit label" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Node type" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Draw color: red" }));
    fireEvent.click(screen.getByRole("button", { name: "Blue draw color" }));
    fireEvent.click(screen.getByRole("button", { name: "Thick" }));

    expect(callbacks.onStylePatch.mock.calls).toEqual([
      [{ kind: "draw", color: "blue" }],
      [{ kind: "draw", size: "l" }],
    ]);
    expect(callbacks.onEditRequest).not.toHaveBeenCalled();
  });

  it("requests image alt editing and reflects controlled lock state", () => {
    const { rerender } = renderControls([image()]);

    fireEvent.click(screen.getByRole("button", { name: "Edit alt text" }));
    const lock = screen.getByRole("button", { name: "Lock image" });
    expect(lock).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(lock);

    expect(callbacks.onEditRequest).toHaveBeenCalledWith({
      objectKind: "image",
      field: "alt",
      objectIds: ["image-1"],
    });
    expect(callbacks.onStylePatch).toHaveBeenCalledWith({ kind: "image", locked: true });

    rerender(
      <SemanticStyleControls selectedObjects={[image({ locked: true })]} editing {...callbacks} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Unlock image" }));
    expect(callbacks.onStylePatch).toHaveBeenLastCalledWith({ kind: "image", locked: false });
  });

  it("shows only homogeneous controls and represents homogeneous mixed values without guessing", () => {
    const { rerender } = renderControls([
      text(),
      text({ id: "text-2", color: "red", size: "l", align: "end" }),
    ]);

    expect(screen.getByRole("toolbar", { name: "Text styles for 2 selected objects" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Text color: mixed" })).toHaveAttribute("data-mixed", "true");
    expect(screen.getByRole("combobox", { name: "Text size" })).toHaveValue("__mixed__");
    expect(screen.getByRole("button", { name: "Align left" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Align right" })).toHaveAttribute("aria-pressed", "false");

    fireEvent.change(screen.getByRole("combobox", { name: "Text size" }), { target: { value: "s" } });
    expect(callbacks.onStylePatch).toHaveBeenCalledWith({ kind: "text", size: "s" });

    rerender(
      <SemanticStyleControls selectedObjects={[text(), shape()]} editing {...callbacks} />,
    );
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
  });

  it("accepts only bounded hex colors and never projects untrusted color text into CSS", () => {
    renderControls([text()]);

    fireEvent.click(screen.getByRole("button", { name: "Text color: black" }));
    const input = screen.getByRole("textbox", { name: "Custom hex" });
    fireEvent.change(input, { target: { value: "red;background:url(javascript:alert(1))" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a 3, 6, or 8 digit hex color");
    expect(callbacks.onStylePatch).not.toHaveBeenCalled();
    expect(document.querySelector('[style*="javascript"]')).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: "#ABCDEF80" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(callbacks.onStylePatch).toHaveBeenCalledWith({ kind: "text", color: "#abcdef80" });
    expect(screen.queryByRole("dialog", { name: "Text color picker" })).not.toBeInTheDocument();
  });

  it("dismisses popovers with Escape or an outside pointer and contains canvas events", () => {
    const canvasEvents = {
      click: vi.fn(),
      contextMenu: vi.fn(),
      doubleClick: vi.fn(),
      keyDown: vi.fn(),
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
        onPointerDown={canvasEvents.pointerDown}
        onPointerMove={canvasEvents.pointerMove}
        onPointerUp={canvasEvents.pointerUp}
        onWheel={canvasEvents.wheel}
      >
        <SemanticStyleControls selectedObjects={[shape()]} editing {...callbacks} />
      </div>,
    );

    const fill = screen.getByRole("button", { name: "Fill: light-blue" });
    fireEvent.click(fill);
    const blue = screen.getByRole("button", { name: "Blue fill" });
    blue.focus();
    expect(fireEvent.keyDown(blue, { key: "Escape" })).toBe(false);
    expect(screen.queryByRole("dialog", { name: "Fill picker" })).not.toBeInTheDocument();
    expect(fill).toHaveFocus();

    fireEvent.click(fill);
    expect(screen.getByRole("dialog", { name: "Fill picker" })).toBeVisible();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog", { name: "Fill picker" })).not.toBeInTheDocument();

    fireEvent.pointerDown(fill, { pointerId: 4 });
    fireEvent.pointerMove(fill, { pointerId: 4 });
    fireEvent.pointerUp(fill, { pointerId: 4 });
    fireEvent.doubleClick(fill);
    fireEvent.contextMenu(fill);
    fireEvent.wheel(fill);
    fireEvent.keyDown(fill, { key: "Tab" });
    for (const callback of Object.values(canvasEvents)) expect(callback).not.toHaveBeenCalled();
  });

  it("renders nothing for spectators and disables every host intent when requested", () => {
    const { rerender } = renderControls([image()], { editing: false });
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();

    rerender(
      <SemanticStyleControls selectedObjects={[image()]} editing disabled {...callbacks} />,
    );
    const toolbar = screen.getByRole("toolbar", { name: "Image styles for 1 selected object" });
    expect(toolbar).toBeVisible();
    for (const control of screen.getAllByRole("button")) expect(control).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Edit alt text" }));
    fireEvent.click(screen.getByRole("button", { name: "Lock image" }));
    expect(callbacks.onEditRequest).not.toHaveBeenCalled();
    expect(callbacks.onStylePatch).not.toHaveBeenCalled();
  });
});
