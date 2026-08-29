"use client";

import { useSyncExternalStore } from "react";

export const MOBILE_CANVAS_MEDIA_QUERY =
  "(max-width: 720px), (pointer: coarse) and (max-width: 1024px)";

function subscribe(listener: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia(MOBILE_CANVAS_MEDIA_QUERY);
  query.addEventListener?.("change", listener);
  return () => query.removeEventListener?.("change", listener);
}

function snapshot(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia(MOBILE_CANVAS_MEDIA_QUERY).matches;
}

export function useCanvasMobileLayout(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
