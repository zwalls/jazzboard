import type { AgentCanvasDraftSnapshot } from "@/lib/agent-drafts/types";
import type { ResolvedConnectorRoute } from "@/lib/domain/connector-routing";
import type { CanvasBounds, CanvasObject, Diagram } from "@/lib/domain/types";

import { projectPersistedSemanticArtwork, type SemanticSceneObject } from "./semantic-scene";

export type AgentDraftProjection = Readonly<{
  draft: AgentCanvasDraftSnapshot;
  visibleObjects: readonly CanvasObject[];
  objects: readonly SemanticSceneObject[];
  bounds: CanvasBounds;
  connectorRoutes: Readonly<Record<string, ResolvedConnectorRoute>>;
}>;

const projectionCache = new WeakMap<
  AgentCanvasDraftSnapshot,
  WeakMap<object, WeakMap<object, AgentDraftProjection | null>>
>();
const EMPTY_AUTHORITATIVE_DIAGRAMS: Readonly<Record<string, Diagram>> = Object.freeze({});

/**
 * Builds the semantic draft scene once for both its artwork and presentation-only
 * choreography. Room envelopes and draft snapshots are immutable, so their
 * identities are safe weak cache keys and cannot retain expired room state.
 */
export function projectAgentDraft(
  draft: AgentCanvasDraftSnapshot,
  authoritativeObjects: Readonly<Record<string, CanvasObject>>,
  authoritativeDiagrams: Readonly<Record<string, Diagram>> = EMPTY_AUTHORITATIVE_DIAGRAMS,
): AgentDraftProjection | null {
  let byObjects = projectionCache.get(draft);
  if (!byObjects) {
    byObjects = new WeakMap<object, WeakMap<object, AgentDraftProjection | null>>();
    projectionCache.set(draft, byObjects);
  }
  let byDiagrams = byObjects.get(authoritativeObjects);
  if (!byDiagrams) {
    byDiagrams = new WeakMap<object, AgentDraftProjection | null>();
    byObjects.set(authoritativeObjects, byDiagrams);
  }
  if (byDiagrams.has(authoritativeDiagrams)) {
    return byDiagrams.get(authoritativeDiagrams) ?? null;
  }

  const visibleObjects = draft.previewObjects
    .filter((object) => {
      const authoritative = authoritativeObjects[object.id];
      if (!authoritative) return draft.status !== "presenting";
      // A committed Mermaid reveal deliberately projects the exact durable
      // revision through the existing choreography layer. If a collaborator
      // edits the object while it is being revealed, the newer authoritative
      // revision wins immediately and the stale presentation disappears.
      return draft.status === "presenting" &&
        authoritative.revision === object.revision &&
        authoritative.createdAt === object.createdAt;
    })
    .map((object) => object as CanvasObject);
  if (!visibleObjects.length) {
    byDiagrams.set(authoritativeDiagrams, null);
    return null;
  }

  const previewObjects = Object.fromEntries(visibleObjects.map((object) => [object.id, object]));
  // Persisted preview routes need only their bound endpoint objects. Draft
  // objects win over authoritative ones, just as in the full room overlay.
  const endpointObjects: Record<string, CanvasObject> = Object.assign(Object.create(null), previewObjects);
  for (const object of Object.values(previewObjects)) {
    if (object.kind !== "connector") continue;
    for (const id of [object.start.objectId, object.end.objectId]) {
      if (id && !Object.hasOwn(endpointObjects, id) && Object.hasOwn(authoritativeObjects, id)) {
        endpointObjects[id] = authoritativeObjects[id];
      }
    }
  }
  const { objects, bounds, connectorRoutes } = projectPersistedSemanticArtwork(previewObjects, endpointObjects);
  const projection = bounds
    ? { draft, visibleObjects, objects, bounds, connectorRoutes }
    : null;
  byDiagrams.set(authoritativeDiagrams, projection);
  return projection;
}
