import { expect, test, type CDPSession, type Locator, type Page } from "@playwright/test";
import sharp from "sharp";

import { createRoomViaApi } from "./helpers";

type Bounds = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

type ChromeSample = Readonly<{
  bounds: Bounds;
  display: string;
  opacity: number;
  visibility: string;
  entropy: number;
  visualViewportScale: number;
}>;

type PinchSample = Readonly<Record<"topLeft" | "topRight" | "bottomCenter" | "bottomRight", ChromeSample>>;

type CapturedWheelEvent = Readonly<{
  isTrusted: boolean;
  cancelable: boolean;
  ctrlKey: boolean;
  defaultPrevented: boolean;
  metaKey: boolean;
  deltaY: number;
}>;

const POSITION_TOLERANCE_PX = 1.5;

function persistentChrome(page: Page) {
  return {
    topLeft: page.getByTestId("combined-left-panel"),
    topRight: page.getByTestId("room-controls"),
    bottomCenter: page.getByRole("toolbar", { name: "Canvas tools" }),
    bottomRight: page.getByLabel("Canvas zoom controls"),
  } as const;
}

async function samplePaint(locator: Locator): Promise<ChromeSample> {
  const measurement = await locator.evaluate((element) => {
    const computed = getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    return {
      bounds: {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      },
      display: computed.display,
      opacity: Number(computed.opacity),
      visibility: computed.visibility,
      visualViewportScale: window.visualViewport?.scale ?? 1,
    };
  });
  const png = await locator.page().screenshot({
    animations: "disabled",
    clip: measurement.bounds,
  });
  const stats = await sharp(png).stats();
  return {
    ...measurement,
    entropy: stats.entropy,
  };
}

async function sampleChrome(page: Page): Promise<PinchSample> {
  const chrome = persistentChrome(page);
  return {
    topLeft: await samplePaint(chrome.topLeft),
    topRight: await samplePaint(chrome.topRight),
    bottomCenter: await samplePaint(chrome.bottomCenter),
    bottomRight: await samplePaint(chrome.bottomRight),
  };
}

function expectChromeSamplePainted(sample: PinchSample, baseline: PinchSample): void {
  for (const position of Object.keys(baseline) as Array<keyof PinchSample>) {
    expect(sample[position].display, `${position} should remain in layout`).not.toBe("none");
    expect(sample[position].visibility, `${position} should remain visible`).toBe("visible");
    expect(sample[position].opacity, `${position} should remain opaque`).toBeGreaterThan(0.99);
    expect(
      sample[position].visualViewportScale,
      `${position} should remain in the unscaled browser visual viewport`,
    ).toBe(1);
    for (const dimension of ["x", "y", "width", "height"] as const) {
      expect(
        Math.abs(sample[position].bounds[dimension] - baseline[position].bounds[dimension]),
        `${position} ${dimension} should remain screen-fixed during trusted pinch input`,
      ).toBeLessThanOrEqual(POSITION_TOLERANCE_PX);
    }
    expect(
      sample[position].entropy,
      `${position} should retain painted detail during trusted pinch input`,
    ).toBeGreaterThanOrEqual(baseline[position].entropy * 0.75);
  }
}

async function pinchAndSample(
  page: Page,
  cdp: CDPSession,
  center: Readonly<{ x: number; y: number }>,
  scaleFactor: number,
): Promise<PinchSample[]> {
  let finished = false;
  let pinchError: unknown = null;
  const pinch = cdp.send("Input.synthesizePinchGesture", {
    ...center,
    scaleFactor,
    relativeSpeed: 120,
    gestureSourceType: "default",
  }).catch((error: unknown) => {
    pinchError = error;
  }).finally(() => {
    finished = true;
  });
  const samples: PinchSample[] = [];
  samples.push(await sampleChrome(page));
  expect(finished, "the first paint sample should be captured during the pinch").toBe(false);
  await pinch;
  if (pinchError) throw pinchError;
  samples.push(await sampleChrome(page));
  return samples;
}

async function repeatPinchAndSample(
  page: Page,
  cdp: CDPSession,
  center: Readonly<{ x: number; y: number }>,
  scaleFactor: number,
  count: number,
): Promise<PinchSample[]> {
  const samples: PinchSample[] = [];
  for (let index = 0; index < count; index += 1) {
    samples.push(...await pinchAndSample(page, cdp, center, scaleFactor));
  }
  return samples;
}

async function dispatchTrustedPinchWheelStream(
  page: Page,
  cdp: CDPSession,
  center: Readonly<{ x: number; y: number }>,
  totalDeltaY: number,
  steps: number,
): Promise<PinchSample[]> {
  const samples: PinchSample[] = [];
  for (let index = 0; index < steps; index += 1) {
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      ...center,
      deltaX: 0,
      deltaY: totalDeltaY / steps,
      modifiers: 2,
    });
    if (index % 8 === 0) samples.push(await sampleChrome(page));
  }
  samples.push(await sampleChrome(page));
  return samples;
}

function readZoom(text: string | null): number {
  const zoom = Number.parseInt(text ?? "", 10);
  if (!Number.isFinite(zoom)) throw new Error(`Could not read canvas zoom from ${JSON.stringify(text)}.`);
  return zoom;
}

