import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ResolvedConnectorRoute } from "@/lib/domain/connector-routing";
import type { ActorRef, CanvasObject, CanvasObjectBase } from "@/lib/domain/types";

import {
  SemanticCanvasConnectorOverlay,
  SemanticCanvasObject,
  semanticCanvasObjectPropsEqual,
} from "./SemanticCanvasObject";

const actor: ActorRef = {
  participantId: "participant-human",
  displayName: "Avery",
  color: "blue",
  kind: "human",
};

function base(id: string, kind: CanvasObject["kind"]): CanvasObjectBase {
  return {
    id,
    kind,
    x: 20,
    y: 30,
    width: 160,
    height: 90,
    rotation: Math.PI / 8,
    zIndex: 1,
    revision: 4,
    groupId: null,
    diagramIds: [],
    createdAt: 1,
    updatedAt: 2,
    createdBy: actor,
    lastEditedBy: actor,
  };
}

function inSvg(node: React.ReactNode) {
  return render(<svg aria-label="Test canvas">{node}</svg>);
}

afterEach(cleanup);

describe("SemanticCanvasObject", () => {
  it("keeps presence-driven parent closures behind a stable semantic render gate", () => {
    const object: CanvasObject = {
      ...base("stable-object", "shape"),
      kind: "shape",
      shape: "rectangle",
      nodeType: "component",
      label: "Stable object",
      fill: "light-violet",
      stroke: "blue",
    };
    const first = {
      object,
      bounds: { x: 10, y: 20, width: 120, height: 80 },
      selected: false,
      focused: false,
      tabIndex: 0,
      onSelect: vi.fn(),
      onFocus: vi.fn(),
    };

    expect(semanticCanvasObjectPropsEqual(first, {
      ...first,
      onSelect: vi.fn(),
      onFocus: vi.fn(),
    })).toBe(true);
    expect(semanticCanvasObjectPropsEqual(first, { ...first, selected: true })).toBe(false);
    expect(semanticCanvasObjectPropsEqual(first, { ...first, object: { ...object, label: "Changed" } })).toBe(false);
  });

  it("renders accessible semantic text and all three shape geometries", () => {
    const text: CanvasObject = {
      ...base("text-auth", "text"),
      kind: "text",
      content: "Authentication request flow",
      color: "black",
      size: "m",
      align: "middle",
    };
    const shapes: CanvasObject[] = (["rectangle", "ellipse", "diamond"] as const).map((shape) => ({
      ...base(`shape-${shape}`, "shape"),
      kind: "shape",
      shape,
      nodeType: "service",
      nodeMetadata: null,
      label: `${shape} service`,
      fill: "light-blue",
      stroke: "blue",
    }));
    const { container } = inSvg(
      <>
        <SemanticCanvasObject object={text} />
        {shapes.map((shape) => <SemanticCanvasObject key={shape.id} object={shape} />)}
      </>,
    );

    expect(screen.getByRole("img", { name: "Text: Authentication request flow" })).toHaveAttribute(
      "data-object-id",
      "text-auth",
    );
    expect(container.querySelector("#shape-rectangle rect.semantic-canvas-object__shape")).not.toBeNull();
    expect(container.querySelector("#shape-ellipse ellipse")).not.toBeNull();
    expect(container.querySelector("#shape-diamond polygon")).not.toBeNull();
    expect(container.querySelector("#text-auth .semantic-canvas-object__content")).toHaveAttribute(
      "transform",
      expect.stringContaining("rotate("),
    );
    expect(container.querySelector("#text-auth .semantic-canvas-object__text")).toHaveAttribute(
      "font-family",
      "Shantell Sans,Comic Sans MS,Comic Sans,cursive",
    );
    expect(container.querySelector("#text-auth .semantic-canvas-object__text")).toHaveAttribute(
      "font-size",
      "24",
    );
    const rectangle = container.querySelector(
      "#shape-rectangle rect.semantic-canvas-object__shape",
    );
    expect(rectangle).toHaveAttribute("fill", "#deedf8");
    expect(rectangle).toHaveAttribute("stroke", "#5266df");
    expect(rectangle).toHaveAttribute("stroke-width", "3.5");
    expect(rectangle).toHaveAttribute("stroke-linecap", "round");
    expect(rectangle).toHaveAttribute("stroke-linejoin", "round");
    const rectangleLabel = container.querySelector(
      "#shape-rectangle .semantic-canvas-object__label",
    );
    expect(rectangleLabel).toHaveAttribute("fill", "#5266df");
    expect(rectangleLabel).toHaveAttribute("font-size", "22");
    expect(rectangleLabel).toHaveAttribute("stroke", "#deedf8");
    expect(rectangleLabel).toHaveAttribute("stroke-width", "5");
    expect(rectangleLabel).toHaveAttribute("paint-order", "stroke fill");
  });

  it("uses the shared six-line live-render limit for text content", () => {
    const object: CanvasObject = {
      ...base("long-live-text", "text"),
      kind: "text",
      height: 320,
      content: Array.from({ length: 7 }, (_, index) => `line${index + 1}`).join("\n"),
      color: "black",
      size: "m",
      align: "start",
    };
    const { container } = inSvg(<SemanticCanvasObject object={object} />);
    const lines = [...container.querySelectorAll(
      "#long-live-text .semantic-canvas-object__text tspan",
    )].map((line) => line.textContent);

    expect(lines).toHaveLength(6);
    expect(lines.at(-1)).toBe("line6…");
  });

  it("ellipsizes live text before its baselines exceed a short object", () => {
    const object: CanvasObject = {
      ...base("short-live-text", "text"),
      kind: "text",
      height: 96,
      content: "one\ntwo\nthree\nfour",
      color: "black",
      size: "m",
      align: "start",
    };
    const { container } = inSvg(<SemanticCanvasObject object={object} />);
    const lines = [...container.querySelectorAll(
      "#short-live-text .semantic-canvas-object__text tspan",
    )].map((line) => line.textContent);

    expect(lines).toEqual(["one", "two", "three…"]);
    const text = container.querySelector("#short-live-text .semantic-canvas-object__text");
    expect(text).toHaveAttribute("y", "54");
    const lineHeight = Number(text?.querySelectorAll("tspan")[2]?.getAttribute("dy"));
    expect(54 + lineHeight * 2).toBeLessThanOrEqual(object.y + object.height);
  });

  it("renders the supplied curved connector path, label position, and arrowheads", () => {
    const connector: CanvasObject = {
      ...base("connector-auth", "connector"),
      kind: "connector",
      rotation: 0,
      start: { x: 100, y: 100, objectId: "client" },
      end: { x: 360, y: 160, objectId: "api" },
      routing: { mode: "curved", kind: "curved", bend: 80, elbowMidPoint: 0.5, labelPosition: 0.5 },
      direction: "both",
      label: "signed request",
      color: "violet",
    };
    const route: ResolvedConnectorRoute = {
      connectorId: connector.id,
      routing: connector.routing!,
      start: connector.start,
      end: connector.end,
      points: [connector.start, { x: 220, y: 65 }, connector.end],
      arc: { center: { x: 220, y: 400 }, radius: 320, startAngle: -2, sweepAngle: 0.9 },
      labelPoint: { x: 224, y: 78 },
      pathLength: 300,
      pathBounds: { x: 100, y: 65, width: 260, height: 95 },
      labelBounds: { x: 154, y: 58, width: 140, height: 40 },
      bounds: { x: 100, y: 58, width: 260, height: 102 },
      collisionObjectIds: [],
      crossingCount: 0,
      laneIndex: 0,
      candidateCount: 1,
    };
    const { container } = inSvg(<SemanticCanvasObject object={connector} connectorRoute={route} />);

    expect(container.querySelector(".semantic-canvas-object__connector-path")).toHaveAttribute(
      "d",
      expect.stringContaining(" A "),
    );
    expect(container.querySelectorAll(".semantic-canvas-object__arrowhead")).toHaveLength(2);
    expect(container.querySelector(".semantic-canvas-object__connector-path")).toHaveAttribute(
      "stroke",
      "#9050c8",
    );
    expect(container.querySelector(".semantic-canvas-object__connector-path")).toHaveAttribute(
      "stroke-width",
      "3.5",
    );
    const labelMask = container.querySelector(".semantic-canvas-object__connector-label rect");
    expect(labelMask).toHaveAttribute("fill", "#ffffff");
    expect(labelMask).toHaveAttribute("stroke", "none");
    expect(labelMask).toHaveAttribute("rx", "4");
    expect(container.querySelector(".semantic-canvas-object__connector-label-text")).toHaveTextContent(
      /signed\s*request/,
    );
    expect(container.querySelector(".semantic-canvas-object__connector-label-text")).toHaveAttribute(
      "font-family",
      "Shantell Sans,Comic Sans MS,Comic Sans,cursive",
    );
    expect(container.querySelector(".semantic-canvas-object__connector-label-text")).toHaveAttribute(
      "font-size",
      "20",
    );
    expect(screen.getByRole("img", { name: /Connector: signed request, client to api/ })).toHaveAttribute(
      "id",
      "connector-auth",
    );

    const split = inSvg(
      <>
        <SemanticCanvasObject
          object={connector}
          connectorRoute={route}
          connectorLayer="shaft"
          focused
        />
        <SemanticCanvasConnectorOverlay
          object={connector}
          connectorRoute={route}
          bounds={route.bounds}
          focused
          onSelect={vi.fn()}
        />
      </>,
    );
    expect(split.container.querySelectorAll('[data-object-id="connector-auth"]')).toHaveLength(1);
    expect(
      split.container.querySelector(
        '[data-object-id="connector-auth"] .semantic-canvas-object__connector-path',
      ),
    ).not.toBeNull();
    expect(
      split.container.querySelector(
        '[data-object-id="connector-auth"] .semantic-canvas-object__connector-label-hit-target',
      ),
    ).not.toBeNull();
    expect(
      split.container.querySelector(
        '[data-object-id="connector-auth"] .semantic-canvas-object__arrowhead',
      ),
    ).toBeNull();
    const overlay = split.container.querySelector('[data-connector-overlay-id="connector-auth"]');
    expect(overlay).toHaveAttribute("aria-hidden", "true");
    expect(overlay).toHaveAttribute("pointer-events", "none");
    expect(overlay).toHaveAttribute("data-connector-overlay-focused", "true");
    expect(overlay?.querySelector(".semantic-canvas-object__connector-label")).toHaveAttribute(
      "pointer-events",
      "all",
    );
    expect(overlay?.querySelector(".semantic-canvas-object__connector-path")).toBeNull();
    expect(overlay?.querySelectorAll(".semantic-canvas-object__arrowhead")).toHaveLength(2);
    expect(overlay?.querySelector(".semantic-canvas-object__connector-label")).not.toBeNull();
    expect(overlay?.querySelector("[data-focus-ring='true']")).not.toBeNull();
    expect(
      split.container.querySelector(
        '[data-object-id="connector-auth"] [data-focus-ring="true"]',
      ),
    ).toBeNull();
  });

  it("uses the shared twenty-line live-render limit for connector labels", () => {
    const label = Array.from({ length: 21 }, (_, index) =>
      String.fromCharCode(97 + index)).join("\n");
    const connector: CanvasObject = {
      ...base("long-live-connector", "connector"),
      kind: "connector",
      rotation: 0,
      start: { x: 0, y: 0, objectId: null },
      end: { x: 400, y: 0, objectId: null },
      routing: { mode: "straight", kind: "straight", bend: 0, elbowMidPoint: 0.5, labelPosition: 0.5 },
      direction: "end",
      label,
      color: "black",
    };
    const route: ResolvedConnectorRoute = {
      connectorId: connector.id,
      routing: connector.routing!,
      start: connector.start,
      end: connector.end,
      points: [connector.start, connector.end],
      arc: null,
      labelPoint: { x: 200, y: 0 },
      pathLength: 400,
      pathBounds: { x: 0, y: 0, width: 400, height: 0 },
      labelBounds: { x: 190, y: -290, width: 20, height: 580 },
      bounds: { x: 0, y: -290, width: 400, height: 580 },
      collisionObjectIds: [],
      crossingCount: 0,
      laneIndex: 0,
      candidateCount: 1,
    };
    const { container } = inSvg(
      <SemanticCanvasObject object={connector} connectorRoute={route} />,
    );
    const lines = [...container.querySelectorAll(
      "#long-live-connector .semantic-canvas-object__connector-label-text tspan",
    )].map((line) => line.textContent);

    expect(lines).toHaveLength(20);
    expect(lines.at(-1)).toBe("t…");
  });

  it("supports pointer and keyboard selection with visible focus and selection state", () => {
    const onSelect = vi.fn();
    const object: CanvasObject = {
      ...base("decision-one", "shape"),
      kind: "shape",
      shape: "diamond",
      nodeType: "decision",
      nodeMetadata: { kind: "decision", status: "proposed", owner: null, resolution: null, resolvedAt: null },
      label: "Choose cache",
      fill: "yellow",
      stroke: "orange",
    };
    const { container } = inSvg(
      <SemanticCanvasObject object={object} selected onSelect={onSelect} tabIndex={0} />,
    );
    const group = screen.getByRole("button", { name: "decision: Choose cache" });

    fireEvent.pointerDown(group, { button: 0, shiftKey: true });
    fireEvent.keyDown(group, { key: "Enter" });
    fireEvent.focus(group);

    expect(onSelect).toHaveBeenNthCalledWith(1, "decision-one", true);
    expect(onSelect).toHaveBeenNthCalledWith(2, "decision-one", false);
    expect(group).toHaveAttribute("aria-pressed", "true");
    expect(group).toHaveAttribute("data-focused", "true");
    expect(container.querySelector("[data-selection-ring='true']")).toBeNull();
    const focusRing = container.querySelector("[data-focus-ring='true']");
    expect(focusRing).toHaveAttribute("stroke", "#3182ed");
    expect(focusRing).toHaveAttribute("stroke-width", "1.5");
    expect(focusRing).toHaveAttribute("stroke-dasharray", "5 4");
  });

  it("publishes renderer-neutral pointer starts and accessible text-edit requests", () => {
    const onPointerStart = vi.fn();
    const onEditRequested = vi.fn();
    const object: CanvasObject = {
      ...base("editable-text", "text"),
      kind: "text",
      content: "Edit this",
      color: "black",
      size: "m",
      align: "start",
    };
    const { container } = inSvg(
      <SemanticCanvasObject
        object={object}
        selected
        onSelect={vi.fn()}
        onPointerStart={onPointerStart}
        onEditRequested={onEditRequested}
      />,
    );
    const group = screen.getByRole("button", { name: "Text: Edit this" });
    const hitSurface = container.querySelector(".semantic-canvas-object__text-hit-surface");
    expect(hitSurface).toHaveAttribute("x", "20");
    expect(hitSurface).toHaveAttribute("y", "30");
    expect(hitSurface).toHaveAttribute("width", "160");
    expect(hitSurface).toHaveAttribute("height", "90");
    expect(hitSurface).toHaveAttribute("pointer-events", "all");

    fireEvent.pointerDown(hitSurface!, {
      button: 0,
      pointerId: 17,
      clientX: 240,
      clientY: 180,
      shiftKey: true,
    });
    fireEvent.doubleClick(hitSurface!);
    fireEvent.keyDown(group, { key: "F2" });

    expect(onPointerStart).toHaveBeenCalledWith({
      objectId: "editable-text",
      pointerId: 17,
      clientX: 240,
      clientY: 180,
      additive: true,
    });
    expect(onEditRequested).toHaveBeenCalledTimes(2);
    expect(onEditRequested).toHaveBeenNthCalledWith(1, "editable-text");
  });

  it("keeps empty text objects pointer-editable through their semantic bounds", () => {
    const onSelect = vi.fn();
    const onPointerStart = vi.fn();
    const onEditRequested = vi.fn();
    const object: CanvasObject = {
      ...base("empty-text", "text"),
      kind: "text",
      content: "",
      color: "black",
      size: "m",
      align: "start",
    };
    const { container } = inSvg(
      <SemanticCanvasObject
        object={object}
        onSelect={onSelect}
        onPointerStart={onPointerStart}
        onEditRequested={onEditRequested}
      />,
    );
    const hitSurface = container.querySelector(".semantic-canvas-object__text-hit-surface")!;

    expect(container.querySelector(".semantic-canvas-object__text")).toBeNull();
    fireEvent.pointerDown(hitSurface, { button: 0, pointerId: 23, clientX: 70, clientY: 80 });
    fireEvent.doubleClick(hitSurface);

    expect(onSelect).toHaveBeenCalledWith("empty-text", false);
    expect(onPointerStart).toHaveBeenCalledWith({
      objectId: "empty-text",
      pointerId: 23,
      clientX: 70,
      clientY: 80,
      additive: false,
    });
    expect(onEditRequested).toHaveBeenCalledWith("empty-text");
  });

  it("uses the authoritative image URL and reveals an accessible fallback after failure", () => {
    const object: CanvasObject = {
      ...base("image-plan", "image"),
      kind: "image",
      url: "https://assets.example.test/plan.png",
      assetId: null,
      alt: "Annotated migration plan",
      mimeType: "image/png",
      sourceUrl: null,
      locked: false,
    };
    const { container } = inSvg(<SemanticCanvasObject object={object} />);
    const image = container.querySelector("image")!;

    expect(image).toHaveAttribute("href", object.url);
    fireEvent.error(image);
    expect(container.querySelector("image")).toBeNull();
    expect(container.querySelector(".semantic-canvas-object__image-fallback")).not.toBeNull();
    expect(screen.getByRole("img", { name: "Image: Annotated migration plan" })).toBeInTheDocument();
  });

  it("renders freehand points in local coordinates with the authoritative transform", () => {
    const object: CanvasObject = {
      ...base("draw-one", "draw"),
      kind: "draw",
      points: [{ x: 0, y: 0 }, { x: 30, y: 15 }, { x: 45, y: 2 }],
      color: "red",
      size: "m",
    };
    const { container } = inSvg(<SemanticCanvasObject object={object} />);
    const line = container.querySelector("polyline")!;

    expect(line).toHaveAttribute("points", "0,0 30,15 45,2");
    expect(line).toHaveAttribute("transform", expect.stringContaining("translate(20 30) rotate("));
    expect(line).toHaveAttribute("stroke-width", "4.5");
    expect(line).toHaveAttribute("stroke", "#d9484a");
  });
});
