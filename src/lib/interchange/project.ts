import {
  normalizeConnectorRouting,
  resolveConnectorRoutes,
  type ResolvedConnectorRoute,
} from "@/lib/domain/connector-routing";
import type { ActorRef, CanvasBounds, CanvasObject, Diagram, RoomState } from "@/lib/domain/types";

import { parseJazzboardArtifactV1 } from "./schemas";
import {
  JAZZBOARD_ARTIFACT_FORMAT,
  JAZZBOARD_ARTIFACT_SCHEMA_URL,
  JAZZBOARD_ARTIFACT_VERSION,
  JazzboardInterchangeError,
  type JazzboardArtifactV1,
  type JazzboardArtifactWarning,
  type JazzboardSemanticArtifactV1,
  type JazzboardTemplateV1,
  type PortableAttribution,
  type PortableCanvasObject,
  type PortableDiagram,
  type PortableNodeMetadata,
  type ProjectArtifactScope,
  type TemplateCanvasObject,
  type TemplateDiagram,
} from "./types";

const EMPTY_BOUNDS: CanvasBounds = { x: 0, y: 0, width: 1, height: 1 };

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function compareObjects(
  left: Pick<PortableCanvasObject | TemplateCanvasObject, "id" | "zIndex">,
  right: Pick<PortableCanvasObject | TemplateCanvasObject, "id" | "zIndex">,
): number {
  return left.zIndex - right.zIndex || left.id.localeCompare(right.id);
}

function compareWarnings(left: JazzboardArtifactWarning, right: JazzboardArtifactWarning): number {
  return (
    left.code.localeCompare(right.code) ||
    (left.diagramId ?? "").localeCompare(right.diagramId ?? "") ||
    (left.objectId ?? "").localeCompare(right.objectId ?? "") ||
    left.message.localeCompare(right.message)
  );
}

export function sortArtifactWarnings(
  warnings: readonly JazzboardArtifactWarning[],
): JazzboardArtifactWarning[] {
  const unique = new Map<string, JazzboardArtifactWarning>();
  for (const warning of warnings) {
    const key = `${warning.code}\u0000${warning.diagramId ?? ""}\u0000${warning.objectId ?? ""}\u0000${warning.message}`;
    unique.set(key, warning);
  }
  return [...unique.values()].sort(compareWarnings);
}

export function boundsForPortableObjects(
  objects: ReadonlyArray<{
    id?: string;
    kind?: PortableCanvasObject["kind"] | TemplateCanvasObject["kind"];
    x: number;
    y: number;
    width: number;
    height: number;
  }>,
  connectorRoutes: Readonly<Record<string, ResolvedConnectorRoute>> = {},
): CanvasBounds {
  if (!objects.length) return { ...EMPTY_BOUNDS };
  const allBounds = objects.map((object) => {
    const route = object.kind === "connector" && object.id ? connectorRoutes[object.id] : undefined;
    return route?.bounds ?? {
      x: object.x,
      y: object.y,
      width: object.width,
      height: object.height,
    };
  });
  const minX = Math.min(...allBounds.map((bounds) => bounds.x));
  const minY = Math.min(...allBounds.map((bounds) => bounds.y));
  const maxX = Math.max(...allBounds.map((bounds) => bounds.x + bounds.width));
  const maxY = Math.max(...allBounds.map((bounds) => bounds.y + bounds.height));
  return {
    x: minX,
    y: minY,
    width: Math.max(maxX - minX, 1),
    height: Math.max(maxY - minY, 1),
  };
}

function attribution(actor: ActorRef): PortableAttribution {
  return {
    displayName: actor.displayName || "Unknown",
    kind: actor.kind,
  };
}

function portableBase(object: CanvasObject) {
  return {
    id: object.id,
    x: object.x,
    y: object.y,
    width: object.width,
    height: object.height,
    rotation: object.rotation,
    zIndex: object.zIndex,
    groupId: object.groupId,
    revision: object.revision,
    createdAt: object.createdAt,
    updatedAt: object.updatedAt,
    createdBy: attribution(object.createdBy),
    lastEditedBy: attribution(object.lastEditedBy),
  };
}

