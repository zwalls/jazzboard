// @vitest-environment node

import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ActorRef, CanvasObject, PathObject, ShapeObject } from "@/lib/domain/types";

import { renderSemanticSceneSvg } from "./semantic-png-svg";
import { buildSemanticScene } from "./semantic-scene";
import {
  renderTargetedCanvasPng,
  TARGETED_PNG_LIMITS,
  type TargetedCanvasPngInput,
} from "./targeted-png.server";

const actor: ActorRef = { participantId: "host", displayName: "Host", color: "#123456", kind: "human" };

function shape(id: string, values: Partial<ShapeObject> = {}): ShapeObject {
  return {
    id,
    kind: "shape",
    shape: "rectangle",
    nodeType: null,
    label: "",
    fill: "#993333",
    stroke: "#993333",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    zIndex: 1,
    revision: 1,
    groupId: null,
    diagramIds: [],
    createdAt: 1,
    updatedAt: 1,
    createdBy: actor,
    lastEditedBy: actor,
    ...values,
  };
}

function snapshot(...objects: CanvasObject[]) {
  return {
    id: "room-with-read-access",
    roomRevision: 5,
    objects: Object.fromEntries(objects.map((object) => [object.id, object])),
  };
}

function targets(...objects: CanvasObject[]): TargetedCanvasPngInput {
  return {
    scope: {
      kind: "objects",
      targets: objects.map(({ id, revision }) => ({ objectId: id, expectedRevision: revision })),
    },
  };
}

