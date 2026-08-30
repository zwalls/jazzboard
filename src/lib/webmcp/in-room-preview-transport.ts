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
    const pixels = {
      delivery: "host_capture_required" as const,
      nativeImageResultSupported: false as const,
      clip: presentation.clip,
      validationSelector: presentation.validation?.activeSelector ?? null,
      expiresAt: presentation.expiresAt,
      visualInspectionStatus: "not_performed" as const,
    };
    const nextStep = geometryCoverageStatus === "partial"
      ? visualQuality?.status === "fail"
        ? `Supported deterministic geometry already has a known failure and ${unsupportedGeometryLabel} coverage is partial. Fix every finding, rerun exact-revision analysis, then frame the live canvas again and inspect all pixels including unsupported geometry; framing itself is not visual QA.`
        : `Deterministic geometry coverage is partial because ${unsupportedGeometryLabel} require pixel inspection; report.status is not a complete geometry certification. Framing is not visual QA. Before expiresAt or invalidation, capture the full clean viewport while validation.activeSelector exists, crop those pixels to screenshotClip, inspect unsupported geometry for readability, crossings, clearance, endpoints, and labels, then revise and repeat when needed.`
      : "Framing is not visual QA. Before expiresAt or invalidation, capture the full clean viewport while validation.activeSelector exists, crop those pixels to screenshotClip, inspect readability, crossings, clearance, endpoints, and labels, then revise and repeat when needed. Do not report visual QA as passed from this JSON result alone.";
    const pixelCaptureProtocol = {
      capture: "full_viewport_while_validation_selector_is_active",
      crop: "crop_the_captured_pixels_to_screenshotClip_in_viewport_css_pixels",
      reason: "Direct clipped browser captures can transiently perturb viewport geometry; full-viewport capture preserves the exact framed camera.",
    } as const;
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