function portableNodeMetadata(object: CanvasObject): PortableNodeMetadata | null {
  if (object.kind !== "shape") return null;
  const candidate = (object as CanvasObject & { nodeMetadata?: unknown }).nodeMetadata;
  if (!candidate || typeof candidate !== "object") return null;
  const value = candidate as Record<string, unknown>;
  const owner = value.owner === null || typeof value.owner === "string" ? value.owner : null;
  const resolution = value.resolution === null || typeof value.resolution === "string" ? value.resolution : null;
  const resolvedAt =
    value.resolvedAt === null ||
    (typeof value.resolvedAt === "number" && Number.isInteger(value.resolvedAt) && value.resolvedAt >= 0)
      ? value.resolvedAt
      : null;
  if (
    value.kind === "decision" &&
    object.nodeType === "decision" &&
    ["proposed", "accepted", "rejected", "superseded"].includes(String(value.status))
  ) {
    const status = value.status as Extract<PortableNodeMetadata, { kind: "decision" }>["status"];
    return {
      kind: "decision",
      status,
      owner,
      resolution,
      resolvedAt,
    };
  }
  if (
    value.kind === "open_question" &&
    object.nodeType === "open_question" &&
    ["open", "answered", "deferred", "closed"].includes(String(value.status))
  ) {
    const status = value.status as Extract<PortableNodeMetadata, { kind: "open_question" }>["status"];
    return {
      kind: "open_question",
      status,
      owner,
      resolution,
      resolvedAt,
    };
  }
  return null;
}

function endpoint(
  connectorId: string,
  terminal: "start" | "end",
  value: {
    x: number;
    y: number;
    objectId: string | null;
    normalizedAnchor?: { x: number; y: number } | null;
    isPrecise?: boolean | null;
    isExact?: boolean | null;
    snap?: "center" | "edge-point" | "edge" | "none" | null;
  },
  includedIds: ReadonlySet<string>,
  warnings: JazzboardArtifactWarning[],
  diagramId: string | null,
) {
  const portableValue = {
    x: value.x,
    y: value.y,
    objectId: value.objectId,
    ...(value.normalizedAnchor !== undefined
      ? { normalizedAnchor: value.normalizedAnchor ? { ...value.normalizedAnchor } : null }
      : {}),
    ...(value.isPrecise !== undefined ? { isPrecise: value.isPrecise } : {}),
    ...(value.isExact !== undefined ? { isExact: value.isExact } : {}),
    ...(value.snap !== undefined ? { snap: value.snap } : {}),
  };
  if (value.objectId && !includedIds.has(value.objectId)) {
    warnings.push({
      code: "EXTERNAL_CONNECTOR_ENDPOINT_OMITTED",
      message: `Connector ${connectorId} ${terminal} endpoint referenced content outside this artifact; the private semantic ID was omitted while its exact point was preserved.`,
      objectId: connectorId,
      diagramId,
    });
    return { ...portableValue, objectId: null };
  }
  return portableValue;
}

function connectorRouting(object: Extract<CanvasObject, { kind: "connector" }>) {
  return { ...normalizeConnectorRouting(object.routing) };
}

function portableObject(
  object: Exclude<CanvasObject, { kind: "path" }>,
  includedIds: ReadonlySet<string>,
  warnings: JazzboardArtifactWarning[],
  diagramId: string | null,
): PortableCanvasObject {
  const base = portableBase(object);
  if (object.kind === "text") {
    return {
      ...base,
      kind: "text",
      content: object.content,
      color: object.color,
      size: object.size,
      align: object.align,
    };
  }
  if (object.kind === "shape") {
    return {
      ...base,
      kind: "shape",
      shape: object.shape,
      nodeType: object.nodeType ?? null,
      nodeMetadata: portableNodeMetadata(object),
      label: object.label,
      fill: object.fill,
      stroke: object.stroke,
    };
  }
  if (object.kind === "connector") {
    return {
      ...base,
      kind: "connector",
      start: endpoint(object.id, "start", object.start, includedIds, warnings, diagramId),
      end: endpoint(object.id, "end", object.end, includedIds, warnings, diagramId),
      direction: object.direction,
      label: object.label,
      color: object.color,
      routing: connectorRouting(object),
    };
  }
  if (object.kind === "image") {
    warnings.push({
      code: "MEDIA_NOT_EMBEDDED",
      message: `Image ${object.id} was exported as a safe placeholder; private and external source URLs are never copied into a portable artifact.`,
      objectId: object.id,
      diagramId,
    });
    return {
      ...base,
      kind: "image",
      alt: object.alt,
      mimeType: object.mimeType,
      locked: object.locked,
      media: {
        availability: "placeholder",
        reason: "private_or_external_source_omitted",
      },
    };
  }
  return {
    ...base,
    kind: "draw",
    points: object.points.map((point) => ({ x: point.x, y: point.y })),
    color: object.color,
    size: object.size,
  };
}

