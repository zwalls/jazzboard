import { describe, expect, it } from "vitest";

import {
  AGENT_DRAFT_CHOREOGRAPHY_LIMITS,
  AgentDraftChoreographyCoordinator,
  type AgentDraftChoreographyFrame,
  type AgentDraftChoreographyPlan,
} from "./agent-draft-choreography";
import {
  AgentDraftRevealRegistry,
  type AgentDraftRevealObject,
} from "./agent-draft-reveal";

function visible(objectId: string, fingerprint = `${objectId}:1`): AgentDraftRevealObject {
  return { objectId, fingerprint };
}

function plan(input: {
  draftId?: string;
  revision?: number;
  visible: readonly AgentDraftRevealObject[];
  scheduled?: readonly AgentDraftRevealObject[];
}): AgentDraftChoreographyPlan {
  const scheduled = input.scheduled ?? input.visible;
  return {
    draftId: input.draftId ?? "draft-a",
    revision: input.revision ?? 1,
    startPoint: { x: 0, y: 0 },
    targets: scheduled.map((object, index) => ({
      objectId: object.objectId,
      fingerprint: object.fingerprint,
      segments: [{
        phase: "outline",
        purpose: "work",
        objectId: object.objectId,
        fingerprint: object.fingerprint,
        points: [
          { x: index * 120, y: 20 },
          { x: index * 120 + 80, y: 20 },
        ],
        durationMs: 400,
      }],
    })),
    visibleObjectIds: input.visible.map((object) => object.objectId),
    visibleObjects: input.visible,
    inspectionPoints: [{ x: 300, y: 160 }, { x: 320, y: 180 }],
    viewportZoom: 1,
  };
}

function frame(input: Partial<AgentDraftChoreographyFrame> = {}): AgentDraftChoreographyFrame {
  return {
    pagePoint: { x: 40, y: 20 },
    phase: "outline",
    objectId: "object-a",
    fingerprint: "object-a:1",
    phaseProgress: 0.5,
    active: true,
    ...input,
  };
}

function syncPending(
  registry: AgentDraftRevealRegistry,
  draftId: string,
  objects: readonly AgentDraftRevealObject[],
): void {
  registry.syncRenderedDraft({
    draftId,
    objects,
    revealImmediately: false,
    seedComplete: false,
  });
}

