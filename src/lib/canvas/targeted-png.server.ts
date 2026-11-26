import { Buffer } from "node:buffer";
import { z } from "zod";

import { createCanvasObjectSchema } from "@/lib/domain/schemas";
import type { CanvasBounds, CanvasObject, RoomState } from "@/lib/domain/types";

import { renderSemanticSceneSvg, SemanticPngRenderError } from "./semantic-png-svg";
import { projectPersistedSemanticArtwork, type SemanticScene } from "./semantic-scene";
import { SEMANTIC_SHAPE_STROKE_WIDTH } from "./semantic-visual-style";

export const TARGETED_PNG_LIMITS = {
  maxTargets: 120,
  maxGroupScan: 10_000,
  maxGeometryItems: 32_000,
  maxTextChars: 32_000,
  maxCoordinate: 10_000_000,
  maxPadding: 128,
  maxDimension: 1_536,
  maxSvgBytes: 1_000_000,
  maxPngBytes: 1_500_000,
  timeoutSeconds: 3,
  maxConcurrentRasters: 2,
} as const;

const idSchema = z.string().min(1).max(128);
const revisionSchema = z.number().int().positive();
const objectTargetSchema = z.strictObject({
  objectId: idSchema,
  expectedRevision: revisionSchema,
});

export const targetedCanvasPngInputSchema = z.strictObject({
  scope: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("objects"),
      targets: z.array(objectTargetSchema).min(1).max(TARGETED_PNG_LIMITS.maxTargets),
    }),
    z.strictObject({
      kind: z.literal("group"),
      groupId: idSchema,
      expectedRoomRevision: revisionSchema,
    }),
  ]),
  padding: z.number().int().min(0).max(TARGETED_PNG_LIMITS.maxPadding).optional(),
});

export type TargetedCanvasPngInput = z.infer<typeof targetedCanvasPngInputSchema>;

export type TargetedCanvasPng = {
  bytes: Buffer;
  metadata: {
    mimeType: "image/png";
    width: number;
    height: number;
    byteLength: number;
    roomRevision: number;
    objectRevisions: Array<{ objectId: string; revision: number }>;
    bounds: CanvasBounds;
    scale: number;
    warnings: string[];
  };
};

export type TargetedPngErrorCode =
  | "INVALID_SCOPE"
  | "TARGET_NOT_FOUND"
  | "REVISION_MISMATCH"
  | "UNSUPPORTED_CONTENT"
  | "RENDER_LIMIT"
  | "RENDER_BUSY"
  | "RENDER_FAILED";

export class TargetedCanvasPngError extends Error {
  constructor(public readonly code: TargetedPngErrorCode, message: string) {
    super(message);
    this.name = "TargetedCanvasPngError";
  }
}

type AuthorizedRoomSnapshot = Readonly<Pick<RoomState, "id" | "roomRevision" | "objects">>;

function fail(code: TargetedPngErrorCode, message: string): never {
  throw new TargetedCanvasPngError(code, message);
}

function resolveScope(room: AuthorizedRoomSnapshot, scope: TargetedCanvasPngInput["scope"]): CanvasObject[] {
  if (scope.kind === "objects") {
    const seen = new Set<string>();
    return scope.targets.map(({ objectId, expectedRevision }) => {
      if (seen.has(objectId)) fail("INVALID_SCOPE", "Object targets must be unique.");
      seen.add(objectId);
      const object = Object.hasOwn(room.objects, objectId) ? room.objects[objectId] : undefined;
      if (!object || object.id !== objectId) fail("TARGET_NOT_FOUND", "A target is not in the authorized room.");
      if (object.revision !== expectedRevision) fail("REVISION_MISMATCH", "An object changed. Read the canvas and retry.");
      return object;
    });
  }

  if (scope.expectedRoomRevision !== room.roomRevision) {
    fail("REVISION_MISMATCH", "Group membership may have changed. Read the canvas and retry.");
  }
  const members: CanvasObject[] = [];
  let scanned = 0;
  for (const id in room.objects) {
    if (!Object.hasOwn(room.objects, id)) continue;
    if (++scanned > TARGETED_PNG_LIMITS.maxGroupScan) {
      fail("RENDER_LIMIT", "This room is too large for group discovery. Use explicit object targets.");
    }
    const object = room.objects[id]!;
    if (object.groupId !== scope.groupId) continue;
    if (object.id !== id) fail("RENDER_FAILED", "The selected group has inconsistent room data.");
    if (members.length === TARGETED_PNG_LIMITS.maxTargets) {
      fail("RENDER_LIMIT", "The selected group contains too many objects. Use a smaller explicit selection.");
    }
    members.push(object);
  }
  if (!members.length) fail("TARGET_NOT_FOUND", "The group is not in the authorized room.");
  return members;
}

