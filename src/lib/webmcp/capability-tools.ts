/// <reference types="webmcp-types" />

import {
  SEMANTIC_CANVAS_BACKGROUND,
  SEMANTIC_COLOR_PALETTE,
  SEMANTIC_CONNECTOR_STROKE_WIDTH,
  SEMANTIC_DRAW_STROKE_WIDTHS,
  SEMANTIC_SHAPE_STROKE_WIDTH,
  SEMANTIC_TEXT_FONT_SIZES,
} from "@/lib/canvas/semantic-visual-style";
import { VECTOR_PATH_LIMITS } from "@/lib/domain/vector-path";

import type {
  JazzboardToolFailure,
  JazzboardToolResult,
  JazzboardWebMcpBinding,
} from "./types";

export const JAZZBOARD_CANVAS_CAPABILITY_TOOL_NAMES = [
  "get_canvas_capabilities",
] as const;

const CANONICAL_AUTHORING_EXAMPLES = {
  createNodeLifecycle: {
    tool: "create_node",
    inputExamples: [
      {
        label: "Use regional failover",
        nodeType: "decision",
        nodeMetadata: {
          kind: "decision",
          status: "accepted",
          owner: "Platform team",
          resolution: "Adopt active-passive failover for the first release.",
        },
      },
      {
        label: "Which recovery objective applies?",
        nodeType: "open_question",
        nodeMetadata: {
          kind: "open_question",
          status: "open",
          owner: "Reliability lead",
          resolution: null,
        },
      },
    ],
    lifecycleContracts: {
      decisionStatuses: ["proposed", "accepted", "rejected", "superseded"],
      openQuestionStatuses: ["open", "answered", "deferred", "closed"],
      unresolved: "proposed-decision-or-open-status-question-requires-null-resolution",
      resolved: "all-other-statuses-require-nonempty-resolution",
      owner: "nonempty-string-or-null",
    },
  },
  createDrawing: {
    tool: "create_drawing",
    input: {
      points: [{ x: 120, y: 160 }, { x: 180, y: 120 }, { x: 240, y: 180 }],
      color: "black",
      size: "m",
      rotation: 0,
    },
  },
  createPath: {
    tool: "create_path",
    input: {
      start: { x: 100, y: 240 },
      segments: [
        { kind: "line", to: { x: 180, y: 240 } },
        { kind: "quadratic", control: { x: 230, y: 160 }, to: { x: 280, y: 240 } },
        {
          kind: "cubic",
          control1: { x: 330, y: 320 },
          control2: { x: 380, y: 160 },
          to: { x: 440, y: 240 },
        },
      ],
      closed: false,
      fill: "none",
      stroke: "#334155",
      strokeWidth: 4.5,
      opacity: 1,
      lineCap: "round",
      lineJoin: "round",
      fillRule: "nonzero",
    },
  },
  createPolygon: {
    tool: "create_polygon",
    input: {
      points: [{ x: 520, y: 180 }, { x: 660, y: 180 }, { x: 700, y: 300 }, { x: 560, y: 330 }],
      fill: "light-blue",
      stroke: "blue",
      strokeWidth: 3,
      opacity: 0.9,
    },
  },
  drawConnection: {
    tool: "draw_connection",
    input: {
      start: { objectId: "node_client", port: { side: "right", position: 0.5, exact: true } },
      end: { objectId: "node_api", port: { side: "left", position: 0.5, exact: true } },
      direction: "end",
      label: "request",
      routing: { mode: "elbow", elbowMidPoint: 0.5, labelPosition: 0.5 },
    },
    endpointContract: "objectId-with-optional-port-or-absolute-canvas-point",
    routingExamples: [
      { mode: "auto" },
      { mode: "straight", labelPosition: 0.5 },
      { mode: "curved", bend: 48, labelPosition: 0.5 },
      { mode: "elbow", elbowMidPoint: 0.5, labelPosition: 0.5 },
    ],
  },
  applyCanvasTransaction: {
    tool: "apply_canvas_transaction",
    input: {
      operations: [
        { op: "create_node", tempRef: "client", label: "Client", nodeType: "component" },
        { op: "create_node", tempRef: "api", label: "API", nodeType: "service" },
        {
          op: "connect",
          tempRef: "request",
          start: { tempRef: "client" },
          end: { tempRef: "api" },
          direction: "end",
          label: "request",
        },
        { op: "create_diagram", tempRef: "system", title: "System context" },
      ],
    },
    expectedSemantics:
      "members/connectors are omitted, so this single Diagram infers compatible objects created in the transaction; tempRef values resolve atomically",
  },
  updateObjectPath: {
    tool: "update_object",
    input: {
      objectId: "path_example",
      expectedRevision: 3,
      operation: "edit",
      patch: {
        start: { x: 0, y: 0.5 },
        segments: [
          { kind: "line", to: { x: 0.35, y: 0.1 } },
          { kind: "quadratic", control: { x: 0.65, y: 0 }, to: { x: 1, y: 0.5 } },
        ],
        closed: false,
      },
    },
    pointSpace: "normalized-object-local-0-to-1",
  },
} as const;

