"use client";

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { pageToViewportPoint } from "@/lib/canvas/camera";
import { agentDraftObjectFingerprint } from "@/lib/canvas/agent-draft-choreography";
import {
  projectAgentDraft,
  type AgentDraftProjection,
} from "@/lib/canvas/agent-draft-projection";
import type { AgentDraftRevealRegistry } from "@/lib/canvas/agent-draft-reveal";
import type { SemanticSceneObject } from "@/lib/canvas/semantic-scene";
import {
  SEMANTIC_CONNECTOR_ARROW_SIZE,
  SEMANTIC_CONNECTOR_LABEL_FONT_SIZE,
  SEMANTIC_CONNECTOR_LABEL_LINE_HEIGHT,
  SEMANTIC_DRAW_FONT_FAMILY,
  SEMANTIC_DRAW_STROKE_WIDTHS,
  SEMANTIC_SHAPE_CORNER_RADIUS,
  SEMANTIC_SHAPE_LABEL_FONT_SIZE,
  SEMANTIC_SHAPE_LABEL_LINE_HEIGHT,
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
import type { AgentCanvasDraftSnapshot } from "@/lib/agent-drafts/types";
import type { ResolvedConnectorRoute } from "@/lib/domain/connector-routing";
import type {
  CanvasBounds,
  CanvasObject,
  ConnectorObject,
  Diagram,
  DrawObject,
  Point,
  ShapeObject,
  TextObject,
  Viewport,
} from "@/lib/domain/types";

import styles from "./agent-draft-layer.module.css";

const ANNOUNCEMENT_THROTTLE_MS = 240;
const STATUS_PILL_WIDTH = 230;
const STATUS_PILL_HEIGHT = 44;
const STATUS_INSET = 10;
const NO_SETTLED_DRAFTS: ReadonlySet<string> = new Set();

export type AgentDraftLayerProps = Readonly<{
  authoritativeDiagrams?: Readonly<Record<string, Diagram>>;
  authoritativeObjects: Readonly<Record<string, CanvasObject>>;
  drafts: readonly AgentCanvasDraftSnapshot[];
  initiallySettledDraftIds?: ReadonlySet<string>;
  revealRegistry?: AgentDraftRevealRegistry;
  roomId: string;
  viewport: Viewport;
}>;

function finite(value: number): string {
  const rounded = Math.round(value * 1_000) / 1_000;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

function rotationTransform(object: CanvasObject): string | undefined {
  if (!object.rotation) return undefined;
  const degrees = object.rotation * (180 / Math.PI);
  return `rotate(${finite(degrees)} ${finite(object.x + object.width / 2)} ${finite(object.y + object.height / 2)})`;
}

function drawTransform(object: DrawObject): string {
  const translate = `translate(${finite(object.x)} ${finite(object.y)})`;
  if (!object.rotation) return translate;
  return `${translate} rotate(${finite(object.rotation * (180 / Math.PI))})`;
}

function statusLabel(draft: AgentCanvasDraftSnapshot): string {
  if (draft.status === "committing") return "Validating atomic change · not saved";
  if (draft.status === "awaiting_review") return "Awaiting human approval · not on board";
  return "Draft preview · not saved";
}

function announcementFor(projections: readonly AgentDraftProjection[]): string {
  return projections
    .map(({ draft, objects }) => {
      const noun = objects.length === 1 ? "element" : "elements";
      return `${draft.author.displayName}’s agent: ${statusLabel(draft)}. ${objects.length} ${noun} staged.`;
    })
    .join(" ");
}

function useThrottledAnnouncement(value: string): string {
  const [announcement, setAnnouncement] = useState(value);
  const latestRef = useRef(value);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    latestRef.current = value;
    if (value === announcement) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setAnnouncement(latestRef.current);
    }, ANNOUNCEMENT_THROTTLE_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [announcement, value]);

  return announcement;
}