function inGeometryRange(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= TARGETED_PNG_LIMITS.maxCoordinate;
}

function validateSelection(objects: readonly CanvasObject[]): CanvasObject[] {
  let geometryItems = 0;
  let textChars = 0;
  return objects.map((object): CanvasObject => {
    if (object.kind === "image") {
      fail("UNSUPPORTED_CONTENT", "Image assets cannot be included in a targeted native-object PNG.");
    }
    geometryItems += object.kind === "draw" ? object.points.length
      : object.kind === "path" ? object.segments.length * 3 + 1
      : object.kind === "connector" ? (object.routing?.waypoints?.length ?? 0) + 2
      : 1;
    textChars += object.kind === "text" ? object.content.length
      : object.kind === "shape" || object.kind === "connector" ? object.label.length
      : 0;
    if (geometryItems > TARGETED_PNG_LIMITS.maxGeometryItems || textChars > TARGETED_PNG_LIMITS.maxTextChars ||
        ![object.x, object.y, object.width, object.height, object.rotation].every(inGeometryRange)) {
      fail("RENDER_LIMIT", "The selected geometry or text exceeds the targeted render budget.");
    }
    // The renderer consumes drawing fields only, not persisted node metadata.
    // Normalize these fields through the same allowlists as native writes before forming SVG.
    const parsed = createCanvasObjectSchema.safeParse(
      object.kind === "shape" ? { ...object, nodeMetadata: undefined } : object,
    );
    if (!parsed.success || parsed.data.kind === "image") {
      fail("RENDER_FAILED", "A selected object cannot be rendered from its stored geometry.");
    }
    const { revision, diagramIds, createdAt, updatedAt, createdBy, lastEditedBy } = object;
    if (!Number.isSafeInteger(revision) || revision < 1) {
      fail("RENDER_FAILED", "A selected object has an invalid stored revision.");
    }
    const base = { revision, diagramIds, createdAt, updatedAt, createdBy, lastEditedBy };
    if (parsed.data.kind === "shape") return { ...parsed.data, ...base, nodeMetadata: undefined };
    return { ...parsed.data, ...base };
  });
}

function extraPaintMargin(object: CanvasObject): number {
  if (object.kind === "shape") return SEMANTIC_SHAPE_STROKE_WIDTH / 2;
  if (object.kind !== "path" || object.stroke === "none") return 0;
  // The shared path bounds include a half-stroke. Preserve square caps and SVG's default miter limit.
  if (object.lineJoin === "miter") return object.strokeWidth * 1.5;
  return object.lineCap === "square" ? object.strokeWidth / 2 : 0;
}

function projectSelection(room: AuthorizedRoomSnapshot, selected: CanvasObject[]): SemanticScene & { bounds: CanvasBounds } {
  const artwork = Object.fromEntries(selected.map((object) => [object.id, object]));
  const endpoints = Object.create(null) as RoomState["objects"];
  for (const object of selected) {
    if (object.kind !== "connector") continue;
    for (const endpoint of [object.start, object.end]) {
      const id = endpoint.objectId;
      // Endpoint geometry can affect a selected connector, but is never painted implicitly.
      if (id && Object.hasOwn(room.objects, id)) endpoints[id] = room.objects[id]!;
    }
  }
  const projected = projectPersistedSemanticArtwork(artwork, endpoints);
  const objects = projected.objects.map(({ object, bounds }) => {
    const extra = extraPaintMargin(object);
    return {
      object,
      bounds: {
        x: bounds.x - extra,
        y: bounds.y - extra,
        width: bounds.width + 2 * extra,
        height: bounds.height + 2 * extra,
      },
    };
  });
  if (objects.some(({ bounds }) => ![bounds.x, bounds.y, bounds.width, bounds.height].every(inGeometryRange))) {
    fail("RENDER_LIMIT", "The selected geometry is outside the targeted render budget.");
  }
  const x = Math.min(...objects.map(({ bounds }) => bounds.x));
  const y = Math.min(...objects.map(({ bounds }) => bounds.y));
  const right = Math.max(...objects.map(({ bounds }) => bounds.x + bounds.width));
  const bottom = Math.max(...objects.map(({ bounds }) => bounds.y + bounds.height));
  return {
    roomId: room.id,
    roomRevision: room.roomRevision,
    objects,
    bounds: { x, y, width: right - x, height: bottom - y },
    objectsById: Object.fromEntries(objects.map((item) => [item.object.id, item])),
    groupMembers: {},
    connectorRoutes: projected.connectorRoutes,
  };
}

