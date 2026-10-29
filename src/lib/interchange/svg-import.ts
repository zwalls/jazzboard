import { createCanvasObjectSchema } from "@/lib/domain/schemas";
import type { CreateCanvasObject, Point, VectorPathSegment } from "@/lib/domain/types";
import { normalizeWorldVectorPath, VECTOR_PATH_LIMITS } from "@/lib/domain/vector-path";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const DEFAULT_MAX_SOURCE_LENGTH = 1_000_000;
const DEFAULT_MAX_ELEMENTS = 500;
const ELLIPSE_KAPPA = 0.5522847498307936;
const SVG_NUMBER_PATTERN = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;
const CSS_NUMBER_PATTERN = /^[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?$/;

const SUPPORTED_ELEMENTS = new Set(["path", "rect", "ellipse", "circle", "polygon"]);
const COMMON_ATTRIBUTES = new Set([
  "id", "data-name", "aria-label", "fill", "stroke", "stroke-width", "opacity",
  "stroke-linecap", "stroke-linejoin", "fill-rule",
]);
const ELEMENT_ATTRIBUTES: Readonly<Record<string, ReadonlySet<string>>> = {
  path: new Set(["d"]),
  rect: new Set(["x", "y", "width", "height", "rx", "ry"]),
  ellipse: new Set(["cx", "cy", "rx", "ry"]),
  circle: new Set(["cx", "cy", "r"]),
  polygon: new Set(["points"]),
};
const ROOT_ATTRIBUTES = new Set(["xmlns", "width", "height", "viewBox", "preserveAspectRatio"]);

const CSS_NAMED_COLORS: Readonly<Record<string, string>> = Object.freeze({
  aqua: "#00ffff",
  black: "#000000",
  blue: "#0000ff",
  fuchsia: "#ff00ff",
  gray: "#808080",
  green: "#008000",
  lime: "#00ff00",
  maroon: "#800000",
  navy: "#000080",
  olive: "#808000",
  orange: "#ffa500",
  purple: "#800080",
  red: "#ff0000",
  silver: "#c0c0c0",
  teal: "#008080",
  white: "#ffffff",
  yellow: "#ffff00",
});

export interface SvgDomParser {
  parseFromString(source: string, mimeType: "image/svg+xml"): Document;
}

export type SvgNativeImportOptions = Readonly<{
  parser?: SvgDomParser;
  idForPart?: (sourceName: string, index: number) => string;
  origin?: Point;
  zIndexStart?: number;
  maxElements?: number;
  maxSourceLength?: number;
}>;

export class SvgNativeImportError extends Error {
  readonly code: string;
  readonly elementName?: string;

  constructor(code: string, message: string, elementName?: string) {
    super(message);
    this.name = "SvgNativeImportError";
    this.code = code;
    this.elementName = elementName;
  }
}

type WorldPath = Readonly<{
  start: Point;
  segments: VectorPathSegment[];
  closed: boolean;
}>;

type PathStyle = Readonly<{
  fill: string;
  stroke: string;
  strokeWidth: number;
  opacity: number;
  lineCap: "butt" | "round" | "square";
  lineJoin: "miter" | "round" | "bevel";
  fillRule: "nonzero" | "evenodd";
}>;

type PathToken = Readonly<{ kind: "command" | "number"; value: string; offset: number }>;

function fail(code: string, message: string, elementName?: string): never {
  throw new SvgNativeImportError(code, message, elementName);
}

function finiteNumber(value: string | null, label: string, elementName: string, fallback?: number): number {
  if (value === null) {
    if (fallback !== undefined) return fallback;
    return fail("invalid-geometry", `${elementName} requires a finite ${label} attribute.`, elementName);
  }
  const parsed = Number(value);
  if (!SVG_NUMBER_PATTERN.test(value.trim()) || !Number.isFinite(parsed)) {
    return fail("invalid-geometry", `${elementName} has an invalid ${label} value: ${value}.`, elementName);
  }
  return parsed;
}

function positiveNumber(value: string | null, label: string, elementName: string): number {
  const parsed = finiteNumber(value, label, elementName);
  if (parsed <= 0) fail("invalid-geometry", `${elementName} ${label} must be greater than zero.`, elementName);
  return parsed;
}

function byte(value: number): string {
  return Math.round(value).toString(16).padStart(2, "0");
}

function parseColorComponent(value: string, maximum: number): number | null {
  const trimmed = value.trim();
  const percentage = trimmed.endsWith("%");
  const numberSource = percentage ? trimmed.slice(0, -1) : trimmed;
  if (!CSS_NUMBER_PATTERN.test(numberSource)) return null;
  const numeric = Number(numberSource);
  if (!Number.isFinite(numeric)) return null;
  // Multiplying by 2.55 rounds 50% below 127.5 and loses one channel value.
  const scaled = percentage ? numeric * maximum / 100 : numeric;
  return scaled >= 0 && scaled <= maximum ? scaled : null;
}

function normalizePaint(value: string | null, fallback: string, elementName: string, attribute: string): string {
  const paint = (value ?? fallback).trim().toLowerCase();
  if (paint === "none") return "none";
  if (/^#[0-9a-f]{3}$/i.test(paint) || /^#[0-9a-f]{6}$/i.test(paint) || /^#[0-9a-f]{8}$/i.test(paint)) {
    return paint;
  }
  if (/^#[0-9a-f]{4}$/i.test(paint)) {
    return `#${[...paint.slice(1)].map((digit) => digit + digit).join("")}`;
  }
  // CSS names must remain literal colors, not Jazzboard's semantic palette tokens.
  if (Object.hasOwn(CSS_NAMED_COLORS, paint)) return CSS_NAMED_COLORS[paint]!;
  const rgb = paint.match(/^rgba?\((.*)\)$/);
  if (rgb) {
    const components = rgb[1]!.split(",");
    if (components.length === 3 || components.length === 4) {
      const colorSources = components.slice(0, 3);
      const percentages = colorSources.map((component) => component.trim().endsWith("%"));
      const colors = colorSources.map((component) => parseColorComponent(component, 255));
      const alpha = components.length === 4 ? parseColorComponent(components[3]!, 1) : 1;
      if (
        percentages.every((percentage) => percentage === percentages[0])
        && colors.every((component) => component !== null) && alpha !== null
      ) {
        const hex = `#${colors.map((component) => byte(component!)).join("")}`;
        return alpha === 1 ? hex : `${hex}${byte(alpha * 255)}`;
      }
    }
  }
  return fail(
    "unsupported-paint",
    `${elementName} ${attribute} must be none, a supported CSS color name, hex, rgb(), or rgba().`,
    elementName,
  );
}

function enumAttribute<T extends string>(
  element: Element,
  attribute: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = element.getAttribute(attribute)?.trim().toLowerCase();
  if (!value) return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  return fail(
    "unsupported-style",
    `${element.localName} ${attribute} must be one of ${allowed.join(", ")}.`,
    element.localName,
  );
}

function styleFor(element: Element): PathStyle {
  const elementName = element.localName;
  let stroke = normalizePaint(element.getAttribute("stroke"), "none", elementName, "stroke");
  const fill = normalizePaint(element.getAttribute("fill"), "black", elementName, "fill");
  const strokeWidth = finiteNumber(element.getAttribute("stroke-width"), "stroke-width", elementName, 1);
  if (strokeWidth < 0 || strokeWidth > VECTOR_PATH_LIMITS.maxStrokeWidth) {
    fail(
      "invalid-style",
      `${elementName} stroke-width must be between 0 and ${VECTOR_PATH_LIMITS.maxStrokeWidth}.`,
      elementName,
    );
  }
  if (strokeWidth === 0) stroke = "none";
  const opacity = finiteNumber(element.getAttribute("opacity"), "opacity", elementName, 1);
  if (opacity < 0 || opacity > 1) {
    fail("invalid-style", `${elementName} opacity must be between 0 and 1.`, elementName);
  }
  if (fill === "none" && stroke === "none") {
    fail("invisible-element", `${elementName} must have a visible fill or stroke.`, elementName);
  }
  return {
    fill,
    stroke,
    strokeWidth,
    opacity,
    lineCap: enumAttribute(element, "stroke-linecap", ["butt", "round", "square"], "butt"),
    lineJoin: enumAttribute(element, "stroke-linejoin", ["miter", "round", "bevel"], "miter"),
    fillRule: enumAttribute(element, "fill-rule", ["nonzero", "evenodd"], "nonzero"),
  };
}

function tokenizePath(data: string): PathToken[] {
  if (/(^|[A-Za-z])\s*,|,\s*,|,\s*($|[A-Za-z])/.test(data)) {
    fail("invalid-path", "Path data contains a misplaced comma.", "path");
  }
  const tokens: PathToken[] = [];
  const expression = /[A-Za-z]|[-+]?(?:(?:\d+\.\d*)|(?:\.\d+)|(?:\d+))(?:[eE][-+]?\d+)?/g;
  let cursor = 0;
  for (const match of data.matchAll(expression)) {
    const offset = match.index;
    const gap = data.slice(cursor, offset);
    if (!/^[\s,]*$/.test(gap)) {
      fail("invalid-path", `Path data contains invalid syntax near offset ${cursor}.`, "path");
    }
    const value = match[0];
    if (/^[A-Za-z]$/.test(value)) {
      if (!/^[MLHVQCZmlhvqcz]$/.test(value)) {
        fail("unsupported-command", `Unsupported SVG path command ${value} at offset ${offset}.`, "path");
      }
      tokens.push({ kind: "command", value, offset });
    } else {
      tokens.push({ kind: "number", value, offset });
    }
    cursor = offset + value.length;
  }
  if (!/^[\s,]*$/.test(data.slice(cursor))) {
    fail("invalid-path", `Path data contains invalid syntax near offset ${cursor}.`, "path");
  }
  return tokens;
}

function parsePath(data: string): WorldPath {
  const tokens = tokenizePath(data);
  if (tokens.length === 0) fail("invalid-path", "path requires non-empty d data.", "path");
  let index = 0;
  let command: string | null = null;
  let current: Point = { x: 0, y: 0 };
  let start: Point | null = null;
  let closed = false;
  const segments: VectorPathSegment[] = [];

  const nextNumber = (): number => {
    const token = tokens[index];
    if (!token || token.kind !== "number") {
      fail("invalid-path", `SVG path command ${command ?? "?"} is missing numeric parameters.`, "path");
    }
    index += 1;
    const parsed = Number(token.value);
    if (!Number.isFinite(parsed)) fail("invalid-path", `Path number at offset ${token.offset} is not finite.`, "path");
    return parsed;
  };
  const point = (relative: boolean): Point => {
    const x = nextNumber();
    const y = nextNumber();
    return relative ? { x: current.x + x, y: current.y + y } : { x, y };
  };

  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token.kind === "command") {
      command = token.value;
      index += 1;
    } else if (!command) {
      fail("invalid-path", `Path data must start with M or m, near offset ${token.offset}.`, "path");
    }
    if (!command) fail("invalid-path", "Path data requires a command.", "path");
    const upper = command.toUpperCase();
    const relative: boolean = command !== upper;
    if (closed) fail("unsupported-subpath", "Commands after Z would create another subpath, which is unsupported.", "path");
    if (upper === "Z") {
      if (!start) fail("invalid-path", "Z cannot appear before M.", "path");
      closed = true;
      current = start;
      command = null;
      continue;
    }
    if (tokens[index]?.kind === "command" || index >= tokens.length) {
      fail("invalid-path", `SVG path command ${command} is missing numeric parameters.`, "path");
    }
    if (upper === "M") {
      if (start) fail("unsupported-subpath", "Multiple M commands create subpaths, which are unsupported.", "path");
      current = point(relative);
      start = current;
      command = relative ? "l" : "L";
      continue;
    }
    if (!start) fail("invalid-path", "Path data must begin with M or m.", "path");
    if (upper === "L") {
      current = point(relative);
      segments.push({ kind: "line", to: current });
    } else if (upper === "H") {
      const x = nextNumber();
      current = { x: relative ? current.x + x : x, y: current.y };
      segments.push({ kind: "line", to: current });
    } else if (upper === "V") {
      const y = nextNumber();
      current = { x: current.x, y: relative ? current.y + y : y };
      segments.push({ kind: "line", to: current });
    } else if (upper === "Q") {
      const control = point(relative);
      const to = point(relative);
      current = to;
      segments.push({ kind: "quadratic", control, to });
    } else if (upper === "C") {
      const control1 = point(relative);
      const control2 = point(relative);
      const to = point(relative);
      current = to;
      segments.push({ kind: "cubic", control1, control2, to });
    } else {
      fail("unsupported-command", `Unsupported SVG path command ${command}.`, "path");
    }
    if (segments.length > VECTOR_PATH_LIMITS.maxSegments) {
      fail("limit-exceeded", `A path may contain at most ${VECTOR_PATH_LIMITS.maxSegments} segments.`, "path");
    }
  }
  if (!start || segments.length === 0) {
    fail("invalid-path", "A path requires M followed by at least one drawing segment.", "path");
  }
  return { start, segments, closed };
}

