import type { CreateCanvasObject, SemanticTransaction } from "@/lib/domain/types";

import { boundsForPortableObjects, canonicalizeJazzboardArtifact, sortArtifactWarnings } from "./project";
import { parseJazzboardArtifactV1, parseJazzboardTemplateV1 } from "./schemas";
import {
  JAZZBOARD_ARTIFACT_FORMAT,
  JAZZBOARD_ARTIFACT_SCHEMA_URL,
  JAZZBOARD_ARTIFACT_VERSION,
  JazzboardInterchangeError,
  type JazzboardArtifactV1,
  type JazzboardArtifactWarning,
  type JazzboardTemplateV1,
  type PortableNodeMetadata,
  type TemplateCanvasObject,
  type TemplateCreateIdKind,
  type TemplateDiagram,
  type TemplateInstantiationOptions,
  type TemplateInstantiationPlan,
} from "./types";

function selectDiagram(artifact: JazzboardArtifactV1, diagramId?: string) {
  if (diagramId) {
    const diagram = artifact.diagrams.find((candidate) => candidate.id === diagramId);
    if (!diagram) {
      throw new JazzboardInterchangeError(
        "DIAGRAM_NOT_FOUND",
        `Diagram ${diagramId} is not present in this portable artifact.`,
        { diagramId },
      );
    }
    return diagram;
  }
  if (artifact.diagrams.length !== 1) {
    throw new JazzboardInterchangeError(
      "DIAGRAM_REQUIRED",
      "Choose one Diagram when creating a template from an artifact that does not contain exactly one Diagram.",
      { diagramIds: artifact.diagrams.map((diagram) => diagram.id) },
    );
  }
  return artifact.diagrams[0];
}

function stripObject(
  object: Exclude<JazzboardArtifactV1["objects"][number], { kind: "image" }>,
  includedIds: ReadonlySet<string>,
  diagramId: string,
  warnings: JazzboardArtifactWarning[],
): TemplateCanvasObject {
  const base = {
    id: object.id,
    x: object.x,
    y: object.y,
    width: object.width,
    height: object.height,
    rotation: object.rotation,
    zIndex: object.zIndex,
    groupId: object.groupId,
  };
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
      nodeType: object.nodeType,
      nodeMetadata: object.nodeMetadata ? { ...object.nodeMetadata } : null,
      label: object.label,
      fill: object.fill,
      stroke: object.stroke,
    };
  }
  if (object.kind === "draw") {
    return {
      ...base,
      kind: "draw",
      points: object.points.map((point) => ({ ...point })),
      color: object.color,
      size: object.size,
    };
  }

  const endpoint = (terminal: "start" | "end") => {
    const value = object[terminal];
    if (value.objectId && !includedIds.has(value.objectId)) {
      warnings.push({
        code: "EXTERNAL_CONNECTOR_ENDPOINT_OMITTED",
        message: `Connector ${object.id} ${terminal} endpoint was outside Diagram ${diagramId}; the template retains its exact point without that external semantic ID.`,
        objectId: object.id,
        diagramId,
      });
      return { x: value.x, y: value.y, objectId: null };
    }
    return { ...value };
  };
  return {
    ...base,
    kind: "connector",
    start: endpoint("start"),
    end: endpoint("end"),
    direction: object.direction,
    label: object.label,
    color: object.color,
  };
}

