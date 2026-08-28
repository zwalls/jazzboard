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

import type { SemanticScene, SemanticSceneObject } from "./semantic-scene";

export const SEMANTIC_PNG_LIMITS = {
  maxTargets: 200,
  maxPadding: 256,
  maxPixelRatio: 2,
  maxDimension: 4_096,
  maxPixels: 4_096 * 4_096,
  maxOutputBytes: 8_000_000,
  maxSourceImageBytes: 10 * 1_024 * 1_024,
  maxEmbeddedImageBytes: 20 * 1_024 * 1_024,
  maxSvgBytes: 32 * 1_024 * 1_024,
} as const;

export type SemanticPngErrorCode =
  | "SCOPE_EMPTY"
  | "SCOPE_TOO_LARGE"
  | "SCOPE_DUPLICATE_OBJECT_ID"
  | "SCOPE_OBJECT_NOT_FOUND"
  | "SCENE_OBJECT_INVALID"
  | "CONNECTOR_ROUTE_UNAVAILABLE"
  | "RENDER_OPTIONS_INVALID"
  | "DIMENSION_BUDGET_EXCEEDED"
  | "SVG_BYTE_BUDGET_EXCEEDED"
  | "BROWSER_RASTERIZER_UNAVAILABLE"
  | "SVG_RASTERIZATION_FAILED"
  | "CANVAS_CONTEXT_UNAVAILABLE"
  | "CANVAS_SECURITY_ERROR"
  | "PNG_ENCODING_FAILED"
  | "PNG_BYTE_BUDGET_EXCEEDED";

export class SemanticPngRenderError extends Error {
  constructor(
    public readonly code: SemanticPngErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "SemanticPngRenderError";
  }
}

export type SemanticImageWarningCode =
  | "IMAGE_NOT_PROVIDED"
  | "IMAGE_URL_INVALID"
  | "IMAGE_ROOM_MISMATCH"
  | "IMAGE_FETCH_FAILED"
  | "IMAGE_RESPONSE_INVALID"
  | "IMAGE_TYPE_UNSUPPORTED"
  | "IMAGE_CONTENT_INVALID"
  | "IMAGE_SOURCE_TOO_LARGE"
  | "IMAGE_TOTAL_BUDGET_EXCEEDED"
  | "IMAGE_EMBED_REJECTED";

export type SemanticPngWarning = Readonly<{
  code: SemanticImageWarningCode;
  objectId: string;
  message: string;
}>;

export type SemanticSvgImage =
  | Readonly<{ kind: "embedded"; dataUrl: string }>
  | Readonly<{ kind: "unavailable"; code: SemanticImageWarningCode }>;

export type SemanticSvgRenderOptions = Readonly<{
  padding?: number;
  pixelRatio?: number;
  scale?: number;
  background?: boolean;
  darkMode?: boolean;
  maxWidth?: number;
  maxHeight?: number;
  maxSvgBytes?: number;
  images?: Readonly<Record<string, SemanticSvgImage>>;
}>;

export type SemanticSvgRenderResult = Readonly<{
  svg: string;
  objectIds: readonly string[];
  bounds: CanvasBounds;
  logicalWidth: number;
  logicalHeight: number;
  pixelWidth: number;
  pixelHeight: number;
  warnings: readonly SemanticPngWarning[];
}>;

type NormalizedOptions = Required<Omit<SemanticSvgRenderOptions, "images">> & {
  images: Readonly<Record<string, SemanticSvgImage>>;
};

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

const IMAGE_MIME_TYPES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);
const CONNECTOR_LABEL_FONT_SIZE = 20;
const CONNECTOR_LABEL_LINE_HEIGHT = 27;
const CONNECTOR_LABEL_GRAPHEME_WIDTH = 11;
const CONNECTOR_LABEL_TOTAL_INSET = 9;

function fail(
  code: SemanticPngErrorCode,
  message: string,
  details?: Record<string, unknown>,
): never {
  throw new SemanticPngRenderError(code, message, details);
}