function rectPath(element: Element): WorldPath {
  const x = finiteNumber(element.getAttribute("x"), "x", "rect", 0);
  const y = finiteNumber(element.getAttribute("y"), "y", "rect", 0);
  const width = positiveNumber(element.getAttribute("width"), "width", "rect");
  const height = positiveNumber(element.getAttribute("height"), "height", "rect");
  const rx = finiteNumber(element.getAttribute("rx"), "rx", "rect", 0);
  const ry = finiteNumber(element.getAttribute("ry"), "ry", "rect", 0);
  if (rx !== 0 || ry !== 0) {
    fail("unsupported-geometry", "Rounded rect rx/ry is not supported; convert it to a path first.", "rect");
  }
  return {
    start: { x, y },
    segments: [
      { kind: "line", to: { x: x + width, y } },
      { kind: "line", to: { x: x + width, y: y + height } },
      { kind: "line", to: { x, y: y + height } },
    ],
    closed: true,
  };
}

function ellipsePath(cx: number, cy: number, rx: number, ry: number): WorldPath {
  const dx = rx * ELLIPSE_KAPPA;
  const dy = ry * ELLIPSE_KAPPA;
  return {
    start: { x: cx + rx, y: cy },
    segments: [
      { kind: "cubic", control1: { x: cx + rx, y: cy + dy }, control2: { x: cx + dx, y: cy + ry }, to: { x: cx, y: cy + ry } },
      { kind: "cubic", control1: { x: cx - dx, y: cy + ry }, control2: { x: cx - rx, y: cy + dy }, to: { x: cx - rx, y: cy } },
      { kind: "cubic", control1: { x: cx - rx, y: cy - dy }, control2: { x: cx - dx, y: cy - ry }, to: { x: cx, y: cy - ry } },
      { kind: "cubic", control1: { x: cx + dx, y: cy - ry }, control2: { x: cx + rx, y: cy - dy }, to: { x: cx + rx, y: cy } },
    ],
    closed: true,
  };
}

