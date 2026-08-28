import type { CanvasObject } from "@/lib/domain/types";

export const SEMANTIC_Z_ORDER_LIMITS = Object.freeze({
  minZIndex: 0,
  maxZIndex: 1_000_000,
  maxUpdates: 200,
});

export type SemanticZOrderDirection = "forward" | "backward" | "front" | "back";

export type SemanticZOrderUpdate = Readonly<{
  object: CanvasObject;
  zIndex: number;
}>;

export type SemanticZOrderPlan = Readonly<{
  status: "planned" | "noop";
  /** Every object whose paint-order position changes is revision-fenced. */
  updates: readonly SemanticZOrderUpdate[];
  orderedObjectIds: readonly string[];
}>;

export class SemanticZOrderError extends Error {
  constructor(
    readonly code: "OPERATION_LIMIT" | "UNREPRESENTABLE_ORDER",
    message: string,
  ) {
    super(message);
    this.name = "SemanticZOrderError";
  }
}

function compareObjects(left: CanvasObject, right: CanvasObject): number {
  return left.zIndex - right.zIndex || left.id.localeCompare(right.id);
}

function desiredOrder(
  current: readonly CanvasObject[],
  selectedIds: ReadonlySet<string>,
  direction: SemanticZOrderDirection,
): CanvasObject[] {
  if (direction === "front") {
    return [
      ...current.filter((object) => !selectedIds.has(object.id)),
      ...current.filter((object) => selectedIds.has(object.id)),
    ];
  }
  if (direction === "back") {
    return [
      ...current.filter((object) => selectedIds.has(object.id)),
      ...current.filter((object) => !selectedIds.has(object.id)),
    ];
  }

  const result = [...current];
  if (direction === "forward") {
    for (let index = result.length - 2; index >= 0; index -= 1) {
      if (
        selectedIds.has(result[index]!.id) &&
        !selectedIds.has(result[index + 1]!.id)
      ) {
        [result[index], result[index + 1]] = [result[index + 1]!, result[index]!];
      }
    }
  } else {
    for (let index = 1; index < result.length; index += 1) {
      if (
        selectedIds.has(result[index]!.id) &&
        !selectedIds.has(result[index - 1]!.id)
      ) {
        [result[index - 1], result[index]] = [result[index]!, result[index - 1]!];
      }
    }
  }
  return result;
}

/**
 * Assigns a nondecreasing integer z sequence for one mutable window. Stable-ID
 * tie breaks are part of the ordering contract, so an ID descent consumes one
 * additional z level. Existing z values are retained whenever the constraints
 * allow it.
 */
function assignWindow(
  desired: readonly CanvasObject[],
  start: number,
  end: number,
): number[] | null {
  const lower = start > 0 ? desired[start - 1]! : null;
  const upper = end + 1 < desired.length ? desired[end + 1]! : null;
  const window = desired.slice(start, end + 1);
  const high = new Array<number>(window.length);

  const last = window.length - 1;
  high[last] = upper
    ? upper.zIndex - (window[last]!.id.localeCompare(upper.id) >= 0 ? 1 : 0)
    : SEMANTIC_Z_ORDER_LIMITS.maxZIndex;
  for (let index = last - 1; index >= 0; index -= 1) {
    high[index] = high[index + 1]!
      - (window[index]!.id.localeCompare(window[index + 1]!.id) >= 0 ? 1 : 0);
  }

  const assigned: number[] = [];
  let previousId = lower?.id ?? null;
  let previousZ = lower?.zIndex ?? SEMANTIC_Z_ORDER_LIMITS.minZIndex;
  for (let index = 0; index < window.length; index += 1) {
    const object = window[index]!;
    const low = index === 0 && lower === null
      ? SEMANTIC_Z_ORDER_LIMITS.minZIndex
      : previousZ + (previousId !== null && previousId.localeCompare(object.id) >= 0 ? 1 : 0);
    const ceiling = Math.min(high[index]!, SEMANTIC_Z_ORDER_LIMITS.maxZIndex);
    if (low > ceiling || ceiling < SEMANTIC_Z_ORDER_LIMITS.minZIndex) return null;
    const zIndex = Math.max(low, Math.min(ceiling, object.zIndex));
    assigned.push(zIndex);
    previousId = object.id;
    previousZ = zIndex;
  }
  return assigned;
}

