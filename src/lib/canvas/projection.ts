import {
  AssetRecordType,
  createShapeId,
  getArrowTerminalsInArrowSpace,
  renderPlaintextFromRichText,
  toRichText,
  type Editor,
  type JsonObject,
  type TLArrowBinding,
  type TLArrowShape,
  type TLAssetId,
  type TLDefaultColorStyle,
  type TLDefaultSizeStyle,
  type TLDrawShape,
  type TLGeoShape,
  type TLImageShape,
  type TLNoteShape,
  type TLShape,
  type TLShapeId,
  type TLShapePartial,
  type TLTextShape,
} from "tldraw";

import type { CanvasObject, CreateCanvasObject, DiagramNodeType, RoomState } from "@/lib/domain/types";

type JazzboardMeta = JsonObject & {
  jazzboardId?: string;
  jazzboardRevision?: number;
  jazzboardKind?: string;
  jazzboardGroupId?: string;
  jazzboardFill?: string;
  jazzboardStroke?: string;
  jazzboardRenderedColor?: string;
  jazzboardRenderedFill?: string;
  jazzboardTextHeight?: number;
  jazzboardTextSize?: TLDefaultSizeStyle;
  jazzboardTextScale?: number;
  jazzboardNodeType?: DiagramNodeType | null;
};

const TLDRAW_COLORS = new Set([
  "black",
  "grey",
  "light-violet",
  "violet",
  "blue",
  "light-blue",
  "yellow",
  "orange",
  "green",
  "light-green",
  "light-red",
  "red",
  "white",
]);

function color(value: string): TLDefaultColorStyle {
  return (TLDRAW_COLORS.has(value) ? value : "black") as TLDefaultColorStyle;
}

function size(value: string): TLDefaultSizeStyle {
  return (["s", "m", "l", "xl"].includes(value) ? value : "m") as TLDefaultSizeStyle;
}

function semanticId(shape: TLShape): string {
  const meta = shape.meta as JazzboardMeta;
  // Preserve a locally created tldraw id across its first authoritative save.
  // Prefixing the suffix here would cause the server projection to create a
  // second, overlapping `shape:obj_*` record while the original remained in
  // the editor without Jazzboard metadata.
  return meta.jazzboardId ?? shape.id.slice("shape:".length);
}

export function tldrawShapeId(objectId: string): TLShapeId {
  return createShapeId(objectId);
}

function objectCenter(object: CanvasObject | undefined, fallback: { x: number; y: number }) {
  return object
    ? { x: object.x + object.width / 2, y: object.y + object.height / 2 }
    : fallback;
}

function objectEdgePoint(
  object: CanvasObject | undefined,
  toward: { x: number; y: number },
  fallback: { x: number; y: number },
) {
  if (!object) return fallback;
  const center = objectCenter(object, fallback);
  const dx = toward.x - center.x;
  const dy = toward.y - center.y;
  if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) return center;
  const halfWidth = Math.max(object.width / 2, 1);
  const halfHeight = Math.max(object.height / 2, 1);
  const scale = 1 / Math.max(Math.abs(dx) / halfWidth, Math.abs(dy) / halfHeight);
  return { x: center.x + dx * scale, y: center.y + dy * scale };
}

function metaFor(object: CanvasObject): JazzboardMeta {
  const meta: JazzboardMeta = {
    jazzboardId: object.id,
    jazzboardRevision: object.revision,
    jazzboardKind: object.kind,
  };
  if (object.kind === "shape") {
    meta.jazzboardFill = object.fill;
    meta.jazzboardStroke = object.stroke;
    meta.jazzboardRenderedColor = color(object.stroke);
    meta.jazzboardRenderedFill = object.fill === "none" ? "none" : "solid";
    meta.jazzboardNodeType = object.nodeType;
  } else if (object.kind === "text") {
    meta.jazzboardTextHeight = object.height;
    meta.jazzboardTextSize = size(object.size);
    meta.jazzboardTextScale = 1;
  }
  return meta;
}

