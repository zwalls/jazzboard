import { afterEach, describe, expect, it, vi } from "vitest";

import type { ActorRef, CanvasObject } from "@/lib/domain/types";

import { buildSemanticScene, type SemanticScene } from "./semantic-scene";
import {
  renderSemanticScenePng,
  type SemanticPngBrowserDependencies,
} from "./semantic-png-browser";
import { SemanticPngRenderError } from "./semantic-png-svg";

const actor: ActorRef = {
  participantId: "participant-1",
  displayName: "Ada",
  color: "#5965e8",
  kind: "human",
};
const pngPrefix = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function base(id: string, zIndex: number, x: number, y: number, width: number, height: number) {
  return {
    id,
    x,
    y,
    width,
    height,
    rotation: 0,
    zIndex,
    revision: 1,
    groupId: null,
    diagramIds: [],
    createdAt: 1,
    updatedAt: 1,
    createdBy: actor,
    lastEditedBy: actor,
  };
}

function scene(imageUrl = "/api/rooms/room-1/assets?assetId=private"): SemanticScene {
  const objects: CanvasObject[] = [
    {
      ...base("text", 1, 0, 0, 100, 40),
      kind: "text",
      content: "Local preview",
      color: "black",
      size: "m",
      align: "start",
    },
    {
      ...base("image", 2, 120, 0, 80, 60),
      kind: "image",
      url: imageUrl,
      assetId: "private",
      alt: "Private screenshot",
      mimeType: "image/png",
      sourceUrl: null,
      locked: false,
    },
  ];
  return buildSemanticScene({
    id: "room-1",
    roomRevision: 4,
    objects: Object.fromEntries(objects.map((object) => [object.id, object])),
    diagrams: {},
  });
}

function browserFixture(options: {
  response?: Response;
  png?: Blob;
  drawError?: unknown;
  encodeError?: unknown;
} = {}) {
  const blobs: Blob[] = [];
  const revoked: string[] = [];
  const drawImage = vi.fn(() => {
    if (options.drawError) throw options.drawError;
  });
  const context = {
    drawImage,
    imageSmoothingEnabled: false,
    imageSmoothingQuality: "low",
  } as unknown as CanvasRenderingContext2D;
  const output = options.png ?? new Blob(["png"], { type: "image/png" });
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => context),
    toBlob: vi.fn((callback: BlobCallback) => {
      if (options.encodeError) throw options.encodeError;
      callback(output);
    }),
  } as unknown as HTMLCanvasElement;
  const fetch = vi.fn(async () => options.response ?? new Response(pngPrefix, {
    status: 200,
    headers: { "content-type": "image/png" },
  }));
  const loadImage = vi.fn(async () => ({} as CanvasImageSource));
  const dependencies: SemanticPngBrowserDependencies = {
    fetch: fetch as unknown as typeof globalThis.fetch,
    baseUrl: "https://jazzboard.test/rooms/room-1",
    fontDataUrl: null,
    createObjectUrl(blob) {
      blobs.push(blob);
      return `blob:test-${blobs.length}`;
    },
    revokeObjectUrl(url) {
      revoked.push(url);
    },
    loadImage,
    createCanvas: vi.fn(() => canvas),
  };
  return { dependencies, fetch, loadImage, canvas, context, drawImage, blobs, revoked, output };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error("Expected rendering to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(SemanticPngRenderError);
    expect((error as SemanticPngRenderError).code).toBe(code);
  }
}

function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

