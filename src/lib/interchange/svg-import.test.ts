import { describe, expect, it, vi } from "vitest";

import { createCanvasObjectSchema } from "@/lib/domain/schemas";
import { semanticFillColor, semanticStrokeColor } from "@/lib/canvas/semantic-visual-style";
import { VECTOR_PATH_LIMITS } from "@/lib/domain/vector-path";

import { importSvgToNativeObjects, SvgNativeImportError } from "./svg-import";

describe("importSvgToNativeObjects", () => {
  it.each([
    ["aqua", "#00ffff"], ["black", "#000000"], ["blue", "#0000ff"],
    ["fuchsia", "#ff00ff"], ["gray", "#808080"], ["green", "#008000"],
    ["lime", "#00ff00"], ["maroon", "#800000"], ["navy", "#000080"],
    ["olive", "#808000"], ["orange", "#ffa500"], ["purple", "#800080"],
    ["red", "#ff0000"], ["silver", "#c0c0c0"], ["teal", "#008080"],
    ["white", "#ffffff"], ["yellow", "#ffff00"],
  ])("preserves CSS %s in both rendered fill and stroke", (color, expected) => {
    const [object] = importSvgToNativeObjects(`
      <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10">
        <rect width="10" height="10" fill=" ${color.toUpperCase()} " stroke="${color}" />
      </svg>
    `);
    if (object?.kind !== "path") throw new Error("Expected path");
    expect(semanticFillColor(object.fill, "black", true)).toBe(expected);
    expect(semanticStrokeColor(object.stroke, "black", true)).toBe(expected);
  });

  it("preserves the SVG default of opaque black fill with no stroke", () => {
    const [object] = importSvgToNativeObjects(`
      <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10">
        <rect width="10" height="10" />
      </svg>
    `);
    if (object?.kind !== "path") throw new Error("Expected path");
    expect(semanticFillColor(object.fill, "black", true)).toBe("#000000");
    expect(semanticStrokeColor(object.stroke, "black", true)).toBe("none");
  });

  it.each([
    "rgb(, 0, 0)", "rgb(0, , 0)", "rgb(0, 0, )", "rgb(%, 0%, 0%)",
    "rgb(0xff, 0, 0)", "rgb(0b1, 0, 0)", "rgb(100%, 0, 0)",
    "rgba(0, 0, 0, )", "rgba(0, 0, 0, %)", "rgba(0, 0, 0, 0x1)",
    "constructor", "__proto__",
  ])("rejects malformed color %s before allocating any part ids", (paint) => {
    const idForPart = vi.fn((name: string) => name);
    expect(() => importSvgToNativeObjects(`
      <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10">
        <rect id="valid" width="1" height="1" />
        <rect id="invalid" width="1" height="1" fill="${paint}" />
      </svg>
    `, { idForPart })).toThrowError(expect.objectContaining({ code: "unsupported-paint" }));
    expect(idForPart).not.toHaveBeenCalled();
  });

  it.each([
    'x="0x10"', 'y="0b10"', 'x=""', 'y=" "',
    'rx=""', 'ry="0o0"', 'stroke-width="0x2"', 'opacity="0x1"',
  ])("rejects malformed numeric attribute %s before allocating ids", (attribute) => {
    const idForPart = vi.fn((name: string) => name);
    expect(() => importSvgToNativeObjects(`
      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20">
        <rect id="valid" width="1" height="1" />
        <rect id="invalid" width="1" height="1" ${attribute} />
      </svg>
    `, { idForPart })).toThrowError(expect.objectContaining({ code: "invalid-geometry" }));
    expect(idForPart).not.toHaveBeenCalled();
  });

  it("preserves decimal and exponent geometry, percentage RGB and alpha", () => {
    const [object] = importSvgToNativeObjects(`
      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20">
        <rect x=" +.5 " y="-1e1" width="2E+1" height=".25" opacity="5e-1"
          fill="rgb(100%, 50%, 0%)" stroke="rgba(0, 128, 255, 50%)" stroke-width="2e0" />
      </svg>
    `);
    expect(object).toMatchObject({
      x: 0.5, y: -10, width: 20, height: 1, opacity: 0.5,
      fill: "#ff8000", stroke: "#0080ff80", strokeWidth: 2,
    });
  });

  it("imports named primitive parts with native bounds, paints, opacity and injected ids", () => {
    const objects = importSvgToNativeObjects(`
      <svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">
        <rect id="Panel" x="10" y="20" width="50" height="30"
          fill="#abc" stroke="navy" stroke-width="2" opacity="0.6" />
        <circle data-name="Status light" cx="100" cy="40" r="10" fill="rgb(0, 255, 0)" />
        <polygon aria-label="Pointer" points="130,20 160,35 130,50" fill="none" stroke="red" />
      </svg>
    `, {
      idForPart: (name, index) => `part-${index}-${name.toLowerCase().replace(/\s+/g, "-")}`,
      origin: { x: 5, y: 7 },
      zIndexStart: 4,
    });

    expect(objects).toHaveLength(3);
    expect(objects.map((object) => ({ id: object.id, name: object.semanticName, role: object.semanticRole }))).toEqual([
      { id: "part-0-panel", name: "Panel", role: "svg-rect" },
      { id: "part-1-status-light", name: "Status light", role: "svg-circle" },
      { id: "part-2-pointer", name: "Pointer", role: "svg-polygon" },
    ]);
    expect(objects[0]).toMatchObject({
      kind: "path", x: 15, y: 27, width: 50, height: 30, fill: "#abc", stroke: "#000080",
      strokeWidth: 2, opacity: 0.6, closed: true, zIndex: 4,
    });
    expect(objects[1]).toMatchObject({
      kind: "path", x: 95, y: 37, width: 20, height: 20, fill: "#00ff00", closed: true,
    });
    expect(objects.every((object) => createCanvasObjectSchema.safeParse(object).success)).toBe(true);
  });

  it("normalizes absolute and relative lines and Bezier curves", () => {
    const [object] = importSvgToNativeObjects(`
      <svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">
        <path id="Wave" d="M 10 20 h 10 v 10 l -10 0 Q 15 5 20 20 c 5 0 5 10 10 10 Z"
          fill="#123456" stroke="#abcdef80" stroke-linecap="round" stroke-linejoin="bevel" fill-rule="evenodd" />
      </svg>
    `);

    expect(object).toMatchObject({
      semanticName: "Wave",
      kind: "path",
      x: 10,
      y: 5,
      width: 20,
      height: 25,
      closed: true,
      lineCap: "round",
      lineJoin: "bevel",
      fillRule: "evenodd",
    });
    if (object?.kind !== "path") throw new Error("Expected path");
    expect(object.start).toEqual({ x: 0, y: 0.6 });
    expect(object.segments.map((segment) => segment.kind)).toEqual([
      "line", "line", "line", "quadratic", "cubic",
    ]);
    expect(object.segments[3]).toEqual({
      kind: "quadratic",
      control: { x: 0.25, y: 0 },
      to: { x: 0.5, y: 0.6 },
    });
  });

  it("accepts an injected DOMParser-compatible parser", () => {
    const parser = { parseFromString: vi.fn((source: string) => new DOMParser().parseFromString(source, "image/svg+xml")) };
    const objects = importSvgToNativeObjects(
      `<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2" viewBox="0 0 2 2"><path d="M0 0L2 2" /></svg>`,
      { parser },
    );
    expect(objects).toHaveLength(1);
    expect(parser.parseFromString).toHaveBeenCalledWith(expect.any(String), "image/svg+xml");
  });

  it.each(["nested", "flat"])("rejects %s markup over the element budget before invoking the XML parser", (layout) => {
    const parser = { parseFromString: vi.fn((source: string) => new DOMParser().parseFromString(source, "image/svg+xml")) };
    const elements = layout === "nested"
      ? `${"<g>".repeat(200)}${"</g>".repeat(200)}`
      : '<rect width="1" height="1" />'.repeat(200);
    expect(() => importSvgToNativeObjects(`
      <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10">
        ${elements}
      </svg>
    `, { parser, maxElements: 199 })).toThrowError(expect.objectContaining({ code: "limit-exceeded" }));
    expect(parser.parseFromString).not.toHaveBeenCalled();
  });

  it.each([
    "<!-- <rect/><g><path/> -->",
    "<![CDATA[ <rect/><g><path/> ]]>",
    "<?metadata <rect/><g><path/> ?>",
  ])("ignores markup-like text inside %s when checking the element budget", (ignoredMarkup) => {
    expect(importSvgToNativeObjects(`
      <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10">
        ${ignoredMarkup}
        <rect width="1" height="1" />
      </svg>
    `, { maxElements: 1 })).toHaveLength(1);
  });

  it.each(["<!-- <rect/>", "<![CDATA[ <rect/>", "<?metadata <rect/>"])(
    "leaves malformed unterminated markup %s to XML validation",
    (ignoredMarkup) => {
      expect(() => importSvgToNativeObjects(`
        <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10">
          ${ignoredMarkup}
        </svg>
      `, { maxElements: 1 })).toThrowError(expect.objectContaining({ code: "invalid-svg" }));
    },
  );

  it("requires an identity viewport and reports mismatched document dimensions", () => {
    const cases = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="560" viewBox="10 0 480 560"><path d="M0 0L2 2" /></svg>`,
      `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="560" viewBox="0 0 960 560"><path d="M0 0L2 2" /></svg>`,
      `<svg xmlns="http://www.w3.org/2000/svg" width="480px" height="560" viewBox="0 0 480 560"><path d="M0 0L2 2" /></svg>`,
      `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="560" viewBox="0 0 480 560" preserveAspectRatio="none"><path d="M0 0L2 2" /></svg>`,
    ];
    for (const source of cases) {
      expect(() => importSvgToNativeObjects(source)).toThrowError(expect.objectContaining({
        code: "unsupported-viewport",
        message: expect.stringContaining("width=\"480"),
      }));
    }
  });

  it.each([
    "0x0 0 10 10", "0b0 0 10 10", "0 0 0xA 10", "0 0 10 0b1010",
    ",0 0 10 10", "0 0 10 10,", "0,,0 10 10", "0, ,0 10 10",
  ])("rejects malformed identity viewBox %s before allocating ids", (viewBox) => {
    const idForPart = vi.fn((name: string) => name);
    expect(() => importSvgToNativeObjects(`
      <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="${viewBox}">
        <rect width="1" height="1" />
      </svg>
    `, { idForPart })).toThrowError(expect.objectContaining({ code: "unsupported-viewport" }));
    expect(idForPart).not.toHaveBeenCalled();
  });

  it.each(["0 0 10 10", " 0, 0, 10, 10 ", "+0 -0 1e1 10.0", "0,0 10,10"])(
    "accepts identity viewBox %s with valid decimal numbers and separators",
    (viewBox) => {
      expect(importSvgToNativeObjects(`
        <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="${viewBox}">
          <rect width="1" height="1" />
        </svg>
      `)).toHaveLength(1);
    },
  );

  it("accepts a polygon at the native segment limit", () => {
    const points = Array.from({ length: VECTOR_PATH_LIMITS.maxSegments + 1 }, (_, index) => `${index % 2},${index % 3}`).join(" ");
    const [object] = importSvgToNativeObjects(`
      <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10">
        <polygon points="${points}" />
      </svg>
    `);
    if (object?.kind !== "path") throw new Error("Expected path");
    expect(object.segments).toHaveLength(VECTOR_PATH_LIMITS.maxSegments);
    expect(object.closed).toBe(true);
  });

  it("rejects an oversized polygon before normalizing geometry or allocating ids", () => {
    const idForPart = vi.fn((name: string) => name);
    const points = Array.from({ length: VECTOR_PATH_LIMITS.maxSegments + 2 }, (_, index) => `${index % 2},${index % 3}`).join(" ");
    expect(() => importSvgToNativeObjects(`
      <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10">
        <rect id="valid" width="1" height="1" />
        <polygon points="${points}" />
      </svg>
    `, { idForPart })).toThrowError(expect.objectContaining({ code: "limit-exceeded", elementName: "polygon" }));
    expect(idForPart).not.toHaveBeenCalled();
  });

  it.each(["0,0 1e999,0 0,1", "0,0 1,0 0,-1e999"])(
    "rejects non-finite polygon points %s before allocating ids",
    (points) => {
      const idForPart = vi.fn((name: string) => name);
      expect(() => importSvgToNativeObjects(`
        <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10">
          <rect id="valid" width="1" height="1" />
          <polygon points="${points}" />
        </svg>
      `, { idForPart })).toThrowError(expect.objectContaining({ code: "invalid-geometry", elementName: "polygon" }));
      expect(idForPart).not.toHaveBeenCalled();
    },
  );

  it("allocates globally unique stable names when source names collide with generated suffixes", () => {
    const objects = importSvgToNativeObjects(`
      <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10">
        <rect id="a" width="1" height="1" />
        <rect id="a" x="2" width="1" height="1" />
        <rect id="a (2)" x="4" width="1" height="1" />
        <rect id="a" x="6" width="1" height="1" />
      </svg>
    `);
    expect(objects.map((object) => object.semanticName)).toEqual(["a", "a (2)", "a (2) (2)", "a (3)"]);
    expect(new Set(objects.map((object) => object.semanticName)).size).toBe(objects.length);
  });

  it("rejects unsupported syntax atomically without allocating ids", () => {
    const idForPart = vi.fn((name: string, index: number) => `${name}-${index}`);
    expect(() => importSvgToNativeObjects(`
      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20">
        <rect id="valid" width="20" height="10" />
        <path id="unsupported" d="M0 0 A 10 10 0 0 1 20 20" />
      </svg>
    `, { idForPart })).toThrowError(expect.objectContaining({
      name: "SvgNativeImportError",
      code: "unsupported-command",
    }));
    expect(idForPart).not.toHaveBeenCalled();
  });

  it.each(['<xml:rect width="1" height="1" />', '<xml:path d="M0 0L1 1" />'])(
    "rejects a foreign-namespace lookalike %s before allocating ids",
    (element) => {
      const idForPart = vi.fn((name: string) => name);
      expect(() => importSvgToNativeObjects(`
        <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10">
          <rect id="valid" width="1" height="1" />
          ${element}
        </svg>
      `, { idForPart })).toThrowError(expect.objectContaining({ code: "unsupported-element" }));
      expect(idForPart).not.toHaveBeenCalled();
    },
  );

  it.each(['xmlns="http://www.w3.org/2000/svg"', ""])(
    "preserves supported geometry with matching root and child namespaces (%s)",
    (namespace) => {
      expect(importSvgToNativeObjects(`
        <svg ${namespace} width="10" height="10" viewBox="0 0 10 10">
          <rect width="1" height="1" />
        </svg>
      `)).toHaveLength(1);
    },
  );

  it("rejects transforms, groups, style blocks and malformed geometry with actionable errors", () => {
    const cases = [
      [`<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" viewBox="0 0 1 1"><path transform="scale(2)" d="M0 0L1 1" /></svg>`, "unsupported-style"],
      [`<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" viewBox="0 0 1 1"><g><rect width="1" height="1" /></g></svg>`, "unsupported-element"],
      [`<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" viewBox="0 0 1 1"><style>path { fill: red }</style><path d="M0 0L1 1" /></svg>`, "unsupported-element"],
      [`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10"><polygon points="0,0 10" /></svg>`, "invalid-geometry"],
    ] as const;
    for (const [source, code] of cases) {
      expect(() => importSvgToNativeObjects(source)).toThrowError(expect.objectContaining({ code }));
    }
  });

  it("never executes malicious markup and rejects active content", () => {
    const marker = vi.fn();
    Object.assign(globalThis, { __svgImportMarker: marker });
    const source = `
      <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10">
        <script>globalThis.__svgImportMarker()</script>
        <path d="M0 0L10 10" onload="globalThis.__svgImportMarker()" />
      </svg>
    `;
    expect(() => importSvgToNativeObjects(source)).toThrowError(expect.objectContaining({
      name: "SvgNativeImportError",
      code: "unsafe-markup",
    } satisfies Partial<SvgNativeImportError>));
    expect(marker).not.toHaveBeenCalled();
    Reflect.deleteProperty(globalThis, "__svgImportMarker");
  });
});
