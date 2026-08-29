import type {
  AgentDraftChoreographyFrame,
  AgentDraftChoreographyPhase,
  AgentDraftChoreographyPlan,
  AgentDraftRevealEvent,
} from "./agent-draft-choreography";

export type AgentDraftRevealState = "pending" | "active" | "complete";

export type AgentDraftRevealSnapshot = Readonly<{
  state: AgentDraftRevealState;
  phase: AgentDraftChoreographyPhase | null;
  progress: number;
  fingerprint: string;
}>;

type RevealEntry = {
  element: SVGGElement | null;
  fingerprint: string;
  phase: AgentDraftChoreographyPhase | null;
  progress: number;
  state: AgentDraftRevealState;
};

type DraftRevealState = {
  initialized: boolean;
  objects: Map<string, RevealEntry>;
  revision: number;
};

export type AgentDraftRevealObject = Readonly<{
  objectId: string;
  fingerprint: string;
}>;

const PHASE_ORDER: Readonly<Record<AgentDraftChoreographyPhase, number>> = {
  travel: 0,
  outline: 1,
  trace: 1,
  label: 2,
  inspect: 3,
};

function clampProgress(value: number): number {
  return Math.max(0, Math.min(Number.isFinite(value) ? value : 0, 1));
}

/**
 * Room-local, presentation-only reveal state. It mutates only draft SVG
 * attributes and CSS variables; it never touches semantic state or performs I/O.
 */
export class AgentDraftRevealRegistry {
  private disposed = false;
  private drafts = new Map<string, DraftRevealState>();

  syncRenderedDraft(input: {
    draftId: string;
    objects: readonly AgentDraftRevealObject[];
    revealImmediately: boolean;
    seedComplete: boolean;
  }): void {
    if (this.disposed) return;
    let draft = this.drafts.get(input.draftId);
    if (!draft) {
      draft = { initialized: false, objects: new Map(), revision: -1 };
      this.drafts.set(input.draftId, draft);
    }
    const firstSync = !draft.initialized;
    const completeNewObjects = input.revealImmediately || (firstSync && input.seedComplete);
    const visibleIds = new Set(input.objects.map((object) => object.objectId));

    for (const object of input.objects) {
      const current = draft.objects.get(object.objectId);
      if (!current) {
        const entry: RevealEntry = {
          element: null,
          fingerprint: object.fingerprint,
          phase: completeNewObjects ? "inspect" : null,
          progress: completeNewObjects ? 1 : 0,
          state: completeNewObjects ? "complete" : "pending",
        };
        draft.objects.set(object.objectId, entry);
        this.apply(entry);
        continue;
      }
      if (current.fingerprint !== object.fingerprint) {
        current.fingerprint = object.fingerprint;
        current.phase = completeNewObjects ? "inspect" : null;
        current.progress = completeNewObjects ? 1 : 0;
        current.state = completeNewObjects ? "complete" : "pending";
      } else if (completeNewObjects) {
        this.markComplete(current);
      }
      this.apply(current);
    }
    for (const objectId of draft.objects.keys()) {
      if (!visibleIds.has(objectId)) draft.objects.delete(objectId);
    }
    draft.initialized = true;
  }

  syncPlan(plan: AgentDraftChoreographyPlan): void {
    if (this.disposed) return;
    let draft = this.drafts.get(plan.draftId);
    if (!draft) {
      draft = { initialized: true, objects: new Map(), revision: -1 };
      this.drafts.set(plan.draftId, draft);
    }
    if (plan.revision < draft.revision) return;
    draft.revision = plan.revision;
    const scheduled = new Map(plan.targets.map((target) => [target.objectId, target.fingerprint]));
    const visible = plan.visibleObjects ?? plan.targets;
    const visibleIds = new Set(visible.map((object) => object.objectId));
    for (const object of visible) {
      let entry = draft.objects.get(object.objectId);
      if (!entry) {
        entry = {
          element: null,
          fingerprint: object.fingerprint,
          phase: null,
          progress: 0,
          state: "pending",
        };
        draft.objects.set(object.objectId, entry);
      }
      if (entry.fingerprint !== object.fingerprint) {
        entry.fingerprint = object.fingerprint;
        entry.phase = null;
        entry.progress = 0;
        entry.state = "pending";
      }
      if (scheduled.get(object.objectId) !== object.fingerprint) this.markComplete(entry);
      this.apply(entry);
    }
    for (const objectId of draft.objects.keys()) {
      if (!visibleIds.has(objectId)) draft.objects.delete(objectId);
    }
  }