function useExpiryClock(drafts: readonly AgentCanvasDraftSnapshot[]): number {
  const [now, setNow] = useState(() => Date.now());
  const nextExpiry = drafts.reduce(
    (current, draft) => Math.min(current, draft.expiresAt, draft.hardExpiresAt),
    Number.POSITIVE_INFINITY,
  );

  useEffect(() => {
    if (!Number.isFinite(nextExpiry)) return;
    const delay = Math.max(0, Math.min(nextExpiry - Date.now() + 1, 2_147_483_647));
    const timer = setTimeout(() => setNow(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [nextExpiry]);

  return now;
}

function buildDraftProjections(
  drafts: readonly AgentCanvasDraftSnapshot[],
  authoritativeObjects: Readonly<Record<string, CanvasObject>>,
  authoritativeDiagrams: Readonly<Record<string, Diagram>> | undefined,
  roomId: string,
  now: number,
): AgentDraftProjection[] {
  return drafts.flatMap((draft) => {
    if (
      draft.roomId !== roomId ||
      draft.expiresAt <= now ||
      draft.hardExpiresAt <= now
    ) return [];

    const projection = projectAgentDraft(draft, authoritativeObjects, authoritativeDiagrams);
    return projection ? [projection] : [];
  });
}

function TextLines({
  lines,
  x,
  firstY,
  lineHeight,
  anchor,
  fill,
  fontSize,
  revealPart,
}: Readonly<{
  lines: readonly string[];
  x: number;
  firstY: number;
  lineHeight: number;
  anchor: "start" | "middle" | "end";
  fill: string;
  fontSize: number;
  revealPart?: "label";
}>) {
  return (
    <text
      data-agent-draft-reveal-part={revealPart}
      x={x}
      y={firstY}
      fill={fill}
      fontFamily={SEMANTIC_DRAW_FONT_FAMILY}
      fontSize={fontSize}
      textAnchor={anchor}
      pointerEvents="none"
    >
      {lines.map((line, index) => (
        <tspan key={`${index}-${line}`} x={x} dy={index === 0 ? 0 : lineHeight}>{line}</tspan>
      ))}
    </text>
  );
}

function DraftText({ object }: { object: TextObject }) {
  const fontSize = SEMANTIC_TEXT_FONT_SIZES[object.size];
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
    <g transform={rotationTransform(object)}>
      <rect
        className={styles.objectHalo}
        data-agent-draft-reveal-part="halo"
        x={object.x}
        y={object.y}
        width={object.width}
        height={object.height}
        rx={6}
      />
      <TextLines
        lines={lines}
        x={x}
        firstY={object.y + Math.min(fontSize, object.height / 2)}
        lineHeight={fontSize * SEMANTIC_TEXT_LINE_HEIGHT}
        anchor={object.align}
        fill={semanticStrokeColor(object.color)}
        fontSize={fontSize}
        revealPart="label"
      />
    </g>
  );
}

function DraftShape({ object }: { object: ShapeObject }) {
  const fill = semanticFillColor(object.fill, "blue", true);
  const stroke = semanticStrokeColor(object.stroke, "blue");
  const common = {
    className: styles.shape,
    fill,
    stroke,
    strokeWidth: 3.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    vectorEffect: "non-scaling-stroke" as const,
    pathLength: 1,
    "data-agent-draft-reveal-part": "trace",
  };
  let geometry: ReactNode;
  if (object.shape === "ellipse") {
    geometry = <ellipse {...common} cx={object.x + object.width / 2} cy={object.y + object.height / 2} rx={object.width / 2} ry={object.height / 2} />;
  } else if (object.shape === "diamond") {
    geometry = (
      <polygon
        {...common}
        points={`${object.x + object.width / 2},${object.y} ${object.x + object.width},${object.y + object.height / 2} ${object.x + object.width / 2},${object.y + object.height} ${object.x},${object.y + object.height / 2}`}
      />
    );
  } else {
    geometry = <rect {...common} x={object.x} y={object.y} width={object.width} height={object.height} rx={Math.min(SEMANTIC_SHAPE_CORNER_RADIUS, object.width / 8, object.height / 8)} />;
  }
  const lines = layoutSemanticText(
    object.label,
    semanticShapeLabelMaxCharacters(object.width),
    semanticShapeLabelMaxLines(object.height),
  ).lines;
  return (
    <g transform={rotationTransform(object)}>
      {geometry}
      <rect
        className={styles.objectHalo}
        data-agent-draft-reveal-part="halo"
        x={object.x - 3}
        y={object.y - 3}
        width={object.width + 6}
        height={object.height + 6}
        rx={9}
      />
      <TextLines
        lines={lines}
        x={object.x + object.width / 2}
        firstY={object.y + object.height / 2 - ((lines.length - 1) * SEMANTIC_SHAPE_LABEL_LINE_HEIGHT) / 2 + SEMANTIC_SHAPE_LABEL_FONT_SIZE * 0.35}
        lineHeight={SEMANTIC_SHAPE_LABEL_LINE_HEIGHT}
        anchor="middle"
        fill={stroke}
        fontSize={SEMANTIC_SHAPE_LABEL_FONT_SIZE}
        revealPart="label"
      />
    </g>
  );
}

function connectorPath(route: ResolvedConnectorRoute): string {
  if (route.routing.kind === "curved" && route.arc) {
    const largeArc = Math.abs(route.arc.sweepAngle) > Math.PI ? 1 : 0;
    const sweep = route.arc.sweepAngle >= 0 ? 1 : 0;
    return `M ${finite(route.start.x)} ${finite(route.start.y)} A ${finite(route.arc.radius)} ${finite(route.arc.radius)} 0 ${largeArc} ${sweep} ${finite(route.end.x)} ${finite(route.end.y)}`;
  }
  return route.points.map((point, index) => `${index ? "L" : "M"} ${finite(point.x)} ${finite(point.y)}`).join(" ");
}

function arrowHead(tip: Point, neighbor: Point): string {
  const angle = Math.atan2(tip.y - neighbor.y, tip.x - neighbor.x);
  const wing = SEMANTIC_CONNECTOR_ARROW_SIZE * 0.58;
  const baseX = tip.x - Math.cos(angle) * SEMANTIC_CONNECTOR_ARROW_SIZE;
  const baseY = tip.y - Math.sin(angle) * SEMANTIC_CONNECTOR_ARROW_SIZE;
  const perpendicularX = -Math.sin(angle) * wing;
  const perpendicularY = Math.cos(angle) * wing;
  return `${finite(tip.x)},${finite(tip.y)} ${finite(baseX + perpendicularX)},${finite(baseY + perpendicularY)} ${finite(baseX - perpendicularX)},${finite(baseY - perpendicularY)}`;
}

function DraftConnector({
  object,
  route,
}: {
  object: ConnectorObject;
  route: ResolvedConnectorRoute | undefined;
}) {
  if (!route) return null;
  const points = route.points.length ? route.points : [route.start, route.end];
  const startNeighbor = points[1] ?? points[0];
  const endNeighbor = points.at(-2) ?? points.at(-1)!;
  const labelBounds = route.labelBounds;
  const labelLines = labelBounds
    ? layoutSemanticText(
        object.label,
        semanticConnectorLabelMaximumCharacters(labelBounds.width),
        SEMANTIC_CONNECTOR_LABEL_MAX_LINES,
      ).lines
    : [];
  return (
    <g>
      <path
        className={styles.connector}
        data-agent-draft-reveal-part="final"
        d={connectorPath(route)}
        vectorEffect="non-scaling-stroke"
      />
      <path
        className={styles.connectorConstruction}
        data-agent-draft-reveal-part="trace"
        d={connectorPath(route)}
        pathLength={1}
        vectorEffect="non-scaling-stroke"
      />
      {object.direction === "both" && startNeighbor ? (
        <polygon
          className={styles.arrowhead}
          data-agent-draft-reveal-part="terminal"
          points={arrowHead(points[0]!, startNeighbor)}
        />
      ) : null}
      {object.direction !== "none" && endNeighbor ? (
        <polygon
          className={styles.arrowhead}
          data-agent-draft-reveal-part="terminal"
          points={arrowHead(points.at(-1)!, endNeighbor)}
        />
      ) : null}
      {labelBounds ? (
        <g data-agent-draft-reveal-part="label">
          <rect
            className={styles.connectorLabel}
            x={labelBounds.x}
            y={labelBounds.y}
            width={labelBounds.width}
            height={labelBounds.height}
            rx={5}
          />
          <TextLines
            lines={labelLines}
            x={route.labelPoint.x}
            firstY={route.labelPoint.y - ((labelLines.length - 1) * SEMANTIC_CONNECTOR_LABEL_LINE_HEIGHT) / 2 + SEMANTIC_CONNECTOR_LABEL_FONT_SIZE * 0.35}
            lineHeight={SEMANTIC_CONNECTOR_LABEL_LINE_HEIGHT}
            anchor="middle"
            fill="currentColor"
            fontSize={SEMANTIC_CONNECTOR_LABEL_FONT_SIZE}
          />
        </g>
      ) : null}
    </g>
  );
}

function DraftOtherObject({ object }: { object: Exclude<CanvasObject, TextObject | ShapeObject | ConnectorObject> }) {
  if (object.kind === "draw") {
    return (
      <g>
        <polyline
          points={object.points.map((point) => `${finite(point.x)},${finite(point.y)}`).join(" ")}
          transform={drawTransform(object)}
          fill="none"
          stroke={semanticStrokeColor(object.color, "red")}
          strokeWidth={SEMANTIC_DRAW_STROKE_WIDTHS[object.size]}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
          data-agent-draft-reveal-part="trace"
          pathLength={1}
        />
      </g>
    );
  }
  const label = object.alt.trim() || "Image preview";
  const lines = layoutSemanticText(label, Math.max(8, Math.floor(object.width / 9)), 3).lines;
  return (
    <g transform={rotationTransform(object)}>
      <rect
        className={styles.imagePlaceholderFill}
        data-agent-draft-reveal-part="fill"
        x={object.x}
        y={object.y}
        width={object.width}
        height={object.height}
        rx={8}
      />
      <rect
        className={styles.imagePlaceholder}
        data-agent-draft-reveal-part="trace"
        fill="none"
        pathLength={1}
        x={object.x}
        y={object.y}
        width={object.width}
        height={object.height}
        rx={8}
      />
      <TextLines
        lines={lines}
        x={object.x + object.width / 2}
        firstY={object.y + object.height / 2 - ((lines.length - 1) * 17) / 2 + 5}
        lineHeight={17}
        anchor="middle"
        fill="#596376"
        fontSize={14}
        revealPart="label"
      />
    </g>
  );
}

function DraftObjectArtwork({
  draftId,
  fingerprint,
  initiallyComplete,
  item,
  revealRegistry,
  route,
}: {
  draftId: string;
  fingerprint: string;
  initiallyComplete: boolean;
  item: SemanticSceneObject;
  revealRegistry?: AgentDraftRevealRegistry;
  route?: ResolvedConnectorRoute;
}) {
  const object = item.object;
  const elementRef = useRef<SVGGElement | null>(null);
  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element || !revealRegistry) return;
    return revealRegistry.registerObject({
      draftId,
      element,
      fingerprint,
      initiallyComplete,
      objectId: object.id,
    });
  }, [draftId, fingerprint, initiallyComplete, object.id, revealRegistry]);
  return (
    <g
      data-agent-draft-object-id={object.id}
      data-agent-draft-object-kind={object.kind}
      data-agent-draft-reveal-managed={revealRegistry ? "true" : undefined}
      ref={elementRef}
    >
      {object.kind === "text" ? <DraftText object={object} /> : null}
      {object.kind === "shape" ? <DraftShape object={object} /> : null}
      {object.kind === "connector" ? <DraftConnector object={object} route={route} /> : null}
      {object.kind === "image" || object.kind === "draw" ? <DraftOtherObject object={object} /> : null}
    </g>
  );
}