function semanticGroupIdForShape(shape: TLShape | undefined): string | null {
  if (!shape || shape.type !== "group") return null;
  const meta = shape.meta as JazzboardMeta;
  return typeof meta.jazzboardGroupId === "string"
    ? meta.jazzboardGroupId
    : `group_${shape.id.slice("shape:".length)}`;
}

function projectedGroupShapeId(groupId: string): TLShapeId {
  return createShapeId(`jazzboard-group-${groupId}`);
}

function rotatePoint(point: { x: number; y: number }, rotation: number) {
  const cosine = Math.cos(rotation);
  const sine = Math.sin(rotation);
  return {
    x: point.x * cosine - point.y * sine,
    y: point.x * sine + point.y * cosine,
  };
}

function semanticToShape(room: RoomState, object: CanvasObject): TLShapePartial {
  const common = {
    id: tldrawShapeId(object.id),
    x: object.x,
    y: object.y,
    rotation: object.rotation,
    meta: metaFor(object),
  };

  if (object.kind === "text") {
    return {
      ...common,
      type: "text",
      props: {
        w: object.width,
        autoSize: false,
        richText: toRichText(object.content),
        color: color(object.color),
        size: size(object.size),
        textAlign: object.align,
      },
    };
  }
  if (object.kind === "shape") {
    return {
      ...common,
      type: "geo",
      props: {
        w: object.width,
        h: object.height,
        geo: object.shape,
        richText: toRichText(object.label),
        color: color(object.stroke),
        labelColor: color(object.stroke),
        fill: object.fill === "none" ? "none" : "solid",
      },
    };
  }
  if (object.kind === "connector") {
    const startObject = room.objects[object.start.objectId ?? ""];
    const endObject = room.objects[object.end.objectId ?? ""];
    const startCenter = objectCenter(startObject, object.start);
    const endCenter = objectCenter(endObject, object.end);
    const start = objectEdgePoint(startObject, endCenter, object.start);
    const end = objectEdgePoint(endObject, startCenter, object.end);
    // Connector endpoints are semantic page-space points. Arrow props are in
    // the arrow's local space, so remove the shape rotation before storing the
    // end delta or tldraw will rotate it a second time while rendering.
    const localEnd = rotatePoint({ x: end.x - start.x, y: end.y - start.y }, -object.rotation);
    return {
      ...common,
      x: start.x,
      y: start.y,
      type: "arrow",
      props: {
        start: { x: 0, y: 0 },
        end: localEnd,
        text: object.label,
        color: color(object.color),
        arrowheadStart: object.direction === "both" ? "arrow" : "none",
        arrowheadEnd: object.direction === "none" ? "none" : "arrow",
      },
    };
  }
  if (object.kind === "image") {
    return {
      ...common,
      type: "image",
      isLocked: object.locked,
      props: {
        assetId: AssetRecordType.createId(object.assetId ?? object.id),
        w: object.width,
        h: object.height,
        altText: object.alt,
      },
    };
  }
  return {
    ...common,
    type: "draw",
    props: {
      color: color(object.color),
      size: size(object.size),
      segments: [{ type: "free", points: object.points }],
      isComplete: true,
      isClosed: false,
      isPen: false,
      scale: 1,
    },
  };
}

function ensureImageAsset(editor: Editor, object: CanvasObject): void {
  if (object.kind !== "image") return;
  const id = AssetRecordType.createId(object.assetId ?? object.id);
  const asset = AssetRecordType.create({
    id,
    type: "image",
    props: {
      src: object.url,
      w: object.width,
      h: object.height,
      mimeType: object.mimeType,
      name: object.alt || "Jazzboard image",
      isAnimated: object.mimeType === "image/gif",
    },
    meta: { jazzboardAssetId: object.assetId ?? object.id },
  });
  if (editor.getAsset(id)) editor.updateAssets([asset]);
  else editor.createAssets([asset]);
}

