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
import { withActionableRecovery } from "./actionable-failure";

export const JAZZBOARD_CANVAS_CAPABILITY_TOOL_NAMES = [
  "get_canvas_capabilities",
] as const;

export const JAZZBOARD_CANVAS_QUICKSTART_TASKS = [
  "architecture",
  "illustration",
] as const;

export type JazzboardCanvasQuickstartTask =
  (typeof JAZZBOARD_CANVAS_QUICKSTART_TASKS)[number];

export const JAZZBOARD_CANVAS_CAPABILITY_BUNDLES = [
  "quickstart_architecture",
  "quickstart_illustration",
  "core",
  "authoring",
  "architecture",
  "illustration",
  "inspection",
] as const;

export type JazzboardCanvasCapabilityBundle =
  (typeof JAZZBOARD_CANVAS_CAPABILITY_BUNDLES)[number];

const BUNDLE_INDEX = [
  {
    bundle: "quickstart_architecture",
    useWhen: "Starting new relationship-heavy architecture or flow work.",
    call: { bundle: "quickstart_architecture" },
  },
  {
    bundle: "quickstart_illustration",
    useWhen: "Starting new freeform illustration or visual-art work.",
    call: { bundle: "quickstart_illustration" },
  },
  {
    bundle: "authoring",
    useWhen:
      "Exact primitive, color, transparency, point-space, transaction, or update mechanics are needed.",
    call: { bundle: "authoring" },
  },
  {
    bundle: "architecture",
    useWhen:
      "Creating or revising a system, flow, hierarchy, process, or other relationship-heavy Diagram.",
    call: { bundle: "architecture" },
  },
  {
    bundle: "illustration",
    useWhen:
      "Creating a portrait, scene, storyboard, annotation, path-heavy drawing, or layered freeform composition.",
    call: { bundle: "illustration" },
  },
  {
    bundle: "inspection",
    useWhen:
      "Reviewing an exact rendered scope, diagnosing visual defects, or deciding whether work is complete.",
    call: { bundle: "inspection" },
  },
] as const;

const UNIVERSAL_AGENT_PRINCIPLES = [
  "The user's requested meaning, composition, and acceptance criteria control the work.",
  "Read the narrowest authoritative semantic scope and preserve exact revisions before editing.",
  "For every user-visible new multi-object composition, use a progressive draft by default so collaborators see the agent trace each part before one atomic commit. Reserve direct transactions for revision-checked corrections, explicitly instant work, or work with no live audience.",
  "Author at full speed: submit the largest coherent candidate that fits the transaction limits, and never split, pause, or delay draft replacements merely to pace animation. The client presentation queue absorbs rapid cumulative revisions; call finish once and let Jazzboard wait for visible completion internally.",
  "Automatic layout, routing, and deterministic findings are optional evidence, not creative authority.",
  "Preserve deliberate overlap, asymmetry, cropping, routing, spacing, and layering.",
  "A successful mutation or geometry report is not visual QA; inspect the final exact-revision pixels.",
  "On a stale revision, active lease conflict, proposal, or uncertain outcome, re-read instead of retrying blindly.",
] as const;