describe("semantic PNG browser rasterization", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preserves the browser receiver when using ambient fetch for a private asset", async () => {
    const fixture = browserFixture();
    const ambientFetch = vi.fn(function (this: typeof globalThis) {
      if (this !== globalThis) {
        return Promise.reject(new TypeError("Illegal invocation"));
      }
      return Promise.resolve(new Response(pngPrefix, {
        status: 200,
        headers: { "content-type": "image/png" },
      }));
    });
    vi.stubGlobal("fetch", ambientFetch);

    const result = await renderSemanticScenePng(
      scene(),
      ["image"],
      { padding: 0 },
      { ...fixture.dependencies, fetch: undefined },
    );

    expect(ambientFetch).toHaveBeenCalledOnce();
    expect(result.warnings).toEqual([]);
    const svg = await readBlob(fixture.blobs[1]);
    expect(svg).toContain('href="data:image/png;base64,iVBORw0KGgo="');
  });

  it("fetches authorized image pixels into an ephemeral data URL and returns a bounded PNG", async () => {
    const fixture = browserFixture();
    const result = await renderSemanticScenePng(
      scene(),
      ["image", "text"],
      { padding: 10, pixelRatio: 2, maxBytes: 100 },
      fixture.dependencies,
    );

    expect(fixture.fetch).toHaveBeenCalledWith(
      "https://jazzboard.test/api/rooms/room-1/assets?assetId=private",
      expect.objectContaining({
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        mode: "cors",
        referrerPolicy: "no-referrer",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(result).toMatchObject({
      blob: fixture.output,
      logicalWidth: 220,
      logicalHeight: 80,
      width: 440,
      height: 160,
      bounds: { x: -10, y: -10, width: 220, height: 80 },
      warnings: [],
    });
    expect(fixture.loadImage).toHaveBeenCalledTimes(2);
    expect(fixture.canvas.width).toBe(440);
    expect(fixture.canvas.height).toBe(160);
    expect(fixture.drawImage).toHaveBeenCalledWith({}, 0, 0, 440, 160);
    expect(fixture.revoked).toEqual(["blob:test-1", "blob:test-2"]);
    const svg = await readBlob(fixture.blobs[1]);
    expect(svg).toContain('href="data:image/png;base64,iVBORw0KGgo="');
    expect(svg).not.toContain("/api/rooms/room-1/assets");
    expect(svg).not.toMatch(/href="https?:/i);
  });

  it("fetches the same-origin draw font with cache-safe restrictions and embeds it ephemerally", async () => {
    const woff2 = new Uint8Array([0x77, 0x4f, 0x46, 0x32]);
    const fixture = browserFixture({
      response: new Response(woff2, {
        status: 200,
        headers: {
          "content-type": "font/woff2",
          "content-length": String(woff2.byteLength),
        },
      }),
    });

    await renderSemanticScenePng(
      scene(),
      ["text"],
      { padding: 0 },
      { ...fixture.dependencies, fontDataUrl: undefined },
    );

    expect(fixture.fetch).toHaveBeenCalledOnce();
    expect(fixture.fetch).toHaveBeenCalledWith(
      "https://jazzboard.test/fonts/shantell-sans-latin-400-normal.woff2",
      expect.objectContaining({
        method: "GET",
        credentials: "same-origin",
        cache: "force-cache",
        mode: "same-origin",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: expect.any(AbortSignal),
      }),
    );
    const svg = await readBlob(fixture.blobs[0]);
    expect(svg).toContain(
      "@font-face{font-family:'Shantell Sans';font-style:normal;font-weight:400;" +
      "src:url('data:font/woff2;base64,d09GMg==') format('woff2')}",
    );
    expect(svg).not.toContain("https://jazzboard.test/fonts/");
    expect(fixture.revoked).toEqual(["blob:test-1"]);
  });

  it("renders image fetch failures as deterministic warnings and placeholders", async () => {
    const fixture = browserFixture({ response: new Response("denied", { status: 403 }) });
    const result = await renderSemanticScenePng(
      scene(),
      ["image"],
      { padding: 0 },
      fixture.dependencies,
    );

    expect(result.warnings).toMatchObject([
      { code: "IMAGE_RESPONSE_INVALID", objectId: "image" },
    ]);
    expect(fixture.loadImage).toHaveBeenCalledOnce();
    const svg = await readBlob(fixture.blobs[0]);
    expect(svg).not.toContain("<image");
    expect(svg).toContain('stroke-dasharray="8 6"');
  });

  it("does not fetch a private asset reference for a different room", async () => {
    const fixture = browserFixture();
    const result = await renderSemanticScenePng(
      scene("/api/rooms/room-2/assets?assetId=private"),
      ["image"],
      {},
      fixture.dependencies,
    );

    expect(fixture.fetch).not.toHaveBeenCalled();
    expect(result.warnings).toMatchObject([
      { code: "IMAGE_ROOM_MISMATCH", objectId: "image" },
    ]);
  });

  it("honors aborts before allocating or fetching", async () => {
    const fixture = browserFixture();
    const controller = new AbortController();
    controller.abort();

    await expect(
      renderSemanticScenePng(
        scene(),
        ["image"],
        { signal: controller.signal },
        fixture.dependencies,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fixture.fetch).not.toHaveBeenCalled();
    expect(fixture.blobs).toEqual([]);
  });

  it("rejects excessive dimensions before image I/O", async () => {
    const fixture = browserFixture();
    await expectCode(
      renderSemanticScenePng(
        scene(),
        ["image"],
        { pixelRatio: 2, maxWidth: 100 },
        fixture.dependencies,
      ),
      "DIMENSION_BUDGET_EXCEEDED",
    );
    expect(fixture.fetch).not.toHaveBeenCalled();
  });

  it("reports canvas taint/security failures explicitly and revokes ephemeral URLs", async () => {
    const fixture = browserFixture({
      drawError: new DOMException("Tainted", "SecurityError"),
    });
    await expectCode(
      renderSemanticScenePng(scene(), ["text"], {}, fixture.dependencies),
      "CANVAS_SECURITY_ERROR",
    );
    expect(fixture.revoked).toEqual(["blob:test-1"]);
  });

  it("reports origin-unclean PNG encoding failures explicitly", async () => {
    const fixture = browserFixture({
      encodeError: new DOMException("Tainted", "SecurityError"),
    });
    await expectCode(
      renderSemanticScenePng(scene(), ["text"], {}, fixture.dependencies),
      "CANVAS_SECURITY_ERROR",
    );
    expect(fixture.revoked).toEqual(["blob:test-1"]);
  });

  it("discards PNGs that exceed the output byte budget", async () => {
    const fixture = browserFixture({ png: new Blob(["12345"], { type: "image/png" }) });
    await expectCode(
      renderSemanticScenePng(scene(), ["text"], { maxBytes: 4 }, fixture.dependencies),
      "PNG_BYTE_BUDGET_EXCEEDED",
    );
    expect(fixture.revoked).toEqual(["blob:test-1"]);
  });
});
