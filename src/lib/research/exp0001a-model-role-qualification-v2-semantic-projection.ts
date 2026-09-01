import { z } from "zod";

import { canonicalJson, hashCanonicalJson, type JsonValue } from "./provenance-crypto";

const finite = z.number().finite();
const id = z.string().trim().min(1).max(500);
const point = z.object({ x: finite, y: finite }).strict();
const bounds = z.object({ x: finite, y: finite, width: finite.nonnegative(), height: finite.nonnegative() }).strict();
const base = {
  id,
  kind: z.string(),
  semanticName: z.string().max(10_000).nullable(),
  semanticRole: z.string().max(10_000).nullable(),
  x: finite,
  y: finite,
  width: finite.nonnegative(),
  height: finite.nonnegative(),
  rotation: finite,
  zIndex: finite,
  revision: z.number().int().positive(),
  groupId: id.nullable(),
  diagramIds: z.array(id).max(10_000),
};

const endpoint = point.extend({
  objectId: id.nullable(),
  normalizedAnchor: point.nullable(),
  isPrecise: z.boolean().nullable(),
  isExact: z.boolean().nullable(),
  snap: z.enum(["center", "edge-point", "edge", "none"]).nullable(),
}).strict();

const pathSegment = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("line"), to: point }).strict(),
  z.object({ kind: z.literal("quadratic"), control: point, to: point }).strict(),
  z.object({ kind: z.literal("cubic"), control1: point, control2: point, to: point }).strict(),
]);

const objectSchema = z.discriminatedUnion("kind", [
  z.object({
    ...base,
    kind: z.literal("text"),
    content: z.string().max(100_000),
    color: z.string().max(200),
    size: z.string().max(50),
    align: z.string().max(50),
  }).strict(),
  z.object({
    ...base,
    kind: z.literal("shape"),
    shape: z.string().max(100),
    nodeType: z.string().max(100).nullable(),
    nodeMetadata: z.object({
      kind: z.string().max(100),
      status: z.string().max(100),
      resolution: z.string().max(10_000).nullable(),
    }).strict().nullable(),
    label: z.string().max(100_000),
    fill: z.string().max(200),
    stroke: z.string().max(200),
  }).strict(),
  z.object({
    ...base,
    kind: z.literal("connector"),
    start: endpoint,
    end: endpoint,
    routing: z.object({
      mode: z.enum(["auto", "straight", "curved", "elbow"]),
      kind: z.enum(["straight", "curved", "elbow"]),
      bend: finite,
      elbowMidPoint: finite,
      labelPosition: finite,
      labelPositionSource: z.enum(["generated", "authored"]).nullable(),
    }).strict().nullable(),
    direction: z.enum(["none", "end", "both"]),
    label: z.string().max(100_000),
    color: z.string().max(200),
  }).strict(),
  z.object({
    ...base,
    kind: z.literal("image"),
    alt: z.string().max(10_000),
    mimeType: z.string().max(200),
    locked: z.boolean(),
  }).strict(),
  z.object({
    ...base,
    kind: z.literal("draw"),
    points: z.array(point).max(100_000),
    color: z.string().max(200),
    size: z.string().max(50),
  }).strict(),
  z.object({
    ...base,
    kind: z.literal("path"),
    start: point,
    segments: z.array(pathSegment).max(100_000),
    closed: z.boolean(),
    fill: z.string().max(200),
    stroke: z.string().max(200),
    strokeWidth: finite.nonnegative(),
    opacity: finite.min(0).max(1),
    lineCap: z.enum(["butt", "round", "square"]),
    lineJoin: z.enum(["miter", "round", "bevel"]),
    fillRule: z.enum(["nonzero", "evenodd"]),
  }).strict(),
]);

const diagramSchema = z.object({
  id,
  title: z.string().max(10_000),
  description: z.string().max(100_000),
  diagramType: z.enum(["architecture", "flow", "hierarchy", "system_context", "process", "custom"]),
  category: z.string().max(1_000).nullable(),
  tags: z.array(z.string().max(1_000)).max(1_000),
  memberObjectIds: z.array(id).max(10_000),
  connectorIds: z.array(id).max(10_000),
  bounds,
  revision: z.number().int().positive(),
}).strict();

export const qualificationV2SanitizedSemanticStateSchema = z.object({
  schemaVersion: z.literal("exp-0001a-author-review-semantic-state/v2"),
  roomRevision: z.number().int().positive(),
  objects: z.array(objectSchema).max(10_000),
  diagrams: z.array(diagramSchema).max(10_000),
}).strict();

type UnknownRecord = Record<string, unknown>;
const record = (value: unknown, label: string): UnknownRecord => {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`QUALIFICATION_V2_SEMANTIC_${label}_INVALID`);
  }
  return value as UnknownRecord;
};
const array = (value: unknown, label: string): unknown[] => {
  if (!Array.isArray(value)) throw new Error(`QUALIFICATION_V2_SEMANTIC_${label}_INVALID`);
  return value;
};
const projectPoint = (value: unknown) => {
  const source = record(value, "POINT");
  return { x: source.x, y: source.y };
};
const projectEndpoint = (value: unknown) => {
  const source = record(value, "ENDPOINT");
  return {
    ...projectPoint(source),
    objectId: source.objectId ?? null,
    normalizedAnchor: source.normalizedAnchor == null ? null : projectPoint(source.normalizedAnchor),
    isPrecise: source.isPrecise ?? null,
    isExact: source.isExact ?? null,
    snap: source.snap ?? null,
  };
};

