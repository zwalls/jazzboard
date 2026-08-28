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

import type { ResolvedConnectorRoute } from "@/lib/domain/connector-routing";
import { connectorLabelMetrics } from "@/lib/domain/layout";
import type {
  CanvasBounds,
  CanvasObject,
  ConnectorObject,
  DrawObject,
  ImageObject,
  Point,
  ShapeObject,
  TextObject,
} from "@/lib/domain/types";

const COLORS: Readonly<Record<string, string>> = {
  black: "#1d1d1d",
  grey: "#8b919a",
  "light-violet": "#e9e7ff",
  violet: "#7950f2",
  blue: "#4263eb",
  "light-blue": "#a5d8ff",
  yellow: "#f5d90a",
  orange: "#f08c00",
  green: "#2f9e44",
  "light-green": "#b2f2bb",
  "light-red": "#ffc9c9",
  red: "#e03131",
  white: "#ffffff",
};

const CONNECTOR_LABEL_FONT_SIZE = 20;
const CONNECTOR_LABEL_LINE_HEIGHT = 27;
const CONNECTOR_LABEL_GRAPHEME_WIDTH = 11;
const CONNECTOR_LABEL_TOTAL_INSET = 9;

export type SemanticCanvasObjectProps = {
  object: CanvasObject;
  /** Canonical, page-space connector geometry from the semantic scene. */
  connectorRoute?: ResolvedConnectorRoute | null;
  /** Page-space visual bounds. Supplying scene-object bounds keeps rotated/drawn selection exact. */
  bounds?: CanvasBounds;
  selected?: boolean;
  focused?: boolean;
  className?: string;
  tabIndex?: number;
  onSelect?: (objectId: string, additive: boolean) => void;
  onPointerStart?: (input: Readonly<{
    objectId: string;
    pointerId: number;
    clientX: number;
    clientY: number;
    additive: boolean;
  }>) => void;
  onEditRequested?: (objectId: string) => void;
  onFocus?: (objectId: string) => void;
  onBlur?: (objectId: string) => void;
};