const CORE_CAPABILITIES = {
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
    },
    createPointSpace: "absolute-canvas",
    persistedDrawingPointSpace: "object-local-canvas-units",
    persistedPathAndPolygonPointSpace: "normalized-object-local-0-to-1",
    connectorPointSpace: "absolute-canvas",
  },
  paintOrder: {
    field: "zIndex",
    minimum: 0,
    maximum: 1_000_000,
    higherValue: "front",
    equalValuePaintOrder: "object-id-ascending",
    omittedCreateValue: "current-maximum-plus-one",
  },
  limits: {
    maximumTransactionOperations: 200,
    maximumDrawingPointsPerStroke: 2_000,
    maximumPathSegments: VECTOR_PATH_LIMITS.maxSegments,
    maximumPolygonPoints: 2_001,
    maximumPathStrokeWidth: VECTOR_PATH_LIMITS.maxStrokeWidth,
    maximumDiagramMembers: 500,
    maximumDiagramConnectors: 500,
    maximumProgressiveDraftRequestBytes: 256 * 1024,
    maximumRetainedProgressiveDraftBytes: 192 * 1024,
    recommendedRetainedDraftHeadroomBytes: 16 * 1024,
  },
  visualInspection: {
    preferredTool: "inspect_canvas_scope",
    visualInspectionRequiresPixelCapture: true,
    framingOrGeometryAloneIsVisualInspection: false,
    recommendedPixelCapture: "execute-pixelCaptureProtocol.copyReady.cleanViewport-and-inspect-inspectionPixels-plus-inspectionRegion",
    pixelCaptureCompletionGate: "inspect_clean_viewport_pixels_and_scoped_region_before_claiming_visual_qa",
    pixelCaptureForbiddenSubstitute: "ordinary_unclean_or_invalidated_full_viewport",
    blankCaptureRecovery:
      "If the clean capture is blank despite visible semantic targets, execute pixelCaptureProtocol.onBlankCapture once: reframe the exact scope, immediately capture the newly returned cleanViewport, and inspect it. Only the second blank or unavailable clean capture is terminal.",
    exactScopes: ["room", "diagram", "objects"],
    roomScopePurpose:
      "Use an exact room revision after adding to an existing board to judge relative scale, whitespace, spatial distribution, and integration with surrounding content.",
    compositionEvidenceAuthority:
      "Relative geometry is descriptive evidence only; it never makes cropping, overlap, isolation, scale, or asymmetry a defect.",
  },
} as const;

const AUTHORING_BUNDLE = {
  purpose:
    "Renderer-neutral mechanics for precise primitive creation, styling, transactions, and revision-guarded updates.",
  useWithCore: true,
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
    text: { defaultBounds: { width: 320, height: 96 } },
    shape: {
      kinds: ["rectangle", "ellipse", "diamond"],
      directDefaultBounds: { width: 260, height: 140 },
      transactionDefaultBounds: { width: 280, height: 152 },
    },
    node: { defaultBounds: { width: 280, height: 152 } },
    image: { defaultBounds: { width: 640, height: 360 } },
    drawing: {
      operation: "create_drawing",
      inputPointSpace: "absolute-canvas",
      persistedPointSpace: "object-local-canvas-units",
    },
    path: {
      operation: "create_path",
      segments: ["line", "quadratic", "cubic"],
      mayClose: true,
      persistedPointSpace: "normalized-object-local-0-to-1",
      styleFields: [
        "fill",
        "stroke",
        "strokeWidth",
        "opacity",
        "lineCap",
        "lineJoin",
        "fillRule",
      ],
      lineCaps: ["butt", "round", "square"],
      lineJoins: ["miter", "round", "bevel"],
      fillRules: ["nonzero", "evenodd"],
    },
    polygon: {
      operation: "create_polygon",
      representation: "closed-path",
      inputPointSpace: "absolute-canvas",
    },
    connector: {
      operation: "connect",
      routingModes: ["auto", "straight", "curved", "elbow"],
    },
  },
  transactions: {
    tool: "apply_canvas_transaction",
    atomic: true,
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
    temporaryReferences: "resolve-within-one-atomic-request",
    diagramMembership: "omitted-infers-created-objects-explicit-arrays-are-exact",
    progressiveDrafts: "create-only-cumulative-replacement",
    preferredVisibleCompositionDelivery: "delivery.mode=draft",
    progressiveDraftAuthority:
      "Draft delivery is visible construction transport, not human review. After the final candidate, the author calls finish_canvas_draft action=commit without requesting user confirmation. Only an outcome=proposed from a room already in review policy creates a human approval boundary.",
    directDeliveryUse:
      "existing-object-corrections-explicitly-instant-work-or-no-live-audience",
    authoringPace: "full-speed-no-animation-driven-chunking-or-pauses",
    presentationPace: "client-local-queued-from-rapid-cumulative-revisions",
    progressiveDraftSizing:
      "The full cumulative candidate is revalidated on every draft replacement. Keep its retained JSON at least 16 KiB below the 192 KiB limit; simplify nonessential detail or use bounded authoritative stages instead of raising safety ceilings.",
  },
  canonicalExamples: {
    structuredPath: {
      tool: "apply_canvas_transaction",
      input: {
        operations: [{
          op: "create_path",
          tempRef: "accent",
          start: { x: 100, y: 240 },
          segments: [
            { kind: "line", to: { x: 180, y: 240 } },
            {
              kind: "quadratic",
              control: { x: 230, y: 160 },
              to: { x: 280, y: 240 },
            },
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
        }],
      },
    },
    normalizedPathUpdate: {
      tool: "update_object",
      input: {
        objectId: "path_example",
        expectedRevision: 3,
        operation: "edit",
        patch: {
          start: { x: 0, y: 0.5 },
          segments: [{
            kind: "quadratic",
            control: { x: 0.5, y: 0 },
            to: { x: 1, y: 0.5 },
          }],
        },
      },
      patchPointSpace: "normalized-object-local-0-to-1",
    },
  },
} as const;

