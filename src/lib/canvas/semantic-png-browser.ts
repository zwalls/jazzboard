import { parseRoomAssetProxyReference } from "@/lib/assets/policy";
import type { ImageObject } from "@/lib/domain/types";

import type { SemanticScene } from "./semantic-scene";
import { SEMANTIC_DRAW_FONT_URL } from "./semantic-visual-style";
import {
  SEMANTIC_PNG_LIMITS,
  SemanticPngRenderError,
  renderSemanticSceneSvg,
  type SemanticImageWarningCode,
  type SemanticPngWarning,
  type SemanticSvgImage,
  type SemanticSvgRenderOptions,
} from "./semantic-png-svg";

export type SemanticPngRenderOptions = Omit<SemanticSvgRenderOptions, "images" | "fontDataUrl"> &
  Readonly<{
    signal?: AbortSignal;
    maxBytes?: number;
  }>;

export type SemanticPngRenderResult = Readonly<{
  blob: Blob;
  logicalWidth: number;
  logicalHeight: number;
  width: number;
  height: number;
  bounds: { x: number; y: number; width: number; height: number };
  warnings: readonly SemanticPngWarning[];
}>;

export type SemanticPngBrowserDependencies = Readonly<{
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
  createObjectUrl?: (blob: Blob) => string;
  revokeObjectUrl?: (url: string) => void;
  loadImage?: (url: string, signal: AbortSignal) => Promise<CanvasImageSource>;
  createCanvas?: (width: number, height: number) => HTMLCanvasElement;
  /** Tests/adapters may provide a validated font URL directly or null to disable embedding. */
  fontDataUrl?: string | null;
}>;

type BrowserEnvironment = Required<
  Omit<SemanticPngBrowserDependencies, "fetch" | "baseUrl" | "fontDataUrl">
> & Pick<SemanticPngBrowserDependencies, "fetch" | "baseUrl">;

class ImageResolutionError extends Error {
  constructor(public readonly code: SemanticImageWarningCode) {
    super(code);
    this.name = "ImageResolutionError";
  }
}

const IMAGE_MIME_TYPES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);

function abortError(): DOMException {
  return new DOMException("The semantic PNG render was cancelled.", "AbortError");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (
    typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    error.name === "AbortError"
  );
}

function isSecurityError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "name" in error &&
    error.name === "SecurityError",
  );
}

function safelyRevokeObjectUrl(environment: BrowserEnvironment, url: string): void {
  try {
    environment.revokeObjectUrl(url);
  } catch {
    // Revocation is best-effort cleanup and must not replace the render result.
  }
}

function defaultLoadImage(url: string, signal: AbortSignal): Promise<CanvasImageSource> {
  if (typeof Image === "undefined") {
    return Promise.reject(
      new SemanticPngRenderError(
        "BROWSER_RASTERIZER_UNAVAILABLE",
        "This browser does not expose an image decoder for semantic PNG rendering.",
      ),
    );
  }
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const image = new Image();
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      image.onload = null;
      image.onerror = null;
      action();
    };
    const onAbort = () => finish(() => {
      image.src = "";
      reject(abortError());
    });
    image.onload = () => finish(() => resolve(image));
    image.onerror = () => finish(() => reject(new Error("Browser image decode failed.")));
    signal.addEventListener("abort", onAbort, { once: true });
    image.src = url;
  });
}