function portableDiagram(
  room: RoomState,
  diagram: Diagram,
  includedIds: ReadonlySet<string>,
  objects: readonly PortableCanvasObject[],
  connectorRoutes: Readonly<Record<string, ResolvedConnectorRoute>>,
  warnings: JazzboardArtifactWarning[],
): PortableDiagram {
  const memberObjectIds = uniqueSorted(
    diagram.memberObjectIds.filter((objectId) => includedIds.has(objectId) && room.objects[objectId]?.kind !== "connector"),
  );
  const connectorIds = uniqueSorted(
    diagram.connectorIds.filter((objectId) => includedIds.has(objectId) && room.objects[objectId]?.kind === "connector"),
  );
  const originalMemberIds = uniqueSorted(diagram.memberObjectIds);
  const originalConnectorIds = uniqueSorted(diagram.connectorIds);
  if (
    JSON.stringify(memberObjectIds) !== JSON.stringify(originalMemberIds) ||
    JSON.stringify(connectorIds) !== JSON.stringify(originalConnectorIds)
  ) {
    warnings.push({
      code: "DIAGRAM_PARTIAL",
      message: `Diagram ${diagram.id} was limited to the objects included by this artifact scope.`,
      objectId: null,
      diagramId: diagram.id,
    });
  }
  const memberSet = new Set([...memberObjectIds, ...connectorIds]);
  return {
    id: diagram.id,
    title: diagram.title,
    description: diagram.description,
    diagramType: diagram.diagramType,
    category: diagram.category,
    tags: uniqueSorted(diagram.tags),
    memberObjectIds,
    connectorIds,
    bounds: boundsForPortableObjects(
      objects.filter((object) => memberSet.has(object.id)),
      connectorRoutes,
    ),
    revision: diagram.revision,
    createdAt: diagram.createdAt,
    updatedAt: diagram.updatedAt,
    createdBy: attribution(diagram.createdBy),
    lastEditedBy: attribution(diagram.lastEditedBy),
  };
}

function scopeObjectIds(
  room: RoomState,
  scope: ProjectArtifactScope,
  warnings: JazzboardArtifactWarning[],
): { ids: string[]; diagram: Diagram | null } {
  if (scope.kind === "room") {
    return { ids: Object.keys(room.objects), diagram: null };
  }
  if (scope.kind === "diagram") {
    const diagram = room.diagrams?.[scope.diagramId];
    if (!diagram) {
      throw new JazzboardInterchangeError(
        "DIAGRAM_NOT_FOUND",
        `Diagram ${scope.diagramId} does not exist in this authorized room state.`,
        { diagramId: scope.diagramId },
      );
    }
    const requested = uniqueSorted([...diagram.memberObjectIds, ...diagram.connectorIds]);
    for (const objectId of requested) {
      if (!room.objects[objectId]) {
        warnings.push({
          code: "MISSING_OBJECT",
          message: `Diagram ${diagram.id} references missing object ${objectId}; it was not fabricated in the artifact.`,
          objectId,
          diagramId: diagram.id,
        });
      }
    }
    return { ids: requested.filter((objectId) => Boolean(room.objects[objectId])), diagram };
  }

  const requested = uniqueSorted(scope.objectIds);
  for (const objectId of requested) {
    if (!room.objects[objectId]) {
      warnings.push({
        code: "MISSING_OBJECT",
        message: `Selected object ${objectId} no longer exists and was not fabricated in the artifact.`,
        objectId,
        diagramId: null,
      });
    }
  }
  return { ids: requested.filter((objectId) => Boolean(room.objects[objectId])), diagram: null };
}

