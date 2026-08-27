import type { LayoutDensity } from "./types";

export const DEFAULT_LAYOUT_DENSITY: LayoutDensity = "comfortable";

/**
 * Shared canvas-layout defaults. Gaps are minimum edge-to-edge distances;
 * connector-label clearance can make an individual gap larger.
 */
export const LAYOUT_DENSITY_DEFAULTS = {
  comfortable: {
    primaryGap: 160,
    secondaryGap: 100,
    labelPadding: 24,
  },
  compact: {
    primaryGap: 72,
    secondaryGap: 48,
    labelPadding: 12,
  },
} as const satisfies Record<
  LayoutDensity,
  { primaryGap: number; secondaryGap: number; labelPadding: number }
>;

export const DEFAULT_AUTOMATIC_LAYOUT_COLUMNS = 4;
export const DEFAULT_AUTOMATIC_LAYOUT_VIEWPORT_PADDING = 80;
export const DEFAULT_AUTOMATIC_LAYOUT_SLOT_WIDTH = 320;
export const DEFAULT_AUTOMATIC_LAYOUT_SLOT_HEIGHT = 152;

export function layoutDensityDefaults(density: LayoutDensity | undefined) {
  return LAYOUT_DENSITY_DEFAULTS[density ?? DEFAULT_LAYOUT_DENSITY];
}

export function minimumLayoutGaps(input: {
  density?: LayoutDensity;
  primaryGap?: number;
  secondaryGap?: number;
}) {
  const defaults = layoutDensityDefaults(input.density);
  return {
    primaryGap: Math.max(defaults.primaryGap, input.primaryGap ?? 0),
    secondaryGap: Math.max(defaults.secondaryGap, input.secondaryGap ?? 0),
    labelPadding: defaults.labelPadding,
  };
}

export type ConnectorLabelMetrics = {
  normalizedLines: string[];
  width: number;
  height: number;
};

export type ConnectorLabelBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const CONNECTOR_LABEL_FONT_SIZE = 20;
const CONNECTOR_LABEL_LINE_HEIGHT = 1.35;
const CONNECTOR_LABEL_GRAPHEME_WIDTH = 11;
const CONNECTOR_LABEL_INSET = 9;
const CONNECTOR_LABEL_MAX_WIDTH = 16 * CONNECTOR_LABEL_FONT_SIZE;

/**
 * Conservative, platform-independent approximation of tldraw's medium arrow
 * label measurement. It intentionally avoids DOM/font APIs so server layout,
 * export bounds, and client previews can share one deterministic contract.
 */
export function connectorLabelMetrics(label: string): ConnectorLabelMetrics {
  const normalizedLines = label
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (!normalizedLines.length) return { normalizedLines: [], width: 0, height: 0 };

  const estimatedLineWidths = normalizedLines.map(
    (line) => Array.from(line).length * CONNECTOR_LABEL_GRAPHEME_WIDTH,
  );
  const wrappedLineCount = estimatedLineWidths.reduce(
    (count, width) =>
      count + Math.max(1, Math.ceil(width / (CONNECTOR_LABEL_MAX_WIDTH - CONNECTOR_LABEL_INSET))),
    0,
  );
  return {
    normalizedLines,
    width: Math.min(CONNECTOR_LABEL_MAX_WIDTH, Math.max(...estimatedLineWidths) + CONNECTOR_LABEL_INSET),
    height:
      wrappedLineCount * CONNECTOR_LABEL_FONT_SIZE * CONNECTOR_LABEL_LINE_HEIGHT +
      CONNECTOR_LABEL_INSET,
  };
}

export function connectorLabelPrimaryClearance(
  label: string,
  direction: "right" | "down",
  density: LayoutDensity | undefined,
): number {
  const metrics = connectorLabelMetrics(label);
  if (!metrics.normalizedLines.length) return 0;
  const padding = layoutDensityDefaults(density).labelPadding;
  return (direction === "right" ? metrics.width : metrics.height) + padding * 2;
}

/** The deterministic page-space box occupied by a centered connector label. */
export function connectorLabelBounds(
  label: string,
  start: { x: number; y: number },
  end: { x: number; y: number },
): ConnectorLabelBounds | null {
  const metrics = connectorLabelMetrics(label);
  if (!metrics.normalizedLines.length) return null;
  const centerX = (start.x + end.x) / 2;
  const centerY = (start.y + end.y) / 2;
  return {
    x: centerX - metrics.width / 2,
    y: centerY - metrics.height / 2,
    width: metrics.width,
    height: metrics.height,
  };
}
