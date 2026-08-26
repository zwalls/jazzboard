export function safeDownloadStem(value: string, fallback = "jazzboard"): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return normalized || fallback;
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function downloadTextFile(input: {
  content: string;
  filename: string;
  mimeType: string;
}): void {
  triggerDownload(new Blob([input.content], { type: `${input.mimeType};charset=utf-8` }), input.filename);
}

export function svgDownloadDimensions(svg: string): { width: number; height: number } {
  const document = new DOMParser().parseFromString(svg, "image/svg+xml");
  if (document.querySelector("parsererror") || document.documentElement.localName !== "svg") {
    throw new Error("The SVG export is not a valid image.");
  }
  const root = document.documentElement;
  const viewBox = root.getAttribute("viewBox")?.trim().split(/[\s,]+/).map(Number);
  if (
    viewBox?.length === 4 &&
    viewBox.every(Number.isFinite) &&
    viewBox[2] > 0 &&
    viewBox[3] > 0
  ) {
    return { width: viewBox[2], height: viewBox[3] };
  }
  const width = Number.parseFloat(root.getAttribute("width") ?? "");
  const height = Number.parseFloat(root.getAttribute("height") ?? "");
  if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
    return { width, height };
  }
  throw new Error("The SVG export does not declare usable dimensions.");
}

export function boundedRasterSize(
  width: number,
  height: number,
  requestedScale = 2,
): { width: number; height: number; scale: number } {
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new Error("PNG dimensions must be finite positive numbers.");
  }
  const scale = Math.min(Math.max(requestedScale, 1), 4);
  const maxSide = 4_096;
  const maxPixels = 16_000_000;
  const boundedScale = Math.min(
    scale,
    maxSide / width,
    maxSide / height,
    Math.sqrt(maxPixels / (width * height)),
  );
  return {
    width: Math.max(1, Math.floor(width * boundedScale)),
    height: Math.max(1, Math.floor(height * boundedScale)),
    scale: boundedScale,
  };
}

export async function downloadPngFromSvg(input: {
  svg: string;
  width: number;
  height: number;
  filename: string;
  scale?: number;
}): Promise<void> {
  const width = Math.max(1, Math.ceil(input.width));
  const height = Math.max(1, Math.ceil(input.height));
  const raster = boundedRasterSize(width, height, input.scale ?? 2);
  const canvas = document.createElement("canvas");
  canvas.width = raster.width;
  canvas.height = raster.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser cannot render a PNG export.");

  const svgUrl = URL.createObjectURL(new Blob([input.svg], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const image = new Image();
    image.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("The SVG export could not be rendered as PNG."));
      image.src = svgUrl;
    });
    context.setTransform(raster.width / width, 0, 0, raster.height / height, 0, 0);
    context.drawImage(image, 0, 0, width, height);
    const png = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("The PNG export could not be encoded."));
      }, "image/png");
    });
    triggerDownload(png, input.filename);
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}