function browserEnvironment(
  dependencies: SemanticPngBrowserDependencies,
): BrowserEnvironment {
  // Browser host functions are not guaranteed to tolerate an arbitrary
  // receiver. Keeping `window.fetch` as a property on our environment object
  // and later calling `environment.fetch(...)` invokes it with the
  // environment as `this`; Chromium rejects that before issuing a request.
  // Bind only the ambient host function. Injected fetch implementations keep
  // their original calling contract for deterministic tests and adapters.
  const ambientFetch = typeof globalThis.fetch === "function"
    ? globalThis.fetch.bind(globalThis)
    : undefined;
  const createObjectUrl = dependencies.createObjectUrl ?? (
    typeof URL !== "undefined" && typeof URL.createObjectURL === "function"
      ? URL.createObjectURL.bind(URL)
      : undefined
  );
  const revokeObjectUrl = dependencies.revokeObjectUrl ?? (
    typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function"
      ? URL.revokeObjectURL.bind(URL)
      : undefined
  );
  const createCanvas = dependencies.createCanvas ?? (
    typeof document !== "undefined"
      ? (width: number, height: number) => {
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          return canvas;
        }
      : undefined
  );
  if (!createObjectUrl || !revokeObjectUrl || !createCanvas) {
    throw new SemanticPngRenderError(
      "BROWSER_RASTERIZER_UNAVAILABLE",
      "This browser does not expose the local Blob and canvas APIs required for semantic PNG rendering.",
    );
  }
  return {
    fetch: dependencies.fetch ?? ambientFetch,
    baseUrl: dependencies.baseUrl ?? globalThis.location?.href,
    createObjectUrl,
    revokeObjectUrl,
    loadImage: dependencies.loadImage ?? defaultLoadImage,
    createCanvas,
  };
}

function normalizeMimeType(value: string | null | undefined): string {
  const type = value?.split(";", 1)[0].trim().toLowerCase() ?? "";
  return type === "image/jpg" ? "image/jpeg" : type;
}

function rasterSignatureMatches(mimeType: string, bytes: Uint8Array): boolean {
  const ascii = (start: number, length: number) =>
    Array.from(bytes.slice(start, start + length), (value) => String.fromCharCode(value)).join("");
  if (mimeType === "image/png") {
    return [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
  }
  if (mimeType === "image/jpeg") return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mimeType === "image/gif") return ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a";
  if (mimeType === "image/webp") return ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP";
  return false;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}