/** Convert one Diagram into an audit-free, create-only portable template. */
export function createJazzboardTemplate(
  input: JazzboardArtifactV1,
  diagramId?: string,
): JazzboardTemplateV1 {
  const artifact = parseJazzboardArtifactV1(input);
  const diagram = selectDiagram(artifact, diagramId);
  const includedIds = new Set([...diagram.memberObjectIds, ...diagram.connectorIds]);
  const selectedObjects = artifact.objects
    .filter((object) => includedIds.has(object.id))
    .sort((left, right) => left.zIndex - right.zIndex || left.id.localeCompare(right.id));
  const image = selectedObjects.find((object) => object.kind === "image");
  if (image) {
    throw new JazzboardInterchangeError(
      "TEMPLATE_MEDIA_UNSUPPORTED",
      `Diagram ${diagram.id} contains image ${image.id}. Jazzboard v1 templates are create-only and never copy media or source URLs.`,
      { diagramId: diagram.id, objectId: image.id },
    );
  }

  const warnings = artifact.warnings.filter(
    (warning) => warning.diagramId === diagram.id || (warning.objectId !== null && includedIds.has(warning.objectId)),
  );
  const objects = selectedObjects.map((object) =>
    stripObject(
      object as Exclude<(typeof selectedObjects)[number], { kind: "image" }>,
      includedIds,
      diagram.id,
      warnings,
    ),
  );
  const templateDiagram: TemplateDiagram = {
    id: diagram.id,
    title: diagram.title,
    description: diagram.description,
    diagramType: diagram.diagramType,
    category: diagram.category,
    tags: [...new Set(diagram.tags)].sort((left, right) => left.localeCompare(right)),
    memberObjectIds: [...diagram.memberObjectIds].sort((left, right) => left.localeCompare(right)),
    connectorIds: [...diagram.connectorIds].sort((left, right) => left.localeCompare(right)),
  };
  const template: JazzboardTemplateV1 = {
    $schema: JAZZBOARD_ARTIFACT_SCHEMA_URL,
    format: JAZZBOARD_ARTIFACT_FORMAT,
    version: JAZZBOARD_ARTIFACT_VERSION,
    kind: "template",
    title: diagram.title,
    description: diagram.description,
    source: null,
    bounds: "bounds" in diagram
      ? { ...(diagram as { bounds: JazzboardTemplateV1["bounds"] }).bounds }
      : objects.length
        ? boundsForPortableObjects(objects)
        : { ...artifact.bounds },
    objects,
    diagrams: [templateDiagram],
    warnings: sortArtifactWarnings(warnings),
  };
  return canonicalizeJazzboardArtifact(parseJazzboardTemplateV1(template)) as JazzboardTemplateV1;
}

function defaultCreateId(kind: TemplateCreateIdKind): string {
  return `${kind}_${globalThis.crypto.randomUUID()}`;
}

function validGeneratedId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

type PlannedNodeMetadata = PortableNodeMetadata extends infer Metadata
  ? Metadata extends PortableNodeMetadata
    ? Omit<Metadata, "resolvedAt">
    : never
  : never;

type PlannedShape = Omit<Extract<CreateCanvasObject, { kind: "shape" }>, "nodeMetadata"> & {
  /** resolvedAt is server-managed when a fresh object is instantiated. */
  nodeMetadata?: PlannedNodeMetadata;
};

function createObject(
  object: TemplateCanvasObject,
  objectIds: ReadonlyMap<string, string>,
  groupIds: ReadonlyMap<string, string>,
  dx: number,
  dy: number,
  zIndex: number,
): CreateCanvasObject {
  const base = {
    id: objectIds.get(object.id)!,
    x: object.x + dx,
    y: object.y + dy,
    width: object.width,
    height: object.height,
    rotation: object.rotation,
    zIndex,
    groupId: object.groupId ? groupIds.get(object.groupId)! : null,
  };
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
    const nodeMetadata = object.nodeMetadata
      ? {
          kind: object.nodeMetadata.kind,
          status: object.nodeMetadata.status,
          owner: object.nodeMetadata.owner,
          resolution: object.nodeMetadata.resolution,
        } as PlannedNodeMetadata
      : null;
    const shape: PlannedShape = {
      ...base,
      kind: "shape",
      shape: object.shape,
      nodeType: object.nodeType,
      label: object.label,
      fill: object.fill,
      stroke: object.stroke,
      ...(nodeMetadata ? { nodeMetadata } : {}),
    };
    return shape as CreateCanvasObject;
  }
  if (object.kind === "draw") {
    return {
      ...base,
      kind: "draw",
      points: object.points.map((point) => ({ ...point })),
      color: object.color,
      size: object.size,
    };
  }
  return {
    ...base,
    kind: "connector",
    start: {
      x: object.start.x + dx,
      y: object.start.y + dy,
      objectId: object.start.objectId ? objectIds.get(object.start.objectId)! : null,
    },
    end: {
      x: object.end.x + dx,
      y: object.end.y + dy,
      objectId: object.end.objectId ? objectIds.get(object.end.objectId)! : null,
    },
    direction: object.direction,
    label: object.label,
    color: object.color,
  };
}

/**
 * Plan an all-create SemanticTransaction. Nothing in the source template is
 * treated as an authorization, revision guard, or target-room entity ID.
 */