export type JazzboardCanvasCapabilities = Readonly<{
  schemaVersion: 1;
  role: JazzboardWebMcpBinding["role"];
  authority: Readonly<{
    currentPageToolRegistryIsAuthoritative: true;
    roleCanMutateCanvas: boolean;
    exactRevisionsGuardExistingEntityEdits: true;
  }>;
  coordinateSystem: Readonly<{
    space: "canvas";
    unit: "canvas-unit";
    origin: "unbounded";
    xDirection: "right";
    yDirection: "down";
    objectBoundsOrigin: "unrotated-top-left";
    dimensions: "positive-width-and-height";
    rotation: Readonly<{
      unit: "radian";
      positiveDirectionOnScreen: "clockwise";
      zero: "unrotated";
      rectangularObjectPivot: "object-center";
      freehandDrawingPivot: "object-local-origin";
      pathAndPolygonPivot: "object-center";
      quarterTurnExample: number;
    }>;
    authoredPointSpaces: Readonly<{
      createDrawingPathAndPolygonInput: "absolute-canvas";
      persistedAndPatchDrawingPoints: "object-local-canvas-units";
      persistedAndPatchPathAndPolygonPoints: "normalized-object-local-0-to-1";
      connectorPoints: "absolute-canvas";
    }>;
  }>;
  paintOrder: Readonly<{
    field: "zIndex";
    minimum: 0;
    maximum: 1_000_000;
    higherValue: "front";
    equalValuePaintOrder: "object-id-ascending";
    equalValueFrontmost: "lexicographically-later-object-id";
    omittedCreateValue: "current-maximum-plus-one";
  }>;
  colors: Readonly<{
    acceptedCustomFormats: readonly ["#RGB", "#RRGGBB", "#RRGGBBAA"];
    namedColors: typeof SEMANTIC_COLOR_PALETTE;
    namedColorBehavior: "solid-for-ink-pastel-for-fill";
    invalidValues: "rejected";
    transparency: Readonly<{
      transparentShapeOrPathFill: "none";
      transparentPathStroke: "none";
      alphaHexSupported: true;
      pathOpacityRange: readonly [0, 1];
    }>;
    canvasBackground: typeof SEMANTIC_CANVAS_BACKGROUND;
  }>;
  styleMetrics: Readonly<{
    textFontSizes: typeof SEMANTIC_TEXT_FONT_SIZES;
    freehandStrokeWidths: typeof SEMANTIC_DRAW_STROKE_WIDTHS;
    shapeStrokeWidth: typeof SEMANTIC_SHAPE_STROKE_WIDTH;
    connectorStrokeWidth: typeof SEMANTIC_CONNECTOR_STROKE_WIDTH;
  }>;
  primitives: Readonly<{
    text: Readonly<{ supported: true; defaultBounds: Readonly<{ width: 320; height: 96 }> }>;
    shape: Readonly<{
      supported: true;
      kinds: readonly ["rectangle", "ellipse", "diamond"];
      directDefaultBounds: Readonly<{ width: 260; height: 140 }>;
      transactionDefaultBounds: Readonly<{ width: 280; height: 152 }>;
    }>;
    node: Readonly<{ supported: true; defaultBounds: Readonly<{ width: 280; height: 152 }> }>;
    image: Readonly<{ supported: true; defaultBounds: Readonly<{ width: 640; height: 360 }> }>;
    drawing: Readonly<{
      supported: true;
      minimumPoints: 2;
      maximumPointsPerStroke: 2_000;
      transactionCreateOperation: "create_drawing";
    }>;
    path: Readonly<{
      supported: true;
      transactionCreateOperation: "create_path";
      segments: readonly ["line", "quadratic", "cubic"];
      maximumSegments: typeof VECTOR_PATH_LIMITS.maxSegments;
      mayClose: true;
      styleFields: readonly ["fill", "stroke", "strokeWidth", "opacity", "lineCap", "lineJoin", "fillRule"];
      maximumStrokeWidth: typeof VECTOR_PATH_LIMITS.maxStrokeWidth;
      lineCaps: readonly ["butt", "round", "square"];
      lineJoins: readonly ["miter", "round", "bevel"];
      fillRules: readonly ["nonzero", "evenodd"];
    }>;
    polygon: Readonly<{
      supported: true;
      transactionCreateOperation: "create_polygon";
      representation: "closed-path";
      minimumPoints: 3;
      maximumPoints: 2_001;
      styleFields: readonly ["fill", "stroke", "strokeWidth", "opacity", "lineCap", "lineJoin", "fillRule"];
    }>;
    connector: Readonly<{
      supported: true;
      routingModes: readonly ["auto", "straight", "curved", "elbow"];
    }>;
  }>;
  transactions: Readonly<{
    atomic: true;
    maximumOperations: 200;
    createOperations: readonly [
      "create_node",
      "create_shape",
      "create_text",
      "create_drawing",
      "create_path",
      "create_polygon",
      "connect",
      "create_diagram",
    ];
    diagramMembership: "omitted-infers-created-objects-explicit-arrays-are-exact";
    progressiveDrafts: "create-only-cumulative-replacement";
  }>;
  canonicalExamples: typeof CANONICAL_AUTHORING_EXAMPLES;
  inspection: Readonly<{
    preferredTool: "inspect_canvas_scope";
    legacyGeometryTool: "analyze_diagram_layout";
    legacyFramingTool: "render_canvas_preview";
    visualInspectionRequiresPixelCapture: true;
    framingOrGeometryAloneIsVisualInspection: false;
    recommendedPixelCapture: "full-viewport-then-crop-screenshotClip";
    freehandGeometryCoverage: "partial";
    vectorPathGeometryCoverage: "partial";
    correctionLoop: readonly [
      "read-exact-revision",
      "inspect-semantics-and-pixels",
      "compare-with-requested-intent",
      "correct-unintended-problems",
      "repeat-until-verified",
    ];
  }>;
}>;

