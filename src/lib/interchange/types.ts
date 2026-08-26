import type {
  ActorKind,
  CanvasBounds,
  DiagramNodeType,
  DiagramType,
  Point,
  SemanticTransaction,
} from "@/lib/domain/types";

export const JAZZBOARD_ARTIFACT_FORMAT = "jazzboard.semantic" as const;
export const JAZZBOARD_ARTIFACT_VERSION = 1 as const;
export const JAZZBOARD_ARTIFACT_SCHEMA_URL =
  "https://jazzboard-rho.vercel.app/schemas/jazzboard-artifact-v1.json" as const;

export type JazzboardArtifactWarningCode =
  | "MEDIA_NOT_EMBEDDED"
  | "MISSING_OBJECT"
  | "DIAGRAM_PARTIAL"
  | "EXTERNAL_CONNECTOR_ENDPOINT_OMITTED"
  | "MERMAID_OBJECT_OMITTED"
  | "MERMAID_CONNECTOR_OMITTED";

export type JazzboardArtifactWarning = {
  code: JazzboardArtifactWarningCode;
  message: string;
  objectId: string | null;
  diagramId: string | null;
};

/** Deliberately excludes participant IDs and participant colors. */
export type PortableAttribution = {
  displayName: string;
  kind: ActorKind;
};

export type PortableCanvasObjectBase = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  zIndex: number;
  groupId: string | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
  createdBy: PortableAttribution;
  lastEditedBy: PortableAttribution;
};

export type PortableTextObject = PortableCanvasObjectBase & {
  kind: "text";
  content: string;
  color: string;
  size: "s" | "m" | "l" | "xl";
  align: "start" | "middle" | "end";
};

export type PortableNodeMetadata =
  | {
      kind: "decision";
      status: "proposed" | "accepted" | "rejected" | "superseded";
      owner: string | null;
      resolution: string | null;
      resolvedAt: number | null;
    }
  | {
      kind: "open_question";
      status: "open" | "answered" | "deferred" | "closed";
      owner: string | null;
      resolution: string | null;
      resolvedAt: number | null;
    };

export type PortableShapeObject = PortableCanvasObjectBase & {
  kind: "shape";
  shape: "rectangle" | "ellipse" | "diamond";
  nodeType: DiagramNodeType | null;
  nodeMetadata: PortableNodeMetadata | null;
  label: string;
  fill: string;
  stroke: string;
};

export type PortableConnectorEndpoint = Point & {
  objectId: string | null;
};

export type PortableConnectorObject = PortableCanvasObjectBase & {
  kind: "connector";
  start: PortableConnectorEndpoint;
  end: PortableConnectorEndpoint;
  direction: "none" | "end" | "both";
  label: string;
  color: string;
};

export type PortableImageObject = PortableCanvasObjectBase & {
  kind: "image";
  alt: string;
  mimeType: string;
  locked: boolean;
  media: {
    availability: "placeholder";
    reason: "private_or_external_source_omitted";
  };
};

export type PortableDrawObject = PortableCanvasObjectBase & {
  kind: "draw";
  points: Point[];
  color: string;
  size: "s" | "m" | "l";
};

export type PortableCanvasObject =
  | PortableTextObject
  | PortableShapeObject
  | PortableConnectorObject
  | PortableImageObject
  | PortableDrawObject;

export type PortableDiagram = {
  id: string;
  title: string;
  description: string;
  diagramType: DiagramType;
  category: string | null;
  tags: string[];
  memberObjectIds: string[];
  connectorIds: string[];
  bounds: CanvasBounds;
  revision: number;
  createdAt: number;
  updatedAt: number;
  createdBy: PortableAttribution;
  lastEditedBy: PortableAttribution;
};

export type JazzboardArtifactSource = {
  roomRevision: number;
  diagramId: string | null;
  diagramRevision: number | null;
};