function geometryFor(element: Element): WorldPath {
  if (element.localName === "path") return parsePath(element.getAttribute("d") ?? "");
  if (element.localName === "rect") return rectPath(element);
  if (element.localName === "ellipse") {
    return ellipsePath(
      finiteNumber(element.getAttribute("cx"), "cx", "ellipse", 0),
      finiteNumber(element.getAttribute("cy"), "cy", "ellipse", 0),
      positiveNumber(element.getAttribute("rx"), "rx", "ellipse"),
      positiveNumber(element.getAttribute("ry"), "ry", "ellipse"),
    );
  }
  if (element.localName === "circle") {
    const radius = positiveNumber(element.getAttribute("r"), "r", "circle");
    return ellipsePath(
      finiteNumber(element.getAttribute("cx"), "cx", "circle", 0),
      finiteNumber(element.getAttribute("cy"), "cy", "circle", 0),
      radius,
      radius,
    );
  }
  const raw = element.getAttribute("points") ?? "";
  const tokens = tokenizePath(raw);
  if (tokens.some((token) => token.kind !== "number") || tokens.length < 6 || tokens.length % 2 !== 0) {
    fail("invalid-geometry", "polygon points must contain at least three finite x,y pairs.", "polygon");
  }
  if (tokens.length / 2 - 1 > VECTOR_PATH_LIMITS.maxSegments) {
    fail("limit-exceeded", `A polygon may contain at most ${VECTOR_PATH_LIMITS.maxSegments + 1} points.`, "polygon");
  }
  const points: Point[] = [];
  for (let index = 0; index < tokens.length; index += 2) {
    const x = Number(tokens[index]!.value);
    const y = Number(tokens[index + 1]!.value);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      fail("invalid-geometry", "polygon points must contain finite x,y pairs.", "polygon");
    }
    points.push({ x, y });
  }
  return {
    start: points[0]!,
    segments: points.slice(1).map((to) => ({ kind: "line", to })),
    closed: true,
  };
}