function pillPosition(bounds: CanvasBounds, viewport: Viewport): CSSProperties {
  const point = pageToViewportPoint({ x: bounds.x, y: bounds.y }, viewport);
  const physicalWidth = viewport.width * viewport.zoom;
  const physicalHeight = viewport.height * viewport.zoom;
  return {
    left: Math.max(STATUS_INSET, Math.min(point.x, Math.max(STATUS_INSET, physicalWidth - STATUS_PILL_WIDTH - STATUS_INSET))),
    top: Math.max(STATUS_INSET, Math.min(point.y - STATUS_PILL_HEIGHT - 8, Math.max(STATUS_INSET, physicalHeight - STATUS_PILL_HEIGHT - STATUS_INSET))),
  };
}

/**
 * Presentation-only projection of in-flight agent intent. Draft artwork is
 * deliberately absent from the authoritative scene/runtime and cannot receive
 * pointer, keyboard, export, selection, or accessibility-object semantics.
 */
export function AgentDraftLayer({
  authoritativeDiagrams,
  authoritativeObjects,
  drafts,
  initiallySettledDraftIds = NO_SETTLED_DRAFTS,
  revealRegistry,
  roomId,
  viewport,
}: AgentDraftLayerProps) {
  const now = useExpiryClock(drafts);
  const projections = useMemo(
    () => buildDraftProjections(drafts, authoritativeObjects, authoritativeDiagrams, roomId, now),
    [authoritativeDiagrams, authoritativeObjects, drafts, now, roomId],
  );
  const renderProjections = useMemo(() => projections.map((projection) => ({
    ...projection,
    fingerprints: new Map(projection.objects.map(({ object }) => [
      object.id,
      agentDraftObjectFingerprint(object, projection.connectorRoutes[object.id]),
    ])),
  })), [projections]);
  useLayoutEffect(() => {
    if (!revealRegistry) return;
    const visibleDraftIds = new Set<string>();
    for (const projection of renderProjections) {
      visibleDraftIds.add(projection.draft.id);
      const initiallySettled = initiallySettledDraftIds.has(projection.draft.id);
      revealRegistry.syncRenderedDraft({
        draftId: projection.draft.id,
        objects: projection.objects.map(({ object }) => ({
          objectId: object.id,
          fingerprint: projection.fingerprints.get(object.id)!,
        })),
        revealImmediately: projection.draft.status === "awaiting_review",
        seedComplete: initiallySettled,
      });
    }
    revealRegistry.removeMissingDrafts(visibleDraftIds);
  }, [initiallySettledDraftIds, renderProjections, revealRegistry]);
  const liveText = useThrottledAnnouncement(announcementFor(projections));
  if (!projections.length && !liveText) return null;

  const cameraTransform = `translate(${-viewport.x * viewport.zoom} ${-viewport.y * viewport.zoom}) scale(${viewport.zoom})`;
  return (
    <div className={styles.layer} data-testid="agent-draft-layer" style={{ pointerEvents: "none" }}>
      {projections.length ? (
        <svg
          className={styles.art}
          width="100%"
          height="100%"
          aria-hidden="true"
          focusable="false"
          pointerEvents="none"
        >
          <g transform={cameraTransform} pointerEvents="none">
            {renderProjections.map(({ draft, objects, connectorRoutes, fingerprints }) => (
              <g
                key={`${draft.id}:connectors`}
                className={styles.draftArtwork}
                data-agent-draft-id={draft.id}
                data-agent-draft-status={draft.status}
                style={{ "--agent-draft-color": draft.author.color } as CSSProperties}
              >
                {objects.filter(({ object }) => object.kind === "connector").map((item) => (
                  <DraftObjectArtwork
                    draftId={draft.id}
                    fingerprint={fingerprints.get(item.object.id)!}
                    initiallyComplete={draft.status === "awaiting_review"}
                    key={item.object.id}
                    item={item}
                    revealRegistry={revealRegistry}
                    route={connectorRoutes[item.object.id]}
                  />
                ))}
              </g>
            ))}
            {renderProjections.map(({ draft, objects, connectorRoutes, fingerprints }) => (
              <g
                key={`${draft.id}:objects`}
                className={styles.draftArtwork}
                data-agent-draft-id={draft.id}
                data-agent-draft-status={draft.status}
                style={{ "--agent-draft-color": draft.author.color } as CSSProperties}
              >
                {objects.filter(({ object }) => object.kind !== "connector").map((item) => (
                  <DraftObjectArtwork
                    draftId={draft.id}
                    fingerprint={fingerprints.get(item.object.id)!}
                    initiallyComplete={draft.status === "awaiting_review"}
                    key={item.object.id}
                    item={item}
                    revealRegistry={revealRegistry}
                    route={connectorRoutes[item.object.id]}
                  />
                ))}
              </g>
            ))}
          </g>
        </svg>
      ) : null}

      {projections.map(({ draft, bounds, objects }) => (
        <div
          aria-hidden="true"
          className={styles.statusPill}
          data-agent-draft-pill={draft.id}
          data-agent-draft-status={draft.status}
          key={`${draft.id}:pill`}
          style={{
            ...pillPosition(bounds, viewport),
            "--agent-draft-color": draft.author.color,
          } as CSSProperties}
        >
          <strong>{draft.author.displayName} · agent</strong>
          <span>{statusLabel(draft)} · {objects.length} {objects.length === 1 ? "element" : "elements"}</span>
        </div>
      ))}

      <div className={styles.liveRegion} role="status" aria-atomic="true" aria-live="polite">
        {liveText}
      </div>
    </div>
  );
}
