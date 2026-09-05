/** One pointer subscription and at most one pending frame for every live Ripple. */
const avatars = new Set<HTMLElement>();
let pointer: { x: number; y: number } | null = null;
let frame: number | null = null;
let reducedMotion: MediaQueryList | null = null;

function reset(element: HTMLElement) {
  element.style.removeProperty("--ripple-gaze-x");
  element.style.removeProperty("--ripple-gaze-y");
  element.removeAttribute("data-ripple-gaze");
}

function update() {
  frame = null;
  if (!pointer || document.hidden || reducedMotion?.matches) {
    avatars.forEach(reset);
    return;
  }
  // Finish geometry reads before writing styles to avoid interleaved layout.
  const positions = Array.from(avatars, (element) => ({ element, box: element.getBoundingClientRect() }));
  for (const { element, box } of positions) {
    const dx = pointer.x - (box.x + box.width / 2);
    const dy = pointer.y - (box.y + box.height / 2);
    const distance = Math.hypot(dx, dy);
    if (box.width < 40 || distance > 160 || box.width === 0) {
      reset(element);
      continue;
    }
    const offset = Math.min(box.width * 0.018, 2);
    const divisor = Math.max(distance, 24);
    element.style.setProperty("--ripple-gaze-x", `${(dx / divisor * offset).toFixed(2)}px`);
    element.style.setProperty("--ripple-gaze-y", `${(dy / divisor * offset).toFixed(2)}px`);
    element.setAttribute("data-ripple-gaze", "true");
  }
}

function schedule() {
  if (frame === null) frame = window.requestAnimationFrame(update);
}

function onPointer(event: PointerEvent) {
  if (event.pointerType === "touch") return;
  pointer = { x: event.clientX, y: event.clientY };
  schedule();
}

function clear() {
  pointer = null;
  if (frame !== null) window.cancelAnimationFrame(frame);
  frame = null;
  avatars.forEach(reset);
}

function onVisibility() {
  if (document.hidden) clear();
}

/** Register only animated avatars. Returns a cleanup that releases shared listeners. */
export function registerRippleGaze(element: HTMLElement, enabled = true): () => void {
  if (!enabled) return () => {};
  if (avatars.size === 0) {
    reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;
    reducedMotion?.addEventListener("change", clear);
    window.addEventListener("pointermove", onPointer, { passive: true });
    window.addEventListener("blur", clear);
    document.documentElement.addEventListener("pointerleave", clear);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("scroll", clear, { passive: true, capture: true });
    window.addEventListener("resize", clear, { passive: true });
  }
  avatars.add(element);
  return () => {
    reset(element);
    avatars.delete(element);
    if (avatars.size) return;
    clear();
    reducedMotion?.removeEventListener("change", clear);
    reducedMotion = null;
    window.removeEventListener("pointermove", onPointer);
    window.removeEventListener("blur", clear);
    document.documentElement.removeEventListener("pointerleave", clear);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("scroll", clear, true);
    window.removeEventListener("resize", clear);
  };
}
