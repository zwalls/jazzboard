import {
  CANVAS_PREVIEW_LIMITS,
  CanvasPreviewError,
  finalizeCanvasSceneContext,
  type CanvasPresentationArtifact,
  type CanvasPreviewPresenter,
  type CanvasPreviewTransportAdapter,
} from "./canvas-preview";
import { disposeLiveCanvasPreviews } from "./live-canvas-preview";

function serializedByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function stabilizeInspectionResultByteLength<
  Result extends { data: { resultSerialization: { byteLength: number } } },
>(result: Result): number {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const byteLength = serializedByteLength(result);
    if (result.data.resultSerialization.byteLength === byteLength) return byteLength;
    result.data.resultSerialization.byteLength = byteLength;
  }
  return serializedByteLength(result);
}

function assertInspectionResultByteBudget(
  result: { data: { resultSerialization: { byteLength: number } } },
): void {
  if (result.data.resultSerialization.byteLength <= CANVAS_PREVIEW_LIMITS.maxInspectionResultBytes) return;
  throw new CanvasPreviewError(
    "PREVIEW_INSPECTION_RESULT_TOO_LARGE",
    "The complete serialized inspect_canvas_scope result exceeds its byte budget; use overview or inspect a smaller focus scope.",
    {
      byteLength: result.data.resultSerialization.byteLength,
      maxBytes: CANVAS_PREVIEW_LIMITS.maxInspectionResultBytes,
    },
  );
}