function reconcileConnectorBindings(editor: Editor, object: CanvasObject): void {
  if (object.kind !== "connector") return;
  const arrowId = tldrawShapeId(object.id);
  const arrow = editor.getShape(arrowId);
  if (!arrow || arrow.type !== "arrow") return;

  const bindings = editor.getBindingsFromShape<TLArrowBinding>(arrowId, "arrow");
  for (const terminal of ["start", "end"] as const) {
    const endpoint = object[terminal];
    const targetId = endpoint.objectId ? tldrawShapeId(endpoint.objectId) : null;
    const target = targetId ? editor.getShape(targetId) : null;
    const existing = bindings.filter((binding) => binding.props.terminal === terminal);

    if (!target) {
      if (existing.length) editor.deleteBindings(existing);
      continue;
    }

    const props: TLArrowBinding["props"] = {
      terminal,
      normalizedAnchor: { x: 0.5, y: 0.5 },
      isExact: false,
      isPrecise: false,
      snap: "none",
    };
    if (existing.length > 1) editor.deleteBindings(existing.slice(1));
    if (existing[0]) {
      const current = existing[0];
      const propsMatch =
        current.props.terminal === props.terminal &&
        current.props.normalizedAnchor.x === props.normalizedAnchor.x &&
        current.props.normalizedAnchor.y === props.normalizedAnchor.y &&
        current.props.isExact === props.isExact &&
        current.props.isPrecise === props.isPrecise &&
        current.props.snap === props.snap;
      if (current.toId !== target.id || !propsMatch) {
        editor.updateBinding({ id: current.id, type: "arrow", toId: target.id, props });
      }
    } else {
      editor.createBinding({ type: "arrow", fromId: arrowId, toId: target.id, props });
    }
  }
}