const ARCHITECTURE_BUNDLE = {
  purpose:
    "Intent-led authoring for relationship-heavy diagrams with optional deterministic layout and route evidence.",
  useWithCore: true,
  workflow: [
    "Write a compact visual contract: audience, required entities, relationships, hierarchy, and readability target.",
    "Read the relevant Diagram or neighborhood; do not load unrelated board state.",
    "Stage a user-visible new graph and its Diagram as a progressive create-only draft with stable temporary references; use a direct transaction only for revision-checked corrections or when the user explicitly requests an instant result.",
    "Submit one coherent candidate, or rapid cumulative replacements when semantic reasoning genuinely changes it. Do not subdivide or pause work merely to pace the construction animation.",
    "Choose exact positions, explicit routes, or opt-in layout according to the requested composition.",
    "Read the live draft only when semantic inspection helps, then autonomously finish the latest exact revision once without asking for confirmation. Progressive delivery is animation, not review. Jazzboard waits for visible construction internally; after finish returns applied, run its recommended exact artifact inspection and, when present, its exact whole-room composition inspection. Judge the screenshot crop plus descriptive scale, whitespace, distribution, and surrounding-content facts against user intent, then patch only identified defects. If finish returns proposed, report the true room review boundary without claiming publication.",
  ],
  toolChoices: {
    coherentCreate: "apply_canvas_transaction-with-delivery.mode=draft",
    directCorrection: "apply_canvas_transaction-without-delivery",
    finishProgressiveCreate: "finish_canvas_draft",
    existingGraphRead: "read_diagram-or-read_neighborhood",
    deterministicLayout: "layout_objects-or-one-auto_layout-operation",
    conventionalGeometryEvidence: "analyze_diagram_layout",
    preferredInspection: "inspect_canvas_scope",
  },
  judgment: {
    automaticLayout: "opt-in-only-when-flow-grid-or-hierarchy-matches-intent",
    automaticRouting: "delegates-path-choice-but-does-not-certify-readability",
    explicitRouting: "use-when-ports-curvature-elbows-or-label-position-carry-meaning",
    geometryFindings: "intent-unaware-evidence-not-redesign-permission",
  },
  canonicalExamples: {
    progressiveSystemDiagram: {
      tool: "apply_canvas_transaction",
      input: {
        operations: [
          {
            op: "create_node",
            tempRef: "client",
            label: "Client",
            nodeType: "component",
            x: 80,
            y: 220,
          },
          {
            op: "create_node",
            tempRef: "api",
            label: "API",
            nodeType: "service",
            x: 480,
            y: 220,
          },
          {
            op: "connect",
            tempRef: "request",
            start: {
              tempRef: "client",
              port: { side: "right", position: 0.5, exact: true },
            },
            end: {
              tempRef: "api",
              port: { side: "left", position: 0.5, exact: true },
            },
            direction: "end",
            label: "request",
            routing: { mode: "straight", labelPosition: 0.5 },
          },
          {
            op: "create_diagram",
            tempRef: "system",
            title: "System context",
            diagramType: "architecture",
          },
        ],
        delivery: { mode: "draft" },
      },
      semantics:
        "Omitted Diagram membership infers compatible creates; exact positions and routing preserve this composition. Rapid cumulative replacements may refine the candidate without animation-driven pauses. Then call finish_canvas_draft with action=commit yourself; no user confirmation is needed for progressive delivery. Jazzboard waits for visible completion internally.",
    },
    optionalHierarchyLayout: {
      operation: {
        op: "auto_layout",
        layout: "hierarchy",
        layoutDirection: "right",
        density: "comfortable",
        targets: ["client", "api"],
        diagramTempRef: "system",
      },
      useOnlyWhen:
        "The user's requested architecture is a conventional directed hierarchy and automatic placement is desired.",
    },
  },
} as const;