test("keeps persistent chrome painted during trusted trackpad-style pinch out and in", async ({
  page,
}, testInfo) => {
  test.skip(process.platform !== "darwin", "CDP's default pinch source models macOS Chrome trackpads.");
  test.setTimeout(45_000);
  await page.setViewportSize({ width: 1_280, height: 800 });
  await page.addInitScript(() => {
    const events: Array<Record<string, unknown>> = [];
    Object.defineProperty(window, "__jazzboardPinchWheelEvents", {
      configurable: true,
      value: events,
    });
    addEventListener("wheel", (event) => {
      events.push({
        isTrusted: event.isTrusted,
        cancelable: event.cancelable,
        ctrlKey: event.ctrlKey,
        defaultPrevented: event.defaultPrevented,
        metaKey: event.metaKey,
        deltaY: event.deltaY,
      });
    });
  });

  const host = await createRoomViaApi(page.request, "Pat Pinch", "Trusted pinch regression");
  await page.goto(`/room/${encodeURIComponent(host.room.id)}`);
  const canvas = page.getByTestId("semantic-canvas");
  const zoomControls = page.getByLabel("Canvas zoom controls");
  await expect(canvas).toBeVisible({ timeout: 20_000 });
  await expect(zoomControls).toContainText("100%");

  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  if (!bounds) throw new Error("The semantic canvas must have measurable bounds.");
  const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  const cdp = await page.context().newCDPSession(page);
  const baseline = await sampleChrome(page);

  const viewportChrome = page.getByTestId("room-viewport-chrome");
  await expect(viewportChrome).toBeVisible();
  await expect(viewportChrome).toHaveCSS("position", "fixed");
  for (const [position, locator] of Object.entries(persistentChrome(page))) {
    const ownership = await locator.evaluate((element) => ({
      insideSemanticCanvas: element.closest('[data-testid="semantic-canvas"]') !== null,
      insideViewportChrome: element.closest('[data-testid="room-viewport-chrome"]') !== null,
    }));
    expect(ownership.insideViewportChrome, `${position} should live in room viewport chrome`).toBe(true);
    expect(ownership.insideSemanticCanvas, `${position} should live outside the semantic canvas`).toBe(false);
  }

  const pinchOutSamples = await repeatPinchAndSample(page, cdp, center, 0.4, 3);
  const zoomedOut = readZoom(await zoomControls.textContent());
  expect(zoomedOut, "trusted pinch out should materially reduce the canvas zoom").toBeLessThanOrEqual(53);
  const pinchOutWheelEvents = await page.evaluate(() => (
    (window as unknown as { __jazzboardPinchWheelEvents: CapturedWheelEvent[] })
      .__jazzboardPinchWheelEvents.length
  ));
  const pinchInSamples = await dispatchTrustedPinchWheelStream(
    page,
    cdp,
    center,
    -Math.log(1 / (zoomedOut / 100)) / 0.0025,
    48,
  );
  const finalZoom = readZoom(await zoomControls.textContent());
  expect(finalZoom, "trusted reverse pinch should restore the starting zoom").toBeGreaterThanOrEqual(99);
  expect(finalZoom, "trusted reverse pinch should restore the starting zoom").toBeLessThanOrEqual(101);

  expect(pinchOutSamples.length, "pinch out should be sampled while in progress").toBeGreaterThan(1);
  expect(pinchInSamples.length, "pinch in should be sampled while in progress").toBeGreaterThan(1);
  for (const sample of [...pinchOutSamples, ...pinchInSamples]) {
    expectChromeSamplePainted(sample, baseline);
  }

  const wheelEvents = await page.evaluate(() => (
    (window as unknown as { __jazzboardPinchWheelEvents: CapturedWheelEvent[] })
      .__jazzboardPinchWheelEvents
  ));
  expect(wheelEvents.length, "Chrome pinch synthesis should emit a wheel-event stream").toBeGreaterThan(2);
  expect(wheelEvents.every((event) => event.isTrusted), "pinch events should be browser-trusted").toBe(true);
  expect(
    wheelEvents.every((event) => event.ctrlKey && !event.metaKey),
    "pinch events should match macOS Chrome's ctrl+wheel shape",
  ).toBe(true);
  expect(wheelEvents.some((event) => event.deltaY > 0), "pinch out should emit positive deltas").toBe(true);
  expect(wheelEvents.some((event) => event.deltaY < 0), "pinch in should emit negative deltas").toBe(true);
  const cancelableTrustedPinchEvents = wheelEvents.filter((event) => (
    event.cancelable && event.isTrusted && event.ctrlKey
  ));
  expect(
    cancelableTrustedPinchEvents.length,
    "the stream should include cancelable trusted ctrl+wheel events",
  ).toBeGreaterThan(0);
  expect(
    cancelableTrustedPinchEvents.every((event) => event.defaultPrevented),
    "every cancelable trusted ctrl+wheel event should be consumed by Jazzboard",
  ).toBe(true);

  const minimumEntropyRatio = Math.min(...[...pinchOutSamples, ...pinchInSamples].flatMap((sample) => (
    (Object.keys(sample) as Array<keyof PinchSample>).flatMap((position) => (
      [sample[position].entropy / baseline[position].entropy]
    ))
  )));
  const diagnostic = {
      browser: testInfo.project.name,
      pinchOutSamples: pinchOutSamples.length,
      pinchInSamples: pinchInSamples.length,
      wheelEvents: wheelEvents.length,
      synthesizedPinchWheelEvents: pinchOutWheelEvents,
      reversePinchWheelEvents: wheelEvents.length - pinchOutWheelEvents,
      trustedWheelEvents: wheelEvents.filter((event) => event.isTrusted).length,
      cancelableWheelEvents: wheelEvents.filter((event) => event.cancelable).length,
      defaultPreventedWheelEvents: wheelEvents.filter((event) => event.defaultPrevented).length,
      zoomedOut,
      finalZoom,
      minimumEntropyRatio,
  };
  await testInfo.attach("trusted-pinch-diagnostic.json", {
    body: Buffer.from(JSON.stringify(diagnostic, null, 2)),
    contentType: "application/json",
  });
});