export function projectRoomIntoTldraw(
  editor: Editor,
  room: RoomState,
  locallyActiveObjectIds: ReadonlySet<string> = new Set(),
): void {
  const wasReadonly = editor.getIsReadonly();
  if (wasReadonly) editor.updateInstanceState({ isReadonly: false });
  try {
    editor.store.mergeRemoteChanges(() => {
      const serverIds = new Set(Object.keys(room.objects));
      const desiredGroupIds = new Set(
        Object.values(room.objects).flatMap((object) => (object.groupId ? [object.groupId] : [])),
      );

      for (const shape of editor.getCurrentPageShapes()) {
        if (shape.type !== "group") continue;
        const meta = shape.meta as JazzboardMeta;
        if (meta.jazzboardGroupId && !desiredGroupIds.has(meta.jazzboardGroupId)) {
          editor.ungroupShapes([shape.id], { select: false });
        }
      }

      for (const object of Object.values(room.objects).sort((a, b) => a.zIndex - b.zIndex)) {
        if (locallyActiveObjectIds.has(object.id)) continue;
        ensureImageAsset(editor, object);
        const id = tldrawShapeId(object.id);
        let existing = editor.getShape(id);
        let partial = semanticToShape(room, object);
        if (existing && String(existing.parentId).startsWith("shape:")) {
          const parent = editor.getShape(existing.parentId as TLShapeId);
          if (object.groupId && semanticGroupIdForShape(parent) === object.groupId && parent) {
            const localOrigin = editor.getPointInShapeSpace(parent, { x: object.x, y: object.y });
            partial = { ...partial, x: localOrigin.x, y: localOrigin.y };
          } else {
            editor.reparentShapes([id], editor.getCurrentPageId());
            existing = editor.getShape(id);
          }
        }
        if (existing && existing.type !== partial.type) editor.deleteShape(id);
        if (editor.getShape(id)) editor.updateShape(partial);
        else editor.createShape(partial);
      }

      // Bindings must be reconciled only after every target shape exists;
      // semantic z-order does not guarantee that connectors follow targets.
      for (const object of Object.values(room.objects)) {
        if (!locallyActiveObjectIds.has(object.id)) reconcileConnectorBindings(editor, object);
      }

      const stale = editor
        .getCurrentPageShapes()
        .filter((shape) => {
          const objectId = (shape.meta as JazzboardMeta).jazzboardId;
          return objectId && !locallyActiveObjectIds.has(objectId) && !serverIds.has(objectId);
        })
        .map((shape) => shape.id);
      if (stale.length) editor.deleteShapes(stale);

      const groups = new Map<string, CanvasObject[]>();
      for (const object of Object.values(room.objects)) {
        if (!object.groupId || locallyActiveObjectIds.has(object.id)) continue;
        const members = groups.get(object.groupId) ?? [];
        members.push(object);
        groups.set(object.groupId, members);
      }
      for (const [semanticGroupId, members] of groups) {
        const memberIds = members.map((object) => tldrawShapeId(object.id)).filter((id) => editor.getShape(id));
        if (memberIds.length < 2) continue;
        const existingGroup = editor
          .getCurrentPageShapes()
          .find((shape) => semanticGroupIdForShape(shape) === semanticGroupId);
        const groupShapeId = existingGroup?.id ?? projectedGroupShapeId(semanticGroupId);
        if (!existingGroup) editor.groupShapes(memberIds, { groupId: groupShapeId, select: false });
        else {
          const missing = memberIds.filter((id) => editor.getShape(id)?.parentId !== groupShapeId);
          if (missing.length) editor.reparentShapes(missing, groupShapeId);
        }
        if (editor.getShape(groupShapeId)) {
          editor.updateShape({
            id: groupShapeId,
            type: "group",
            meta: { jazzboardGroupId: semanticGroupId },
          });
        }
        for (const member of [...members].sort((a, b) => a.zIndex - b.zIndex)) {
          editor.bringToFront([tldrawShapeId(member.id)]);
        }
      }

      const topLevel = Object.values(room.objects)
        .filter((object) => !object.groupId)
        .map((object) => ({ id: tldrawShapeId(object.id), zIndex: object.zIndex }));
      for (const [groupId, members] of groups) {
        const group = editor.getCurrentPageShapes().find((shape) => semanticGroupIdForShape(shape) === groupId);
        if (group) topLevel.push({ id: group.id, zIndex: Math.min(...members.map((member) => member.zIndex)) });
      }
      for (const item of topLevel.sort((a, b) => a.zIndex - b.zIndex)) editor.bringToFront([item.id]);
    });
  } finally {
    if (wasReadonly) editor.updateInstanceState({ isReadonly: true });
  }
}

function groupIdFor(editor: Editor, shape: TLShape): string | null {
  if (!String(shape.parentId).startsWith("shape:")) return null;
  const parent = editor.getShape(shape.parentId as TLShapeId);
  return semanticGroupIdForShape(parent);
}

