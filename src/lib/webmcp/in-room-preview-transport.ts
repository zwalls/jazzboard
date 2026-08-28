import type {
  CanvasPreviewArtifact,
  CanvasPreviewPresenter,
  CanvasPreviewTransportAdapter,
} from "./canvas-preview";

/**
 * Turns a painted, local-only preview presentation into the bounded JSON
 * handoff used by a vision-capable browser agent's screenshot step.
 */
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
        screenshotClip: presentation.clip,
        expiresAt: presentation.expiresAt,
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
            ? "Supported deterministic geometry already has a known failure and freehand stroke coverage is partial. Fix every finding, rerun exact-revision analysis, then render again and inspect all preview pixels including unsupported strokes; rendering itself is not visual QA."
            : "Deterministic geometry coverage is partial because freehand drawing strokes require pixel inspection; report.status is not a complete geometry certification. Rendering is not visual QA. Capture a browser screenshot using screenshotClip before expiresAt, inspect all returned pixels including those strokes for readability, crossings, clearance, endpoints, and labels, then revise and repeat when needed."
          : "Rendering is not visual QA. Capture a browser screenshot using screenshotClip before expiresAt, inspect the returned pixels for readability, crossings, clearance, endpoints, and labels, then revise and repeat when needed. Do not report visual QA as passed from this JSON result alone.",
      },
    };
  }
}