let activeRasters = 0;

/** Pass only an authoritative snapshot already authorized for this caller's room read. */
export async function renderTargetedCanvasPng(
  room: AuthorizedRoomSnapshot,
  rawInput: TargetedCanvasPngInput,
): Promise<TargetedCanvasPng> {
  if (rawInput?.scope?.kind === "objects" && Array.isArray(rawInput.scope.targets) &&
      rawInput.scope.targets.length > TARGETED_PNG_LIMITS.maxTargets) {
    fail("RENDER_LIMIT", "Target too large. Select fewer native objects.");
  }
  const parsed = targetedCanvasPngInputSchema.safeParse(rawInput);
  if (!parsed.success) fail("INVALID_SCOPE", "Specify exact object targets or a group with its room revision.");
  if (activeRasters >= TARGETED_PNG_LIMITS.maxConcurrentRasters) {
    fail("RENDER_BUSY", "The renderer is busy. Retry shortly.");
  }
  activeRasters += 1;
  try {
    const selected = validateSelection(resolveScope(room, parsed.data.scope));
    const scene = projectSelection(room, selected);
    const padding = parsed.data.padding ?? 24;
    const max = TARGETED_PNG_LIMITS.maxDimension;
    const largestDimension = Math.max(scene.bounds.width, scene.bounds.height) + padding * 2;
    const scale = largestDimension <= max ? 1 : (max - 1) / largestDimension;
    const artifact = renderSemanticSceneSvg(scene, selected.map(({ id }) => id), {
      padding,
      scale,
      maxWidth: max,
      maxHeight: max,
      maxSvgBytes: TARGETED_PNG_LIMITS.maxSvgBytes,
    });
    if (artifact.warnings.length) fail("UNSUPPORTED_CONTENT", "The selected objects could not be faithfully rendered.");

    // Only our generated SVG enters the native decoder, never a caller-supplied source or asset.
    const { default: sharp } = await import("sharp");
    const { data, info } = await sharp(Buffer.from(artifact.svg), {
      failOn: "warning",
      limitInputPixels: max * max,
    }).timeout({ seconds: TARGETED_PNG_LIMITS.timeoutSeconds }).png().toBuffer({ resolveWithObject: true });
    if (data.byteLength > TARGETED_PNG_LIMITS.maxPngBytes ||
        info.width !== artifact.pixelWidth || info.height !== artifact.pixelHeight) {
      fail("RENDER_LIMIT", "The PNG exceeded its output budget or had unexpected dimensions.");
    }

    const warnings: string[] = [];
    if (scale < 1) warnings.push("The selection was downscaled to fit the image budget.");
    if (selected.some((object) =>
      object.kind === "text" ? object.content.trim() :
        (object.kind === "shape" || object.kind === "connector") && object.label.trim(),
    )) {
      warnings.push("Text uses server fonts; glyphs can differ from the browser canvas.");
    }
    return {
      bytes: data,
      metadata: {
        mimeType: "image/png",
        width: info.width,
        height: info.height,
        byteLength: data.byteLength,
        roomRevision: scene.roomRevision,
        objectRevisions: scene.objects.map(({ object }) => ({ objectId: object.id, revision: object.revision })),
        bounds: artifact.bounds,
        scale,
        warnings,
      },
    };
  } catch (error) {
    if (error instanceof TargetedCanvasPngError) throw error;
    if (error instanceof SemanticPngRenderError &&
        (error.code === "SVG_BYTE_BUDGET_EXCEEDED" || error.code === "DIMENSION_BUDGET_EXCEEDED")) {
      fail("RENDER_LIMIT", "The selected objects exceed the image budget.");
    }
    fail("RENDER_FAILED", "The selected objects could not be rendered.");
  } finally {
    activeRasters -= 1;
  }
}
