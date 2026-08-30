import type {
  CanvasPreviewArtifact,
  CanvasPreviewPresenter,
  CanvasPreviewTransportAdapter,
} from "./canvas-preview";

/** Turns a framed live-canvas region into a bounded browser screenshot handoff. */
export class InRoomCanvasPreviewTransport implements CanvasPreviewTransportAdapter {
  async emit(
    input: CanvasPreviewArtifact,
    present: CanvasPreviewPresenter,
    signal: AbortSignal,
  ): Promise<unknown> {
    const presentation = await present(input, signal);
    const { source, renderedBounds, visualQuality, ...metadata } = input.metadata;
    const geometryCoverageStatus = visualQuality?.geometryCoverage.status ?? "not_applicable";
    const geometryQualityStatus = visualQuality?.status === "fail"
      ? "fail"
      : visualQuality && geometryCoverageStatus === "complete"
        ? visualQuality.status
        : "unknown";
    return {
      ok: true,
      tool: "render_canvas_preview",
      data: {
        previewId: presentation.previewId,
        presentation: "live_canvas",
        screenshotClip: presentation.clip,
        expiresAt: presentation.expiresAt,
        clipInvalidatedBy: ["viewport_change", "window_resize", "scope_revision_change"],
        visualInspectionStatus: "not_performed",
        geometryQualityStatus,
        geometryCoverageStatus,
        visualQuality,
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
        },
        targets: source.objectRevisions,
        nextStep: geometryCoverageStatus === "partial"
          ? visualQuality?.status === "fail"
            ? "Supported deterministic geometry already has a known failure and freehand stroke coverage is partial. Fix every finding, rerun exact-revision analysis, then frame the live canvas again and inspect all pixels including unsupported strokes; framing itself is not visual QA."
            : "Deterministic geometry coverage is partial because freehand drawing strokes require pixel inspection; report.status is not a complete geometry certification. Framing is not visual QA. Immediately capture the live canvas with screenshotClip before expiresAt or any viewport, window, or scope-revision change, inspect all returned pixels including those strokes for readability, crossings, clearance, endpoints, and labels, then revise and repeat when needed."
          : "Framing is not visual QA. Immediately capture the live canvas with screenshotClip before expiresAt or any viewport, window, or scope-revision change, inspect the returned pixels for readability, crossings, clearance, endpoints, and labels, then revise and repeat when needed. Do not report visual QA as passed from this JSON result alone.",
      },
    };
  }
}
