import { describe, expect, it } from "vitest";

import {
  getCanvasRendererMode,
  parseCanvasRendererMode,
  resolveCanvasRendererMode,
} from "./renderer-mode";

describe("canvas renderer mode", () => {
  it("parses only supported modes and safely falls back to tldraw", () => {
    expect(parseCanvasRendererMode("tldraw")).toBe("tldraw");
    expect(parseCanvasRendererMode(" semantic ")).toBe("semantic");
    expect(parseCanvasRendererMode("SEMANTIC-EDIT")).toBe("semantic-edit");
    expect(parseCanvasRendererMode("SHADOW")).toBe("shadow");
    expect(parseCanvasRendererMode("future-renderer")).toBe("tldraw");
    expect(parseCanvasRendererMode(undefined)).toBe("tldraw");
  });

  it("exposes the first-party editing canary only to participants", () => {
    expect(resolveCanvasRendererMode("semantic-edit", "participant")).toBe("semantic-edit");
    expect(resolveCanvasRendererMode("semantic-edit", "spectator")).toBe("semantic");
    expect(resolveCanvasRendererMode("semantic-edit", null)).toBe("tldraw");
  });

  it("allows semantic rendering only for a passive spectator", () => {
    expect(resolveCanvasRendererMode("semantic", "spectator")).toBe("semantic");
    expect(resolveCanvasRendererMode("semantic", "participant")).toBe("tldraw");
    expect(resolveCanvasRendererMode("semantic", null)).toBe("tldraw");
    expect(resolveCanvasRendererMode("semantic", undefined)).toBe("tldraw");
  });

  it("allows passive shadow diagnostics for either role while keeping tldraw visible", () => {
    expect(resolveCanvasRendererMode("shadow", "spectator")).toBe("shadow");
    expect(resolveCanvasRendererMode("shadow", "participant")).toBe("shadow");
  });

  it("keeps explicit tldraw mode for every role", () => {
    expect(resolveCanvasRendererMode("tldraw", "participant")).toBe("tldraw");
    expect(resolveCanvasRendererMode("tldraw", "spectator")).toBe("tldraw");
  });

  it("reads the build-time environment flag through the same safety gate", () => {
    const previous = process.env.NEXT_PUBLIC_JAZZBOARD_CANVAS_RENDERER;
    process.env.NEXT_PUBLIC_JAZZBOARD_CANVAS_RENDERER = "semantic";
    try {
      expect(getCanvasRendererMode("spectator")).toBe("semantic");
      expect(getCanvasRendererMode("participant")).toBe("tldraw");
    } finally {
      if (previous === undefined) {
        delete process.env.NEXT_PUBLIC_JAZZBOARD_CANVAS_RENDERER;
      } else {
        process.env.NEXT_PUBLIC_JAZZBOARD_CANVAS_RENDERER = previous;
      }
    }
  });
});