export function tldrawShapeToSemantic(editor: Editor, shape: TLShape): CreateCanvasObject | null {
  const pageTransform = editor.getShapePageTransform(shape);
  const origin = pageTransform.point();
  const localBounds = editor.getShapeGeometry(shape).bounds;
  const base = {
    id: semanticId(shape),
    x: origin.x,
    y: origin.y,
    width: Math.max(localBounds.width, 1),
    height: Math.max(localBounds.height, 1),
    rotation: pageTransform.rotation(),
    zIndex: Math.max(editor.getCurrentPageShapesSorted().findIndex((item) => item.id === shape.id), 0),
    groupId: groupIdFor(editor, shape),
  };

  if (shape.type === "text") {
    const textShape = shape as TLTextShape;
    const meta = textShape.meta as JazzboardMeta;
    const textSizeUnchanged =
      meta.jazzboardTextSize === textShape.props.size &&
      meta.jazzboardTextScale === textShape.props.scale;
    return {
      ...base,
      kind: "text",
      height:
        textSizeUnchanged && typeof meta.jazzboardTextHeight === "number"
          ? meta.jazzboardTextHeight
          : base.height,
      content: renderPlaintextFromRichText(editor, textShape.props.richText),
      color: textShape.props.color,
      size: textShape.props.size,
      align: textShape.props.textAlign,
    };
  }
  if (shape.type === "note") {
    const noteShape = shape as TLNoteShape;
    const align = noteShape.props.align.replace("-legacy", "") as "start" | "middle" | "end";
    return {
      ...base,
      kind: "text",
      content: renderPlaintextFromRichText(editor, noteShape.props.richText),
      color: noteShape.props.labelColor,
      size: noteShape.props.size,
      align,
    };
  }
  if (shape.type === "geo") {
    const geoShape = shape as TLGeoShape;
    const meta = geoShape.meta as JazzboardMeta;
    const supported = ["rectangle", "ellipse", "diamond"].includes(geoShape.props.geo)
      ? (geoShape.props.geo as "rectangle" | "ellipse" | "diamond")
      : "rectangle";
    const colorChanged =
      typeof meta.jazzboardRenderedColor === "string" &&
      geoShape.props.color !== meta.jazzboardRenderedColor;
    const fillChanged =
      typeof meta.jazzboardRenderedFill === "string" &&
      geoShape.props.fill !== meta.jazzboardRenderedFill;
    const stroke = colorChanged ? geoShape.props.color : (meta.jazzboardStroke ?? geoShape.props.color);
    const fill =
      geoShape.props.fill === "none"
        ? "none"
        : colorChanged
          ? geoShape.props.color
          : fillChanged && meta.jazzboardFill === "none"
            ? geoShape.props.color
            : (meta.jazzboardFill ?? geoShape.props.color);
    return {
      ...base,
      kind: "shape",
      shape: supported,
      nodeType: meta.jazzboardNodeType ?? null,
      label: renderPlaintextFromRichText(editor, geoShape.props.richText),
      fill,
      stroke,
    };
  }
  if (shape.type === "arrow") {
    const arrowShape = shape as TLArrowShape;
    const bindings = editor.getBindingsFromShape<TLArrowBinding>(arrowShape.id, "arrow");
    const startBinding = bindings.find((binding) => binding.props.terminal === "start");
    const endBinding = bindings.find((binding) => binding.props.terminal === "end");
    const targetId = (target: TLShapeId | undefined) => {
      if (!target) return null;
      const targetShape = editor.getShape(target);
      return targetShape ? semanticId(targetShape) : null;
    };
    const terminals = getArrowTerminalsInArrowSpace(editor, arrowShape, {
      start: startBinding,
      end: endBinding,
    });
    const start = pageTransform.applyToPoint(terminals.start);
    const end = pageTransform.applyToPoint(terminals.end);
    return {
      ...base,
      kind: "connector",
      start: { ...start, objectId: targetId(startBinding?.toId) },
      end: { ...end, objectId: targetId(endBinding?.toId) },
      direction:
        arrowShape.props.arrowheadStart !== "none"
          ? "both"
          : arrowShape.props.arrowheadEnd === "none"
            ? "none"
            : "end",
      label: arrowShape.props.text,
      color: arrowShape.props.color,
    };
  }
  if (shape.type === "image") {
    const imageShape = shape as TLImageShape;
    const asset = imageShape.props.assetId ? editor.getAsset(imageShape.props.assetId as TLAssetId) : null;
    if (!asset || asset.type !== "image" || !asset.props.src) return null;
    return {
      ...base,
      kind: "image",
      url: asset.props.src,
      assetId: String(asset.id).slice("asset:".length),
      alt: imageShape.props.altText || asset.props.name || "Image",
      mimeType: asset.props.mimeType ?? "image/*",
      sourceUrl: null,
      locked: imageShape.isLocked,
    };
  }
  if (shape.type === "draw") {
    const drawShape = shape as TLDrawShape;
    const points = drawShape.props.segments.flatMap((segment) =>
      segment.points.map((point) => ({
        x: point.x * drawShape.props.scale,
        y: point.y * drawShape.props.scale,
      })),
    );
    if (points.length < 2) return null;
    return {
      ...base,
      kind: "draw",
      points,
      color: drawShape.props.color,
      size: drawShape.props.size === "xl" ? "l" : drawShape.props.size,
    };
  }
  return null;
}

