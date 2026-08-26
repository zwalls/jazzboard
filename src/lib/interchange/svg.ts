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

function color(value: string, fallback: string, allowNone = false): string {
  const normalized = value.toLowerCase();
  if (allowNone && normalized === "none") return "none";
  if (COLORS[normalized]) return COLORS[normalized];
  if (/^#[0-9a-f]{3}([0-9a-f]{3})?([0-9a-f]{2})?$/i.test(normalized)) return normalized;
  return fallback;
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

function geometryPoints(object: ArtifactObject): Coordinate[] {
  if (object.kind === "connector") return [object.start, object.end];
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

function renderBounds(artifact: JazzboardArtifactV1, padding: number) {
  let minX = artifact.bounds.x;
  let minY = artifact.bounds.y;
  let maxX = artifact.bounds.x + artifact.bounds.width;
  let maxY = artifact.bounds.y + artifact.bounds.height;
  for (const object of artifact.objects) {
    for (const point of geometryPoints(object)) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
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
): string {
  if (!lines.length) return "";
  const spans = lines
    .map(
      (line, index) =>
        `<tspan x="${number(x)}" dy="${index === 0 ? "0" : number(lineHeight)}">${xmlText(line, 500)}</tspan>`,
    )
    .join("");
  return `<text x="${number(x)}" y="${number(firstY)}" fill="${fill}" font-family="ui-sans-serif,system-ui,sans-serif" font-size="${number(fontSize)}" text-anchor="${anchor}">${spans}</text>`;
}

function renderText(object: Extract<ArtifactObject, { kind: "text" }>): string {
  const fontSize = { s: 16, m: 20, l: 28, xl: 36 }[object.size];
  const lineHeight = fontSize * 1.25;
  const maxCharacters = Math.max(8, Math.floor(object.width / (fontSize * 0.58)));
  const lines = wrappedLines(object.content, maxCharacters);
  const x = object.align === "start" ? object.x : object.align === "end" ? object.x + object.width : object.x + object.width / 2;
  const firstY = object.y + Math.min(fontSize, object.height / 2);
  return `<g${rotation(object)}>${textLines(lines, x, firstY, lineHeight, object.align, color(object.color, "#1d1d1d"), fontSize)}</g>`;
}

function renderShape(object: Extract<ArtifactObject, { kind: "shape" }>): string {
  const fill = color(object.fill, "#e9e7ff", true);
  const stroke = color(object.stroke, "#4263eb");
  const attributes = `fill="${fill}" stroke="${stroke}" stroke-width="2"`;
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
    geometry = `<rect x="${number(object.x)}" y="${number(object.y)}" width="${number(object.width)}" height="${number(object.height)}" rx="10" ${attributes}/>`;
  }
  const lines = wrappedLines(object.label, Math.max(8, Math.floor(object.width / 9)), 5);
  const lineHeight = 18;
  const firstY = object.y + object.height / 2 - ((lines.length - 1) * lineHeight) / 2 + 5;
  const label = textLines(lines, object.x + object.width / 2, firstY, lineHeight, "middle", stroke, 15);
  return `<g${rotation(object)}>${geometry}${label}</g>`;
}

function renderConnector(object: Extract<ArtifactObject, { kind: "connector" }>): string {
  const stroke = color(object.color, "#1d1d1d");
  const markerStart = object.direction === "both" ? ' marker-start="url(#jazzboard-arrow-start)"' : "";
  const markerEnd = object.direction === "none" ? "" : ' marker-end="url(#jazzboard-arrow-end)"';
  const line = `<line x1="${number(object.start.x)}" y1="${number(object.start.y)}" x2="${number(object.end.x)}" y2="${number(object.end.y)}" stroke="${stroke}" stroke-width="2" stroke-linecap="round"${markerStart}${markerEnd}/>`;
  if (!object.label.trim()) return line;
  const x = (object.start.x + object.end.x) / 2;
  const y = (object.start.y + object.end.y) / 2 - 7;
  return `${line}${textLines([object.label.replace(/\s+/g, " ").slice(0, 240)], x, y, 16, "middle", stroke, 13)}`;
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
  const width = { s: 2, m: 4, l: 7 }[object.size];
  return `<polyline points="${points}" transform="${localRotation(object)}" fill="none" stroke="${color(object.color, "#e03131")}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

function renderObject(object: ArtifactObject): string {
  if (object.kind === "text") return renderText(object);
  if (object.kind === "shape") return renderShape(object);
  if (object.kind === "connector") return renderConnector(object);
  if (object.kind === "image") return renderImage(object);
  return renderDraw(object);
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
  const view = renderBounds(artifact, padding);
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
    .map(renderObject)
    .join("");
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${number(view.x)} ${number(view.y)} ${number(view.width)} ${number(view.height)}" role="img" aria-labelledby="jazzboard-title jazzboard-description">`,
    `<title id="jazzboard-title">${xmlText(artifact.title, 200)}</title>`,
    `<desc id="jazzboard-description">${xmlText(artifact.description || "Jazzboard semantic canvas export.", 1_000)}</desc>`,
    '<defs><marker id="jazzboard-arrow-end" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L0,6 L9,3 z" fill="#1d1d1d"/></marker><marker id="jazzboard-arrow-start" markerWidth="10" markerHeight="10" refX="1" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M9,0 L9,6 L0,3 z" fill="#1d1d1d"/></marker></defs>',
    `<rect x="${number(view.x)}" y="${number(view.y)}" width="${number(view.width)}" height="${number(view.height)}" fill="#ffffff"/>`,
    objects,
    "</svg>",
  ].join("");
  return { svg, width, height, warnings: sortArtifactWarnings(warnings) };
}
