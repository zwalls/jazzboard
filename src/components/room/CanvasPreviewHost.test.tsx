import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CanvasPreviewArtifact } from "@/lib/webmcp";

import { CanvasPreviewHost, type CanvasPreviewHostHandle } from "./CanvasPreviewHost";

function artifact(label: string): CanvasPreviewArtifact {
  return {
    blob: new Blob([label], { type: "image/png" }),
    metadata: {
      mimeType: "image/png",
      width: 320,
      height: 180,
      logicalWidth: 320,
      logicalHeight: 180,
      byteLength: label.length,
      renderedBounds: { x: 10, y: 20, width: 320, height: 180 },
      padding: 32,
      pixelRatio: 1,
      source: {
        kind: "objects",
        targets: [{ objectId: "object-a", expectedRevision: 3 }],
        roomRevision: 12,
        objectRevisions: [{ objectId: "object-a", revision: 3 }],
      },
      warnings: [],
    },
  };
}

describe("CanvasPreviewHost", () => {
  const createObjectURL = vi.fn<(blob: Blob) => string>();
  const revokeObjectURL = vi.fn<(url: string) => void>();
  let frames: Array<FrameRequestCallback> = [];

  beforeEach(() => {
    createObjectURL.mockReset();
    createObjectURL.mockReturnValueOnce("blob:preview-1").mockReturnValueOnce("blob:preview-2");
    revokeObjectURL.mockReset();
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
    frames = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function flushPaintFrames() {
    while (frames.length) frames.shift()?.(performance.now());
  }

  it("paints one local Blob at a time and returns only its exact viewport clip", async () => {
    const host = createRef<CanvasPreviewHostHandle>();
    const rendered = render(<CanvasPreviewHost ref={host} />);
    const controller = new AbortController();
    let first!: Promise<Awaited<ReturnType<CanvasPreviewHostHandle["present"]>>>;

    act(() => {
      first = host.current!.present(artifact("first"), controller.signal);
    });
    const firstImage = screen.getByRole("img", { name: "Exact rendered Jazzboard canvas preview" });
    vi.spyOn(firstImage, "getBoundingClientRect").mockReturnValue({
      x: 42,
      y: 64,
      width: 320,
      height: 180,
      top: 64,
      left: 42,
      right: 362,
      bottom: 244,
      toJSON: () => ({}),
    });
    fireEvent.load(firstImage);
    act(flushPaintFrames);

    await expect(first).resolves.toMatchObject({
      clip: {
        coordinateSpace: "viewport-css-pixels",
        x: 42,
        y: 64,
        width: 320,
        height: 180,
      },
    });
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));

    let second!: Promise<Awaited<ReturnType<CanvasPreviewHostHandle["present"]>>>;
    act(() => {
      second = host.current!.present(artifact("second"), controller.signal);
    });
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:preview-1");
    const secondImage = screen.getByRole("img", { name: "Exact rendered Jazzboard canvas preview" });
    vi.spyOn(secondImage, "getBoundingClientRect").mockReturnValue({
      x: 12,
      y: 24,
      width: 200,
      height: 100,
      top: 24,
      left: 12,
      right: 212,
      bottom: 124,
      toJSON: () => ({}),
    });
    fireEvent.load(secondImage);
    act(flushPaintFrames);
    await expect(second).resolves.toMatchObject({ previewId: expect.stringMatching(/^preview_/) });

    rendered.unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:preview-2");
  });
});
