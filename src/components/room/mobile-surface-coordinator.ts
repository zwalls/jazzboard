export const MOBILE_SURFACE_OPEN_EVENT = "jazzboard:mobile-surface-open";

type MobileSurfaceOpenDetail = Readonly<{ surfaceId: string }>;

export function announceMobileSurfaceOpen(surfaceId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<MobileSurfaceOpenDetail>(MOBILE_SURFACE_OPEN_EVENT, {
    detail: { surfaceId },
  }));
}

export function subscribeToMobileSurfaceOpen(
  listener: (surfaceId: string) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const handle = (event: Event) => {
    const surfaceId = (event as CustomEvent<MobileSurfaceOpenDetail>).detail?.surfaceId;
    if (typeof surfaceId === "string" && surfaceId) listener(surfaceId);
  };
  window.addEventListener(MOBILE_SURFACE_OPEN_EVENT, handle);
  return () => window.removeEventListener(MOBILE_SURFACE_OPEN_EVENT, handle);
}