export function jazzboardMeta(shape: TLShape): { objectId: string | null; revision: number | null } {
  const meta = shape.meta as JazzboardMeta;
  return {
    objectId: typeof meta.jazzboardId === "string" ? meta.jazzboardId : null,
    revision: typeof meta.jazzboardRevision === "number" ? meta.jazzboardRevision : null,
  };
}

const PROJECTION_EPSILON = 0.001;

function sameProjectedNumber(left: number, right: number): boolean {
  return Math.abs(left - right) <= PROJECTION_EPSILON;
}

function sameProjectedPoint(left: { x: number; y: number }, right: { x: number; y: number }): boolean {
  return sameProjectedNumber(left.x, right.x) && sameProjectedNumber(left.y, right.y);
}

function sameProjectedBase(current: CanvasObject, draft: CreateCanvasObject): boolean {
  return (
    current.id === draft.id &&
    current.kind === draft.kind &&
    sameProjectedNumber(current.x, draft.x) &&
    sameProjectedNumber(current.y, draft.y) &&
    sameProjectedNumber(current.width, draft.width) &&
    sameProjectedNumber(current.height, draft.height) &&
    sameProjectedNumber(current.rotation, draft.rotation) &&
    current.zIndex === draft.zIndex &&
    current.groupId === draft.groupId
  );
}

/**
 * Returns whether a tldraw shape draft already represents the authoritative
 * semantic object and therefore must not be sent back as a human edit.
 *
 * Bound arrow terminals are deliberately special. Jazzboard stores their
 * server-resolved edge points, while tldraw's binding model round-trips the
 * terminal at its normalized anchor. Those coordinates and the arrow's base
 * bounds are derived render state whenever the bound object IDs are unchanged.
 * tldraw also interleaves a bound arrow above its targets, so its local stack
 * index is derived too; fully unbound connectors retain exact z-order edits.
 */
export function isEquivalentTldrawProjection(current: CanvasObject, draft: CreateCanvasObject): boolean {
  if (current.id !== draft.id || current.kind !== draft.kind) return false;

  if (current.kind === "connector" && draft.kind === "connector") {
    const hasBoundEndpoint = current.start.objectId !== null || current.end.objectId !== null;
    const sameEndpoint = (
      authoritative: typeof current.start,
      projected: typeof draft.start,
    ) =>
      authoritative.objectId === projected.objectId &&
      (authoritative.objectId !== null || sameProjectedPoint(authoritative, projected));

    return (
      (hasBoundEndpoint || current.zIndex === draft.zIndex) &&
      current.groupId === draft.groupId &&
      sameEndpoint(current.start, draft.start) &&
      sameEndpoint(current.end, draft.end) &&
      current.direction === draft.direction &&
      current.label === draft.label &&
      current.color === draft.color
    );
  }

  if (!sameProjectedBase(current, draft)) return false;

  if (current.kind === "text" && draft.kind === "text") {
    return (
      current.content === draft.content &&
      current.color === draft.color &&
      current.size === draft.size &&
      current.align === draft.align
    );
  }
  if (current.kind === "shape" && draft.kind === "shape") {
    return (
      current.shape === draft.shape &&
      current.nodeType === (draft.nodeType ?? null) &&
      current.label === draft.label &&
      current.fill === draft.fill &&
      current.stroke === draft.stroke
    );
  }
  if (current.kind === "image" && draft.kind === "image") {
    return (
      current.url === draft.url &&
      current.assetId === draft.assetId &&
      current.alt === draft.alt &&
      current.mimeType === draft.mimeType &&
      current.sourceUrl === draft.sourceUrl &&
      current.locked === draft.locked
    );
  }
  if (current.kind === "draw" && draft.kind === "draw") {
    return (
      current.color === draft.color &&
      current.size === draft.size &&
      current.points.length === draft.points.length &&
      current.points.every((point, index) => sameProjectedPoint(point, draft.points[index]))
    );
  }
  return false;
}