function canvasCapabilities(role: JazzboardWebMcpBinding["role"]): JazzboardCanvasCapabilities {
  return {
    schemaVersion: 1,
    role,
    authority: {
      currentPageToolRegistryIsAuthoritative: true,
      roleCanMutateCanvas: role === "participant",
      exactRevisionsGuardExistingEntityEdits: true,
    },
    coordinateSystem: {
      space: "canvas",
      unit: "canvas-unit",
      origin: "unbounded",
      xDirection: "right",
      yDirection: "down",
      objectBoundsOrigin: "unrotated-top-left",
      dimensions: "positive-width-and-height",
      rotation: {
        unit: "radian",
        positiveDirectionOnScreen: "clockwise",
        zero: "unrotated",
        rectangularObjectPivot: "object-center",
        freehandDrawingPivot: "object-local-origin",
        pathAndPolygonPivot: "object-center",
        quarterTurnExample: Math.PI / 2,
      },
      authoredPointSpaces: {
        createDrawingPathAndPolygonInput: "absolute-canvas",
        persistedAndPatchDrawingPoints: "object-local-canvas-units",
        persistedAndPatchPathAndPolygonPoints: "normalized-object-local-0-to-1",
        connectorPoints: "absolute-canvas",
      },
    },
    paintOrder: {
      field: "zIndex",
      minimum: 0,
      maximum: 1_000_000,
      higherValue: "front",
      equalValuePaintOrder: "object-id-ascending",
      equalValueFrontmost: "lexicographically-later-object-id",
      omittedCreateValue: "current-maximum-plus-one",
    },
    colors: {
      acceptedCustomFormats: ["#RGB", "#RRGGBB", "#RRGGBBAA"],
      namedColors: SEMANTIC_COLOR_PALETTE,
      namedColorBehavior: "solid-for-ink-pastel-for-fill",
      invalidValues: "rejected",
      transparency: {
        transparentShapeOrPathFill: "none",
        transparentPathStroke: "none",
        alphaHexSupported: true,
        pathOpacityRange: [0, 1],
      },
      canvasBackground: SEMANTIC_CANVAS_BACKGROUND,
    },
    styleMetrics: {
      textFontSizes: SEMANTIC_TEXT_FONT_SIZES,
      freehandStrokeWidths: SEMANTIC_DRAW_STROKE_WIDTHS,
      shapeStrokeWidth: SEMANTIC_SHAPE_STROKE_WIDTH,
      connectorStrokeWidth: SEMANTIC_CONNECTOR_STROKE_WIDTH,
    },
    primitives: {
      text: { supported: true, defaultBounds: { width: 320, height: 96 } },
      shape: {
        supported: true,
        kinds: ["rectangle", "ellipse", "diamond"],
        directDefaultBounds: { width: 260, height: 140 },
        transactionDefaultBounds: { width: 280, height: 152 },
      },
      node: { supported: true, defaultBounds: { width: 280, height: 152 } },
      image: { supported: true, defaultBounds: { width: 640, height: 360 } },
      drawing: {
        supported: true,
        minimumPoints: 2,
        maximumPointsPerStroke: 2_000,
        transactionCreateOperation: "create_drawing",
      },
      path: {
        supported: true,
        transactionCreateOperation: "create_path",
        segments: ["line", "quadratic", "cubic"],
        maximumSegments: VECTOR_PATH_LIMITS.maxSegments,
        mayClose: true,
        styleFields: ["fill", "stroke", "strokeWidth", "opacity", "lineCap", "lineJoin", "fillRule"],
        maximumStrokeWidth: VECTOR_PATH_LIMITS.maxStrokeWidth,
        lineCaps: ["butt", "round", "square"],
        lineJoins: ["miter", "round", "bevel"],
        fillRules: ["nonzero", "evenodd"],
      },
      polygon: {
        supported: true,
        transactionCreateOperation: "create_polygon",
        representation: "closed-path",
        minimumPoints: 3,
        maximumPoints: 2_001,
        styleFields: ["fill", "stroke", "strokeWidth", "opacity", "lineCap", "lineJoin", "fillRule"],
      },
      connector: {
        supported: true,
        routingModes: ["auto", "straight", "curved", "elbow"],
      },
    },
    transactions: {
      atomic: true,
      maximumOperations: 200,
      createOperations: [
        "create_node",
        "create_shape",
        "create_text",
        "create_drawing",
        "create_path",
        "create_polygon",
        "connect",
        "create_diagram",
      ],
      diagramMembership: "omitted-infers-created-objects-explicit-arrays-are-exact",
      progressiveDrafts: "create-only-cumulative-replacement",
    },
    canonicalExamples: CANONICAL_AUTHORING_EXAMPLES,
    inspection: {
      preferredTool: "inspect_canvas_scope",
      legacyGeometryTool: "analyze_diagram_layout",
      legacyFramingTool: "render_canvas_preview",
      visualInspectionRequiresPixelCapture: true,
      framingOrGeometryAloneIsVisualInspection: false,
      recommendedPixelCapture: "full-viewport-then-crop-screenshotClip",
      freehandGeometryCoverage: "partial",
      vectorPathGeometryCoverage: "partial",
      correctionLoop: [
        "read-exact-revision",
        "inspect-semantics-and-pixels",
        "compare-with-requested-intent",
        "correct-unintended-problems",
        "repeat-until-verified",
      ],
    },
  };
}

function invalidInput(): JazzboardToolFailure {
  return {
    ok: false,
    tool: "get_canvas_capabilities",
    error: {
      code: "INVALID_TOOL_INPUT",
      message: "get_canvas_capabilities accepts no arguments.",
    },
  };
}

export function createJazzboardCanvasCapabilityWebMcpTools(
  binding: JazzboardWebMcpBinding,
): WebMCP.ModelContextTool[] {
  return [{
    name: "get_canvas_capabilities",
    title: "Read the Jazzboard canvas contract",
    description:
      "Read the current role plus authoritative coordinate, rotation, color, transparency, paint-order, primitive, transaction, and inspection conventions before authoring.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    async execute(rawInput): Promise<JazzboardToolResult<JazzboardCanvasCapabilities>> {
      if (
        rawInput === null ||
        typeof rawInput !== "object" ||
        Array.isArray(rawInput) ||
        Object.keys(rawInput).length > 0
      ) {
        return invalidInput();
      }
      return {
        ok: true,
        tool: "get_canvas_capabilities",
        data: canvasCapabilities(binding.role),
      };
    },
  }];
}