function finiteNumber(value: number): string {
  const rounded = Math.round(value * 1_000) / 1_000;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

function semanticColor(value: string, fallback: string, allowNone = false): string {
  const normalized = value.toLowerCase();
  if (allowNone && normalized === "none") return "none";
  if (COLORS[normalized]) return COLORS[normalized];
  if (/^#[0-9a-f]{3}([0-9a-f]{3})?([0-9a-f]{2})?$/i.test(normalized)) return normalized;
  return fallback;
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

function wrapLines(value: string, maxCharacters: number, maxLines = 6): string[] {
  const paragraphs = value
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const lines: string[] = [];

  for (const paragraph of paragraphs) {
    let current = "";
    for (const sourceWord of paragraph.split(" ")) {
      const words: string[] = [];
      const graphemes = Array.from(sourceWord);
      for (let offset = 0; offset < graphemes.length; offset += maxCharacters) {
        words.push(graphemes.slice(offset, offset + maxCharacters).join(""));
      }
      for (const word of words) {
        if (!current) current = word;
        else if (Array.from(`${current} ${word}`).length <= maxCharacters) current = `${current} ${word}`;
        else {
          lines.push(current);
          current = word;
        }
        if (lines.length >= maxLines) break;
      }
      if (lines.length >= maxLines) break;
    }
    if (lines.length < maxLines && current) lines.push(current);
    if (lines.length >= maxLines) break;
  }

  const normalized = paragraphs.join(" ");
  if (lines.length && Array.from(lines.join(" ")).length < Array.from(normalized).length) {
    const last = lines.length - 1;
    lines[last] = `${Array.from(lines[last]).slice(0, Math.max(1, maxCharacters - 1)).join("")}…`;
  }
  return lines;
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
}: {
  lines: readonly string[];
  x: number;
  firstY: number;
  lineHeight: number;
  anchor: "start" | "middle" | "end";
  fill: string;
  fontSize: number;
  className: string;
}) {
  if (!lines.length) return null;
  return (
    <text
      className={className}
      x={x}
      y={firstY}
      fill={fill}
      fontFamily="Inter, ui-sans-serif, system-ui, sans-serif"
      fontSize={fontSize}
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
  const fontSize = { s: 16, m: 20, l: 28, xl: 36 }[object.size];
  const lineHeight = fontSize * 1.25;
  const lines = wrapLines(object.content, Math.max(8, Math.floor(object.width / (fontSize * 0.58))));
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
        fill={semanticColor(object.color, "#1d1d1d")}
        fontSize={fontSize}
        className="semantic-canvas-object__text"
      />
    </g>
  );
}

function hexLuminance(value: string): number | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (!match) return null;
  const full = match[1].length === 3
    ? match[1].split("").map((character) => `${character}${character}`).join("")
    : match[1];
  const channels = [0, 2, 4].map((offset) => Number.parseInt(full.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((channel) => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function shapeLabelColor(fill: string, stroke: string): string {
  if (fill === "none") return stroke;
  const luminance = hexLuminance(fill);
  if (luminance === null || luminance > 0.45) return "#182033";
  return "#ffffff";
}

function ShapePrimitive({ object }: { object: ShapeObject }) {
  const fill = semanticColor(object.fill, "#e9e7ff", true);
  const stroke = semanticColor(object.stroke, "#4263eb");
  const shared = {
    fill,
    stroke,
    strokeWidth: 2,
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
        rx={Math.min(12, object.width / 8, object.height / 8)}
      />
    );
  }
  const lines = wrapLines(object.label, Math.max(8, Math.floor(object.width / 9)), 5);
  const lineHeight = 18;
  const firstY = object.y + object.height / 2 - ((lines.length - 1) * lineHeight) / 2 + 5;
  return (
    <g className="semantic-canvas-object__content" transform={rotationTransform(object)}>
      {geometry}
      <SvgTextLines
        lines={lines}
        x={object.x + object.width / 2}
        firstY={firstY}
        lineHeight={lineHeight}
        anchor="middle"
        fill={shapeLabelColor(fill, stroke)}
        fontSize={15}
        className="semantic-canvas-object__label"
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

function arrowHead(tip: Point, neighbor: Point, size = 10): string {
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
  const maxGraphemes = Math.max(
    1,
    Math.floor((availableWidth - CONNECTOR_LABEL_TOTAL_INSET) / CONNECTOR_LABEL_GRAPHEME_WIDTH),
  );
  return wrapLines(value, maxGraphemes, 20);
}

function ConnectorPrimitive({
  object,
  route,
}: {
  object: ConnectorObject;
  route: ResolvedConnectorRoute | null | undefined;
}) {
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
  const stroke = semanticColor(object.color, "#1d1d1d");
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
    ? geometry.labelPoint.y - ((labelLines.length - 1) * CONNECTOR_LABEL_LINE_HEIGHT) / 2 + CONNECTOR_LABEL_FONT_SIZE * 0.35
    : 0;

  return (
    <g className="semantic-canvas-object__content semantic-canvas-object__connector">
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
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        pointerEvents="none"
      />
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
        <g className="semantic-canvas-object__connector-label" pointerEvents="none">
          <rect
            x={labelBounds.x}
            y={labelBounds.y}
            width={labelBounds.width}
            height={labelBounds.height}
            rx={6}
            fill="#ffffff"
            stroke="#d7dce3"
            strokeWidth={1}
          />
          <SvgTextLines
            lines={labelLines}
            x={geometry.labelPoint.x}
            firstY={firstTextY}
            lineHeight={CONNECTOR_LABEL_LINE_HEIGHT}
            anchor="middle"
            fill={stroke}
            fontSize={CONNECTOR_LABEL_FONT_SIZE}
            className="semantic-canvas-object__connector-label-text"
          />
        </g>
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
  const lines = wrapLines(label, Math.max(10, Math.floor(object.width / 9)), 3);
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
        stroke="#8b919a"
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
        stroke="#8b919a"
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
      stroke={semanticColor(object.color, "#e03131")}
      strokeWidth={{ s: 2, m: 4, l: 7 }[object.size]}
      strokeLinecap="round"
      strokeLinejoin="round"
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
  return "Freehand drawing";
}

function defaultBounds(object: CanvasObject, route: ResolvedConnectorRoute | null | undefined): CanvasBounds {
  if (object.kind === "connector" && route) return route.bounds;
  return { x: object.x, y: object.y, width: object.width, height: object.height };
}

function SelectionOutline({ bounds, focused, selected }: {
  bounds: CanvasBounds;
  focused: boolean;
  selected: boolean;
}) {
  if (!focused && !selected) return null;
  const inset = 5;
  return (
    <rect
      className={`semantic-canvas-object__selection${focused ? " is-focused" : ""}${selected ? " is-selected" : ""}`}
      data-focus-ring={focused ? "true" : undefined}
      data-selection-ring={selected ? "true" : undefined}
      x={bounds.x - inset}
      y={bounds.y - inset}
      width={Math.max(1, bounds.width + inset * 2)}
      height={Math.max(1, bounds.height + inset * 2)}
      rx={8}
      fill="none"
      stroke={selected ? "#5965e8" : "#32b898"}
      strokeWidth={focused ? 2.5 : 2}
      strokeDasharray={focused && !selected ? "5 4" : undefined}
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
  className,
  tabIndex,
  onSelect,
  onPointerStart,
  onEditRequested,
  onFocus,
  onBlur,
}: SemanticCanvasObjectProps) {
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null);
  const [locallyFocused, setLocallyFocused] = useState(false);
  const showFocus = focused || locallyFocused;
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
    primitive = <ConnectorPrimitive object={object} route={connectorRoute} />;
  } else if (object.kind === "image") {
    primitive = (
      <ImagePrimitive
        object={object}
        failed={failedImageUrl === object.url}
        onError={() => setFailedImageUrl(object.url)}
      />
    );
  } else primitive = <DrawPrimitive object={object} />;

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
      <SelectionOutline bounds={bounds ?? defaultBounds(object, connectorRoute)} focused={showFocus} selected={selected} />
    </g>
  );
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
    && previous.className === next.className
    && previous.tabIndex === next.tabIndex
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