async function readBoundedResponse(
  response: Response,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > SEMANTIC_PNG_LIMITS.maxSourceImageBytes
  ) {
    throw new ImageResolutionError("IMAGE_SOURCE_TOO_LARGE");
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    throwIfAborted(signal);
    if (bytes.byteLength > SEMANTIC_PNG_LIMITS.maxSourceImageBytes) {
      throw new ImageResolutionError("IMAGE_SOURCE_TOO_LARGE");
    }
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      throwIfAborted(signal);
      const result = await reader.read();
      if (result.done) break;
      byteLength += result.value.byteLength;
      if (byteLength > SEMANTIC_PNG_LIMITS.maxSourceImageBytes) {
        await reader.cancel();
        throw new ImageResolutionError("IMAGE_SOURCE_TOO_LARGE");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function authorizedUrl(
  object: ImageObject,
  roomId: string,
  baseUrl: string | undefined,
): URL {
  const reference = parseRoomAssetProxyReference(object.url);
  if (reference && reference.roomId !== roomId) {
    throw new ImageResolutionError("IMAGE_ROOM_MISMATCH");
  }
  let parsed: URL;
  try {
    parsed = new URL(object.url, baseUrl);
  } catch {
    throw new ImageResolutionError("IMAGE_URL_INVALID");
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username ||
    parsed.password
  ) {
    throw new ImageResolutionError("IMAGE_URL_INVALID");
  }
  if (reference && baseUrl) {
    try {
      if (parsed.origin !== new URL(baseUrl).origin) {
        throw new ImageResolutionError("IMAGE_URL_INVALID");
      }
    } catch (error) {
      if (error instanceof ImageResolutionError) throw error;
      throw new ImageResolutionError("IMAGE_URL_INVALID");
    }
  }
  parsed.hash = "";
  return parsed;
}

async function decodeFetchedImage(
  bytes: Uint8Array,
  mimeType: string,
  environment: BrowserEnvironment,
  signal: AbortSignal,
): Promise<void> {
  const blob = new Blob([new Uint8Array(bytes).buffer], { type: mimeType });
  let url: string;
  try {
    url = environment.createObjectUrl(blob);
  } catch {
    throw new ImageResolutionError("IMAGE_CONTENT_INVALID");
  }
  try {
    await environment.loadImage(url, signal);
  } catch (error) {
    if (isAbort(error, signal)) throw abortError();
    throw new ImageResolutionError("IMAGE_CONTENT_INVALID");
  } finally {
    safelyRevokeObjectUrl(environment, url);
  }
}

async function fetchImage(
  object: ImageObject,
  scene: SemanticScene,
  environment: BrowserEnvironment,
  signal: AbortSignal,
): Promise<{ image: SemanticSvgImage; byteLength: number }> {
  try {
    throwIfAborted(signal);
    const url = authorizedUrl(object, scene.roomId, environment.baseUrl);
    if (!environment.fetch) throw new ImageResolutionError("IMAGE_FETCH_FAILED");
    let response: Response;
    try {
      response = await environment.fetch(url.href, {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        mode: "cors",
        redirect: "follow",
        referrerPolicy: "no-referrer",
        signal,
      });
    } catch (error) {
      if (isAbort(error, signal)) throw abortError();
      throw new ImageResolutionError("IMAGE_FETCH_FAILED");
    }
    if (!response.ok || response.type === "opaque") {
      throw new ImageResolutionError("IMAGE_RESPONSE_INVALID");
    }
    const mimeType = normalizeMimeType(
      response.headers.get("content-type") || object.mimeType,
    );
    if (!IMAGE_MIME_TYPES.has(mimeType)) {
      throw new ImageResolutionError("IMAGE_TYPE_UNSUPPORTED");
    }
    const bytes = await readBoundedResponse(response, signal);
    if (!rasterSignatureMatches(mimeType, bytes)) {
      throw new ImageResolutionError("IMAGE_CONTENT_INVALID");
    }
    await decodeFetchedImage(bytes, mimeType, environment, signal);
    return {
      image: { kind: "embedded", dataUrl: `data:${mimeType};base64,${bytesToBase64(bytes)}` },
      byteLength: bytes.byteLength,
    };
  } catch (error) {
    if (isAbort(error, signal)) throw abortError();
    const code = error instanceof ImageResolutionError ? error.code : "IMAGE_FETCH_FAILED";
    return { image: { kind: "unavailable", code }, byteLength: 0 };
  }
}

async function resolveImages(
  scene: SemanticScene,
  objectIds: readonly string[],
  environment: BrowserEnvironment,
  signal: AbortSignal,
): Promise<Record<string, SemanticSvgImage>> {
  const images = Object.create(null) as Record<string, SemanticSvgImage>;
  let embeddedBytes = 0;
  for (const objectId of objectIds) {
    const object = scene.objectsById[objectId].object;
    if (object.kind !== "image") continue;
    const resolved = await fetchImage(object, scene, environment, signal);
    if (
      resolved.image.kind === "embedded" &&
      embeddedBytes + resolved.byteLength > SEMANTIC_PNG_LIMITS.maxEmbeddedImageBytes
    ) {
      images[object.id] = { kind: "unavailable", code: "IMAGE_TOTAL_BUDGET_EXCEEDED" };
      continue;
    }
    images[object.id] = resolved.image;
    embeddedBytes += resolved.byteLength;
  }
  return images;
}

function selectionNeedsDrawFont(
  scene: SemanticScene,
  objectIds: readonly string[],
  images: Readonly<Record<string, SemanticSvgImage>>,
): boolean {
  return objectIds.some((objectId) => {
    const object = scene.objectsById[objectId].object;
    if (object.kind === "text") return Boolean(object.content.trim());
    if (object.kind === "shape" || object.kind === "connector") return Boolean(object.label.trim());
    if (object.kind === "image") return images[object.id]?.kind !== "embedded";
    return false;
  });
}

async function readBoundedFont(
  response: Response,
  signal: AbortSignal,
): Promise<Uint8Array | null> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > SEMANTIC_PNG_LIMITS.maxFontBytes
  ) return null;
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    throwIfAborted(signal);
    return bytes.byteLength <= SEMANTIC_PNG_LIMITS.maxFontBytes ? bytes : null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      throwIfAborted(signal);
      const result = await reader.read();
      if (result.done) break;
      byteLength += result.value.byteLength;
      if (byteLength > SEMANTIC_PNG_LIMITS.maxFontBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function resolveDrawFont(
  environment: BrowserEnvironment,
  signal: AbortSignal,
): Promise<string | undefined> {
  if (!environment.fetch || !environment.baseUrl) return undefined;
  let url: URL;
  try {
    url = new URL(SEMANTIC_DRAW_FONT_URL, environment.baseUrl);
    if (url.origin !== new URL(environment.baseUrl).origin) return undefined;
  } catch {
    return undefined;
  }
  try {
    const response = await environment.fetch(url.href, {
      method: "GET",
      credentials: "same-origin",
      cache: "force-cache",
      mode: "same-origin",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal,
    });
    if (!response.ok || response.type === "opaque") return undefined;
    const mimeType = normalizeMimeType(response.headers.get("content-type"));
    if (
      mimeType &&
      mimeType !== "font/woff2" &&
      mimeType !== "application/font-woff2" &&
      mimeType !== "application/octet-stream"
    ) return undefined;
    const bytes = await readBoundedFont(response, signal);
    if (
      !bytes ||
      bytes.length < 4 ||
      bytes[0] !== 0x77 ||
      bytes[1] !== 0x4f ||
      bytes[2] !== 0x46 ||
      bytes[3] !== 0x32
    ) return undefined;
    return `data:font/woff2;base64,${bytesToBase64(bytes)}`;
  } catch (error) {
    if (isAbort(error, signal)) throw abortError();
    return undefined;
  }
}

function pngBlob(
  canvas: HTMLCanvasElement,
  signal: AbortSignal,
): Promise<Blob> {
  if (typeof canvas.toBlob !== "function") {
    return Promise.reject(
      new SemanticPngRenderError(
        "BROWSER_RASTERIZER_UNAVAILABLE",
        "This browser cannot encode a canvas as PNG.",
      ),
    );
  }
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      action();
    };
    const onAbort = () => finish(() => reject(abortError()));
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      canvas.toBlob((blob) => finish(() => {
        if (!blob) {
          reject(new SemanticPngRenderError(
            "PNG_ENCODING_FAILED",
            "The browser returned no PNG bytes for the semantic canvas.",
          ));
          return;
        }
        resolve(blob);
      }), "image/png");
    } catch (error) {
      finish(() => reject(
        isSecurityError(error)
          ? new SemanticPngRenderError(
              "CANVAS_SECURITY_ERROR",
              "The browser blocked PNG encoding because the canvas was not origin-clean.",
            )
          : new SemanticPngRenderError(
              "PNG_ENCODING_FAILED",
              "The browser could not encode the semantic canvas as PNG.",
            ),
      ));
    }
  });
}