  registerObject(input: {
    draftId: string;
    objectId: string;
    fingerprint: string;
    element: SVGGElement;
    initiallyComplete?: boolean;
  }): () => void {
    if (this.disposed) return () => undefined;
    let draft = this.drafts.get(input.draftId);
    if (!draft) {
      draft = { initialized: false, objects: new Map(), revision: -1 };
      this.drafts.set(input.draftId, draft);
    }
    let entry = draft.objects.get(input.objectId);
    if (!entry || entry.fingerprint !== input.fingerprint) {
      entry = {
        element: input.element,
        fingerprint: input.fingerprint,
        phase: input.initiallyComplete ? "inspect" : null,
        progress: input.initiallyComplete ? 1 : 0,
        state: input.initiallyComplete ? "complete" : "pending",
      };
      draft.objects.set(input.objectId, entry);
    } else {
      entry.element = input.element;
    }
    this.apply(entry);
    return () => {
      if (entry?.element === input.element) entry.element = null;
    };
  }

  applyFrame(draftId: string, frame: AgentDraftChoreographyFrame): void {
    if (
      this.disposed ||
      !frame.active ||
      frame.phase === "travel" ||
      frame.phase === "inspect" ||
      !frame.objectId ||
      !frame.fingerprint
    ) return;
    const entry = this.drafts.get(draftId)?.objects.get(frame.objectId);
    if (!entry || entry.state === "complete" || entry.fingerprint !== frame.fingerprint) return;
    const progress = clampProgress(frame.phaseProgress);
    if (entry.phase === frame.phase && progress < entry.progress) return;
    if (entry.phase && PHASE_ORDER[frame.phase] < PHASE_ORDER[entry.phase]) return;
    entry.state = "active";
    entry.phase = frame.phase;
    entry.progress = progress;
    this.apply(entry);
  }

  applyEvents(draftId: string, events: readonly AgentDraftRevealEvent[]): void {
    if (this.disposed) return;
    const draft = this.drafts.get(draftId);
    if (!draft) return;
    for (const event of events) {
      const entry = draft.objects.get(event.objectId);
      if (!entry || (event.fingerprint && entry.fingerprint !== event.fingerprint)) continue;
      if (event.type === "object-complete") {
        this.markComplete(entry);
      } else if (entry.state !== "complete" && event.phase) {
        entry.state = "active";
        entry.phase = event.phase;
        entry.progress = 1;
      }
      this.apply(entry);
    }
  }

  settleUndrivenDrafts(drivenDraftIds: ReadonlySet<string>): void {
    if (this.disposed) return;
    for (const [draftId, draft] of this.drafts) {
      if (drivenDraftIds.has(draftId)) continue;
      for (const entry of draft.objects.values()) {
        if (entry.state === "complete") continue;
        this.markComplete(entry);
        this.apply(entry);
      }
    }
  }

  finishDraft(draftId: string): void {
    const draft = this.drafts.get(draftId);
    if (!draft || this.disposed) return;
    for (const entry of draft.objects.values()) {
      this.markComplete(entry);
      this.apply(entry);
    }
  }

  removeMissingDrafts(visibleDraftIds: ReadonlySet<string>): void {
    if (this.disposed) return;
    for (const draftId of this.drafts.keys()) {
      if (!visibleDraftIds.has(draftId)) this.drafts.delete(draftId);
    }
  }

  snapshot(draftId: string, objectId: string): AgentDraftRevealSnapshot | null {
    const entry = this.drafts.get(draftId)?.objects.get(objectId);
    return entry ? {
      state: entry.state,
      phase: entry.phase,
      progress: entry.progress,
      fingerprint: entry.fingerprint,
    } : null;
  }

  dispose(): void {
    this.disposed = true;
    this.drafts.clear();
  }

  private markComplete(entry: RevealEntry): void {
    entry.state = "complete";
    entry.phase = "inspect";
    entry.progress = 1;
  }

  private apply(entry: RevealEntry): void {
    const element = entry.element;
    if (!element) return;
    element.dataset.agentDraftRevealState = entry.state;
    element.dataset.agentDraftRevealPhase = entry.phase ?? "pending";
    element.dataset.agentDraftRevealFingerprint = entry.fingerprint;
    element.style.setProperty("--agent-draft-reveal-progress", String(entry.progress));
    element.style.setProperty(
      "--agent-draft-reveal-remaining",
      `${Math.max(0, (1 - entry.progress) * 100)}%`,
    );
  }
}