const ILLUSTRATION_BUNDLE = {
  purpose:
    "Intent-led layered illustration using exact shapes, paths, strokes, transparency, grouping, and paint order.",
  useWithCore: true,
  workflow: [
    "Write a visual brief covering subject, recognizable parts, silhouette, palette, depth, mood, and acceptance criteria.",
    "Plan a small number of semantic layers or named parts while retaining exact object-level control.",
    "Build each user-visible new layer as a progressive create-only draft with native paths and shapes; use a direct transaction only for revision-checked corrections or an explicitly instant result.",
    "Submit coherent layers and rapid cumulative refinements without animation-driven pauses; the client queues visible construction independently of the agent's reasoning pace.",
    "Use exact coordinates, groupId, opacity, and zIndex; omit architecture layout unless the user explicitly requests it.",
    "Autonomously finish the latest exact draft revision without asking for confirmation; progressive delivery is animation, not review. Then run its recommended exact artifact inspection and, when present, exact whole-room composition inspection. Inspect actual committed pixels plus descriptive relative scale, whitespace, distribution, and surrounding-content facts for likeness, silhouette, expression, balance, color, and unintended occlusion, then patch locally.",
  ],
  compositionConvention: {
    container: "custom-Diagram",
    title: "composition-name",
    description: "visual-brief-and-acceptance-criteria",
    category: "medium-or-artifact-kind",
    tags: "style-and-subject-tokens",
    groupId: "namespaced-named-part-or-layer",
    zIndex: "authoritative-layer-order",
    note:
      "This convention uses existing semantic fields; it does not force freeform work through architecture layout rules.",
  },
  judgment: {
    deliberateGeometry: "preserve-overlap-asymmetry-cropping-and-layering",
    deterministicAnalysis: "optional-evidence-for-art",
    pixelInspection: "required-for-final-visual-judgment",
    creativeControl: "agent-chooses-form-style-and-correction-from-user-intent",
  },
  canonicalExamples: {
    layeredPortraitFragment: {
      tool: "apply_canvas_transaction",
      input: {
        operations: [
          {
            op: "create_shape",
            tempRef: "face",
            shape: "ellipse",
            label: "",
            x: 420,
            y: 150,
            width: 150,
            height: 190,
            fill: "#c99372",
            stroke: "#6c4738",
            groupId: "portrait:face",
            zIndex: 20,
          },
          {
            op: "create_path",
            tempRef: "shadow",
            start: { x: 535, y: 175 },
            segments: [{
              kind: "cubic",
              control1: { x: 580, y: 215 },
              control2: { x: 575, y: 285 },
              to: { x: 540, y: 325 },
            }],
            closed: true,
            fill: "#8b5948",
            stroke: "none",
            strokeWidth: 0,
            opacity: 0.28,
            lineCap: "round",
            lineJoin: "round",
            fillRule: "nonzero",
            groupId: "portrait:face",
            zIndex: 21,
          },
          {
            op: "create_diagram",
            tempRef: "portrait",
            title: "Portrait study",
            description:
              "A recognizable, softly modeled portrait with a clear silhouette, subtle expression, and layered atmospheric depth.",
            diagramType: "custom",
            category: "vector-art",
            tags: ["portrait", "layered", "soft-modeling"],
          },
        ],
        delivery: { mode: "draft" },
      },
      next:
        "Replace with the complete cumulative create-only operation list and exact draft revision as quickly as reasoning requires. Then call finish_canvas_draft with action=commit yourself; do not ask for confirmation because progressive delivery is not review. Jazzboard waits for visible construction and commits atomically, after which you perform pixel inspection of the committed result.",
    },
  },
} as const;