function finite(value: number, label: string, details?: Record<string, unknown>): number {
  if (!Number.isFinite(value)) {
    fail("SCENE_OBJECT_INVALID", `Semantic PNG ${label} must be finite.`, details);
  }
  return value;
}

function formatNumber(value: number): string {
  finite(value, "geometry");
  const rounded = Math.round(value * 1_000) / 1_000;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

function xml(value: string, maxLength: number): string {
  return Array.from(value.normalize("NFKC"))
    .slice(0, maxLength)
    .join("")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function color(value: string, fallback: string, allowNone = false): string {
  const normalized = value.toLowerCase();
  if (allowNone && normalized === "none") return "none";
  if (COLORS[normalized]) return COLORS[normalized];
  if (/^#[0-9a-f]{3}([0-9a-f]{3})?([0-9a-f]{2})?$/i.test(normalized)) return normalized;
  return fallback;
}

function normalizeOptions(options: SemanticSvgRenderOptions): NormalizedOptions {
  const normalized: NormalizedOptions = {
    padding: options.padding ?? 32,
    pixelRatio: options.pixelRatio ?? 1,
    scale: options.scale ?? 1,
    background: options.background ?? true,
    darkMode: options.darkMode ?? false,
    maxWidth: options.maxWidth ?? SEMANTIC_PNG_LIMITS.maxDimension,
    maxHeight: options.maxHeight ?? SEMANTIC_PNG_LIMITS.maxDimension,
    maxSvgBytes: options.maxSvgBytes ?? SEMANTIC_PNG_LIMITS.maxSvgBytes,
    images: options.images ?? {},
  };
  const invalid =
    !Number.isFinite(normalized.padding) ||
    normalized.padding < 0 ||
    normalized.padding > SEMANTIC_PNG_LIMITS.maxPadding ||
    !Number.isFinite(normalized.pixelRatio) ||
    normalized.pixelRatio < 1 ||
    normalized.pixelRatio > SEMANTIC_PNG_LIMITS.maxPixelRatio ||
    !Number.isFinite(normalized.scale) ||
    normalized.scale <= 0 ||
    normalized.scale > 1 ||
    !Number.isInteger(normalized.maxWidth) ||
    normalized.maxWidth < 1 ||
    normalized.maxWidth > SEMANTIC_PNG_LIMITS.maxDimension ||
    !Number.isInteger(normalized.maxHeight) ||
    normalized.maxHeight < 1 ||
    normalized.maxHeight > SEMANTIC_PNG_LIMITS.maxDimension ||
    !Number.isInteger(normalized.maxSvgBytes) ||
    normalized.maxSvgBytes < 1 ||
    normalized.maxSvgBytes > SEMANTIC_PNG_LIMITS.maxSvgBytes;
  if (invalid) {
    fail(
      "RENDER_OPTIONS_INVALID",
      "Semantic PNG render options exceed the supported safety limits.",
    );
  }
  return normalized;
}

function assertPoint(point: Point, objectId: string, label: string): void {
  finite(point.x, `${label}.x`, { objectId });
  finite(point.y, `${label}.y`, { objectId });
}

function assertObject(item: SemanticSceneObject, scene: SemanticScene): void {
  const { object, bounds } = item;
  if (
    !object.id ||
    !Object.prototype.hasOwnProperty.call(scene.objectsById, object.id) ||
    scene.objectsById[object.id]?.object.id !== object.id
  ) {
    fail("SCENE_OBJECT_INVALID", "The semantic scene object index is inconsistent.", {
      objectId: object.id,
    });
  }
  for (const [label, value] of Object.entries({
    x: object.x,
    y: object.y,
    width: object.width,
    height: object.height,
    rotation: object.rotation,
    zIndex: object.zIndex,
    boundsX: bounds.x,
    boundsY: bounds.y,
    boundsWidth: bounds.width,
    boundsHeight: bounds.height,
  })) {
    finite(value, label, { objectId: object.id });
  }
  if (object.width <= 0 || object.height <= 0 || bounds.width <= 0 || bounds.height <= 0) {
    fail("SCENE_OBJECT_INVALID", "Semantic PNG object dimensions must be positive.", {
      objectId: object.id,
    });
  }
  if (object.kind === "draw") {
    if (object.points.length < 2) {
      fail("SCENE_OBJECT_INVALID", "Semantic draw objects require at least two points.", {
        objectId: object.id,
      });
    }
    object.points.forEach((point, index) => assertPoint(point, object.id, `points.${index}`));
  }
  if (object.kind === "connector") {
    const hasRoute = Object.prototype.hasOwnProperty.call(scene.connectorRoutes, object.id);
    const route = hasRoute ? scene.connectorRoutes[object.id] : undefined;
    if (!route || route.connectorId !== object.id || route.points.length < 2) {
      fail(
        "CONNECTOR_ROUTE_UNAVAILABLE",
        "The exact semantic connector route is unavailable.",
        { objectId: object.id },
      );
    }
    if (route.routing.kind === "curved" && !route.arc) {
      fail(
        "CONNECTOR_ROUTE_UNAVAILABLE",
        "The exact semantic connector arc is unavailable.",
        { objectId: object.id },
      );
    }
    route.points.forEach((point, index) => assertPoint(point, object.id, `route.points.${index}`));
    assertPoint(route.start, object.id, "route.start");
    assertPoint(route.end, object.id, "route.end");
    assertPoint(route.labelPoint, object.id, "route.labelPoint");
    if (route.arc) {
      assertPoint(route.arc.center, object.id, "route.arc.center");
      finite(route.arc.radius, "route.arc.radius", { objectId: object.id });
      finite(route.arc.sweepAngle, "route.arc.sweepAngle", { objectId: object.id });
      if (route.arc.radius <= 0) {
        fail("SCENE_OBJECT_INVALID", "Semantic connector arc radius must be positive.", {
          objectId: object.id,
        });
      }
    }
    if (route.labelBounds) {
      finite(route.labelBounds.x, "route.labelBounds.x", { objectId: object.id });
      finite(route.labelBounds.y, "route.labelBounds.y", { objectId: object.id });
      finite(route.labelBounds.width, "route.labelBounds.width", { objectId: object.id });
      finite(route.labelBounds.height, "route.labelBounds.height", { objectId: object.id });
      if (route.labelBounds.width <= 0 || route.labelBounds.height <= 0) {
        fail("SCENE_OBJECT_INVALID", "Semantic connector label bounds must be positive.", {
          objectId: object.id,
        });
      }
    }
  }
}

function exactScope(scene: SemanticScene, objectIds: readonly string[]): SemanticSceneObject[] {
  if (!objectIds.length) {
    fail("SCOPE_EMPTY", "Semantic PNG rendering requires at least one semantic object ID.");
  }
  if (objectIds.length > SEMANTIC_PNG_LIMITS.maxTargets) {
    fail("SCOPE_TOO_LARGE", "Semantic PNG scope exceeds the object limit.", {
      targetCount: objectIds.length,
      maxTargets: SEMANTIC_PNG_LIMITS.maxTargets,
    });
  }
  const seen = new Set<string>();
  const selected = objectIds.map((objectId) => {
    if (seen.has(objectId)) {
      fail("SCOPE_DUPLICATE_OBJECT_ID", "Semantic PNG object IDs must be unique.", {
        objectId,
      });
    }
    seen.add(objectId);
    const hasObject = Object.prototype.hasOwnProperty.call(scene.objectsById, objectId);
    const item = hasObject ? scene.objectsById[objectId] : undefined;
    if (!item) {
      fail("SCOPE_OBJECT_NOT_FOUND", "A requested semantic object is not in the scene.", {
        objectId,
      });
    }
    assertObject(item, scene);
    return item;
  });
  return selected.sort(
    (left, right) =>
      left.object.zIndex - right.object.zIndex || left.object.id.localeCompare(right.object.id),
  );
}

function unionBounds(items: readonly SemanticSceneObject[], padding: number): CanvasBounds {
  const minX = Math.min(...items.map((item) => item.bounds.x)) - padding;
  const minY = Math.min(...items.map((item) => item.bounds.y)) - padding;
  const maxX = Math.max(...items.map((item) => item.bounds.x + item.bounds.width)) + padding;
  const maxY = Math.max(...items.map((item) => item.bounds.y + item.bounds.height)) + padding;
  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
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
      const graphemes = Array.from(sourceWord);
      const words = Array.from(
        { length: Math.ceil(graphemes.length / maxCharacters) },
        (_, index) => graphemes.slice(index * maxCharacters, (index + 1) * maxCharacters).join(""),
      );
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

function textLines(
  lines: readonly string[],
  x: number,
  firstY: number,
  lineHeight: number,
  anchor: "start" | "middle" | "end",
  fill: string,
  fontSize: number,
): string {
  if (!lines.length) return "";
  const spans = lines.map(
    (line, index) =>
      `<tspan x="${formatNumber(x)}" dy="${index ? formatNumber(lineHeight) : "0"}">${xml(line, 2_000)}</tspan>`,
  ).join("");
  return `<text x="${formatNumber(x)}" y="${formatNumber(firstY)}" fill="${fill}" font-family="Inter,ui-sans-serif,system-ui,sans-serif" font-size="${formatNumber(fontSize)}" text-anchor="${anchor}">${spans}</text>`;
}

function rotation(object: CanvasObject): string {
  if (!object.rotation) return "";
  return ` transform="rotate(${formatNumber(object.rotation * (180 / Math.PI))} ${formatNumber(object.x + object.width / 2)} ${formatNumber(object.y + object.height / 2)})"`;
}

function renderText(object: TextObject): string {
  const fontSize = { s: 16, m: 20, l: 28, xl: 36 }[object.size];
  const lines = wrapLines(
    object.content,
    Math.max(8, Math.floor(object.width / (fontSize * 0.58))),
  );
  const x = object.align === "start"
    ? object.x
    : object.align === "end"
      ? object.x + object.width
      : object.x + object.width / 2;
  return `<g${rotation(object)}>${textLines(
    lines,
    x,
    object.y + Math.min(fontSize, object.height / 2),
    fontSize * 1.25,
    object.align,
    color(object.color, "#1d1d1d"),
    fontSize,
  )}</g>`;
}

function hexLuminance(value: string): number | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (!match) return null;
  const full = match[1].length === 3
    ? match[1].split("").map((character) => `${character}${character}`).join("")
    : match[1];
  const channels = [0, 2, 4].map((offset) => Number.parseInt(full.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((channel) =>
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function shapeLabelColor(fill: string, stroke: string): string {
  if (fill === "none") return stroke;
  const luminance = hexLuminance(fill);
  return luminance === null || luminance > 0.45 ? "#182033" : "#ffffff";
}

function renderShape(object: ShapeObject): string {
  const fill = color(object.fill, "#e9e7ff", true);
  const stroke = color(object.stroke, "#4263eb");
  const attributes = `fill="${fill}" stroke="${stroke}" stroke-width="2"`;
  let geometry: string;
  if (object.shape === "ellipse") {
    geometry = `<ellipse cx="${formatNumber(object.x + object.width / 2)}" cy="${formatNumber(object.y + object.height / 2)}" rx="${formatNumber(object.width / 2)}" ry="${formatNumber(object.height / 2)}" ${attributes}/>`;
  } else if (object.shape === "diamond") {
    const points = [
      `${formatNumber(object.x + object.width / 2)},${formatNumber(object.y)}`,
      `${formatNumber(object.x + object.width)},${formatNumber(object.y + object.height / 2)}`,
      `${formatNumber(object.x + object.width / 2)},${formatNumber(object.y + object.height)}`,
      `${formatNumber(object.x)},${formatNumber(object.y + object.height / 2)}`,
    ].join(" ");
    geometry = `<polygon points="${points}" ${attributes}/>`;
  } else {
    const radius = Math.min(12, object.width / 8, object.height / 8);
    geometry = `<rect x="${formatNumber(object.x)}" y="${formatNumber(object.y)}" width="${formatNumber(object.width)}" height="${formatNumber(object.height)}" rx="${formatNumber(radius)}" ${attributes}/>`;
  }
  const lines = wrapLines(object.label, Math.max(8, Math.floor(object.width / 9)), 5);
  const firstY = object.y + object.height / 2 - ((lines.length - 1) * 18) / 2 + 5;
  const label = textLines(
    lines,
    object.x + object.width / 2,
    firstY,
    18,
    "middle",
    shapeLabelColor(fill, stroke),
    15,
  );
  return `<g${rotation(object)}>${geometry}${label}</g>`;
}

function connectorPath(object: ConnectorObject, scene: SemanticScene): string {
  const route = scene.connectorRoutes[object.id];
  if (route.routing.kind === "curved" && route.arc) {
    const largeArc = Math.abs(route.arc.sweepAngle) > Math.PI ? 1 : 0;
    const sweep = route.arc.sweepAngle >= 0 ? 1 : 0;
    return `M ${formatNumber(route.start.x)} ${formatNumber(route.start.y)} A ${formatNumber(route.arc.radius)} ${formatNumber(route.arc.radius)} 0 ${largeArc} ${sweep} ${formatNumber(route.end.x)} ${formatNumber(route.end.y)}`;
  }
  return route.points.map(
    (point, index) => `${index ? "L" : "M"} ${formatNumber(point.x)} ${formatNumber(point.y)}`,
  ).join(" ");
}

function arrowHead(tip: Point, neighbor: Point, size = 10): string {
  const angle = Math.atan2(tip.y - neighbor.y, tip.x - neighbor.x);
  const wing = size * 0.58;
  const baseX = tip.x - Math.cos(angle) * size;
  const baseY = tip.y - Math.sin(angle) * size;
  const perpendicularX = -Math.sin(angle) * wing;
  const perpendicularY = Math.cos(angle) * wing;
  return [
    `${formatNumber(tip.x)},${formatNumber(tip.y)}`,
    `${formatNumber(baseX + perpendicularX)},${formatNumber(baseY + perpendicularY)}`,
    `${formatNumber(baseX - perpendicularX)},${formatNumber(baseY - perpendicularY)}`,
  ].join(" ");
}

function renderConnector(object: ConnectorObject, scene: SemanticScene): string {
  const route = scene.connectorRoutes[object.id];
  const points = route.points;
  const stroke = color(object.color, "#1d1d1d");
  const startNeighbor = points[1];
  const endNeighbor = points.at(-2)!;
  const parts = [
    `<path d="${connectorPath(object, scene)}" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  ];
  if (object.direction === "both") {
    parts.push(`<polygon points="${arrowHead(points[0], startNeighbor)}" fill="${stroke}"/>`);
  }
  if (object.direction !== "none") {
    parts.push(`<polygon points="${arrowHead(points.at(-1)!, endNeighbor)}" fill="${stroke}"/>`);
  }
  const metrics = connectorLabelMetrics(object.label);
  if (metrics.normalizedLines.length) {
    const labelBounds = route.labelBounds ?? {
      x: route.labelPoint.x - metrics.width / 2,
      y: route.labelPoint.y - metrics.height / 2,
      width: metrics.width,
      height: metrics.height,
    };
    const maxGraphemes = Math.max(
      1,
      Math.floor((labelBounds.width - CONNECTOR_LABEL_TOTAL_INSET) / CONNECTOR_LABEL_GRAPHEME_WIDTH),
    );
    const lines = wrapLines(object.label, maxGraphemes, 20);
    const firstY = route.labelPoint.y - ((lines.length - 1) * CONNECTOR_LABEL_LINE_HEIGHT) / 2 +
      CONNECTOR_LABEL_FONT_SIZE * 0.35;
    parts.push(
      `<g><rect x="${formatNumber(labelBounds.x)}" y="${formatNumber(labelBounds.y)}" width="${formatNumber(labelBounds.width)}" height="${formatNumber(labelBounds.height)}" rx="6" fill="#ffffff" stroke="#d7dce3" stroke-width="1"/>${textLines(lines, route.labelPoint.x, firstY, CONNECTOR_LABEL_LINE_HEIGHT, "middle", stroke, CONNECTOR_LABEL_FONT_SIZE)}</g>`,
    );
  }
  return parts.join("");
}

function renderDraw(object: DrawObject): string {
  const points = object.points.map(
    (point) => `${formatNumber(point.x)},${formatNumber(point.y)}`,
  ).join(" ");
  const transform = `translate(${formatNumber(object.x)} ${formatNumber(object.y)})${
    object.rotation ? ` rotate(${formatNumber(object.rotation * (180 / Math.PI))})` : ""
  }`;
  return `<polyline points="${points}" transform="${transform}" fill="none" stroke="${color(object.color, "#e03131")}" stroke-width="${{ s: 2, m: 4, l: 7 }[object.size]}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

function base64Prefix(payload: string, maximumBytes = 16): Uint8Array | null {
  if (
    payload.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload)
  ) {
    return null;
  }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const output: number[] = [];
  for (let offset = 0; offset < payload.length && output.length < maximumBytes; offset += 4) {
    const values = [0, 1, 2, 3].map((index) => {
      const character = payload[offset + index];
      return character === "=" ? 0 : alphabet.indexOf(character);
    });
    if (values.some((value) => value < 0)) return null;
    const combined = (values[0] << 18) | (values[1] << 12) | (values[2] << 6) | values[3];
    output.push((combined >> 16) & 255);
    if (payload[offset + 2] !== "=" && output.length < maximumBytes) output.push((combined >> 8) & 255);
    if (payload[offset + 3] !== "=" && output.length < maximumBytes) output.push(combined & 255);
  }
  return new Uint8Array(output);
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return Array.from(bytes.slice(start, start + length), (value) => String.fromCharCode(value)).join("");
}

function hasRasterSignature(mimeType: string, bytes: Uint8Array): boolean {
  if (mimeType === "image/png") {
    return [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
  }
  if (mimeType === "image/jpeg") return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mimeType === "image/gif") return ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a";
  if (mimeType === "image/webp") return ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP";
  return false;
}

function embeddedImage(
  object: ImageObject,
  image: SemanticSvgImage | undefined,
): { href: string | null; warning: SemanticPngWarning | null } {
  if (!image) {
    return { href: null, warning: imageWarning("IMAGE_NOT_PROVIDED", object.id) };
  }
  if (image.kind === "unavailable") {
    return { href: null, warning: imageWarning(image.code, object.id) };
  }
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/i.exec(image.dataUrl);
  if (!match) {
    return { href: null, warning: imageWarning("IMAGE_EMBED_REJECTED", object.id) };
  }
  const mimeType = match[1].toLowerCase() === "image/jpg" ? "image/jpeg" : match[1].toLowerCase();
  const payload = match[2];
  const prefix = base64Prefix(payload);
  if (!IMAGE_MIME_TYPES.has(mimeType) || !prefix || !hasRasterSignature(mimeType, prefix)) {
    return { href: null, warning: imageWarning("IMAGE_EMBED_REJECTED", object.id) };
  }
  const byteLength = Math.floor(payload.length * 0.75) - (payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0);
  if (byteLength > SEMANTIC_PNG_LIMITS.maxSourceImageBytes) {
    return { href: null, warning: imageWarning("IMAGE_SOURCE_TOO_LARGE", object.id) };
  }
  return { href: `data:${mimeType};base64,${payload}`, warning: null };
}

function imageWarning(code: SemanticImageWarningCode, objectId: string): SemanticPngWarning {
  const messages: Record<SemanticImageWarningCode, string> = {
    IMAGE_NOT_PROVIDED: "Authorized image pixels were not provided; a placeholder was rendered.",
    IMAGE_URL_INVALID: "The image URL was invalid; a placeholder was rendered.",
    IMAGE_ROOM_MISMATCH: "The image referenced a different room; a placeholder was rendered.",
    IMAGE_FETCH_FAILED: "The authorized image could not be fetched; a placeholder was rendered.",
    IMAGE_RESPONSE_INVALID: "The authorized image response was unsuccessful; a placeholder was rendered.",
    IMAGE_TYPE_UNSUPPORTED: "The authorized image type is unsupported; a placeholder was rendered.",
    IMAGE_CONTENT_INVALID: "The authorized image bytes did not match their raster type; a placeholder was rendered.",
    IMAGE_SOURCE_TOO_LARGE: "The authorized image exceeded its byte limit; a placeholder was rendered.",
    IMAGE_TOTAL_BUDGET_EXCEEDED: "Embedding this image would exceed the render byte budget; a placeholder was rendered.",
    IMAGE_EMBED_REJECTED: "The embedded image was not a safe raster data URL; a placeholder was rendered.",
  };
  return { code, objectId, message: messages[code] };
}

function imagePlaceholder(object: ImageObject): string {
  const x = formatNumber(object.x);
  const y = formatNumber(object.y);
  const width = formatNumber(object.width);
  const height = formatNumber(object.height);
  const lines = wrapLines(
    object.alt.trim() || "Image unavailable",
    Math.max(10, Math.floor(object.width / 9)),
    3,
  );
  const firstY = object.y + object.height / 2 - ((lines.length - 1) * 17) / 2 + 5;
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="8" fill="#f2f4f8" stroke="#8b919a" stroke-width="2" stroke-dasharray="8 6"/><line x1="${x}" y1="${y}" x2="${formatNumber(object.x + object.width)}" y2="${formatNumber(object.y + object.height)}" stroke="#c2c7d0"/><line x1="${formatNumber(object.x + object.width)}" y1="${y}" x2="${x}" y2="${formatNumber(object.y + object.height)}" stroke="#c2c7d0"/>${textLines(lines, object.x + object.width / 2, firstY, 17, "middle", "#596376", 14)}`;
}

function renderImage(
  object: ImageObject,
  image: SemanticSvgImage | undefined,
  warnings: SemanticPngWarning[],
): string {
  const resolved = embeddedImage(object, image);
  if (resolved.warning) warnings.push(resolved.warning);
  const content = resolved.href
    ? `<rect x="${formatNumber(object.x)}" y="${formatNumber(object.y)}" width="${formatNumber(object.width)}" height="${formatNumber(object.height)}" rx="8" fill="#f2f4f8"/><image href="${resolved.href}" x="${formatNumber(object.x)}" y="${formatNumber(object.y)}" width="${formatNumber(object.width)}" height="${formatNumber(object.height)}" preserveAspectRatio="xMidYMid meet"/><rect x="${formatNumber(object.x)}" y="${formatNumber(object.y)}" width="${formatNumber(object.width)}" height="${formatNumber(object.height)}" rx="8" fill="none" stroke="#8b919a" stroke-width="1"/>`
    : imagePlaceholder(object);
  return `<g${rotation(object)}>${content}</g>`;
}

function renderObject(
  object: CanvasObject,
  scene: SemanticScene,
  image: SemanticSvgImage | undefined,
  warnings: SemanticPngWarning[],
): string {
  let content: string;
  if (object.kind === "text") content = renderText(object);
  else if (object.kind === "shape") content = renderShape(object);
  else if (object.kind === "connector") content = renderConnector(object, scene);
  else if (object.kind === "image") content = renderImage(object, image, warnings);
  else content = renderDraw(object);
  return `<g data-semantic-object-id="${xml(object.id, 128)}">${content}</g>`;
}

/**
 * Pure semantic SVG generation. The exact ID scope is validated before any
 * rendering, and image hrefs can only be signature-checked raster data URLs.
 * The output contains no script, style, foreignObject, use, or external href.
 */
export function renderSemanticSceneSvg(
  scene: SemanticScene,
  objectIds: readonly string[],
  options: SemanticSvgRenderOptions = {},
): SemanticSvgRenderResult {
  const normalized = normalizeOptions(options);
  const selected = exactScope(scene, objectIds);
  const selectedImageIds = new Set(
    selected.filter((item) => item.object.kind === "image").map((item) => item.object.id),
  );
  for (const imageId of Object.keys(normalized.images)) {
    if (!selectedImageIds.has(imageId)) {
      fail(
        "SCENE_OBJECT_INVALID",
        "Embedded image data must belong to an image in the exact render scope.",
        { objectId: imageId },
      );
    }
  }

  const bounds = unionBounds(selected, normalized.padding);
  const logicalWidth = Math.max(1, Math.ceil(bounds.width * normalized.scale));
  const logicalHeight = Math.max(1, Math.ceil(bounds.height * normalized.scale));
  const pixelWidth = Math.max(1, Math.ceil(logicalWidth * normalized.pixelRatio));
  const pixelHeight = Math.max(1, Math.ceil(logicalHeight * normalized.pixelRatio));
  if (
    pixelWidth > normalized.maxWidth ||
    pixelHeight > normalized.maxHeight ||
    pixelWidth * pixelHeight > SEMANTIC_PNG_LIMITS.maxPixels
  ) {
    fail(
      "DIMENSION_BUDGET_EXCEEDED",
      "Semantic PNG dimensions exceed the bounded browser raster budget.",
      {
        width: pixelWidth,
        height: pixelHeight,
        maxWidth: normalized.maxWidth,
        maxHeight: normalized.maxHeight,
      },
    );
  }

  const warnings: SemanticPngWarning[] = [];
  const encoder = new TextEncoder();
  const renderedObjects: string[] = [];
  let renderedObjectBytes = 0;
  for (const { object } of selected) {
    const hasImage = Object.prototype.hasOwnProperty.call(normalized.images, object.id);
    const renderedObject = renderObject(
      object,
      scene,
      hasImage ? normalized.images[object.id] : undefined,
      warnings,
    );
    renderedObjectBytes += encoder.encode(renderedObject).byteLength;
    if (renderedObjectBytes > normalized.maxSvgBytes) {
      fail(
        "SVG_BYTE_BUDGET_EXCEEDED",
        "Semantic SVG exceeded its in-memory byte budget.",
        { byteLength: renderedObjectBytes, maxBytes: normalized.maxSvgBytes },
      );
    }
    renderedObjects.push(renderedObject);
  }
  const objects = renderedObjects.join("");
  const background = normalized.background
    ? `<rect x="${formatNumber(bounds.x)}" y="${formatNumber(bounds.y)}" width="${formatNumber(bounds.width)}" height="${formatNumber(bounds.height)}" fill="${normalized.darkMode ? "#181a20" : "#ffffff"}"/>`
    : "";
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pixelWidth}" height="${pixelHeight}" viewBox="${formatNumber(bounds.x)} ${formatNumber(bounds.y)} ${formatNumber(bounds.width)} ${formatNumber(bounds.height)}" role="img" aria-labelledby="semantic-png-title semantic-png-description">`,
    '<title id="semantic-png-title">Jazzboard semantic canvas</title>',
    '<desc id="semantic-png-description">Exact authorized semantic canvas scope rendered locally.</desc>',
    background,
    objects,
    "</svg>",
  ].join("");
  const svgBytes = encoder.encode(svg).byteLength;
  if (svgBytes > normalized.maxSvgBytes) {
    fail(
      "SVG_BYTE_BUDGET_EXCEEDED",
      "Semantic SVG exceeded its in-memory byte budget.",
      { byteLength: svgBytes, maxBytes: normalized.maxSvgBytes },
    );
  }
  return {
    svg,
    objectIds: selected.map((item) => item.object.id),
    bounds,
    logicalWidth,
    logicalHeight,
    pixelWidth,
    pixelHeight,
    warnings,
  };
}
