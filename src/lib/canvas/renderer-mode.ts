import type { RoomRole } from "@/lib/domain/types";

export const CANVAS_RENDERER_MODE_ENV = "NEXT_PUBLIC_JAZZBOARD_CANVAS_RENDERER";

export type CanvasRendererMode = "tldraw" | "semantic" | "semantic-edit" | "shadow";

/** Parses one untrusted environment value with a production-safe fallback. */
export function parseCanvasRendererMode(value: unknown): CanvasRendererMode {
  if (typeof value !== "string") return "tldraw";
  const normalized = value.trim().toLowerCase();
  return normalized === "semantic" ||
    normalized === "semantic-edit" ||
    normalized === "shadow" ||
    normalized === "tldraw"
    ? normalized
    : "tldraw";
}

/**
 * The passive semantic renderer remains spectator-only under `semantic`.
 * `semantic-edit` is an explicit participant canary; spectators still receive
 * its passive form and therefore never gain mutation affordances. Shadow mode
 * is safe for either role because it keeps tldraw visible.
 */
export function resolveCanvasRendererMode(
  configuredValue: unknown,
  role: RoomRole | null | undefined,
): CanvasRendererMode {
  const configuredMode = parseCanvasRendererMode(configuredValue);
  if (configuredMode === "semantic" && role !== "spectator") return "tldraw";
  if (configuredMode === "semantic-edit") {
    if (role === "participant") return "semantic-edit";
    if (role === "spectator") return "semantic";
    return "tldraw";
  }
  return configuredMode;
}

/** Reads the browser-exposed build-time flag and applies the role safety gate. */
export function getCanvasRendererMode(role: RoomRole | null | undefined): CanvasRendererMode {
  return resolveCanvasRendererMode(process.env.NEXT_PUBLIC_JAZZBOARD_CANVAS_RENDERER, role);
}