const INSPECTION_BUNDLE = {
  purpose:
    "Exact-revision semantic, deterministic, and pixel evidence for issue-focused visual correction.",
  useWithCore: true,
  preferredTool: "inspect_canvas_scope",
  fallbackTools: ["analyze_diagram_layout", "render_canvas_preview"],
  correctionLoop: [
    "Read the exact current scope and requested intent.",
    "Run deterministic checks where they are relevant; treat findings as facts, not design commands.",
    "Frame the exact revision with inspect_canvas_scope when registered.",
    "While validation is active, execute pixelCaptureProtocol.copyReady.cleanViewport. Inspect inspectionPixels as a stable clean canvas, judging the exact inspectionRegion first and surrounding pixels as authorized composition context. Never substitute an ordinary unclean or invalidated viewport.",
    "If the first clean capture is blank despite visible semantic targets, execute pixelCaptureProtocol.onBlankCapture exactly once: reframe the exact scope, immediately capture the newly returned cleanViewport, and inspect it. Only a second blank or unavailable clean capture is terminal.",
    "Inspect the cropped pixels against the visual contract and identify defects by stable object ID.",
    "When work was added to an existing board, inspect the exact room revision at overview once and compare relative scale, whitespace, spatial distribution, and surrounding-content integration against the requested intent.",
    "Patch only the affected region, re-render, and stop after success or bounded stagnation.",
  ],
  coverage: {
    freehandGeometry: "partial",
    vectorPathGeometry: "partial",
    actualPixelsRequiredFor:
      "likeness-hierarchy-readability-color-context-occlusion-and-aesthetic-judgment",
  },
  compositionEvidence: {
    fields: ["framing", "scale", "distribution"],
    scope: "exact-requested-scope-only",
    wholeRoomRequires: "scope.kind=room-with-exact-room-revision",
    authority:
      "descriptive-axis-aligned-bounds-context-only-never-an-automatic-quality-verdict-or-layout-trigger",
    caveats: [
      "median-area-ratios-are-selection-sensitive-in-heterogeneous-scenes",
      "nearest-neighbor-center-distance-is-not-edge-clearance",
      "centers-and-quadrants-do-not-measure-visual-weight-or-intent",
    ],
  },
  canonicalExamples: {
    diagramScope: {
      tool: "inspect_canvas_scope",
      input: {
        scope: {
          kind: "diagram",
          diagramId: "diagram_system",
          expectedRevision: 4,
        },
        padding: 24,
      },
    },
    objectScope: {
      tool: "inspect_canvas_scope",
      input: {
        scope: {
          kind: "objects",
          targets: [
            { objectId: "path_face", expectedRevision: 3 },
            { objectId: "path_hair", expectedRevision: 2 },
          ],
        },
        padding: 24,
      },
    },
    roomCompositionScope: {
      tool: "inspect_canvas_scope",
      input: {
        scope: { kind: "room", expectedRevision: 12 },
        padding: 24,
        representation: "overview",
      },
      useWhen:
        "An artifact was added to an existing board and final relative scale or integration needs judgment.",
    },
    pixelCapture:
      "Execute pixelCaptureProtocol.copyReady.cleanViewport while validation.activeSelector exists; inspect inspectionPixels, the exact inspectionRegion, and surrounding authorized clean-canvas context. If the clean capture is unexpectedly blank, execute onBlankCapture once and inspect the newly returned clean viewport before reporting unavailable. The JSON result alone and an ordinary unclean or invalidated viewport are not visual QA.",
  },
} as const;

type CapabilityAuthority = Readonly<{
  currentPageToolRegistryIsAuthoritative: true;
  serverAuthorizationAndValidationRemainAuthoritative: true;
  bundlesAreGuidanceNotPermissions: true;
  roleCanMutateCanvas: boolean;
  exactRevisionsGuardExistingEntityEdits: true;
}>;

type CapabilityEnvelope<
  TBundle extends JazzboardCanvasCapabilityBundle,
  TData,
> = Readonly<{
  schemaVersion: 2;
  bundle: TBundle;
  role: JazzboardWebMcpBinding["role"];
  authority: CapabilityAuthority;
  data: TData;
}>;