/** Turns a framed live-canvas region into a bounded browser screenshot handoff. */
export class InRoomCanvasPreviewTransport implements CanvasPreviewTransportAdapter {
  async emit(
    input: CanvasPresentationArtifact,
    present: CanvasPreviewPresenter,
    signal: AbortSignal,
    toolName: "render_canvas_preview" | "inspect_canvas_scope" = "render_canvas_preview",
  ): Promise<unknown> {
    const presentation = await present(input, signal);
    const {
      source,
      renderedBounds,
      visualQuality,
      inspectionEvidence,
      ...metadata
    } = input.metadata;
    const geometryCoverageStatus = visualQuality?.geometryCoverage.status
      ?? (toolName === "inspect_canvas_scope"
        ? inspectionEvidence?.coverage.geometry ?? "not_applicable"
        : "not_applicable");
    const geometryQualityStatus = visualQuality?.status === "fail"
      ? "fail"
      : visualQuality && geometryCoverageStatus === "complete"
        ? visualQuality.status
        : "unknown";
    const unsupportedGeometry = [
      visualQuality?.geometryCoverage.unsupportedDrawObjectCount
        ? "freehand strokes"
        : null,
      visualQuality?.geometryCoverage.unsupportedPathObjectCount
        ? "vector paths"
        : null,
    ].filter((value): value is string => Boolean(value));
    const unsupportedGeometryLabel = unsupportedGeometry.length
      ? unsupportedGeometry.join(" and/or ")
      : "unsupported geometry";
    const blankCaptureReframe = source.kind === "room"
      ? {
          tool: "inspect_canvas_scope" as const,
          arguments: {
            scope: { kind: "room" as const, expectedRevision: source.expectedRevision },
            representation: "overview" as const,
          },
        }
      : source.kind === "diagram"
        ? {
            tool: "render_canvas_preview" as const,
            arguments: {
              scope: {
                kind: "diagram" as const,
                diagramId: source.diagramId,
                expectedRevision: source.expectedRevision,
              },
            },
          }
        : {
            tool: "render_canvas_preview" as const,
            arguments: {
              scope: {
                kind: "objects" as const,
                targets: source.targets,
              },
            },
          };
    const pixelCaptureProtocol = {
      schemaVersion: 4 as const,
      capture: "non_mutating_direct_clip_or_full_viewport_crop_while_validation_is_active" as const,
      crop: "use_screenshotClip_in_viewport_css_pixels" as const,
      reason: "A documented non-mutating browser clip is the fastest exact capture. Full-viewport capture plus in-memory crop remains the compatibility fallback.",
      copyReady: {
        preferredPath: "directClip" as const,
        directClip: {
          precondition: "browser_screenshot_clip_is_documented_as_non_mutating" as const,
          action: "browser_screenshot" as const,
          arguments: {
            clip: {
              x: presentation.clip.x,
              y: presentation.clip.y,
              width: presentation.clip.width,
              height: presentation.clip.height,
            },
          },
          resultReference: "inspectionPixels" as const,
        },
        fallbackPath: "fullViewportCrop" as const,
        browserCapture: {
          action: "browser_screenshot" as const,
          arguments: { fullPage: false as const },
          resultReference: "fullViewportPixels" as const,
        },
        crop: {
          action: "crop_image_in_memory" as const,
          sourceReference: "fullViewportPixels" as const,
          rectangle: presentation.clip,
          resultReference: "inspectionPixels" as const,
        },
        inspect: {
          action: "inspect_image_pixels" as const,
          sourceReference: "inspectionPixels" as const,
        },
      },
      completionGate: "inspect_cropped_pixels_before_claiming_visual_qa" as const,
      forbiddenSubstitutions: [
        "uncropped_full_viewport",
        "framing_metadata_without_pixels",
        "stale_or_replacement_inspection",
      ] as const,
      onBlankCapture: {
        classification: "invalid_or_stale_capture_not_successful_inspection" as const,
        trigger:
          "The exact captured clip contains no expected canvas ink even though the validated semantic scope contains visible objects.",
        retryLimit: 1 as const,
        steps: [
          {
            step: "reframe_exact_scope" as const,
            action: "call_webmcp_tool" as const,
            ...blankCaptureReframe,
            resultReference: "reframedInspection" as const,
          },
          {
            step: "capture_new_returned_clip_immediately" as const,
            action: "browser_screenshot" as const,
            argumentsPath:
              "reframedInspection.data.pixelCaptureProtocol.copyReady.directClip.arguments" as const,
            precondition:
              "browser_screenshot_clip_is_documented_as_non_mutating" as const,
            resultReference: "recoveredInspectionPixels" as const,
          },
          {
            step: "inspect_recovered_pixels" as const,
            action: "inspect_image_pixels" as const,
            sourceReference: "recoveredInspectionPixels" as const,
          },
        ],
        terminalFailure:
          "Only if the second exact capture is still blank or unavailable, report pixel inspection unavailable. Do not loop, infer pixels from metadata, or claim visual QA passed.",
      },
      onCaptureUnavailable:
        "If capture is blank despite visible semantic targets, execute onBlankCapture first. Otherwise report that exact pixel inspection is unavailable; do not claim that visual QA passed and do not infer pixels from geometry metadata.",
    } as const;
    const pixels = {
      delivery: "host_capture_required" as const,
      nativeImageResultSupported: false as const,
      clip: presentation.clip,
      validationSelector: presentation.validation?.activeSelector ?? null,
      expiresAt: presentation.expiresAt,
      action: {
        required: true as const,
        protocolPath: "data.pixelCaptureProtocol" as const,
        completionGate: "inspect_cropped_pixels_before_claiming_visual_qa" as const,
      },
      visualInspectionStatus: "not_performed" as const,
    };
    const nextStep = geometryCoverageStatus === "partial"
      ? visualQuality?.status === "fail"
        ? `Supported deterministic geometry already has a known failure and ${unsupportedGeometryLabel} coverage is partial. Fix every finding, rerun exact-revision analysis, then frame the live canvas again and inspect all pixels including unsupported geometry; framing itself is not visual QA.`
        : `Deterministic geometry coverage is partial because ${unsupportedGeometryLabel} require pixel inspection; report.status is not a complete geometry certification. Execute pixelCaptureProtocol.copyReady before expiresAt or invalidation: prefer directClip when the browser documents a non-mutating clip capture, otherwise use fullViewportCrop. Inspect only inspectionPixels for readability, crossings, clearance, endpoints, and labels. Do not substitute the uncropped viewport. If the exact capture is blank despite visible semantic targets, execute onBlankCapture once and inspect the new returned clip. Revise and repeat when needed.`
      : "Framing is not visual QA. Execute pixelCaptureProtocol.copyReady before expiresAt or invalidation: prefer directClip when the browser documents a non-mutating clip capture, otherwise use fullViewportCrop. Inspect only inspectionPixels for readability, crossings, clearance, endpoints, and labels. Do not substitute the uncropped viewport or report visual QA as passed from JSON alone. If the exact capture is blank despite visible semantic targets, execute pixelCaptureProtocol.onBlankCapture once: reframe the exact scope and immediately capture the new returned directClip. Only if that second exact capture is still blank or unavailable, report pixel inspection unavailable.";
    const clipInvalidatedBy = [
      "viewport_change",
      "window_resize",
      "window_scroll",
      "document_change",
      "visual_contributor_revision_change",
      "inspection_replacement",
      "inspection_timeout",
      "room_unmount",
    ];

    if (toolName === "inspect_canvas_scope") {
      if (!inspectionEvidence) {
        throw new CanvasPreviewError(
          "PREVIEW_INSPECTION_EVIDENCE_UNAVAILABLE",
          "The active renderer did not provide bounded inspection evidence.",
        );
      }
      const sceneContext = finalizeCanvasSceneContext(inspectionEvidence, pixels);
      // Keep inspection siblings bounded and non-duplicative. Exact revisions,
      // bounds, findings, and pixel metadata live in sceneContext; the result
      // envelope retains only framing protocol/status fields needed by hosts.
      const result = {
        ok: true as const,
        tool: toolName,
        data: {
          previewId: presentation.previewId,
          presentation: "live_canvas" as const,
          screenshotClip: presentation.clip,
          pixelCaptureProtocol,
          expiresAt: presentation.expiresAt,
          clipInvalidatedBy,
          validation: presentation.validation ?? null,
          visualInspectionStatus: "not_performed" as const,
          geometryQualityStatus,
          geometryCoverageStatus,
          sceneContext,
          nextStep,
          resultSerialization: {
            byteLength: 0,
            byteLimit: CANVAS_PREVIEW_LIMITS.maxInspectionResultBytes,
          },
        },
      };
      stabilizeInspectionResultByteLength(result);
      assertInspectionResultByteBudget(result);
      return result;
    }

    return {
      ok: true,
      tool: toolName,
      data: {
        previewId: presentation.previewId,
        presentation: "live_canvas",
        screenshotClip: presentation.clip,
        pixelCaptureProtocol,
        expiresAt: presentation.expiresAt,
        clipInvalidatedBy,
        validation: presentation.validation ?? null,
        visualInspectionStatus: "not_performed",
        geometryQualityStatus,
        geometryCoverageStatus,
        visualQuality,
        semanticEvidence: inspectionEvidence ?? null,
        ...metadata,
        pageBounds: renderedBounds,
        scope:
          source.kind === "objects"
            ? { kind: source.kind }
            : source.kind === "room"
              ? { kind: source.kind, expectedRevision: source.expectedRevision }
            : {
                kind: source.kind,
                diagramId: source.diagramId,
                expectedRevision: source.expectedRevision,
              },
        sourceRevisions: {
          roomRevision: source.roomRevision,
          diagramRevision: source.kind === "diagram" ? source.expectedRevision : null,
          objects: source.objectRevisions,
          visualContributors: source.visualContributorRevisions ?? source.objectRevisions,
        },
        targets: source.objectRevisions,
        nextStep,
      },
    };
  }

  dispose(): void {
    disposeLiveCanvasPreviews();
  }
}