function validateAttributes(element: Element, root = false): void {
  const allowed = root ? ROOT_ATTRIBUTES : new Set([...COMMON_ATTRIBUTES, ...ELEMENT_ATTRIBUTES[element.localName]!]);
  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name;
    if (/^on/i.test(name)) {
      fail("unsafe-markup", `Event attribute ${name} is not allowed.`, element.localName);
    }
    if (!allowed.has(name)) {
      fail(
        name === "transform" || name === "style" || name === "class" || name === "filter" || name === "mask" || name === "clip-path"
          ? "unsupported-style"
          : "unsupported-attribute",
        `${element.localName} attribute ${name} is unsupported; flatten it into explicit geometry and presentation attributes.`,
        element.localName,
      );
    }
  }
}

function validateIdentityViewport(root: Element): void {
  const widthSource = root.getAttribute("width");
  const heightSource = root.getAttribute("height");
  const viewBoxSource = root.getAttribute("viewBox");
  const plainNumber = /^(?:(?:\d+\.?\d*)|(?:\.\d+))$/;
  const expected = "width and height as positive unitless numbers with viewBox=\"0 0 width height\"";
  const received = `width=${JSON.stringify(widthSource)}, height=${JSON.stringify(heightSource)}, viewBox=${JSON.stringify(viewBoxSource)}`;
  if (
    !widthSource || !heightSource
    || !plainNumber.test(widthSource.trim()) || !plainNumber.test(heightSource.trim())
  ) {
    fail("unsupported-viewport", `SVG requires identity document dimensions: ${expected}. Received ${received}.`, "svg");
  }
  const width = Number(widthSource);
  const height = Number(heightSource);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    fail("unsupported-viewport", `SVG requires identity document dimensions: ${expected}. Received ${received}.`, "svg");
  }
  const viewBoxTokens = viewBoxSource?.trim().split(/[\s,]+/);
  const viewBox = viewBoxTokens?.every((value) => SVG_NUMBER_PATTERN.test(value))
    ? viewBoxTokens.map(Number)
    : null;
  if (
    !viewBox || viewBox.length !== 4 || viewBox.some((value) => !Number.isFinite(value))
    || /,\s*,/.test(viewBoxSource ?? "")
    || viewBox[0] !== 0 || viewBox[1] !== 0 || viewBox[2] !== width || viewBox[3] !== height
  ) {
    fail("unsupported-viewport", `SVG requires identity document dimensions: ${expected}. Received ${received}.`, "svg");
  }
  const preserveAspectRatio = root.getAttribute("preserveAspectRatio")?.trim().replace(/\s+/g, " ");
  if (preserveAspectRatio && preserveAspectRatio !== "xMidYMid meet") {
    fail(
      "unsupported-viewport",
      `SVG preserveAspectRatio=${JSON.stringify(preserveAspectRatio)} is unsupported. Use the default \"xMidYMid meet\" with identity document dimensions. Received ${received}.`,
      "svg",
    );
  }
}