export type JazzboardSemanticArtifactV1 = {
  $schema: typeof JAZZBOARD_ARTIFACT_SCHEMA_URL;
  format: typeof JAZZBOARD_ARTIFACT_FORMAT;
  version: typeof JAZZBOARD_ARTIFACT_VERSION;
  kind: "board" | "diagram" | "selection" | "snapshot";
  title: string;
  description: string;
  source: JazzboardArtifactSource;
  bounds: CanvasBounds;
  objects: PortableCanvasObject[];
  diagrams: PortableDiagram[];
  warnings: JazzboardArtifactWarning[];
};

export type TemplateCanvasObjectBase = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  zIndex: number;
  groupId: string | null;
};

export type TemplateTextObject = TemplateCanvasObjectBase &
  Pick<PortableTextObject, "kind" | "content" | "color" | "size" | "align">;

export type TemplateShapeObject = TemplateCanvasObjectBase &
  Pick<
    PortableShapeObject,
    "kind" | "shape" | "nodeType" | "nodeMetadata" | "label" | "fill" | "stroke"
  >;

export type TemplateConnectorObject = TemplateCanvasObjectBase &
  Pick<PortableConnectorObject, "kind" | "start" | "end" | "direction" | "label" | "color">;

export type TemplateDrawObject = TemplateCanvasObjectBase &
  Pick<PortableDrawObject, "kind" | "points" | "color" | "size">;

/** Image objects are intentionally not portable templates in v1. */
export type TemplateCanvasObject =
  | TemplateTextObject
  | TemplateShapeObject
  | TemplateConnectorObject
  | TemplateDrawObject;

export type TemplateDiagram = {
  id: string;
  title: string;
  description: string;
  diagramType: DiagramType;
  category: string | null;
  tags: string[];
  memberObjectIds: string[];
  connectorIds: string[];
};

export type JazzboardTemplateV1 = {
  $schema: typeof JAZZBOARD_ARTIFACT_SCHEMA_URL;
  format: typeof JAZZBOARD_ARTIFACT_FORMAT;
  version: typeof JAZZBOARD_ARTIFACT_VERSION;
  kind: "template";
  title: string;
  description: string;
  source: null;
  bounds: CanvasBounds;
  objects: TemplateCanvasObject[];
  diagrams: TemplateDiagram[];
  warnings: JazzboardArtifactWarning[];
};

export type JazzboardArtifactV1 = JazzboardSemanticArtifactV1 | JazzboardTemplateV1;

export type ProjectArtifactScope =
  | { kind: "room" }
  | { kind: "diagram"; diagramId: string }
  | { kind: "selection"; objectIds: readonly string[] };

export type MermaidExport = {
  source: string;
  warnings: JazzboardArtifactWarning[];
};

export type SvgExport = {
  svg: string;
  width: number;
  height: number;
  warnings: JazzboardArtifactWarning[];
};

export type SvgRenderOptions = {
  padding?: number;
  maxWidth?: number;
  maxHeight?: number;
};

export type TemplateIdMap = {
  objects: Record<string, string>;
  diagrams: Record<string, string>;
  groups: Record<string, string>;
};

export type TemplateCreateIdKind = "text" | "shape" | "connector" | "draw" | "diagram" | "group";

export type TemplateInstantiationOptions = {
  origin: Point;
  baseZIndex?: number;
  createId?: (kind: TemplateCreateIdKind, sourceId: string) => string;
  reservedIds?: ReadonlySet<string>;
};

export type TemplateInstantiationPlan = {
  transaction: SemanticTransaction;
  idMap: TemplateIdMap;
  bounds: CanvasBounds;
  warnings: JazzboardArtifactWarning[];
};

export type JazzboardInterchangeErrorCode =
  | "ARTIFACT_INVALID"
  | "DIAGRAM_NOT_FOUND"
  | "DIAGRAM_REQUIRED"
  | "TEMPLATE_INVALID"
  | "TEMPLATE_MEDIA_UNSUPPORTED"
  | "TEMPLATE_ID_COLLISION";

export class JazzboardInterchangeError extends Error {
  constructor(
    public readonly code: JazzboardInterchangeErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "JazzboardInterchangeError";
  }
}