/**
 * Plans one atomic semantic stacking operation without rewriting the room.
 * Adjacent moves swap the selected cohort across one neighboring layer;
 * front/back are stable partitions. When duplicate z values need local space,
 * the planner expands a bounded window and fails before emitting any updates if
 * more than `maxUpdates` objects would need to participate.
 */
export function planSemanticZOrder(input: Readonly<{
  objects: Iterable<CanvasObject>;
  selectedObjectIds: Iterable<string>;
  direction: SemanticZOrderDirection;
  maxUpdates?: number;
}>): SemanticZOrderPlan {
  const maxUpdates = input.maxUpdates ?? SEMANTIC_Z_ORDER_LIMITS.maxUpdates;
  const current = [...input.objects].sort(compareObjects);
  const existingIds = new Set(current.map((object) => object.id));
  const selectedIds = new Set(
    [...input.selectedObjectIds].filter((id) => existingIds.has(id)),
  );
  const desired = desiredOrder(current, selectedIds, input.direction);
  const movedIndexes = current.flatMap((object, index) =>
    desired[index]!.id === object.id ? [] : [index]);

  if (!movedIndexes.length) {
    return Object.freeze({
      status: "noop",
      updates: Object.freeze([]),
      orderedObjectIds: Object.freeze(current.map((object) => object.id)),
    });
  }

  const first = movedIndexes[0]!;
  const last = movedIndexes[movedIndexes.length - 1]!;
  if (last - first + 1 > maxUpdates) {
    throw new SemanticZOrderError(
      "OPERATION_LIMIT",
      `A semantic stacking transaction may update at most ${maxUpdates} objects.`,
    );
  }

  let selectedWindow: Readonly<{ start: number; end: number; assigned: number[] }> | null = null;
  const maximumExtra = Math.min(maxUpdates - (last - first + 1), current.length - (last - first + 1));
  for (let extra = 0; extra <= maximumExtra && selectedWindow === null; extra += 1) {
    for (let leftExtra = 0; leftExtra <= extra; leftExtra += 1) {
      const rightExtra = extra - leftExtra;
      const start = first - leftExtra;
      const end = last + rightExtra;
      if (start < 0 || end >= current.length) continue;
      const assigned = assignWindow(desired, start, end);
      if (assigned) {
        selectedWindow = Object.freeze({ start, end, assigned });
        break;
      }
    }
  }
  if (!selectedWindow) {
    throw new SemanticZOrderError(
      current.length > maxUpdates ? "OPERATION_LIMIT" : "UNREPRESENTABLE_ORDER",
      current.length > maxUpdates
        ? `The local stack is too dense to reorder safely within ${maxUpdates} atomic updates.`
        : "The requested stack order cannot be represented within the z-index bounds.",
    );
  }

  const movedIds = new Set(movedIndexes.map((index) => current[index]!.id));
  const updates: SemanticZOrderUpdate[] = [];
  for (let index = selectedWindow.start; index <= selectedWindow.end; index += 1) {
    const object = desired[index]!;
    const zIndex = selectedWindow.assigned[index - selectedWindow.start]!;
    if (movedIds.has(object.id) || object.zIndex !== zIndex) {
      updates.push(Object.freeze({ object, zIndex }));
    }
  }
  if (updates.length > maxUpdates) {
    throw new SemanticZOrderError(
      "OPERATION_LIMIT",
      `A semantic stacking transaction may update at most ${maxUpdates} objects.`,
    );
  }

  return Object.freeze({
    status: "planned",
    updates: Object.freeze(updates),
    orderedObjectIds: Object.freeze(desired.map((object) => object.id)),
  });
}
