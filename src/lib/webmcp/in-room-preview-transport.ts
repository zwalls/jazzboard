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
      schemaVersion: 5 as const,
      capture: "stable_clean_viewport_while_validation_is_active" as const,
      crop: "screenshotClip_is_the_scoped_inspection_region_within_clean_viewport_pixels" as const,
      reason: "A clean full-viewport capture keeps responsive canvas geometry stable, avoids clipped-capture reflow, and requires no external image-cropping library. The exact screenshotClip remains the primary inspection region; surrounding clean canvas is composition context.",
      copyReady: {
        preferredPath: "cleanViewport" as const,
        cleanViewport: {
          precondition: "validation_active_and_clean_canvas_presentation" as const,
          action: "browser_screenshot" as const,
          arguments: { fullPage: false as const },
          resultReference: "inspectionPixels" as const,
          inspectionRegion: presentation.clip,
          surroundingPixels:
            "authorized_clean_canvas_composition_context_not_a_substitute_for_inspecting_inspectionRegion" as const,
        },
        compatibilityPath: "directClip" as const,
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
      completionGate: "inspect_clean_viewport_pixels_and_scoped_region_before_claiming_visual_qa" as const,
      forbiddenSubstitutions: [
        "ordinary_unclean_or_invalidated_full_viewport",
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
            step: "capture_new_clean_viewport_immediately" as const,
            action: "browser_screenshot" as const,
            argumentsPath:
              "reframedInspection.data.pixelCaptureProtocol.copyReady.cleanViewport.arguments" as const,
            precondition:
              "reframedInspection.data.validation.activeSelector_is_still_active" as const,
            resultReference: "recoveredInspectionPixels" as const,
          },
          {
            step: "inspect_recovered_pixels" as const,
            action: "inspect_image_pixels" as const,
            sourceReference: "recoveredInspectionPixels" as const,
          },
        ],
        terminalFailure:
          "Only if the second clean capture is still blank or unavailable, report pixel inspection unavailable. Do not loop, infer pixels from metadata, or claim visual QA passed.",
      },
      onCaptureUnavailable:
        "If the clean capture is blank despite visible semantic targets, execute onBlankCapture first. Otherwise report that exact pixel inspection is unavailable; do not claim that visual QA passed and do not infer pixels from geometry metadata.",
    } as const;
    // Some agent hosts preserve scalar strings but collapse nested tool-result
    // objects in their default display. Keep the complete structured protocol
    // above, and duplicate only its preferred executable path as bounded JSON
    // so a caller never has to guess screenshot arguments from an opaque object.
    const canonicalPixelCaptureJson = JSON.stringify({
      schemaVersion: 1,
      executeBeforeExpiresAt: presentation.expiresAt,
      validationSelector: presentation.validation?.activeSelector ?? null,
      capture: pixelCaptureProtocol.copyReady.cleanViewport,
      inspect: pixelCaptureProtocol.copyReady.inspect,
      completionGate: pixelCaptureProtocol.completionGate,
      forbiddenSubstitutions: pixelCaptureProtocol.forbiddenSubstitutions,
      onBlankCapture: pixelCaptureProtocol.onBlankCapture,
    });
    const pixels = {
      delivery: "host_capture_required" as const,
      nativeImageResultSupported: false as const,
      clip: presentation.clip,
      validationSelector: presentation.validation?.activeSelector ?? null,
      expiresAt: presentation.expiresAt,
      action: {
        required: true as const,
        protocolPath: "data.pixelCaptureProtocol" as const,
        completionGate: "inspect_clean_viewport_pixels_and_scoped_region_before_claiming_visual_qa" as const,
      },
      visualInspectionStatus: "not_performed" as const,
    };
    const completePixelInspection =
      "Execute pixelCaptureProtocol.copyReady.cleanViewport before expiresAt or invalidation and inspect inspectionPixels, including the exact inspectionRegion plus its clean canvas context, for readability, crossings, clearance, endpoints, and labels. Do not substitute an ordinary unclean or invalidated viewport or report visual QA as passed from JSON alone. If the clean capture is blank despite visible semantic targets, execute pixelCaptureProtocol.onBlankCapture once: reframe the exact scope and immediately capture the newly returned cleanViewport. Only if that second clean capture is still blank or unavailable, report pixel inspection unavailable.";
    const nextStep = geometryCoverageStatus === "partial"
      ? visualQuality?.status === "fail"
        ? `Supported deterministic geometry already has a known failure and ${unsupportedGeometryLabel} coverage is partial. Fix every finding, rerun exact-revision analysis, then frame the live canvas again and inspect all pixels including unsupported geometry; framing itself is not visual QA.`
        : `Deterministic geometry coverage is partial because ${unsupportedGeometryLabel} require pixel inspection; report.status is not a complete geometry certification. Execute pixelCaptureProtocol.copyReady.cleanViewport before expiresAt or invalidation and inspect inspectionPixels, including the exact inspectionRegion and its clean canvas context, for readability, crossings, clearance, endpoints, and labels. Do not substitute an ordinary unclean or invalidated viewport. If the clean capture is blank despite visible semantic targets, execute onBlankCapture once and inspect the newly returned clean viewport. Revise and repeat when needed.`
      : geometryQualityStatus === "fail"
        ? `Known deterministic geometry failures remain. For a conventional diagram or any acceptance criterion forbidding overlap, truncation, intrusion, or ambiguous routing, do not claim completion: correct every unintended failure, reinspect the newest exact revisions, then capture pixels. Deliberate user-requested geometry remains valid when explicitly preserved. ${completePixelInspection}`
        : geometryQualityStatus === "warning"
          ? `Deterministic geometry warnings remain. Review every warning against the requested intent; any warning matching an explicit no-overlap, no-truncation, no-intrusion, or unambiguous-routing criterion is a blocker until corrected and reinspected. Deliberate user-requested geometry remains valid. ${completePixelInspection}`
          : `Framing is not visual QA. ${completePixelInspection}`;
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
          canonicalPixelCaptureJson,
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
        canonicalPixelCaptureJson,
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