export type JazzboardCanvasCapabilities =
  | CapabilityEnvelope<"quickstart_architecture", JazzboardCanvasQuickstart>
  | CapabilityEnvelope<"quickstart_illustration", JazzboardCanvasQuickstart>
  | CapabilityEnvelope<"core", Readonly<{
      bundleIndex: typeof BUNDLE_INDEX;
      universalAgentPrinciples: typeof UNIVERSAL_AGENT_PRINCIPLES;
      coordinateSystem: typeof CORE_CAPABILITIES.coordinateSystem;
      paintOrder: typeof CORE_CAPABILITIES.paintOrder;
      limits: typeof CORE_CAPABILITIES.limits;
      visualInspection: typeof CORE_CAPABILITIES.visualInspection;
    }>>
  | CapabilityEnvelope<"authoring", typeof AUTHORING_BUNDLE>
  | CapabilityEnvelope<"architecture", typeof ARCHITECTURE_BUNDLE>
  | CapabilityEnvelope<"illustration", typeof ILLUSTRATION_BUNDLE>
  | CapabilityEnvelope<"inspection", typeof INSPECTION_BUNDLE>;

export type JazzboardCanvasQuickstart = Readonly<{
  schemaVersion: 1;
  task: JazzboardCanvasQuickstartTask;
  role: JazzboardWebMcpBinding["role"];
  roleCanMutateCanvas: boolean;
  purpose: string;
  fastPath: readonly string[];
  transactionContract: Readonly<{
    tool: "apply_canvas_transaction";
    delivery: Readonly<{ mode: "draft" }>;
    responseDetail: "concise";
    operationLimit: 200;
    metadataPlacement: string;
    schemaAuthority: string;
  }>;
  draftPreflight: Readonly<{
    field: "draftValidation";
    authority: string;
    correction: string;
  }>;
  canonicalDraftSkeleton: Readonly<Record<string, unknown>>;
  readabilityHeuristics: readonly string[];
  completion: Readonly<{
    tool: "finish_canvas_draft";
    action: "commit";
    confirmationRequired: false;
    finalInspection: "inspect_canvas_scope";
  }>;
  escalation: Readonly<{
    capabilityTool: "get_canvas_capabilities";
    useOnlyWhen: string;
  }>;
}>;

const QUICKSTART_CANONICAL_DRAFT_SKELETON = {
  operations: [
    {
      op: "create_node",
      tempRef: "source",
      label: "Source",
      semanticName: "Source",
      semanticRole: "architecture.source",
      nodeType: "component",
      x: 80,
      y: 180,
      width: 160,
      height: 72,
    },
    {
      op: "create_node",
      tempRef: "target",
      label: "Target",
      semanticName: "Target",
      semanticRole: "architecture.target",
      nodeType: "service",
      x: 480,
      y: 180,
      width: 160,
      height: 72,
    },
    {
      op: "connect",
      tempRef: "source_to_target",
      semanticName: "Source requests Target",
      semanticRole: "architecture.request",
      start: { tempRef: "source", port: { side: "right", position: 0.5, exact: true } },
      end: { tempRef: "target", port: { side: "left", position: 0.5, exact: true } },
      direction: "end",
      label: "request",
      routing: { mode: "straight", labelPosition: 0.5 },
    },
    {
      op: "create_diagram",
      tempRef: "diagram",
      title: "System flow",
      description: "Source-to-target request flow.",
      diagramType: "architecture",
      category: "system",
      tags: ["request-flow"],
      members: [{ tempRef: "source" }, { tempRef: "target" }],
      connectors: [{ tempRef: "source_to_target" }],
    },
  ],
  delivery: { mode: "draft" },
  responseDetail: "concise",
  intent: "Create the requested system flow.",
  summary: "Two semantic nodes and one labeled directed relationship.",
} as const;

function authority(role: JazzboardWebMcpBinding["role"]): CapabilityAuthority {
  return {
    currentPageToolRegistryIsAuthoritative: true,
    serverAuthorizationAndValidationRemainAuthoritative: true,
    bundlesAreGuidanceNotPermissions: true,
    roleCanMutateCanvas: role === "participant",
    exactRevisionsGuardExistingEntityEdits: true,
  };
}