/**
 * Browser-only local rasterization. Authorized image URLs are fetched with
 * credentials limited to same-origin, decoded, embedded in-memory, and then
 * discarded with the ephemeral SVG. No render bytes are uploaded or stored.
 */
export async function renderSemanticScenePng(
  scene: SemanticScene,
  objectIds: readonly string[],
  options: SemanticPngRenderOptions = {},
  dependencies: SemanticPngBrowserDependencies = {},
): Promise<SemanticPngRenderResult> {
  const signal = options.signal ?? new AbortController().signal;
  const maxBytes = options.maxBytes ?? SEMANTIC_PNG_LIMITS.maxOutputBytes;
  if (
    !Number.isInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > SEMANTIC_PNG_LIMITS.maxOutputBytes
  ) {
    throw new SemanticPngRenderError(
      "RENDER_OPTIONS_INVALID",
      "Semantic PNG byte limits exceed the supported safety bounds.",
    );
  }
  throwIfAborted(signal);
  const svgOptions: SemanticSvgRenderOptions = options;
  const preflight = renderSemanticSceneSvg(scene, objectIds, svgOptions);
  const environment = browserEnvironment(dependencies);
  const images = await resolveImages(scene, preflight.objectIds, environment, signal);
  throwIfAborted(signal);
  const fontDataUrl = dependencies.fontDataUrl === null ||
    !selectionNeedsDrawFont(scene, preflight.objectIds, images)
    ? undefined
    : dependencies.fontDataUrl ?? await resolveDrawFont(environment, signal);
  throwIfAborted(signal);
  const rendered = renderSemanticSceneSvg(scene, preflight.objectIds, {
    ...svgOptions,
    images,
    fontDataUrl,
  });

  const svgBlob = new Blob([rendered.svg], { type: "image/svg+xml;charset=utf-8" });
  let svgUrl: string;
  try {
    svgUrl = environment.createObjectUrl(svgBlob);
  } catch (error) {
    throw new SemanticPngRenderError(
      isSecurityError(error) ? "CANVAS_SECURITY_ERROR" : "SVG_RASTERIZATION_FAILED",
      "The browser could not create the ephemeral semantic SVG image.",
    );
  }
  try {
    let image: CanvasImageSource;
    try {
      image = await environment.loadImage(svgUrl, signal);
    } catch (error) {
      if (isAbort(error, signal)) throw abortError();
      throw new SemanticPngRenderError(
        isSecurityError(error) ? "CANVAS_SECURITY_ERROR" : "SVG_RASTERIZATION_FAILED",
        "The browser could not decode the safe semantic SVG for rasterization.",
      );
    }
    throwIfAborted(signal);
    let canvas: HTMLCanvasElement;
    try {
      canvas = environment.createCanvas(rendered.pixelWidth, rendered.pixelHeight);
      canvas.width = rendered.pixelWidth;
      canvas.height = rendered.pixelHeight;
    } catch (error) {
      throw new SemanticPngRenderError(
        isSecurityError(error) ? "CANVAS_SECURITY_ERROR" : "BROWSER_RASTERIZER_UNAVAILABLE",
        "The browser could not allocate the bounded semantic PNG canvas.",
      );
    }
    let context: CanvasRenderingContext2D | null;
    try {
      context = canvas.getContext("2d");
    } catch (error) {
      throw new SemanticPngRenderError(
        isSecurityError(error) ? "CANVAS_SECURITY_ERROR" : "CANVAS_CONTEXT_UNAVAILABLE",
        "The browser could not create a 2D canvas for semantic PNG rendering.",
      );
    }
    if (!context) {
      throw new SemanticPngRenderError(
        "CANVAS_CONTEXT_UNAVAILABLE",
        "The browser could not create a 2D canvas for semantic PNG rendering.",
      );
    }
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    try {
      context.drawImage(image, 0, 0, rendered.pixelWidth, rendered.pixelHeight);
    } catch (error) {
      throw new SemanticPngRenderError(
        isSecurityError(error) ? "CANVAS_SECURITY_ERROR" : "SVG_RASTERIZATION_FAILED",
        isSecurityError(error)
          ? "The browser blocked semantic PNG rendering because the canvas was tainted."
          : "The browser could not draw the semantic SVG into the PNG canvas.",
      );
    }
    throwIfAborted(signal);
    const blob = await pngBlob(canvas, signal);
    throwIfAborted(signal);
    if (!blob.size || (blob.type && blob.type !== "image/png")) {
      throw new SemanticPngRenderError(
        "PNG_ENCODING_FAILED",
        "The browser returned a non-PNG image from semantic rasterization.",
      );
    }
    if (blob.size > maxBytes) {
      throw new SemanticPngRenderError(
        "PNG_BYTE_BUDGET_EXCEEDED",
        "The rendered semantic PNG exceeded its byte budget and was discarded.",
        { byteLength: blob.size, maxBytes },
      );
    }
    return {
      blob,
      logicalWidth: rendered.logicalWidth,
      logicalHeight: rendered.logicalHeight,
      width: rendered.pixelWidth,
      height: rendered.pixelHeight,
      bounds: rendered.bounds,
      warnings: rendered.warnings,
    };
  } finally {
    safelyRevokeObjectUrl(environment, svgUrl);
  }
}
