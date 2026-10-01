import type { CanvasObject, RoomState } from "@/lib/domain/types";

export const GUIDED_WALKTHROUGH_LIMITS = Object.freeze({
  maxSteps: 20,
  maxTargetsPerKind: 12,
  maxTitleLength: 120,
  maxCaptionLength: 280,
  maxDetailsLength: 1_200,
});

export type GuidedWalkthroughStep = Readonly<{
  caption: string;
  details?: string;
  objectIds: readonly string[];
  connectorIds: readonly string[];
}>;

export type GuidedWalkthrough = Readonly<{
  id: string;
  roomId: string;
  revision: number;
  title: string;
  steps: readonly GuidedWalkthroughStep[];
  currentStepIndex: number;
  startedAt: number;
}>;

export type GuidedWalkthroughDisplay = Readonly<{
  walkthroughId: string;
  revision: number;
  stepIndex: number;
}>;

export type GuidedWalkthroughTarget = Readonly<{
  id: string;
  kind: CanvasObject["kind"];
  label: string;
}>;

export type GuidedWalkthroughStatus = Readonly<{
  active: boolean;
  walkthroughId: string | null;
  title: string | null;
  revision: number | null;
  stepCount: number;
  presentation: "inactive" | "pending" | "displayed";
  currentStep: Readonly<{
    index: number;
    caption: string;
    details: string | null;
    targets: readonly GuidedWalkthroughTarget[];
  }> | null;
}>;

function objectLabel(object: CanvasObject): string {
  if (object.kind === "shape") return object.label || `${object.shape} node`;
  if (object.kind === "text") return object.content || "Untitled text";
  if (object.kind === "connector") return object.label || "Connector";
  if (object.kind === "image") return object.alt || "Image";
  if (object.kind === "path") return "Vector path";
  return "Freehand annotation";
}

export function guidedWalkthroughStatus(
  walkthrough: GuidedWalkthrough | null,
  room?: Pick<RoomState, "objects"> | null,
  display?: GuidedWalkthroughDisplay | null,
): GuidedWalkthroughStatus {
  if (!walkthrough) {
    return {
      active: false,
      walkthroughId: null,
      title: null,
      revision: null,
      stepCount: 0,
      presentation: "inactive",
      currentStep: null,
    };
  }
  const step = walkthrough.steps[walkthrough.currentStepIndex] ?? null;
  return {
    active: true,
    walkthroughId: walkthrough.id,
    title: walkthrough.title,
    revision: walkthrough.revision,
    stepCount: walkthrough.steps.length,
    presentation: display?.walkthroughId === walkthrough.id
      && display.revision === walkthrough.revision
      && display.stepIndex === walkthrough.currentStepIndex
      ? "displayed"
      : "pending",
    currentStep: step ? {
      index: walkthrough.currentStepIndex + 1,
      caption: step.caption,
      details: step.details ?? null,
      targets: room ? [...step.objectIds, ...step.connectorIds].flatMap((objectId) => {
        const object = room.objects[objectId];
        return object ? [{ id: object.id, kind: object.kind, label: objectLabel(object) }] : [];
      }) : [],
    } : null,
  };
}

/**
 * Removes targets that disappeared from the authoritative room while a local
 * tour was open. Empty steps are removed and the active index remains bounded.
 */
export function reconcileGuidedWalkthrough(
  walkthrough: GuidedWalkthrough,
  room: Pick<RoomState, "objects">,
): GuidedWalkthrough | null {
  const steps = walkthrough.steps.flatMap((step) => {
    const objectIds = step.objectIds.filter((objectId) => {
      const object = room.objects[objectId];
      return Boolean(object && object.kind !== "connector");
    });
    const connectorIds = step.connectorIds.filter((objectId) =>
      room.objects[objectId]?.kind === "connector"
    );
    return objectIds.length || connectorIds.length
      ? [{ ...step, objectIds, connectorIds }]
      : [];
  });
  if (!steps.length) return null;
  const currentStepIndex = Math.min(walkthrough.currentStepIndex, steps.length - 1);
  const unchanged = currentStepIndex === walkthrough.currentStepIndex
    && steps.length === walkthrough.steps.length
    && steps.every((step, index) => {
      const previous = walkthrough.steps[index];
      return previous
        && step.objectIds.length === previous.objectIds.length
        && step.connectorIds.length === previous.connectorIds.length;
    });
  return unchanged ? walkthrough : { ...walkthrough, steps, currentStepIndex };
}