export function projectJazzboardArtifact(
  room: RoomState,
  scope: ProjectArtifactScope,
): JazzboardSemanticArtifactV1 {
  const warnings: JazzboardArtifactWarning[] = [];
  const selected = scopeObjectIds(room, scope, warnings);
  const contextDiagramId = selected.diagram?.id ?? null;
  const portableIds = selected.ids.filter((objectId) => {
    const object = room.objects[objectId];
    if (object?.kind !== "path") return true;
    warnings.push({
      code: "VECTOR_PATH_UNSUPPORTED_V1",
      message: `Vector path ${object.id} was omitted because Jazzboard artifact v1 cannot represent native paths without losing geometry or style.`,
      objectId: object.id,
      diagramId: contextDiagramId,
    });
    return false;
  });
  const includedIds = new Set(portableIds);
  const objects = portableIds
    .map((objectId) => portableObject(room.objects[objectId] as Exclude<CanvasObject, { kind: "path" }>, includedIds, warnings, contextDiagramId))
    .sort(compareObjects);
  const connectorRoutes = resolveConnectorRoutes(room);

  const roomDiagrams = Object.values(room.diagrams ?? {});
  const diagrams = (
    scope.kind === "diagram"
      ? [selected.diagram!]
      : scope.kind === "room"
        ? roomDiagrams
        : roomDiagrams.filter((diagram) =>
            [...diagram.memberObjectIds, ...diagram.connectorIds].some((objectId) => includedIds.has(objectId)),
          )
  )
    .map((diagram) => portableDiagram(room, diagram, includedIds, objects, connectorRoutes, warnings))
    .sort((left, right) => left.id.localeCompare(right.id));

  const kind = scope.kind === "room" ? "board" : scope.kind;
  const title = selected.diagram?.title ?? (scope.kind === "selection" ? `${room.title} selection` : room.title);
  const description = selected.diagram?.description ??
    (scope.kind === "selection"
      ? `Selected semantic objects from ${room.title}.`
      : `Portable semantic representation of ${room.title}.`);
  const artifact: JazzboardSemanticArtifactV1 = {
    $schema: JAZZBOARD_ARTIFACT_SCHEMA_URL,
    format: JAZZBOARD_ARTIFACT_FORMAT,
    version: JAZZBOARD_ARTIFACT_VERSION,
    kind,
    title,
    description,
    source: {
      roomRevision: room.roomRevision,
      diagramId: selected.diagram?.id ?? null,
      diagramRevision: selected.diagram?.revision ?? null,
    },
    bounds: boundsForPortableObjects(objects, connectorRoutes),
    objects,
    diagrams,
    warnings: sortArtifactWarnings(warnings),
  };

  return parseJazzboardArtifactV1(artifact) as JazzboardSemanticArtifactV1;
}

function canonicalDiagram(diagram: PortableDiagram): PortableDiagram {
  return {
    ...diagram,
    tags: uniqueSorted(diagram.tags),
    memberObjectIds: uniqueSorted(diagram.memberObjectIds),
    connectorIds: uniqueSorted(diagram.connectorIds),
  };
}

function canonicalTemplateDiagram(diagram: TemplateDiagram): TemplateDiagram {
  return {
    ...diagram,
    tags: uniqueSorted(diagram.tags),
    memberObjectIds: uniqueSorted(diagram.memberObjectIds),
    connectorIds: uniqueSorted(diagram.connectorIds),
  };
}

export function canonicalizeJazzboardArtifact(artifact: JazzboardArtifactV1): JazzboardArtifactV1 {
  const parsed = parseJazzboardArtifactV1(artifact);
  if (parsed.kind === "template") {
    const canonical: JazzboardTemplateV1 = {
      ...parsed,
      objects: [...parsed.objects].sort(compareObjects),
      diagrams: parsed.diagrams.map(canonicalTemplateDiagram).sort((left, right) => left.id.localeCompare(right.id)),
      warnings: sortArtifactWarnings(parsed.warnings),
    };
    return canonical;
  }
  return {
    ...parsed,
    objects: [...parsed.objects].sort(compareObjects),
    diagrams: parsed.diagrams.map(canonicalDiagram).sort((left, right) => left.id.localeCompare(right.id)),
    warnings: sortArtifactWarnings(parsed.warnings),
  };
}

export function serializeJazzboardArtifact(artifact: JazzboardArtifactV1): string {
  return `${JSON.stringify(canonicalizeJazzboardArtifact(artifact), null, 2)}\n`;
}