function projectObject(value: unknown) {
  const source = record(value, "OBJECT");
  const common = {
    id: source.id,
    kind: source.kind,
    semanticName: source.semanticName ?? null,
    semanticRole: source.semanticRole ?? null,
    x: source.x,
    y: source.y,
    width: source.width,
    height: source.height,
    rotation: source.rotation,
    zIndex: source.zIndex,
    revision: source.revision,
    groupId: source.groupId ?? null,
    diagramIds: [...array(source.diagramIds ?? [], "DIAGRAM_IDS")].sort(),
  };
  switch (source.kind) {
    case "text":
      return { ...common, content: source.content, color: source.color, size: source.size, align: source.align };
    case "shape": {
      const metadata = source.nodeMetadata == null ? null : record(source.nodeMetadata, "NODE_METADATA");
      return {
        ...common,
        shape: source.shape,
        nodeType: source.nodeType ?? null,
        nodeMetadata: metadata === null ? null : {
          kind: metadata.kind,
          status: metadata.status,
          resolution: metadata.resolution ?? null,
        },
        label: source.label,
        fill: source.fill,
        stroke: source.stroke,
      };
    }
    case "connector": {
      const routing = source.routing == null ? null : record(source.routing, "ROUTING");
      return {
        ...common,
        start: projectEndpoint(source.start),
        end: projectEndpoint(source.end),
        routing: routing === null ? null : {
          mode: routing.mode,
          kind: routing.kind,
          bend: routing.bend,
          elbowMidPoint: routing.elbowMidPoint,
          labelPosition: routing.labelPosition,
          labelPositionSource: routing.labelPositionSource ?? null,
        },
        direction: source.direction,
        label: source.label,
        color: source.color,
      };
    }
    case "image":
      return { ...common, alt: source.alt, mimeType: source.mimeType, locked: source.locked };
    case "draw":
      return { ...common, points: array(source.points, "POINTS").map(projectPoint), color: source.color, size: source.size };
    case "path":
      return {
        ...common,
        start: projectPoint(source.start),
        segments: array(source.segments, "SEGMENTS").map((segmentValue) => {
          const segment = record(segmentValue, "SEGMENT");
          if (segment.kind === "line") return { kind: segment.kind, to: projectPoint(segment.to) };
          if (segment.kind === "quadratic") {
            return { kind: segment.kind, control: projectPoint(segment.control), to: projectPoint(segment.to) };
          }
          return {
            kind: segment.kind,
            control1: projectPoint(segment.control1),
            control2: projectPoint(segment.control2),
            to: projectPoint(segment.to),
          };
        }),
        closed: source.closed,
        fill: source.fill,
        stroke: source.stroke,
        strokeWidth: source.strokeWidth,
        opacity: source.opacity,
        lineCap: source.lineCap,
        lineJoin: source.lineJoin,
        fillRule: source.fillRule,
      };
    default:
      throw new Error("QUALIFICATION_V2_SEMANTIC_OBJECT_KIND_INVALID");
  }
}

function projectDiagram(value: unknown) {
  const source = record(value, "DIAGRAM");
  const sourceBounds = record(source.bounds, "DIAGRAM_BOUNDS");
  return {
    id: source.id,
    title: source.title,
    description: source.description,
    diagramType: source.diagramType,
    category: source.category ?? null,
    tags: array(source.tags, "TAGS"),
    memberObjectIds: array(source.memberObjectIds, "MEMBERS"),
    connectorIds: array(source.connectorIds, "CONNECTORS"),
    bounds: { x: sourceBounds.x, y: sourceBounds.y, width: sourceBounds.width, height: sourceBounds.height },
    revision: source.revision,
  };
}

/**
 * Converts an authoritative `read_room_state` result (or its `data` object)
 * into the only semantic shape that may cross the blinded-review boundary.
 * Attribution, timestamps, room identity, participants, sessions, leases, and
 * every future/unknown metadata field are omitted by construction.
 */
export function projectQualificationV2SanitizedSemanticState(input: unknown) {
  const root = record(input, "ROOT");
  const data = root.data == null ? root : record(root.data, "DATA");
  const room = record(data.room, "ROOM");
  const projected = {
    schemaVersion: "exp-0001a-author-review-semantic-state/v2" as const,
    roomRevision: room.roomRevision,
    objects: array(data.objects, "OBJECTS").map(projectObject),
    diagrams: array(data.diagrams ?? [], "DIAGRAMS").map(projectDiagram),
  };
  return Object.freeze(qualificationV2SanitizedSemanticStateSchema.parse(projected));
}

export function parseQualificationV2SanitizedSemanticState(input: unknown) {
  const parsed = qualificationV2SanitizedSemanticStateSchema.parse(input);
  // Re-projecting a sanitized payload must be byte-identical. This turns the
  // projection into a positive allowlist rather than a best-effort redactor.
  const reprojection = projectQualificationV2SanitizedSemanticState({
    room: { roomRevision: parsed.roomRevision },
    objects: parsed.objects,
    diagrams: parsed.diagrams,
  });
  if (canonicalJson(reprojection) !== canonicalJson(parsed)) {
    throw new Error("QUALIFICATION_V2_SEMANTIC_PROJECTION_NOT_CANONICAL");
  }
  return parsed;
}

export function qualificationV2SanitizedSemanticStateDigest(input: unknown) {
  return hashCanonicalJson(parseQualificationV2SanitizedSemanticState(input) as unknown as JsonValue);
}