function canvasCapabilities(
  role: JazzboardWebMcpBinding["role"],
  bundle: JazzboardCanvasCapabilityBundle,
): JazzboardCanvasCapabilities {
  const envelope = {
    schemaVersion: 2 as const,
    bundle,
    role,
    authority: authority(role),
  };
  if (bundle === "quickstart_architecture") {
    return { ...envelope, bundle, data: canvasQuickstart(role, "architecture") };
  }
  if (bundle === "quickstart_illustration") {
    return { ...envelope, bundle, data: canvasQuickstart(role, "illustration") };
  }
  if (bundle === "core") {
    return {
      ...envelope,
      bundle,
      data: {
        bundleIndex: BUNDLE_INDEX,
        universalAgentPrinciples: UNIVERSAL_AGENT_PRINCIPLES,
        ...CORE_CAPABILITIES,
      },
    };
  }
  if (bundle === "authoring") {
    return { ...envelope, bundle, data: AUTHORING_BUNDLE };
  }
  if (bundle === "architecture") {
    return { ...envelope, bundle, data: ARCHITECTURE_BUNDLE };
  }
  if (bundle === "illustration") {
    return { ...envelope, bundle, data: ILLUSTRATION_BUNDLE };
  }
  return { ...envelope, bundle, data: INSPECTION_BUNDLE };
}

function canvasQuickstart(
  role: JazzboardWebMcpBinding["role"],
  task: JazzboardCanvasQuickstartTask,
): JazzboardCanvasQuickstart {
  return {
    schemaVersion: 1,
    task,
    role,
    roleCanMutateCanvas: role === "participant",
    purpose:
      `Fast complete path for new ${task} work. Use this response instead of preloading core, authoring, and inspection bundles.`,
    fastPath: [
      "Read only the exact existing Diagram, neighborhood, or region that affects the requested work; skip a room-wide read for a clearly empty target area.",
      "Submit one full-speed coherent create-only candidate with stable tempRefs, one first-class Diagram, delivery.mode=draft, and responseDetail=concise. Do not split work to pace the visible animation.",
      "Check draftValidation before finishing. Correct only unintended findings with an exact-revision updateMode=patch containing the affected stable tempRefs, then recheck the new receipt. Use updateMode=replace only to remove or fully replace candidate content; deliberate overlap, routing, cropping, and asymmetry remain valid.",
      "Call finish_canvas_draft once with action=commit and the latest exact draft revision. No user confirmation is required.",
      "Use the returned recommended inspect_canvas_scope request, inspect the exact cropped pixels, and make only evidence-backed direct corrections.",
      "If the first clean capture is blank despite visible semantic targets, follow pixelCaptureProtocol.onBlankCapture once: reframe the exact scope, immediately capture the newly returned cleanViewport, and inspect it before reporting pixel inspection unavailable.",
    ],
    transactionContract: {
      tool: "apply_canvas_transaction",
      delivery: { mode: "draft" },
      responseDetail: "concise",
      operationLimit: 200,
      metadataPlacement:
        "Root fields are only operations, delivery, responseDetail, intent, and summary; expectedRoomRevision is not accepted. intent and summary belong at transaction top level; semanticName and semanticRole belong on supported create operations. nodeMetadata is only for decision/open_question lifecycle state and must be omitted for ordinary service/component/requirement nodes.",
      schemaAuthority:
        "The registered apply_canvas_transaction input schema is authoritative. Do not invent operation fields; follow actionable recovery instead of retrying blindly.",
    },
    draftPreflight: {
      field: "draftValidation",
      authority:
        "Intent-unaware deterministic evidence only; it must never override the requested composition or deliberate geometry.",
      correction:
        "When an unintended fail or warning is present, patch the unpublished draft and recheck the new receipt before finish; otherwise preserve the candidate and continue.",
    },
    canonicalDraftSkeleton: QUICKSTART_CANONICAL_DRAFT_SKELETON,
    readabilityHeuristics: [
      "On the first draft call, use delivery={mode:draft} only. Never supply draftId without expectedDraftRevision; both are required only for an exact-revision patch or replacement.",
      "Connector ports are objects shaped as {side:left|right|top|bottom, position:0..1, exact:boolean}; a side string alone is invalid.",
      "A curved connector must include bend with absolute value at least 8 canvas units. Use straight or elbow when no deliberate curve is needed; elbow may include elbowMidPoint from 0..1.",
      "Leave a measurable labeled corridor between nodes. Typical one-word labels need about 90-110 canvas units of clear gap and longer labels such as replication need roughly 135+; 40-75 unit gaps commonly put label bounds inside endpoint nodes. These are planning facts, not enforced layout.",
      "Use distinct attachment positions or route lanes when several connectors share one side. This is evidence for agent judgment, never mandatory layout.",
      "Do not finish while draftValidation still reports an unintended fail. Patch only the affected node or connector tempRefs with the exact draft revision, then inspect the replacement receipt.",
      "When the user's acceptance criteria explicitly forbid collisions, intrusion, or ambiguous routing, every corresponding draftValidation warning or failure is a blocker. Patch it before finish rather than treating warning status as permission to publish. This does not apply to creative work that intentionally overlaps.",
    ],
    completion: {
      tool: "finish_canvas_draft",
      action: "commit",
      confirmationRequired: false,
      finalInspection: "inspect_canvas_scope",
    },
    escalation: {
      capabilityTool: "get_canvas_capabilities",
      useOnlyWhen:
        `Call at most the ${task} bundle when an unfamiliar mechanic is genuinely needed, or the quick path is rejected with actionable recovery. Do not preload multiple bundles.`,
    },
  };
}

