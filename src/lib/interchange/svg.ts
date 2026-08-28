import {
  connectorLabelBoundsForRoute,
  normalizeConnectorRouting,
  resolveConnectorRoutes,
  type ResolvedConnectorRoute,
} from "@/lib/domain/connector-routing";
import {
  SEMANTIC_CANVAS_BACKGROUND,
  SEMANTIC_CONNECTOR_ARROW_SIZE,
  SEMANTIC_CONNECTOR_LABEL_FONT_SIZE,
  SEMANTIC_CONNECTOR_LABEL_LINE_HEIGHT,
  SEMANTIC_CONNECTOR_STROKE_WIDTH,
  SEMANTIC_DRAW_FONT_FAMILY,
  SEMANTIC_DRAW_STROKE_WIDTHS,
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
import { connectorLabelMetrics } from "@/lib/domain/layout";
import type { RoomState } from "@/lib/domain/types";

import { parseJazzboardArtifactV1 } from "./schemas";
import { sortArtifactWarnings } from "./project";
import type {
  JazzboardArtifactV1,
  JazzboardArtifactWarning,
  SvgExport,
  SvgRenderOptions,
} from "./types";

type ArtifactObject = JazzboardArtifactV1["objects"][number];
type Coordinate = { x: number; y: number };
type ConnectorObject = Extract<ArtifactObject, { kind: "connector" }>;

const CONNECTOR_LABEL_GRAPHEME_WIDTH = 11;
const CONNECTOR_LABEL_TOTAL_INSET = 9;

function number(value: number): string {
  const rounded = Math.round(value * 1_000) / 1_000;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

function xmlText(value: string, maxLength = 2_000): string {
  return value
    .normalize("NFKC")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .slice(0, maxLength)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function rotation(object: ArtifactObject): string {
  if (!object.rotation) return "";
  const degrees = object.rotation * (180 / Math.PI);
  const centerX = object.x + object.width / 2;
  const centerY = object.y + object.height / 2;
  return ` transform="rotate(${number(degrees)} ${number(centerX)} ${number(centerY)})"`;
}

function localRotation(object: ArtifactObject): string {
  if (!object.rotation) return `translate(${number(object.x)} ${number(object.y)})`;
  return `translate(${number(object.x)} ${number(object.y)}) rotate(${number(object.rotation * (180 / Math.PI))})`;
}

function rotatedPoint(point: Coordinate, angle: number, origin: Coordinate): Coordinate {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const dx = point.x - origin.x;
  const dy = point.y - origin.y;
  return {
    x: origin.x + dx * cosine - dy * sine,
    y: origin.y + dx * sine + dy * cosine,
  };
}

function geometryPoints(
  object: ArtifactObject,
  connectorRoutes: Readonly<Record<string, ResolvedConnectorRoute>>,
): Coordinate[] {
  if (object.kind === "connector") {
    return connectorRoutes[object.id]?.points ?? [object.start, object.end];
  }
  if (object.kind === "draw") {
    return object.points.map((point) => {
      const rotated = rotatedPoint(point, object.rotation, { x: 0, y: 0 });
      return { x: object.x + rotated.x, y: object.y + rotated.y };
    });
  }
  const center = { x: object.x + object.width / 2, y: object.y + object.height / 2 };
  return [
    { x: object.x, y: object.y },
    { x: object.x + object.width, y: object.y },
    { x: object.x + object.width, y: object.y + object.height },
    { x: object.x, y: object.y + object.height },
  ].map((point) => rotatedPoint(point, object.rotation, center));
}

/**
 * Freeze auto intent to its persisted concrete kind while rendering. This
 * prevents a scoped export from changing just because unrelated obstacles
 * were intentionally omitted from the portable artifact.
 */
function resolvedArtifactConnectorRoutes(
  artifact: JazzboardArtifactV1,
): Record<string, ResolvedConnectorRoute> {
  const objects = Object.fromEntries(
    artifact.objects.map((object, index) => {
      if (object.kind !== "connector") return [object.id, object];
      const routing = normalizeConnectorRouting(object.routing);
      return [
        object.id,
        {
          ...object,
          createdAt: "createdAt" in object ? object.createdAt : index,
          start: object.start.isPrecise && object.start.normalizedAnchor
            ? object.start
            : { ...object.start, objectId: null },
          end: object.end.isPrecise && object.end.normalizedAnchor
            ? object.end
            : { ...object.end, objectId: null },
          routing: { ...routing, mode: routing.kind },
        },
      ];
    }),
  );
  const diagrams = Object.fromEntries(artifact.diagrams.map((diagram) => [diagram.id, diagram]));
  return resolveConnectorRoutes({ objects, diagrams } as unknown as Pick<RoomState, "objects" | "diagrams">);
}

function wrapConnectorLine(value: string, maxGraphemes: number): string[] {
  const graphemes = Array.from(value);
  const targetLineCount = Math.max(1, Math.ceil(graphemes.length / maxGraphemes));
  if (targetLineCount === 1) return [value];
  const lines: string[] = [];
  let offset = 0;
  for (let lineIndex = 0; lineIndex < targetLineCount - 1; lineIndex += 1) {
    const remainingLines = targetLineCount - lineIndex;
    const remainingGraphemes = graphemes.length - offset;
    const minimumTake = Math.max(1, remainingGraphemes - (remainingLines - 1) * maxGraphemes);
    const maximumTake = Math.min(maxGraphemes, remainingGraphemes - (remainingLines - 1));
    const idealTake = Math.min(
      maximumTake,
      Math.max(minimumTake, Math.round(remainingGraphemes / remainingLines)),
    );
    let take = idealTake;
    let nearestBoundaryDistance = Number.POSITIVE_INFINITY;
    for (let candidate = minimumTake; candidate <= maximumTake; candidate += 1) {
      if (!/\s/u.test(graphemes[offset + candidate] ?? "")) continue;
      let nextOffset = offset + candidate;
      while (/\s/u.test(graphemes[nextOffset] ?? "")) nextOffset += 1;
      if (graphemes.length - nextOffset < remainingLines - 1) continue;
      const distance = Math.abs(candidate - idealTake);
      if (distance < nearestBoundaryDistance) {
        take = candidate;
        nearestBoundaryDistance = distance;
      }
    }
    const line = graphemes.slice(offset, offset + take).join("").trim();
    if (line) lines.push(line);
    offset += take;
    while (/\s/u.test(graphemes[offset] ?? "")) offset += 1;
  }
  const finalLine = graphemes.slice(offset).join("").trim();
  if (finalLine) lines.push(finalLine);
  return lines;
}

function connectorLabelLayout(object: ConnectorObject, route: ResolvedConnectorRoute) {
  const metrics = connectorLabelMetrics(object.label);
  if (!metrics.normalizedLines.length) return null;
  const maxGraphemes = Math.max(
    1,
    Math.floor((metrics.width - CONNECTOR_LABEL_TOTAL_INSET) / CONNECTOR_LABEL_GRAPHEME_WIDTH),
  );
  const lines = metrics.normalizedLines.flatMap((line) => wrapConnectorLine(line, maxGraphemes));
  const bounds = route.labelBounds ?? connectorLabelBoundsForRoute(
    object.label,
    route.points,
    route.routing.labelPosition,
  )!;
  const width = bounds.width;
  const height = bounds.height;
  const centerX = route.labelPoint.x;
  const centerY = route.labelPoint.y;
  return {
    x: bounds.x,
    y: bounds.y,
    width,
    height,
    centerX,
    firstTextY:
      centerY - ((lines.length - 1) * SEMANTIC_CONNECTOR_LABEL_LINE_HEIGHT) / 2 +
      SEMANTIC_CONNECTOR_LABEL_FONT_SIZE * 0.35,
    lines,
  };
}

function renderBounds(
  artifact: JazzboardArtifactV1,
  padding: number,
  connectorRoutes: Readonly<Record<string, ResolvedConnectorRoute>>,
) {
  let minX = artifact.bounds.x;
  let minY = artifact.bounds.y;
  let maxX = artifact.bounds.x + artifact.bounds.width;
  let maxY = artifact.bounds.y + artifact.bounds.height;
  for (const object of artifact.objects) {
    for (const point of geometryPoints(object, connectorRoutes)) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
    if (object.kind === "connector") {
      const route = connectorRoutes[object.id];
      const label = route ? connectorLabelLayout(object, route) : null;
      if (label) {
        minX = Math.min(minX, label.x);
        minY = Math.min(minY, label.y);
        maxX = Math.max(maxX, label.x + label.width);
        maxY = Math.max(maxY, label.y + label.height);
      }
    }
  }
  minX -= padding;
  minY -= padding;
  maxX += padding;
  maxY += padding;
  return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}

function boundedOption(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

function wrappedLines(value: string, maxCharacters: number, maxLines = 6): string[] {
  const text = value.replace(/\s+/g, " ").trim().slice(0, 1_200);
  if (!text) return [];
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (!current) current = word;
    else if (`${current} ${word}`.length <= maxCharacters) current = `${current} ${word}`;
    else {
      lines.push(current);
      current = word;
    }
    if (lines.length >= maxLines) break;
  }
  if (lines.length < maxLines && current) lines.push(current);
  if (words.join(" ").length > lines.join(" ").length && lines.length) {
    lines[lines.length - 1] = `${lines[lines.length - 1].slice(0, Math.max(1, maxCharacters - 1))}…`;
  }
  return lines;
}

function textLines(
  lines: readonly string[],
  x: number,
  firstY: number,
  lineHeight: number,
  anchor: "start" | "middle" | "end",
  fill: string,
  fontSize: number,
  outlineColor?: string,
  outlineWidth = 0,
): string {
  if (!lines.length) return "";
  const spans = lines
    .map(
      (line, index) =>
        `<tspan x="${number(x)}" dy="${index === 0 ? "0" : number(lineHeight)}">${xmlText(line, 500)}</tspan>`,
    )
    .join("");
  const outline = outlineColor
    ? ` stroke="${outlineColor}" stroke-width="${number(outlineWidth)}" stroke-linejoin="round" paint-order="stroke fill"`
    : "";
  return `<text class="jazzboard-draw-text" x="${number(x)}" y="${number(firstY)}" fill="${fill}" font-family="${SEMANTIC_DRAW_FONT_FAMILY}" font-size="${number(fontSize)}" font-weight="400" text-anchor="${anchor}"${outline}>${spans}</text>`;
}

function renderText(object: Extract<ArtifactObject, { kind: "text" }>): string {
  const fontSize = SEMANTIC_TEXT_FONT_SIZES[object.size];
  const lineHeight = fontSize * SEMANTIC_TEXT_LINE_HEIGHT;
  const maxCharacters = Math.max(8, Math.floor(object.width / (fontSize * 0.58)));
  const lines = wrappedLines(object.content, maxCharacters);
  const x = object.align === "start" ? object.x : object.align === "end" ? object.x + object.width : object.x + object.width / 2;
  const firstY = object.y + Math.min(fontSize, object.height / 2);
  return `<g${rotation(object)}>${textLines(lines, x, firstY, lineHeight, object.align, semanticStrokeColor(object.color), fontSize)}</g>`;
}

function renderShape(object: Extract<ArtifactObject, { kind: "shape" }>): string {
  const fill = semanticFillColor(object.fill, "blue", true);
  const stroke = semanticStrokeColor(object.stroke, "blue");
  const attributes = `fill="${fill}" stroke="${stroke}" stroke-width="${number(SEMANTIC_SHAPE_STROKE_WIDTH)}" stroke-linecap="round" stroke-linejoin="round"`;
  let geometry: string;
  if (object.shape === "ellipse") {
    geometry = `<ellipse cx="${number(object.x + object.width / 2)}" cy="${number(object.y + object.height / 2)}" rx="${number(object.width / 2)}" ry="${number(object.height / 2)}" ${attributes}/>`;
  } else if (object.shape === "diamond") {
    const points = [
      `${number(object.x + object.width / 2)},${number(object.y)}`,
      `${number(object.x + object.width)},${number(object.y + object.height / 2)}`,
      `${number(object.x + object.width / 2)},${number(object.y + object.height)}`,
      `${number(object.x)},${number(object.y + object.height / 2)}`,
    ].join(" ");
    geometry = `<polygon points="${points}" ${attributes}/>`;
  } else {
    const radius = Math.min(
      SEMANTIC_SHAPE_CORNER_RADIUS,
      object.width / 8,
      object.height / 8,
    );
    geometry = `<rect x="${number(object.x)}" y="${number(object.y)}" width="${number(object.width)}" height="${number(object.height)}" rx="${number(radius)}" ${attributes}/>`;
  }
  const lines = wrappedLines(
    object.label,
    semanticShapeLabelMaxCharacters(object.width),
    semanticShapeLabelMaxLines(object.height),
  );
  const firstY = object.y + object.height / 2 -
    ((lines.length - 1) * SEMANTIC_SHAPE_LABEL_LINE_HEIGHT) / 2 +
    SEMANTIC_SHAPE_LABEL_FONT_SIZE * 0.35;
  const label = textLines(
    lines,
    object.x + object.width / 2,
    firstY,
    SEMANTIC_SHAPE_LABEL_LINE_HEIGHT,
    "middle",
    stroke,
    SEMANTIC_SHAPE_LABEL_FONT_SIZE,
    fill === "none" ? SEMANTIC_CANVAS_BACKGROUND : fill,
    5,
  );
  return `<g${rotation(object)}>${geometry}${label}</g>`;
}

function routePath(points: readonly Coordinate[]): string {
  return points.map((point, index) => `${index ? "L" : "M"} ${number(point.x)} ${number(point.y)}`).join(" ");
}

function arrowHead(
  tip: Coordinate,
  neighbor: Coordinate,
  size = SEMANTIC_CONNECTOR_ARROW_SIZE,
): string {
  const angle = Math.atan2(tip.y - neighbor.y, tip.x - neighbor.x);
  const wing = size * 0.58;
  const baseX = tip.x - Math.cos(angle) * size;
  const baseY = tip.y - Math.sin(angle) * size;
  const perpendicularX = -Math.sin(angle) * wing;
  const perpendicularY = Math.cos(angle) * wing;
  return [
    `${number(tip.x)},${number(tip.y)}`,
    `${number(baseX + perpendicularX)},${number(baseY + perpendicularY)}`,
    `${number(baseX - perpendicularX)},${number(baseY - perpendicularY)}`,
  ].join(" ");
}

function renderConnector(object: ConnectorObject, route: ResolvedConnectorRoute): string {
  const stroke = semanticStrokeColor(object.color);
  const points = route.points;
  const strokeAttributes = `stroke="${stroke}" stroke-width="${number(SEMANTIC_CONNECTOR_STROKE_WIDTH)}" stroke-linecap="round" stroke-linejoin="round"`;
  let geometry: string;
  if (route.routing.kind === "straight") {
    geometry = `<line x1="${number(route.start.x)}" y1="${number(route.start.y)}" x2="${number(route.end.x)}" y2="${number(route.end.y)}" ${strokeAttributes}/>`;
  } else if (route.routing.kind === "curved" && route.arc) {
    const largeArc = Math.abs(route.arc.sweepAngle) > Math.PI ? 1 : 0;
    const sweep = route.arc.sweepAngle >= 0 ? 1 : 0;
    const path = `M ${number(route.start.x)} ${number(route.start.y)} A ${number(route.arc.radius)} ${number(route.arc.radius)} 0 ${largeArc} ${sweep} ${number(route.end.x)} ${number(route.end.y)}`;
    geometry = `<path d="${path}" fill="none" ${strokeAttributes}/>`;
  } else {
    geometry = `<path d="${routePath(route.points)}" fill="none" ${strokeAttributes}/>`;
  }
  const arrowheads: string[] = [];
  if (object.direction === "both") {
    arrowheads.push(
      `<polygon points="${arrowHead(points[0], points[1])}" fill="${stroke}"/>`,
    );
  }
  if (object.direction !== "none") {
    arrowheads.push(
      `<polygon points="${arrowHead(points.at(-1)!, points.at(-2)!)}" fill="${stroke}"/>`,
    );
  }
  const label = connectorLabelLayout(object, route);
  if (!label) return `${geometry}${arrowheads.join("")}`;
  const background = `<rect x="${number(label.x)}" y="${number(label.y)}" width="${number(label.width)}" height="${number(label.height)}" rx="4" fill="${SEMANTIC_CANVAS_BACKGROUND}" stroke="none"/>`;
  const text = textLines(
    label.lines,
    label.centerX,
    label.firstTextY,
    SEMANTIC_CONNECTOR_LABEL_LINE_HEIGHT,
    "middle",
    stroke,
    SEMANTIC_CONNECTOR_LABEL_FONT_SIZE,
  );
  return `${geometry}${arrowheads.join("")}<g>${background}${text}</g>`;
}

function renderImage(object: Extract<ArtifactObject, { kind: "image" }>): string {
  const x = number(object.x);
  const y = number(object.y);
  const width = number(object.width);
  const height = number(object.height);
  const lines = wrappedLines(object.alt || "Image unavailable in portable export", Math.max(10, Math.floor(object.width / 9)), 3);
  const label = textLines(lines, object.x + object.width / 2, object.y + object.height / 2, 17, "middle", "#596376", 14);
  return `<g${rotation(object)}><rect x="${x}" y="${y}" width="${width}" height="${height}" rx="8" fill="#f2f4f8" stroke="#8b919a" stroke-width="2" stroke-dasharray="8 6"/><line x1="${x}" y1="${y}" x2="${number(object.x + object.width)}" y2="${number(object.y + object.height)}" stroke="#c2c7d0"/><line x1="${number(object.x + object.width)}" y1="${y}" x2="${x}" y2="${number(object.y + object.height)}" stroke="#c2c7d0"/>${label}</g>`;
}

function renderDraw(object: Extract<ArtifactObject, { kind: "draw" }>): string {
  const points = object.points.map((point) => `${number(point.x)},${number(point.y)}`).join(" ");
  return `<polyline points="${points}" transform="${localRotation(object)}" fill="none" stroke="${semanticStrokeColor(object.color, "red")}" stroke-width="${number(SEMANTIC_DRAW_STROKE_WIDTHS[object.size])}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

function renderObject(
  object: ArtifactObject,
  connectorRoutes: Readonly<Record<string, ResolvedConnectorRoute>>,
): string {
  if (object.kind === "text") return renderText(object);
  if (object.kind === "shape") return renderShape(object);
  if (object.kind === "connector") {
    const route = connectorRoutes[object.id];
    if (route) return renderConnector(object, route);
  }
  if (object.kind === "image") return renderImage(object);
  if (object.kind === "draw") return renderDraw(object);
  return "";
}

/**
 * Render sanitized semantic geometry without executable SVG features. The
 * output never emits script, style, foreignObject, image, use, or href tags.
 */
export function renderJazzboardSvg(
  input: JazzboardArtifactV1,
  options: SvgRenderOptions = {},
): SvgExport {
  const artifact = parseJazzboardArtifactV1(input);
  const padding = boundedOption(options.padding, 48, 0, 512);
  const maxWidth = boundedOption(options.maxWidth, 4_096, 1, 8_192);
  const maxHeight = boundedOption(options.maxHeight, 4_096, 1, 8_192);
  const connectorRoutes = resolvedArtifactConnectorRoutes(artifact);
  const view = renderBounds(artifact, padding, connectorRoutes);
  const scale = Math.min(1, maxWidth / view.width, maxHeight / view.height);
  const width = Math.max(1, Math.ceil(view.width * scale));
  const height = Math.max(1, Math.ceil(view.height * scale));
  const warnings: JazzboardArtifactWarning[] = [...artifact.warnings];
  for (const object of artifact.objects) {
    if (object.kind !== "image") continue;
    if (warnings.some((warning) => warning.code === "MEDIA_NOT_EMBEDDED" && warning.objectId === object.id)) {
      continue;
    }
    warnings.push({
      code: "MEDIA_NOT_EMBEDDED",
      message: `Image ${object.id} is represented by a non-networked SVG placeholder.`,
      objectId: object.id,
      diagramId: null,
    });
  }
  const objects = [...artifact.objects]
    .sort((left, right) => left.zIndex - right.zIndex || left.id.localeCompare(right.id))
    .map((object) => renderObject(object, connectorRoutes))
    .join("");
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${number(view.x)} ${number(view.y)} ${number(view.width)} ${number(view.height)}" role="img" aria-labelledby="jazzboard-title jazzboard-description">`,
    `<title id="jazzboard-title">${xmlText(artifact.title, 200)}</title>`,
    `<desc id="jazzboard-description">${xmlText(artifact.description || "Jazzboard semantic canvas export.", 1_000)}</desc>`,
    `<rect x="${number(view.x)}" y="${number(view.y)}" width="${number(view.width)}" height="${number(view.height)}" fill="${SEMANTIC_CANVAS_BACKGROUND}"/>`,
    objects,
    "</svg>",
  ].join("");
  return { svg, width, height, warnings: sortArtifactWarnings(warnings) };
}
