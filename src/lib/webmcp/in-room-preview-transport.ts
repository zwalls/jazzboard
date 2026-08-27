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
    const { source, renderedBounds, ...metadata } = input.metadata;
    return {
      ok: true,
      tool: "render_canvas_preview",
      data: {
        previewId: presentation.previewId,
        screenshotClip: presentation.clip,
        expiresAt: presentation.expiresAt,
        ...metadata,
        pageBounds: renderedBounds,
        scope:
          source.kind === "objects"
            ? { kind: source.kind }
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
        nextStep:
          "Capture a browser screenshot using screenshotClip before expiresAt; the clip contains only the rendered preview image.",
      },
    };
  }
}