function invalidInput(details?: Record<string, unknown>): JazzboardToolFailure {
  return withActionableRecovery({
    ok: false,
    tool: "get_canvas_capabilities",
    error: {
      code: "INVALID_TOOL_INPUT",
      message:
        "get_canvas_capabilities accepts only a listed quickstart or capability bundle.",
      ...(details ? { details } : {}),
    },
  });
}

function parseBundle(rawInput: unknown):
  | { ok: true; bundle: JazzboardCanvasCapabilityBundle }
  | { ok: false; failure: JazzboardToolFailure } {
  if (
    rawInput === null ||
    typeof rawInput !== "object" ||
    Array.isArray(rawInput)
  ) {
    return { ok: false, failure: invalidInput() };
  }
  const record = rawInput as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => key !== "bundle")) {
    return {
      ok: false,
      failure: invalidInput({ unexpectedFields: keys.filter((key) => key !== "bundle") }),
    };
  }
  if (record.bundle === undefined) return { ok: true, bundle: "core" };
  if (
    typeof record.bundle !== "string" ||
    !JAZZBOARD_CANVAS_CAPABILITY_BUNDLES.includes(
      record.bundle as JazzboardCanvasCapabilityBundle,
    )
  ) {
    return { ok: false, failure: invalidInput({ bundle: record.bundle }) };
  }
  return {
    ok: true,
    bundle: record.bundle as JazzboardCanvasCapabilityBundle,
  };
}

export function createJazzboardCanvasCapabilityWebMcpTools(
  binding: JazzboardWebMcpBinding,
): WebMCP.ModelContextTool[] {
  return [{
    name: "get_canvas_capabilities",
    title: "Read a Jazzboard canvas capability bundle",
    description:
      "Start new work with one quickstart bundle; do not preload others. Deeper bundles are for recovery. Guidance never grants permissions.",
    inputSchema: {
      type: "object",
      properties: {
        bundle: {
          type: "string",
          enum: JAZZBOARD_CANVAS_CAPABILITY_BUNDLES,
          description: "Prefer one quickstart; omission defaults to core.",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    async execute(rawInput): Promise<JazzboardToolResult<JazzboardCanvasCapabilities>> {
      const parsed = parseBundle(rawInput);
      if (!parsed.ok) return parsed.failure;
      return {
        ok: true,
        tool: "get_canvas_capabilities",
        data: canvasCapabilities(binding.role, parsed.bundle),
      };
    },
  }];
}
