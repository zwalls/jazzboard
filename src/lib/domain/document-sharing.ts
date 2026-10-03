/** Compare complete JSON-domain values without depending on object key order. */
export function equalDocumentValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => equalDocumentValue(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = Object.keys(leftRecord);
  return keys.length === Object.keys(rightRecord).length
    && keys.every((key) => Object.hasOwn(rightRecord, key)
      && equalDocumentValue(leftRecord[key], rightRecord[key]));
}

/** Reuse immutable records only after checking their complete incoming values. */
export function shareDocumentRecords<T>(
  current: Record<string, T>,
  next: Record<string, T>,
): Record<string, T> {
  if (current === next) return current;
  const keys = Object.keys(next);
  const equalKeys = keys.filter((key) => Object.hasOwn(current, key)
    && equalDocumentValue(current[key], next[key]));
  if (equalKeys.length === keys.length && keys.length === Object.keys(current).length) {
    return current;
  }
  if (!equalKeys.length) return next;
  const shared = { ...next };
  for (const key of equalKeys) shared[key] = current[key];
  return shared;
}