function sourceName(element: Element, index: number): string {
  const raw = element.getAttribute("data-name") ?? element.getAttribute("aria-label") ?? element.getAttribute("id");
  const normalized = raw?.normalize("NFKC").replace(/\s+/g, " ").trim();
  const name = normalized || `${element.localName[0]!.toUpperCase()}${element.localName.slice(1)} ${index + 1}`;
  if (name.length > 160) fail("invalid-name", `${element.localName} source name exceeds 160 characters.`, element.localName);
  return name;
}

function uniqueNames(elements: readonly Element[]): string[] {
  const counts = new Map<string, number>();
  const used = new Set<string>();
  return elements.map((element, index) => {
    const base = sourceName(element, index);
    let count = counts.get(base) ?? 0;
    let candidate = base;
    while (used.has(candidate)) {
      count += 1;
      const suffix = ` (${count + 1})`;
      candidate = `${base.slice(0, 160 - suffix.length)}${suffix}`;
    }
    counts.set(base, count);
    used.add(candidate);
    return candidate;
  });
}

function defaultId(name: string, index: number): string {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 96) || "part";
  return `svg-${slug}-${index + 1}`;
}

/** Bound XML parser work before building nodes; XML validation still runs afterward. */
function validateElementBudget(source: string, maxElements: number): void {
  let cursor = 0;
  let openingElements = 0;
  while (cursor < source.length) {
    const offset = source.indexOf("<", cursor);
    if (offset < 0) return;
    const ignored = source.startsWith("<!--", offset)
      ? { prefixLength: 4, terminator: "-->" }
      : source.startsWith("<![CDATA[", offset)
        ? { prefixLength: 9, terminator: "]]>" }
        : source.startsWith("<?", offset)
          ? { prefixLength: 2, terminator: "?>" }
          : null;
    if (ignored) {
      const end = source.indexOf(ignored.terminator, offset + ignored.prefixLength);
      // An unterminated comment, CDATA section, or PI is an XML error, not markup.
      if (end < 0) return;
      cursor = end + ignored.terminator.length;
      continue;
    }
    if (source[offset + 1] !== "/" && source[offset + 1] !== "!") {
      openingElements += 1;
      // The root SVG is excluded from the public child-element budget.
      if (openingElements > maxElements + 1) {
        fail("limit-exceeded", `SVG contains more than ${maxElements} elements.`);
      }
    }
    cursor = offset + 1;
  }
}

