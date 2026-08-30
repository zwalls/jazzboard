"use client";

import {
  memo,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";

import {
  SEMANTIC_CANVAS_BACKGROUND,
  SEMANTIC_CONNECTOR_ARROW_SIZE,
  SEMANTIC_CONNECTOR_LABEL_FONT_SIZE,
  SEMANTIC_CONNECTOR_LABEL_LINE_HEIGHT,
  SEMANTIC_CONNECTOR_STROKE_WIDTH,
  SEMANTIC_DRAW_FONT_FAMILY,
  SEMANTIC_DRAW_STROKE_WIDTHS,
  SEMANTIC_SELECTION_COLOR,
  SEMANTIC_SELECTION_STROKE_WIDTH,
  SEMANTIC_SHAPE_CORNER_RADIUS,
  SEMANTIC_SHAPE_LABEL_FONT_SIZE,
  SEMANTIC_SHAPE_LABEL_LINE_HEIGHT,
  SEMANTIC_SHAPE_STROKE_WIDTH,
  SEMANTIC_TEXT_FONT_SIZES,
  SEMANTIC_TEXT_LINE_HEIGHT,
  semanticFillColor,
  semanticShapeLabelMaxCharacters,
  semanticShapeLabelMaxLines,
  semanticStrokeColor,
} from "@/lib/canvas/semantic-visual-style";
import {
  layoutSemanticText,
  SEMANTIC_CONNECTOR_LABEL_MAX_LINES,
  semanticConnectorLabelMaximumCharacters,
  semanticTextMaximumCharacters,
  semanticTextMaximumLines,
} from "@/lib/canvas/semantic-text-layout";
import type { ResolvedConnectorRoute } from "@/lib/domain/connector-routing";
import { connectorLabelMetrics } from "@/lib/domain/layout";
import { vectorPathSvgData } from "@/lib/domain/vector-path";
import type {
  CanvasBounds,
  CanvasObject,
  ConnectorObject,
  DrawObject,
  ImageObject,
  PathObject,
  Point,
  ShapeObject,
  TextObject,
} from "@/lib/domain/types";

type CanvasObjectPointerStartInput = Readonly<{
  objectId: string;
  pointerId: number;
  clientX: number;
  clientY: number;
  additive: boolean;
}>;

export type SemanticCanvasObjectProps = {
  object: CanvasObject;
  /** Canonical, page-space connector geometry from the semantic scene. */
  connectorRoute?: ResolvedConnectorRoute | null;
  /** Page-space visual bounds. Supplying scene-object bounds keeps rotated/drawn selection exact. */
  bounds?: CanvasBounds;
  selected?: boolean;
  focused?: boolean;
  suppressFocusVisual?: boolean;
  className?: string;
  tabIndex?: number;
  onSelect?: (objectId: string, additive: boolean) => void;
  onPointerStart?: (input: CanvasObjectPointerStartInput) => void;
  onEditRequested?: (objectId: string) => void;
  onFocus?: (objectId: string) => void;
  onBlur?: (objectId: string) => void;
  /**
   * The semantic canvas paints connector shafts in authoritative z-order and
   * their arrowheads/labels in a separate foreground overlay. Standalone callers
   * keep the complete connector by default.
   */
  connectorLayer?: "all" | "shaft";
};

export type SemanticCanvasConnectorOverlayProps = Readonly<{
  object: ConnectorObject;
  /** Canonical, page-space connector geometry from the semantic scene. */
  connectorRoute?: ResolvedConnectorRoute | null;
  /** Page-space visual bounds used for the foreground focus outline. */
  bounds?: CanvasBounds;
  focused?: boolean;
  onSelect?: (objectId: string, additive: boolean) => void;
  onPointerStart?: (input: CanvasObjectPointerStartInput) => void;
}>;

function finiteNumber(value: number): string {
  const rounded = Math.round(value * 1_000) / 1_000;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

function rotationTransform(object: CanvasObject): string | undefined {
  if (!object.rotation) return undefined;
  const degrees = object.rotation * (180 / Math.PI);
  return `rotate(${finiteNumber(degrees)} ${finiteNumber(object.x + object.width / 2)} ${finiteNumber(object.y + object.height / 2)})`;
}

function drawTransform(object: DrawObject): string {
  const translate = `translate(${finiteNumber(object.x)} ${finiteNumber(object.y)})`;
  if (!object.rotation) return translate;
  return `${translate} rotate(${finiteNumber(object.rotation * (180 / Math.PI))})`;
}

function SvgTextLines({
  lines,
  x,
  firstY,
  lineHeight,
  anchor,
  fill,
  fontSize,
  className,
  outlineColor,
  outlineWidth = 0,
}: {
  lines: readonly string[];
  x: number;
  firstY: number;
  lineHeight: number;
  anchor: "start" | "middle" | "end";
  fill: string;
  fontSize: number;
  className: string;
  outlineColor?: string;
  outlineWidth?: number;
}) {
  if (!lines.length) return null;
  return (
    <text
      className={className}
      x={x}
      y={firstY}
      fill={fill}
      fontFamily={SEMANTIC_DRAW_FONT_FAMILY}
      fontSize={fontSize}
      fontWeight={400}
      paintOrder={outlineColor ? "stroke fill" : undefined}
      stroke={outlineColor}
      strokeLinejoin={outlineColor ? "round" : undefined}
      strokeWidth={outlineColor ? outlineWidth : undefined}
      textAnchor={anchor}
      pointerEvents="none"
    >
      {lines.map((line, index) => (
        <tspan key={`${index}-${line}`} x={x} dy={index === 0 ? 0 : lineHeight}>
          {line}
        </tspan>
      ))}
    </text>
  );
}

function TextPrimitive({ object }: { object: TextObject }) {
  const fontSize = SEMANTIC_TEXT_FONT_SIZES[object.size];
  const lineHeight = fontSize * SEMANTIC_TEXT_LINE_HEIGHT;
  const lines = layoutSemanticText(
    object.content,
    semanticTextMaximumCharacters(object.width, fontSize),
    semanticTextMaximumLines(object.height, fontSize),
  ).lines;
  const x = object.align === "start"
    ? object.x
    : object.align === "end"
      ? object.x + object.width
      : object.x + object.width / 2;
  return (
    <g className="semantic-canvas-object__content" transform={rotationTransform(object)}>
      <rect
        className="semantic-canvas-object__hit-surface semantic-canvas-object__text-hit-surface"
        x={object.x}
        y={object.y}
        width={object.width}
        height={object.height}
        fill="transparent"
        stroke="none"
        pointerEvents="all"
        aria-hidden="true"
      />
      <SvgTextLines
        lines={lines}
        x={x}
        firstY={object.y + Math.min(fontSize, object.height / 2)}
        lineHeight={lineHeight}
        anchor={object.align}
        fill={semanticStrokeColor(object.color)}
        fontSize={fontSize}
        className="semantic-canvas-object__text"
      />
    </g>
  );
}

function ShapePrimitive({ object }: { object: ShapeObject }) {
  const fill = semanticFillColor(object.fill, "blue", true);
  const stroke = semanticStrokeColor(object.stroke, "blue");
  const shared = {
    fill,
    stroke,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    strokeWidth: SEMANTIC_SHAPE_STROKE_WIDTH,
    className: "semantic-canvas-object__shape",
  } as const;
  let geometry: ReactNode;
  if (object.shape === "ellipse") {
    geometry = (
      <ellipse
        {...shared}
        cx={object.x + object.width / 2}
        cy={object.y + object.height / 2}
        rx={object.width / 2}
        ry={object.height / 2}
      />
    );
  } else if (object.shape === "diamond") {
    geometry = (
      <polygon
        {...shared}
        points={[
          `${object.x + object.width / 2},${object.y}`,
          `${object.x + object.width},${object.y + object.height / 2}`,
          `${object.x + object.width / 2},${object.y + object.height}`,
          `${object.x},${object.y + object.height / 2}`,
        ].join(" ")}
      />
    );
  } else {
    geometry = (
      <rect
        {...shared}
        x={object.x}
        y={object.y}
        width={object.width}
        height={object.height}
        rx={Math.min(SEMANTIC_SHAPE_CORNER_RADIUS, object.width / 8, object.height / 8)}
      />
    );
  }
  const lines = layoutSemanticText(
    object.label,
    semanticShapeLabelMaxCharacters(object.width),
    semanticShapeLabelMaxLines(object.height),
  ).lines;
  const firstY = object.y + object.height / 2 -
    ((lines.length - 1) * SEMANTIC_SHAPE_LABEL_LINE_HEIGHT) / 2 +
    SEMANTIC_SHAPE_LABEL_FONT_SIZE * 0.35;
  return (
    <g className="semantic-canvas-object__content" transform={rotationTransform(object)}>
      {geometry}
      <SvgTextLines
        lines={lines}
        x={object.x + object.width / 2}
        firstY={firstY}
        lineHeight={SEMANTIC_SHAPE_LABEL_LINE_HEIGHT}
        anchor="middle"
        fill={stroke}
        fontSize={SEMANTIC_SHAPE_LABEL_FONT_SIZE}
        className="semantic-canvas-object__label"
        outlineColor={fill === "none" ? SEMANTIC_CANVAS_BACKGROUND : fill}
        outlineWidth={5}
      />
    </g>
  );
}

function connectorPath(route: ResolvedConnectorRoute): string {
  if (route.routing.kind === "curved" && route.arc) {
    const largeArc = Math.abs(route.arc.sweepAngle) > Math.PI ? 1 : 0;
    const sweep = route.arc.sweepAngle >= 0 ? 1 : 0;
    return `M ${finiteNumber(route.start.x)} ${finiteNumber(route.start.y)} A ${finiteNumber(route.arc.radius)} ${finiteNumber(route.arc.radius)} 0 ${largeArc} ${sweep} ${finiteNumber(route.end.x)} ${finiteNumber(route.end.y)}`;
  }
  return route.points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${finiteNumber(point.x)} ${finiteNumber(point.y)}`)
    .join(" ");
}

function arrowHead(tip: Point, neighbor: Point, size = SEMANTIC_CONNECTOR_ARROW_SIZE): string {
  const angle = Math.atan2(tip.y - neighbor.y, tip.x - neighbor.x);
  const wing = size * 0.58;
  const baseX = tip.x - Math.cos(angle) * size;
  const baseY = tip.y - Math.sin(angle) * size;
  const perpendicularX = -Math.sin(angle) * wing;
  const perpendicularY = Math.cos(angle) * wing;
  return [
    `${finiteNumber(tip.x)},${finiteNumber(tip.y)}`,
    `${finiteNumber(baseX + perpendicularX)},${finiteNumber(baseY + perpendicularY)}`,
    `${finiteNumber(baseX - perpendicularX)},${finiteNumber(baseY - perpendicularY)}`,
  ].join(" ");
}

function connectorLabelLines(value: string, availableWidth: number): string[] {
  return [...layoutSemanticText(
    value,
    semanticConnectorLabelMaximumCharacters(availableWidth),
    SEMANTIC_CONNECTOR_LABEL_MAX_LINES,
  ).lines];
}

type ConnectorPresentation = Readonly<{
  geometry: ResolvedConnectorRoute;
  path: string;
  stroke: string;
  points: readonly Point[];
  startNeighbor: Point | undefined;
  endNeighbor: Point;
  labelBounds: CanvasBounds | null;
  labelLines: readonly string[];
  firstTextY: number;
}>;

function connectorPresentation({
  object,
  route,
}: {
  object: ConnectorObject;
  route: ResolvedConnectorRoute | null | undefined;
}): ConnectorPresentation {
  const fallbackPoints = [object.start, object.end];
  const points = route?.points?.length ? route.points : fallbackPoints;
  const fallbackRoute: ResolvedConnectorRoute = {
    connectorId: object.id,
    routing: object.routing ?? { mode: "straight", kind: "straight", bend: 0, elbowMidPoint: 0.5, labelPosition: 0.5 },
    start: object.start,
    end: object.end,
    points,
    arc: null,
    labelPoint: { x: (object.start.x + object.end.x) / 2, y: (object.start.y + object.end.y) / 2 },
    pathLength: Math.hypot(object.end.x - object.start.x, object.end.y - object.start.y),
    pathBounds: {
      x: Math.min(object.start.x, object.end.x),
      y: Math.min(object.start.y, object.end.y),
      width: Math.abs(object.end.x - object.start.x),
      height: Math.abs(object.end.y - object.start.y),
    },
    labelBounds: null,
    bounds: {
      x: Math.min(object.start.x, object.end.x),
      y: Math.min(object.start.y, object.end.y),
      width: Math.abs(object.end.x - object.start.x),
      height: Math.abs(object.end.y - object.start.y),
    },
    collisionObjectIds: [],
    crossingCount: 0,
    laneIndex: 0,
    candidateCount: 1,
  };
  const geometry = route ?? fallbackRoute;
  const path = connectorPath(geometry);
  const stroke = semanticStrokeColor(object.color);
  const startNeighbor = points[1] ?? points[0];
  const endNeighbor = points.at(-2) ?? points.at(-1)!;
  const metrics = connectorLabelMetrics(object.label);
  const labelBounds = geometry.labelBounds ?? (metrics.normalizedLines.length ? {
    x: geometry.labelPoint.x - metrics.width / 2,
    y: geometry.labelPoint.y - metrics.height / 2,
    width: metrics.width,
    height: metrics.height,
  } : null);
  const labelLines = labelBounds ? connectorLabelLines(object.label, labelBounds.width) : [];
  const firstTextY = labelBounds
    ? geometry.labelPoint.y -
      ((labelLines.length - 1) * SEMANTIC_CONNECTOR_LABEL_LINE_HEIGHT) / 2 +
      SEMANTIC_CONNECTOR_LABEL_FONT_SIZE * 0.35
    : 0;

  return {
    geometry,
    path,
    stroke,
    points,
    startNeighbor,
    endNeighbor,
    labelBounds,
    labelLines,
    firstTextY,
  };
}

function ConnectorShaftPrimitive({
  path,
  stroke,
  labelBounds,
}: Pick<ConnectorPresentation, "path" | "stroke" | "labelBounds">) {
  return (
    <g className="semantic-canvas-object__connector-shaft" data-semantic-layer="connector-shaft">
      <path
        className="semantic-canvas-object__connector-hit-target"
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={16}
        vectorEffect="non-scaling-stroke"
        pointerEvents="stroke"
      />
      <path
        className="semantic-canvas-object__connector-path"
        d={path}
        fill="none"
        stroke={stroke}
        strokeWidth={SEMANTIC_CONNECTOR_STROKE_WIDTH}
        strokeLinecap="round"
        strokeLinejoin="round"
        pointerEvents="none"
      />
      {labelBounds ? (
        <rect
          className="semantic-canvas-object__connector-label-hit-target"
          x={labelBounds.x}
          y={labelBounds.y}
          width={labelBounds.width}
          height={labelBounds.height}
          rx={4}
          fill="transparent"
          pointerEvents="fill"
        />
      ) : null}
    </g>
  );
}

function ConnectorOverlayPrimitive({
  object,
  presentation,
  onLabelPointerDown,
}: {
  object: ConnectorObject;
  presentation: ConnectorPresentation;
  onLabelPointerDown?: (event: PointerEvent<SVGGElement>) => void;
}) {
  const {
    geometry,
    stroke,
    points,
    startNeighbor,
    endNeighbor,
    labelBounds,
    labelLines,
    firstTextY,
  } = presentation;
  return (
    <g
      className="semantic-canvas-object__connector-overlay"
      data-semantic-layer="connector-overlay"
      pointerEvents="none"
    >
      {object.direction === "both" && startNeighbor ? (
        <polygon
          className="semantic-canvas-object__arrowhead semantic-canvas-object__arrowhead--start"
          points={arrowHead(points[0], startNeighbor)}
          fill={stroke}
          pointerEvents="none"
        />
      ) : null}
      {object.direction !== "none" && endNeighbor ? (
        <polygon
          className="semantic-canvas-object__arrowhead semantic-canvas-object__arrowhead--end"
          points={arrowHead(points.at(-1)!, endNeighbor)}
          fill={stroke}
          pointerEvents="none"
        />
      ) : null}
      {labelBounds ? (
        <g
          className="semantic-canvas-object__connector-label"
          data-connector-interaction-id={object.id}
          pointerEvents={onLabelPointerDown ? "all" : "none"}
          onPointerDown={onLabelPointerDown}
        >
          <rect
            x={labelBounds.x}
            y={labelBounds.y}
            width={labelBounds.width}
            height={labelBounds.height}
            rx={4}
            fill={SEMANTIC_CANVAS_BACKGROUND}
            stroke="none"
          />
          <SvgTextLines
            lines={labelLines}
            x={geometry.labelPoint.x}
            firstY={firstTextY}
            lineHeight={SEMANTIC_CONNECTOR_LABEL_LINE_HEIGHT}
            anchor="middle"
            fill={stroke}
            fontSize={SEMANTIC_CONNECTOR_LABEL_FONT_SIZE}
            className="semantic-canvas-object__connector-label-text"
          />
        </g>
      ) : null}
    </g>
  );
}

function ConnectorPrimitive({
  object,
  route,
  layer,
}: {
  object: ConnectorObject;
  route: ResolvedConnectorRoute | null | undefined;
  layer: "all" | "shaft";
}) {
  const presentation = connectorPresentation({ object, route });
  return (
    <g className="semantic-canvas-object__content semantic-canvas-object__connector">
      <ConnectorShaftPrimitive
        path={presentation.path}
        stroke={presentation.stroke}
        labelBounds={presentation.labelBounds}
      />
      {layer === "all" ? (
        <ConnectorOverlayPrimitive object={object} presentation={presentation} />
      ) : null}
    </g>
  );
}

function ImagePrimitive({
  object,
  failed,
  onError,
}: {
  object: ImageObject;
  failed: boolean;
  onError: () => void;
}) {
  const label = object.alt.trim() || "Image unavailable";
  const lines = layoutSemanticText(
    label,
    Math.max(10, Math.floor(object.width / 9)),
    3,
  ).lines;
  const lineHeight = 17;
  const firstY = object.y + object.height / 2 - ((lines.length - 1) * lineHeight) / 2 + 5;
  return (
    <g className="semantic-canvas-object__content" transform={rotationTransform(object)}>
      <rect
        className="semantic-canvas-object__image-background"
        x={object.x}
        y={object.y}
        width={object.width}
        height={object.height}
        rx={8}
        fill="#f2f4f8"
        stroke="#8f99a8"
        strokeWidth={failed ? 2 : 1}
        strokeDasharray={failed ? "8 6" : undefined}
      />
      {failed ? (
        <g className="semantic-canvas-object__image-fallback" pointerEvents="none">
          <line
            x1={object.x}
            y1={object.y}
            x2={object.x + object.width}
            y2={object.y + object.height}
            stroke="#c2c7d0"
          />
          <line
            x1={object.x + object.width}
            y1={object.y}
            x2={object.x}
            y2={object.y + object.height}
            stroke="#c2c7d0"
          />
          <SvgTextLines
            lines={lines}
            x={object.x + object.width / 2}
            firstY={firstY}
            lineHeight={lineHeight}
            anchor="middle"
            fill="#596376"
            fontSize={14}
            className="semantic-canvas-object__image-fallback-label"
          />
        </g>
      ) : (
        <image
          key={object.url}
          className="semantic-canvas-object__image"
          href={object.url}
          x={object.x}
          y={object.y}
          width={object.width}
          height={object.height}
          preserveAspectRatio="xMidYMid meet"
          onError={onError}
        />
      )}
      <rect
        className="semantic-canvas-object__image-border"
        x={object.x}
        y={object.y}
        width={object.width}
        height={object.height}
        rx={8}
        fill="none"
        stroke="#8f99a8"
        strokeWidth={1}
        pointerEvents="none"
      />
    </g>
  );
}

function DrawPrimitive({ object }: { object: DrawObject }) {
  return (
    <polyline
      className="semantic-canvas-object__content semantic-canvas-object__draw"
      points={object.points.map((point) => `${finiteNumber(point.x)},${finiteNumber(point.y)}`).join(" ")}
      transform={drawTransform(object)}
      fill="none"
      stroke={semanticStrokeColor(object.color, "red")}
      strokeWidth={SEMANTIC_DRAW_STROKE_WIDTHS[object.size]}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  );
}

function PathPrimitive({ object }: { object: PathObject }) {
  return (
    <path
      className="semantic-canvas-object__content semantic-canvas-object__path"
      d={vectorPathSvgData(object, finiteNumber)}
      transform={rotationTransform(object)}
      fill={semanticFillColor(object.fill, "black", true)}
      stroke={semanticStrokeColor(object.stroke, "black", true)}
      strokeWidth={object.strokeWidth}
      opacity={object.opacity}
      strokeLinecap={object.lineCap}
      strokeLinejoin={object.lineJoin}
      fillRule={object.fillRule}
    />
  );
}

function objectLabel(object: CanvasObject): string {
  if (object.kind === "text") return `Text: ${object.content.trim() || "Empty text"}`;
  if (object.kind === "shape") {
    const classification = object.nodeType?.replace("_", " ") ?? object.shape;
    return `${classification}: ${object.label.trim() || "Unlabeled shape"}`;
  }
  if (object.kind === "connector") {
    const endpoints = [object.start.objectId, object.end.objectId].filter(Boolean).join(" to ");
    return `Connector${object.label.trim() ? `: ${object.label.trim()}` : ""}${endpoints ? `, ${endpoints}` : ""}`;
  }
  if (object.kind === "image") return `Image: ${object.alt.trim() || "Untitled image"}`;
  if (object.kind === "draw") return "Freehand drawing";
  return object.closed ? "Closed vector path" : "Open vector path";
}

function defaultBounds(object: CanvasObject, route: ResolvedConnectorRoute | null | undefined): CanvasBounds {
  if (object.kind === "connector" && route) return route.bounds;
  return { x: object.x, y: object.y, width: object.width, height: object.height };
}

function SelectionOutline({ bounds, focused }: {
  bounds: CanvasBounds;
  focused: boolean;
}) {
  if (!focused) return null;
  const inset = 5;
  return (
    <rect
      className="semantic-canvas-object__selection is-focused"
      data-focus-ring="true"
      x={bounds.x - inset}
      y={bounds.y - inset}
      width={Math.max(1, bounds.width + inset * 2)}
      height={Math.max(1, bounds.height + inset * 2)}
      rx={8}
      fill="none"
      stroke={SEMANTIC_SELECTION_COLOR}
      strokeWidth={SEMANTIC_SELECTION_STROKE_WIDTH}
      strokeDasharray="5 4"
      vectorEffect="non-scaling-stroke"
      pointerEvents="none"
    />
  );
}

function SemanticCanvasObjectComponent({
  object,
  connectorRoute,
  bounds,
  selected = false,
  focused = false,
  suppressFocusVisual = false,
  className,
  tabIndex,
  onSelect,
  onPointerStart,
  onEditRequested,
  onFocus,
  onBlur,
  connectorLayer = "all",
}: SemanticCanvasObjectProps) {
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null);
  const [locallyFocused, setLocallyFocused] = useState(false);
  const showFocus = !suppressFocusVisual && (focused || locallyFocused);
  const label = objectLabel(object).slice(0, 1_000);
  const classes = [
    "semantic-canvas-object",
    `semantic-canvas-object--${object.kind}`,
    selected ? "is-selected" : "",
    showFocus ? "is-focused" : "",
    className ?? "",
  ].filter(Boolean).join(" ");

  function handlePointerDown(event: PointerEvent<SVGGElement>) {
    if (event.button !== 0) return;
    const additive = event.shiftKey || event.metaKey || event.ctrlKey;
    onSelect?.(object.id, additive);
    if (onPointerStart) {
      event.preventDefault();
      onPointerStart({
        objectId: object.id,
        pointerId: event.pointerId,
        clientX: event.clientX,
        clientY: event.clientY,
        additive,
      });
    }
  }

  function handleKeyDown(event: KeyboardEvent<SVGGElement>) {
    if (event.key === "F2" && onEditRequested && (object.kind === "text" || object.kind === "shape")) {
      event.preventDefault();
      event.stopPropagation();
      onEditRequested(object.id);
      return;
    }
    if (!onSelect || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    event.stopPropagation();
    onSelect(object.id, event.shiftKey || event.metaKey || event.ctrlKey);
  }

  function handleDoubleClick(event: MouseEvent<SVGGElement>) {
    if (!onEditRequested || (object.kind !== "text" && object.kind !== "shape")) return;
    event.preventDefault();
    event.stopPropagation();
    onEditRequested(object.id);
  }

  function handleFocus(event: FocusEvent<SVGGElement>) {
    if (event.currentTarget !== event.target) return;
    setLocallyFocused(true);
    onFocus?.(object.id);
  }

  function handleBlur(event: FocusEvent<SVGGElement>) {
    if (event.currentTarget !== event.target) return;
    setLocallyFocused(false);
    onBlur?.(object.id);
  }

  let primitive: ReactNode;
  if (object.kind === "text") primitive = <TextPrimitive object={object} />;
  else if (object.kind === "shape") primitive = <ShapePrimitive object={object} />;
  else if (object.kind === "connector") {
    primitive = <ConnectorPrimitive object={object} route={connectorRoute} layer={connectorLayer} />;
  } else if (object.kind === "image") {
    primitive = (
      <ImagePrimitive
        object={object}
        failed={failedImageUrl === object.url}
        onError={() => setFailedImageUrl(object.url)}
      />
    );
  } else if (object.kind === "draw") primitive = <DrawPrimitive object={object} />;
  else primitive = <PathPrimitive object={object} />;

  return (
    <g
      id={object.id}
      className={classes}
      role={onSelect ? "button" : "img"}
      aria-label={label}
      aria-pressed={onSelect ? selected : undefined}
      tabIndex={tabIndex ?? (onSelect ? 0 : undefined)}
      focusable={tabIndex !== undefined || onSelect ? "true" : undefined}
      data-object-id={object.id}
      data-object-kind={object.kind}
      data-object-revision={object.revision}
      data-object-x={object.x}
      data-object-y={object.y}
      data-object-width={object.width}
      data-object-height={object.height}
      data-node-type={object.kind === "shape" ? object.nodeType ?? undefined : undefined}
      data-rotation={object.rotation}
      data-selected={selected ? "true" : "false"}
      data-focused={showFocus ? "true" : "false"}
      onPointerDown={handlePointerDown}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
      onFocus={handleFocus}
      onBlur={handleBlur}
    >
      <title>{label}</title>
      {primitive}
      <SelectionOutline
        bounds={bounds ?? defaultBounds(object, connectorRoute)}
        focused={showFocus && (object.kind !== "connector" || connectorLayer === "all")}
      />
    </g>
  );
}

/**
 * Non-interactive foreground connector adornments. The authoritative semantic
 * object and its hit target live in the shaft layer, so this overlay never
 * duplicates IDs, accessibility nodes, or pointer handling.
 */
function SemanticCanvasConnectorOverlayComponent({
  object,
  connectorRoute,
  bounds,
  focused = false,
  onSelect,
  onPointerStart,
}: SemanticCanvasConnectorOverlayProps) {
  const presentation = connectorPresentation({ object, route: connectorRoute });
  function handleLabelPointerDown(event: PointerEvent<SVGGElement>) {
    if (event.button !== 0) return;
    const additive = event.shiftKey || event.metaKey || event.ctrlKey;
    onSelect?.(object.id, additive);
    if (onPointerStart) {
      event.preventDefault();
      onPointerStart({
        objectId: object.id,
        pointerId: event.pointerId,
        clientX: event.clientX,
        clientY: event.clientY,
        additive,
      });
    }
    event.stopPropagation();
  }
  return (
    <g
      className="semantic-canvas-connector-overlay"
      data-connector-overlay-id={object.id}
      data-connector-overlay-focused={focused ? "true" : "false"}
      aria-hidden="true"
      pointerEvents="none"
    >
      <ConnectorOverlayPrimitive
        object={object}
        presentation={presentation}
        onLabelPointerDown={onSelect || onPointerStart ? handleLabelPointerDown : undefined}
      />
      <SelectionOutline
        bounds={bounds ?? defaultBounds(object, connectorRoute)}
        focused={focused}
      />
    </g>
  );
}

function semanticCanvasConnectorOverlayPropsEqual(
  previous: SemanticCanvasConnectorOverlayProps,
  next: SemanticCanvasConnectorOverlayProps,
): boolean {
  return previous.object === next.object
    && previous.connectorRoute === next.connectorRoute
    && previous.bounds === next.bounds
    && previous.focused === next.focused
    && Boolean(previous.onSelect) === Boolean(next.onSelect)
    && Boolean(previous.onPointerStart) === Boolean(next.onPointerStart);
}

export function semanticCanvasObjectPropsEqual(
  previous: SemanticCanvasObjectProps,
  next: SemanticCanvasObjectProps,
): boolean {
  return previous.object === next.object
    && previous.connectorRoute === next.connectorRoute
    && previous.bounds === next.bounds
    && previous.selected === next.selected
    && previous.focused === next.focused
    && previous.suppressFocusVisual === next.suppressFocusVisual
    && previous.className === next.className
    && previous.tabIndex === next.tabIndex
    && previous.connectorLayer === next.connectorLayer
    // Canvas handlers are intentionally ref-driven. Their availability can
    // change at a role boundary, but aggregate presence envelopes must not
    // invalidate every object merely by recreating parent closures.
    && Boolean(previous.onSelect) === Boolean(next.onSelect)
    && Boolean(previous.onPointerStart) === Boolean(next.onPointerStart)
    && Boolean(previous.onEditRequested) === Boolean(next.onEditRequested)
    && Boolean(previous.onFocus) === Boolean(next.onFocus)
    && Boolean(previous.onBlur) === Boolean(next.onBlur);
}

export const SemanticCanvasObject = memo(SemanticCanvasObjectComponent, semanticCanvasObjectPropsEqual);
SemanticCanvasObject.displayName = "SemanticCanvasObject";

export const SemanticCanvasConnectorOverlay = memo(
  SemanticCanvasConnectorOverlayComponent,
  semanticCanvasConnectorOverlayPropsEqual,
);
SemanticCanvasConnectorOverlay.displayName = "SemanticCanvasConnectorOverlay";
