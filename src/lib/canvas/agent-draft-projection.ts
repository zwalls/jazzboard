import type { AgentCanvasDraftSnapshot } from "@/lib/agent-drafts/types";
import type { ResolvedConnectorRoute } from "@/lib/domain/connector-routing";
import type { CanvasBounds, CanvasObject, Diagram } from "@/lib/domain/types";

import { buildSemanticScene, type SemanticSceneObject } from "./semantic-scene";

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

function unionBounds(left: CanvasBounds | null, right: CanvasBounds): CanvasBounds {
  if (!left) return { ...right };
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  const maxX = Math.max(left.x + left.width, right.x + right.width);
  const maxY = Math.max(left.y + left.height, right.y + right.height);
  return { x, y, width: Math.max(maxX - x, 1), height: Math.max(maxY - y, 1) };
}

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
    .filter((object) => !authoritativeObjects[object.id])
    .map((object) => object as CanvasObject);
  if (!visibleObjects.length) {
    byDiagrams.set(authoritativeDiagrams, null);
    return null;
  }

  const previewObjects = Object.fromEntries(visibleObjects.map((object) => [object.id, object]));
  const previewDiagrams = Object.fromEntries(
    draft.previewDiagrams.map((diagram) => [diagram.id, diagram]),
  );
  const scene = buildSemanticScene({
    id: draft.roomId,
    roomRevision: draft.baselineRoomRevision,
    objects: { ...authoritativeObjects, ...previewObjects },
    diagrams: { ...authoritativeDiagrams, ...previewDiagrams },
  });
  const visibleIds = new Set(visibleObjects.map((object) => object.id));
  const objects = scene.objects.filter(({ object }) => visibleIds.has(object.id));
  const bounds = objects.reduce<CanvasBounds | null>(
    (current, object) => unionBounds(current, object.bounds),
    null,
  );
  const projection = bounds
    ? { draft, visibleObjects, objects, bounds, connectorRoutes: scene.connectorRoutes }
    : null;
  byDiagrams.set(authoritativeDiagrams, projection);
  return projection;
}
