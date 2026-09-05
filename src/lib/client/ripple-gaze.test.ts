import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerRippleGaze } from "./ripple-gaze";

let callbacks: FrameRequestCallback[];
let cleanups: Array<() => void>;
let media: { matches: boolean; addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> };
function avatar(size = 63) {
  const element = document.createElement("span");
  element.getBoundingClientRect = () => ({ x: 100, y: 100, width: size, height: size } as DOMRect);
  document.body.append(element);
  cleanups.push(registerRippleGaze(element));
  return element;
}
function move(x: number, y: number, pointerType = "mouse") {
  const event = new Event("pointermove");
  Object.assign(event, { clientX: x, clientY: y, pointerType });
  window.dispatchEvent(event);
}
function flush() {
  const pending = callbacks.splice(0);
  pending.forEach(callback => callback(0));
}
beforeEach(() => {
  callbacks = [];
  cleanups = [];
  media = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  vi.stubGlobal("matchMedia", () => media);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { callbacks.push(callback); return callbacks.length; });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
});
afterEach(() => {
  cleanups.forEach(cleanup => cleanup());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("Ripple proximity gaze", () => {
  it("coalesces pointer events for all avatars into one frame without a continuous loop", () => {
    const one = avatar(); const two = avatar();
    move(170, 135); move(180, 140); move(190, 145);
    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1);
    flush();
    expect(one).toHaveAttribute("data-ripple-gaze", "true");
    expect(two).toHaveAttribute("data-ripple-gaze", "true");
    expect(parseFloat(one.style.getPropertyValue("--ripple-gaze-x"))).toBeGreaterThan(0);
    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1);
  });
  it("returns to idle outside the radius and ignores touch and small icons", () => {
    const large = avatar(); const small = avatar(21);
    move(160, 135); flush();
    expect(large).toHaveAttribute("data-ripple-gaze");
    expect(small).not.toHaveAttribute("data-ripple-gaze");
    move(600, 600); flush();
    expect(large).not.toHaveAttribute("data-ripple-gaze");
    move(160, 135, "touch");
    expect(callbacks).toHaveLength(0);
  });
  it("honors reduced motion and resets on window departure", () => {
    const element = avatar();
    media.matches = true;
    move(160, 135); flush();
    expect(element).not.toHaveAttribute("data-ripple-gaze");
    media.matches = false;
    move(160, 135); flush();
    window.dispatchEvent(new Event("blur"));
    expect(element).not.toHaveAttribute("data-ripple-gaze");
  });
  it("releases the shared pointer listener after the final avatar unmounts", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    avatar(); avatar();
    expect(add.mock.calls.filter(([type]) => type === "pointermove")).toHaveLength(1);
    cleanups[0]();
    expect(remove.mock.calls.filter(([type]) => type === "pointermove")).toHaveLength(0);
    cleanups[1]();
    expect(remove.mock.calls.filter(([type]) => type === "pointermove")).toHaveLength(1);
    cleanups = [];
    move(160, 135);
    expect(callbacks).toHaveLength(0);
  });
});