export function planTemplateInstantiation(
  input: unknown,
  options: TemplateInstantiationOptions,
): TemplateInstantiationPlan {
  const template = parseJazzboardTemplateV1(input);
  if (!Number.isFinite(options.origin.x) || !Number.isFinite(options.origin.y)) {
    throw new JazzboardInterchangeError("TEMPLATE_INVALID", "Template origin must contain finite coordinates.");
  }
  const baseZIndex = options.baseZIndex ?? 0;
  if (!Number.isInteger(baseZIndex) || baseZIndex < 0 || baseZIndex > 1_000_000) {
    throw new JazzboardInterchangeError(
      "TEMPLATE_INVALID",
      "Template baseZIndex must be an integer between 0 and 1,000,000.",
    );
  }

  const sourceObjectIds = template.objects.map((object) => object.id).sort((left, right) => left.localeCompare(right));
  const sourceDiagramIds = template.diagrams.map((diagram) => diagram.id).sort((left, right) => left.localeCompare(right));
  const sourceGroupIds = [...new Set(template.objects.flatMap((object) => object.groupId ? [object.groupId] : []))]
    .sort((left, right) => left.localeCompare(right));
  const unavailable = new Set<string>([
    ...(options.reservedIds ?? []),
    ...sourceObjectIds,
    ...sourceDiagramIds,
    ...sourceGroupIds,
  ]);
  const generated = new Set<string>();
  const createId = options.createId ?? ((kind: TemplateCreateIdKind) => defaultCreateId(kind));

  const allocate = (kind: TemplateCreateIdKind, sourceId: string): string => {
    const generatedId = createId(kind, sourceId);
    if (!validGeneratedId(generatedId) || unavailable.has(generatedId) || generated.has(generatedId)) {
      throw new JazzboardInterchangeError(
        "TEMPLATE_ID_COLLISION",
        `Template ID factory did not produce a fresh, safe ID for ${kind} ${sourceId}.`,
        { kind, sourceId, generatedId },
      );
    }
    generated.add(generatedId);
    return generatedId;
  };

  const objectEntries = sourceObjectIds.map((sourceId) => {
    const kind = template.objects.find((object) => object.id === sourceId)!.kind;
    return [sourceId, allocate(kind, sourceId)] as const;
  });
  const diagramEntries = sourceDiagramIds.map((sourceId) => [sourceId, allocate("diagram", sourceId)] as const);
  const groupEntries = sourceGroupIds.map((sourceId) => [sourceId, allocate("group", sourceId)] as const);
  const objectIds = new Map(objectEntries);
  const diagramIds = new Map(diagramEntries);
  const groupIds = new Map(groupEntries);
  const minZIndex = template.objects.length
    ? Math.min(...template.objects.map((object) => object.zIndex))
    : 0;
  const sortedObjects = [...template.objects].sort((left, right) => {
    const leftConnector = left.kind === "connector" ? 1 : 0;
    const rightConnector = right.kind === "connector" ? 1 : 0;
    return leftConnector - rightConnector || left.zIndex - right.zIndex || left.id.localeCompare(right.id);
  });
  const dx = options.origin.x - template.bounds.x;
  const dy = options.origin.y - template.bounds.y;
  const commands: SemanticTransaction["commands"] = sortedObjects.map((object) => {
    const zIndex = baseZIndex + object.zIndex - minZIndex;
    if (zIndex > 1_000_000) {
      throw new JazzboardInterchangeError(
        "TEMPLATE_INVALID",
        `Instantiating template object ${object.id} would exceed the maximum zIndex.`,
        { objectId: object.id, zIndex },
      );
    }
    return { type: "create", object: createObject(object, objectIds, groupIds, dx, dy, zIndex) };
  });
  const diagramCommands: SemanticTransaction["diagramCommands"] = template.diagrams.map((diagram) => ({
    type: "diagram.create",
    diagram: {
      id: diagramIds.get(diagram.id)!,
      title: diagram.title,
      description: diagram.description,
      diagramType: diagram.diagramType,
      category: diagram.category,
      tags: [...diagram.tags],
      memberObjectIds: diagram.memberObjectIds.map((id) => objectIds.get(id)!),
      connectorIds: diagram.connectorIds.map((id) => objectIds.get(id)!),
    },
  }));

  return {
    transaction: { commands, diagramCommands },
    idMap: {
      objects: Object.fromEntries(objectEntries),
      diagrams: Object.fromEntries(diagramEntries),
      groups: Object.fromEntries(groupEntries),
    },
    bounds: {
      x: options.origin.x,
      y: options.origin.y,
      width: template.bounds.width,
      height: template.bounds.height,
    },
    warnings: sortArtifactWarnings(template.warnings),
  };
}