async function pixels(bytes: Buffer) {
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return {
    data,
    info,
    at(x: number, y: number) {
      const offset = (y * info.width + x) * info.channels;
      return Array.from(data.subarray(offset, offset + 3));
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("browserless targeted canvas PNG", () => {
  it("returns a decoded PNG containing only the selected subject, even through overlapping unrelated objects", async () => {
    const first = shape("background", { fill: "#485763", stroke: "#485763", width: 200, height: 160, zIndex: 0 });
    const second = shape("face", { shape: "ellipse", x: 50, y: 25, width: 100, height: 80, fill: "#d9aa7a", stroke: "#d9aa7a" });
    const occluder = shape("must-not-be-painted", { x: 25, y: -40, width: 340, height: 240, fill: "#00ff00", zIndex: 10 });
    const room = snapshot(occluder, second, first);
    const result = await renderTargetedCanvasPng(room, targets(second, first));
    const withoutOccluder = await renderTargetedCanvasPng(snapshot(first, second), targets(first, second));
    expect(result.bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(result.bytes).toEqual(withoutOccluder.bytes);
    const decoded = await pixels(result.bytes);
    expect(decoded.at(100, 80)).toEqual([217, 170, 122]);
    expect(decoded.at(40, 40)).toEqual([72, 87, 99]);
    expect(decoded.at(4, 4)).toEqual([255, 255, 255]);
    expect(result.metadata).toMatchObject({
      mimeType: "image/png",
      width: decoded.info.width,
      height: decoded.info.height,
      roomRevision: 5,
      objectRevisions: [{ objectId: first.id, revision: 1 }, { objectId: second.id, revision: 1 }],
      byteLength: result.bytes.length,
      warnings: [],
    });
  });

  it("preserves native vector path geometry, rotation, stroke and paint with the shared export renderer", async () => {
    const { id, x, y, width, height, zIndex, revision, groupId, diagramIds, createdAt, updatedAt, createdBy, lastEditedBy } =
      shape("veiled-silhouette", { x: -40, y: 42, width: 160, height: 96 });
    const path: PathObject = {
      id, x, y, width, height, zIndex, revision, groupId, diagramIds, createdAt, updatedAt, createdBy, lastEditedBy,
      kind: "path",
      rotation: Math.PI / 12,
      start: { x: 0, y: 0.8 },
      segments: [
        { kind: "cubic", control1: { x: 0.2, y: 0 }, control2: { x: 0.7, y: 0 }, to: { x: 1, y: 0.75 } },
        { kind: "line", to: { x: 0.6, y: 0.9 } },
      ],
      closed: true, fill: "#9c57b7", stroke: "#241735", strokeWidth: 5, opacity: 0.85,
      lineCap: "round", lineJoin: "round", fillRule: "evenodd",
    };
    const room = snapshot(path);
    const result = await renderTargetedCanvasPng(room, { ...targets(path), padding: 12 });
    const referenceSvg = renderSemanticSceneSvg(buildSemanticScene({ ...room, diagrams: {} }), [path.id], { padding: 12 });
    const referencePng = await sharp(Buffer.from(referenceSvg.svg)).png().toBuffer();
    expect((await pixels(result.bytes)).data).toEqual((await pixels(referencePng)).data);
  });

  it("matches the native persisted connector projection without including unselected endpoint pixels", async () => {
    const start = shape("start", { fill: "#00ff00", stroke: "#00ff00", x: 0 });
    const end = shape("end", { fill: "#ff0000", stroke: "#ff0000", x: 350, y: 70, rotation: Math.PI / 6 });
    const connector: CanvasObject = {
      ...shape("elbow"),
      kind: "connector",
      start: { x: 94, y: 50, objectId: start.id, normalizedAnchor: { x: 1, y: 0.5 } },
      end: { x: 352, y: 122, objectId: end.id, normalizedAnchor: { x: 0, y: 0.5 } },
      routing: { mode: "elbow", kind: "elbow", bend: 0, elbowMidPoint: 0.3, labelPosition: 0.5 },
      label: "",
      color: "#122b99",
      direction: "end",
    };
    const room = snapshot(start, end, connector);
    const result = await renderTargetedCanvasPng(room, targets(connector));
    const reference = renderSemanticSceneSvg(buildSemanticScene({ ...room, diagrams: {} }), [connector.id], { padding: 24 });
    expect((await pixels(result.bytes)).data).toEqual((await pixels(await sharp(Buffer.from(reference.svg)).png().toBuffer())).data);
    expect(result.metadata.objectRevisions).toEqual([{ objectId: connector.id, revision: 1 }]);
  });

  it("resolves exact groups at their room revision without adding neighboring groups", async () => {
    const first = shape("folded-hands", { groupId: "portrait", revision: 4 });
    const second = shape("face", { groupId: "portrait", revision: 2, x: 30, y: -40 });
    const other = shape("landscape", { groupId: "unrelated", x: 50 });
    const room = snapshot(first, second, other);
    const result = await renderTargetedCanvasPng(room, {
      scope: { kind: "group", groupId: "portrait", expectedRoomRevision: 5 },
    });
    expect(result.bytes).toEqual((await renderTargetedCanvasPng(room, targets(first, second))).bytes);
    expect(result.metadata.objectRevisions).toEqual([{ objectId: second.id, revision: 2 }, { objectId: first.id, revision: 4 }]);
    await expect(renderTargetedCanvasPng(room, {
      scope: { kind: "group", groupId: "portrait", expectedRoomRevision: 4 },
    })).rejects.toMatchObject({ code: "REVISION_MISMATCH" });
    await expect(renderTargetedCanvasPng(room, {
      scope: { kind: "group", groupId: "absent", expectedRoomRevision: 5 },
    })).rejects.toMatchObject({ code: "TARGET_NOT_FOUND" });
  });

  it("fails closed for invalid, duplicate, stale, cross-room and inherited-property targets", async () => {
    const local = shape("local", { revision: 8 });
    const foreign = shape("foreign");
    const room = snapshot(local);
    const wrongType = { scope: { kind: "room" } } as unknown as TargetedCanvasPngInput;
    await expect(renderTargetedCanvasPng(room, wrongType)).rejects.toMatchObject({ code: "INVALID_SCOPE" });
    await expect(renderTargetedCanvasPng(room, targets())).rejects.toMatchObject({ code: "INVALID_SCOPE" });
    await expect(renderTargetedCanvasPng(room, targets(local, local))).rejects.toMatchObject({ code: "INVALID_SCOPE" });
    await expect(renderTargetedCanvasPng(room, targets({ ...local, revision: 7 }))).rejects.toMatchObject({ code: "REVISION_MISMATCH" });
    await expect(renderTargetedCanvasPng(room, targets(local, foreign))).rejects.toMatchObject({ code: "TARGET_NOT_FOUND" });
    await expect(renderTargetedCanvasPng(room, targets(shape("toString")))).rejects.toMatchObject({ code: "TARGET_NOT_FOUND" });
  });

  it("does not fetch assets and fails rather than substituting a placeholder", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const image: CanvasObject = {
      ...shape("remote-image"),
      kind: "image",
      url: "https://example.invalid/private-art.png",
      sourceUrl: null,
      assetId: null,
      alt: "Private art",
      mimeType: "image/png",
      locked: true,
    };
    const local = shape("native");
    const room = snapshot(image, local);
    await expect(renderTargetedCanvasPng(room, targets(image))).rejects.toMatchObject({ code: "UNSUPPORTED_CONTENT" });
    expect((await renderTargetedCanvasPng(room, targets(local))).metadata.objectRevisions).toEqual([{ objectId: local.id, revision: 1 }]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("renders bounded text as text, rejects invalid render attributes, and reports font fallback", async () => {
    const text: CanvasObject = {
      ...shape("untrusted-label", { width: 500, height: 100 }),
      kind: "text",
      content: '<image href="https://example.invalid/image"/><script>not artwork</script>',
      color: "black",
      size: "m",
      align: "start",
    };
    const result = await renderTargetedCanvasPng(snapshot(text), targets(text));
    expect(result.metadata.warnings).toEqual(["Text uses server fonts; glyphs can differ from the browser canvas."]);
    expect((await pixels(result.bytes)).data.some((value) => value < 100)).toBe(true);
    const corrupt = { ...text, align: 'start" onclick="ignored' } as unknown as CanvasObject;
    await expect(renderTargetedCanvasPng(snapshot(corrupt), targets(corrupt))).rejects.toMatchObject({ code: "RENDER_FAILED" });
  });

  it("bounds target count, group scans, geometry, padding and output dimensions", async () => {
    const many = Array.from({ length: TARGETED_PNG_LIMITS.maxTargets + 1 }, (_, i) => shape("object-" + i, { groupId: "big" }));
    await expect(renderTargetedCanvasPng(snapshot(...many), targets(...many))).rejects.toMatchObject({ code: "RENDER_LIMIT" });
    await expect(renderTargetedCanvasPng(snapshot(...many), {
      scope: { kind: "group", groupId: "big", expectedRoomRevision: 5 },
    })).rejects.toMatchObject({ code: "RENDER_LIMIT" });
    const room = snapshot(...Array.from({ length: TARGETED_PNG_LIMITS.maxGroupScan + 1 }, (_, i) => shape("object-" + i)));
    await expect(renderTargetedCanvasPng(room, {
      scope: { kind: "group", groupId: "not-present", expectedRoomRevision: 5 },
    })).rejects.toMatchObject({ code: "RENDER_LIMIT" });
    const point = { x: 0, y: 1 };
    const dense: CanvasObject = {
      ...shape("ink-a"),
      kind: "draw",
      points: Array.from({ length: 17_000 }, () => point),
      color: "blue",
      size: "m",
    };
    const denseB = { ...dense, id: "ink-b" };
    await expect(renderTargetedCanvasPng(snapshot(dense, denseB), targets(dense, denseB))).rejects.toMatchObject({ code: "RENDER_LIMIT" });
    const huge = shape("huge", { width: 50_000, height: 50_000 });
    await expect(renderTargetedCanvasPng(snapshot(huge), { ...targets(huge), padding: 129 })).rejects.toMatchObject({ code: "INVALID_SCOPE" });
    const scaled = await renderTargetedCanvasPng(snapshot(huge), targets(huge));
    expect(scaled.metadata.width).toBeLessThanOrEqual(TARGETED_PNG_LIMITS.maxDimension);
    expect(scaled.metadata.height).toBeLessThanOrEqual(TARGETED_PNG_LIMITS.maxDimension);
    expect(scaled.metadata.byteLength).toBeLessThanOrEqual(TARGETED_PNG_LIMITS.maxPngBytes);
    expect(scaled.metadata.warnings).toContain("The selection was downscaled to fit the image budget.");
  });

  it("bounds in-flight renders without retaining an admission slot after failure", async () => {
    const local = shape("local");
    const room = snapshot(local);
    const first = renderTargetedCanvasPng(room, targets(local));
    const second = renderTargetedCanvasPng(room, targets(local));
    await expect(renderTargetedCanvasPng(room, targets(local))).rejects.toMatchObject({ code: "RENDER_BUSY" });
    await Promise.all([first, second]);
    await expect(renderTargetedCanvasPng(room, targets(shape("absent")))).rejects.toMatchObject({ code: "TARGET_NOT_FOUND" });
    await expect(renderTargetedCanvasPng(room, targets(local))).resolves.toHaveProperty("metadata.width");
  });
});