describe("AgentDraftRevealRegistry", () => {
  it("progresses from pending to active to complete without travel or regressive frames revealing work", () => {
    const registry = new AgentDraftRevealRegistry();
    const object = visible("object-a");
    syncPending(registry, "draft-a", [object]);
    registry.syncPlan(plan({ visible: [object] }));

    expect(registry.snapshot("draft-a", "object-a")).toEqual({
      state: "pending",
      phase: null,
      progress: 0,
      fingerprint: "object-a:1",
    });

    registry.applyFrame("draft-a", frame({ phase: "travel", phaseProgress: 0.8 }));
    expect(registry.snapshot("draft-a", "object-a")?.state).toBe("pending");

    registry.applyFrame("draft-a", frame({ phaseProgress: 0.65 }));
    expect(registry.snapshot("draft-a", "object-a")).toMatchObject({
      state: "active",
      phase: "outline",
      progress: 0.65,
    });

    registry.applyFrame("draft-a", frame({ phaseProgress: 0.2 }));
    expect(registry.snapshot("draft-a", "object-a")?.progress).toBe(0.65);

    registry.applyEvents("draft-a", [{
      type: "object-complete",
      objectId: "object-a",
      fingerprint: "object-a:1",
      phase: "outline",
    }]);
    expect(registry.snapshot("draft-a", "object-a")).toMatchObject({
      state: "complete",
      phase: "inspect",
      progress: 1,
    });
  });

  it("uses drained completion events so a coarse frame cannot strand skipped work", () => {
    const registry = new AgentDraftRevealRegistry();
    const coordinator = new AgentDraftChoreographyCoordinator();
    const objects = [visible("object-a"), visible("object-b")];
    const choreography = plan({ visible: objects });
    syncPending(registry, "draft-a", objects);
    registry.syncPlan(choreography);

    registry.applyFrame("draft-a", coordinator.accept(choreography, 0));
    registry.applyEvents("draft-a", coordinator.drainRevealEvents());
    const coarse = coordinator.sample(AGENT_DRAFT_CHOREOGRAPHY_LIMITS.maxQueuedDurationMs + 5_000);
    registry.applyFrame("draft-a", coarse);
    registry.applyEvents("draft-a", coordinator.drainRevealEvents());

    expect(coarse.active).toBe(false);
    expect(registry.snapshot("draft-a", "object-a")?.state).toBe("complete");
    expect(registry.snapshot("draft-a", "object-b")?.state).toBe("complete");
  });

  it("preserves unchanged cumulative objects while only newly appended work starts pending", () => {
    const registry = new AgentDraftRevealRegistry();
    const stable = visible("stable");
    syncPending(registry, "draft-a", [stable]);
    registry.syncPlan(plan({ visible: [stable] }));
    registry.finishDraft("draft-a");

    const appended = visible("appended");
    registry.syncRenderedDraft({
      draftId: "draft-a",
      objects: [stable, appended],
      revealImmediately: false,
      seedComplete: false,
    });
    registry.syncPlan(plan({ revision: 2, visible: [stable, appended] }));

    expect(registry.snapshot("draft-a", "stable")?.state).toBe("complete");
    expect(registry.snapshot("draft-a", "appended")?.state).toBe("pending");
  });

  it("resets a changed fingerprint and ignores stale frames and completion events", () => {
    const registry = new AgentDraftRevealRegistry();
    const original = visible("object-a", "object-a:1");
    syncPending(registry, "draft-a", [original]);
    registry.syncPlan(plan({ visible: [original] }));
    registry.applyFrame("draft-a", frame({ fingerprint: original.fingerprint, phaseProgress: 0.7 }));

    const changed = visible("object-a", "object-a:2");
    registry.syncRenderedDraft({
      draftId: "draft-a",
      objects: [changed],
      revealImmediately: false,
      seedComplete: false,
    });
    registry.syncPlan(plan({ revision: 2, visible: [changed] }));
    expect(registry.snapshot("draft-a", "object-a")).toMatchObject({
      state: "pending",
      progress: 0,
      fingerprint: "object-a:2",
    });

    registry.applyFrame("draft-a", frame({ fingerprint: "object-a:1", phaseProgress: 1 }));
    registry.applyEvents("draft-a", [{
      type: "object-complete",
      objectId: "object-a",
      fingerprint: "object-a:1",
      phase: "outline",
    }]);
    expect(registry.snapshot("draft-a", "object-a")?.state).toBe("pending");

    registry.applyFrame("draft-a", frame({ fingerprint: "object-a:2", phaseProgress: 0.3 }));
    expect(registry.snapshot("draft-a", "object-a")).toMatchObject({
      state: "active",
      progress: 0.3,
      fingerprint: "object-a:2",
    });
  });

  it("fails open every visible object omitted from the capped choreography plan", () => {
    const registry = new AgentDraftRevealRegistry();
    const objects = Array.from(
      { length: AGENT_DRAFT_CHOREOGRAPHY_LIMITS.maxTargets + 12 },
      (_, index) => visible(`object-${index}`),
    );
    const scheduled = objects.slice(0, AGENT_DRAFT_CHOREOGRAPHY_LIMITS.maxTargets);
    syncPending(registry, "draft-a", objects);
    registry.syncPlan(plan({ visible: objects, scheduled }));

    for (const object of scheduled) {
      expect(registry.snapshot("draft-a", object.objectId)?.state).toBe("pending");
    }
    for (const object of objects.slice(scheduled.length)) {
      expect(registry.snapshot("draft-a", object.objectId)?.state).toBe("complete");
    }
  });

  it("finishes undriven drafts without affecting a driven draft", () => {
    const registry = new AgentDraftRevealRegistry();
    syncPending(registry, "driven", [visible("same-id", "driven:1")]);
    syncPending(registry, "undriven", [visible("same-id", "undriven:1")]);

    registry.settleUndrivenDrafts(new Set(["driven"]));

    expect(registry.snapshot("driven", "same-id")?.state).toBe("pending");
    expect(registry.snapshot("undriven", "same-id")?.state).toBe("complete");
  });

  it("does not write attributes or CSS again when an undriven draft is already complete", () => {
    const registry = new AgentDraftRevealRegistry();
    const object = visible("settled");
    const element = document.createElementNS("http://www.w3.org/2000/svg", "g");
    syncPending(registry, "undriven", [object]);
    registry.registerObject({
      draftId: "undriven",
      element,
      fingerprint: object.fingerprint,
      objectId: object.objectId,
    });
    registry.settleUndrivenDrafts(new Set());
    expect(registry.snapshot("undriven", object.objectId)?.state).toBe("complete");

    const observer = new MutationObserver(() => undefined);
    observer.observe(element, { attributes: true });
    registry.settleUndrivenDrafts(new Set());

    expect(observer.takeRecords()).toEqual([]);
    observer.disconnect();
  });

  it("isolates identical object IDs and frame progress across drafts", () => {
    const registry = new AgentDraftRevealRegistry();
    syncPending(registry, "draft-a", [visible("same-id", "a:1")]);
    syncPending(registry, "draft-b", [visible("same-id", "b:1")]);

    registry.applyFrame("draft-a", frame({ objectId: "same-id", fingerprint: "a:1", phaseProgress: 0.4 }));

    expect(registry.snapshot("draft-a", "same-id")).toMatchObject({ state: "active", progress: 0.4 });
    expect(registry.snapshot("draft-b", "same-id")).toMatchObject({ state: "pending", progress: 0 });
  });

  it("seeds a late-join snapshot complete and never replays it on unchanged sync", () => {
    const registry = new AgentDraftRevealRegistry();
    const object = visible("existing");
    registry.syncRenderedDraft({
      draftId: "draft-a",
      objects: [object],
      revealImmediately: false,
      seedComplete: true,
    });

    expect(registry.snapshot("draft-a", "existing")?.state).toBe("complete");
    registry.syncRenderedDraft({
      draftId: "draft-a",
      objects: [object],
      revealImmediately: false,
      seedComplete: false,
    });
    expect(registry.snapshot("draft-a", "existing")?.state).toBe("complete");
  });

  it("reports truthful client-local presentation state for one exact draft revision", () => {
    const registry = new AgentDraftRevealRegistry();
    expect(registry.presentationStatus("draft-a", 2)).toMatchObject({
      requestedRevision: 2,
      observedRevision: null,
      state: "not_observed",
      complete: false,
    });

    registry.syncRenderedDraft({
      draftId: "draft-a",
      revision: 2,
      objects: [visible("object-a"), visible("object-b")],
      revealImmediately: false,
      seedComplete: false,
    });
    expect(registry.presentationStatus("draft-a", 2)).toEqual({
      source: "client-local",
      draftId: "draft-a",
      requestedRevision: 2,
      observedRevision: 2,
      state: "pending",
      complete: false,
      objectCount: 2,
      completedObjectCount: 0,
    });
    expect(registry.presentationStatus("draft-a", 3)).toMatchObject({
      observedRevision: 2,
      state: "not_observed",
      complete: false,
    });

    registry.finishDraft("draft-a");
    expect(registry.presentationStatus("draft-a", 2)).toMatchObject({
      state: "complete",
      complete: true,
      completedObjectCount: 2,
    });

    registry.syncRenderedDraft({
      draftId: "draft-a",
      revision: 3,
      objects: [visible("object-a", "object-a:changed"), visible("object-b")],
      revealImmediately: false,
      seedComplete: false,
    });
    expect(registry.presentationStatus("draft-a", 2)).toMatchObject({
      observedRevision: 3,
      state: "superseded",
      complete: false,
    });
    expect(registry.presentationStatus("draft-a", 3)).toMatchObject({
      state: "pending",
      complete: false,
      completedObjectCount: 1,
    });

    registry.dispose();
    expect(registry.presentationStatus("draft-a", 3)).toMatchObject({
      observedRevision: null,
      state: "unavailable",
      complete: false,
    });
  });

  it("waits for the exact revision's closing inspection after every object is revealed", () => {
    const registry = new AgentDraftRevealRegistry();
    const object = visible("object-a");
    registry.syncRenderedDraft({
      draftId: "draft-a",
      revision: 1,
      objects: [object],
      revealImmediately: false,
      seedComplete: false,
    });
    registry.syncPlan(plan({ revision: 1, visible: [object] }));
    registry.applyEvents("draft-a", [{
      type: "object-complete",
      objectId: object.objectId,
      fingerprint: object.fingerprint,
      phase: "outline",
    }]);

    expect(registry.presentationStatus("draft-a", 1)).toMatchObject({
      state: "pending",
      complete: false,
      completedObjectCount: 1,
      objectCount: 1,
    });

    registry.markPresentationComplete("draft-a", 1);
    expect(registry.presentationStatus("draft-a", 1)).toMatchObject({
      state: "complete",
      complete: true,
      completedObjectCount: 1,
      objectCount: 1,
    });

    registry.syncRenderedDraft({
      draftId: "draft-a",
      revision: 2,
      objects: [object, visible("object-b")],
      revealImmediately: false,
      seedComplete: false,
    });
    registry.syncPlan(plan({ revision: 2, visible: [object, visible("object-b")] }));
    registry.markPresentationComplete("draft-a", 1);
    expect(registry.presentationStatus("draft-a", 2)).toMatchObject({
      state: "pending",
      complete: false,
    });
  });
});
