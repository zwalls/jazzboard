import type {
  CanvasPresentationArtifact,
  CanvasPreviewPresenter,
  CanvasPreviewTransportAdapter,
} from "./canvas-preview";
import { disposeLiveCanvasPreviews } from "./live-canvas-preview";

/** Turns a framed live-canvas region into a bounded browser screenshot handoff. */
export class InRoomCanvasPreviewTransport implements CanvasPreviewTransportAdapter {
  async emit(
    input: CanvasPresentationArtifact,
    present: CanvasPreviewPresenter,
    signal: AbortSignal,
    toolName: "render_canvas_preview" | "inspect_canvas_scope" = "render_canvas_preview",
  ): Promise<unknown> {
    const presentation = await present(input, signal);
    const { source, renderedBounds, visualQuality, ...metadata } = input.metadata;
    const geometryCoverageStatus = visualQuality?.geometryCoverage.status ?? "not_applicable";
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
    return {
      ok: true,
      tool: toolName,
      data: {
        previewId: presentation.previewId,
        presentation: "live_canvas",
        screenshotClip: presentation.clip,
        pixelCaptureProtocol: {
          capture: "full_viewport_while_validation_selector_is_active",
          crop: "crop_the_captured_pixels_to_screenshotClip_in_viewport_css_pixels",
          reason: "Direct clipped browser captures can transiently perturb viewport geometry; full-viewport capture preserves the exact framed camera.",
        },
        expiresAt: presentation.expiresAt,
        clipInvalidatedBy: [
          "viewport_change",
          "window_resize",
          "window_scroll",
          "document_change",
          "visual_contributor_revision_change",
          "inspection_replacement",
          "inspection_timeout",
          "room_unmount",
        ],
        validation: presentation.validation ?? null,
        visualInspectionStatus: "not_performed",
        geometryQualityStatus,
        geometryCoverageStatus,
        visualQuality,
        semanticEvidence: input.metadata.inspectionEvidence ?? null,
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
        nextStep: geometryCoverageStatus === "partial"
          ? visualQuality?.status === "fail"
            ? `Supported deterministic geometry already has a known failure and ${unsupportedGeometryLabel} coverage is partial. Fix every finding, rerun exact-revision analysis, then frame the live canvas again and inspect all pixels including unsupported geometry; framing itself is not visual QA.`
            : `Deterministic geometry coverage is partial because ${unsupportedGeometryLabel} require pixel inspection; report.status is not a complete geometry certification. Framing is not visual QA. Before expiresAt or invalidation, capture the full clean viewport while validation.activeSelector exists, crop those pixels to screenshotClip, inspect unsupported geometry for readability, crossings, clearance, endpoints, and labels, then revise and repeat when needed.`
          : "Framing is not visual QA. Before expiresAt or invalidation, capture the full clean viewport while validation.activeSelector exists, crop those pixels to screenshotClip, inspect readability, crossings, clearance, endpoints, and labels, then revise and repeat when needed. Do not report visual QA as passed from this JSON result alone.",
      },
    };
  }

  dispose(): void {
    disposeLiveCanvasPreviews();
  }
}