function parserFor(options: SvgNativeImportOptions): SvgDomParser {
  if (options.parser) return options.parser;
  if (typeof DOMParser !== "undefined") return new DOMParser();
  return fail(
    "parser-unavailable",
    "DOMParser is unavailable. Pass a DOMParser-compatible parser in options.parser.",
  );
}

/**
 * Import a deliberately small SVG subset as individually editable native path objects.
 * The operation is atomic: any unsupported or invalid element rejects the entire SVG.
 */
export function importSvgToNativeObjects(
  source: string,
  options: SvgNativeImportOptions = {},
): CreateCanvasObject[] {
  const maxSourceLength = options.maxSourceLength ?? DEFAULT_MAX_SOURCE_LENGTH;
  const maxElements = options.maxElements ?? DEFAULT_MAX_ELEMENTS;
  if (!Number.isInteger(maxSourceLength) || maxSourceLength <= 0) {
    fail("invalid-options", "maxSourceLength must be a positive integer.");
  }
  if (!Number.isInteger(maxElements) || maxElements <= 0) {
    fail("invalid-options", "maxElements must be a positive integer.");
  }
  if (source.length > maxSourceLength) {
    fail("limit-exceeded", `SVG source exceeds the ${maxSourceLength} character limit.`);
  }
  if (/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(source)) {
    fail("unsafe-markup", "DOCTYPE, ENTITY, and XML stylesheet declarations are not allowed.");
  }
  validateElementBudget(source, maxElements);
  let document: Document;
  try {
    document = parserFor(options).parseFromString(source, "image/svg+xml");
  } catch (error) {
    fail("invalid-svg", `SVG parsing failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (document.querySelector("parsererror")) fail("invalid-svg", "SVG is not well-formed XML.");
  const root = document.documentElement;
  if (!root || root.localName !== "svg" || (root.namespaceURI && root.namespaceURI !== SVG_NAMESPACE)) {
    fail("invalid-svg", "The document root must be an SVG element.");
  }
  validateAttributes(root, true);
  validateIdentityViewport(root);
  const allElements = Array.from(root.querySelectorAll("*"));
  if (allElements.length > maxElements) {
    fail("limit-exceeded", `SVG contains more than ${maxElements} elements.`);
  }
  if (allElements.length === 0) fail("empty-svg", "SVG contains no importable elements.");
  for (const element of allElements) {
    if (element.parentElement !== root) {
      fail("unsupported-nesting", `Nested ${element.localName} elements are unsupported; flatten groups first.`, element.localName);
    }
    if (element.namespaceURI !== root.namespaceURI) {
      fail("unsupported-element", `${element.tagName} must use the same SVG namespace as the document root.`, element.localName);
    }
    if (!SUPPORTED_ELEMENTS.has(element.localName)) {
      fail(
        ["script", "foreignObject", "iframe", "object", "embed", "use", "image"].includes(element.localName)
          ? "unsafe-markup"
          : "unsupported-element",
        `SVG element ${element.localName} is unsupported; use path, rect, ellipse, circle, or polygon.`,
        element.localName,
      );
    }
    validateAttributes(element);
  }

  // Parse and validate every part before returning anything to preserve atomic behavior.
  const names = uniqueNames(allElements);
  const origin = options.origin ?? { x: 0, y: 0 };
  if (!Number.isFinite(origin.x) || !Number.isFinite(origin.y)) {
    fail("invalid-options", "origin must contain finite x and y coordinates.");
  }
  const zIndexStart = options.zIndexStart ?? 0;
  if (!Number.isInteger(zIndexStart) || zIndexStart < 0 || zIndexStart + allElements.length > 1_000_001) {
    fail("invalid-options", "zIndexStart must keep every imported zIndex between 0 and 1,000,000.");
  }
  const parsedParts = allElements.map((element, index) => {
    const geometry = geometryFor(element);
    const shifted = normalizeWorldVectorPath(
      { x: geometry.start.x + origin.x, y: geometry.start.y + origin.y },
      geometry.segments.map((segment) => {
        const shift = (point: Point): Point => ({ x: point.x + origin.x, y: point.y + origin.y });
        if (segment.kind === "line") return { kind: "line" as const, to: shift(segment.to) };
        if (segment.kind === "quadratic") {
          return { kind: "quadratic" as const, control: shift(segment.control), to: shift(segment.to) };
        }
        return {
          kind: "cubic" as const,
          control1: shift(segment.control1),
          control2: shift(segment.control2),
          to: shift(segment.to),
        };
      }),
    );
    return { element, geometry, shifted, style: styleFor(element), name: names[index]!, index };
  });
  const candidates = parsedParts.map(({ element, geometry, shifted, style, name, index }) => {
    const id = (options.idForPart ?? defaultId)(name, index);
    const object = {
      id,
      semanticName: name,
      semanticRole: `svg-${element.localName}`,
      kind: "path" as const,
      ...shifted,
      closed: geometry.closed,
      rotation: 0,
      zIndex: zIndexStart + index,
      groupId: null,
      ...style,
    };
    const parsed = createCanvasObjectSchema.safeParse(object);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      fail(
        "invalid-object",
        `${name} could not become a canvas object: ${issue?.message ?? "schema validation failed"}`,
        element.localName,
      );
    }
    return parsed.data as CreateCanvasObject;
  });
  if (new Set(candidates.map((object) => object.id)).size !== candidates.length) {
    fail("duplicate-id", "idForPart must return a unique id for every SVG part.");
  }
  return candidates;
}
