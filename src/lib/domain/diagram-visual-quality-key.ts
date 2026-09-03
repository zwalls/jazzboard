import type { DiagramVisualQualityFinding } from "./diagram-visual-quality";

function stableDigest(value: unknown): string {
  const input = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * A renderer-neutral identity for one deterministic Diagram finding.
 *
 * It intentionally excludes bounds and numeric measurements so the same
 * semantic conflict remains recognizable while an author adjusts geometry.
 * Exact draft revision guards still prevent an acknowledgement from being
 * reused after any unpublished candidate change.
 */
export function diagramVisualQualityFindingKey(
  finding: DiagramVisualQualityFinding,
): string {
  const stableDetails = Object.fromEntries(
    Object.entries(finding.details ?? {})
      .filter(([, value]) =>
        typeof value === "string" ||
        typeof value === "boolean" ||
        value === null ||
        (Array.isArray(value) && value.every((item) => typeof item === "string")),
      )
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  const identity = {
    objectIds: [...new Set(finding.objectIds)].sort(),
    connectorIds: [...new Set(finding.connectorIds)].sort(),
    stableDetails,
  };
  return `diagram:${finding.code.toLowerCase()}:${stableDigest(identity)}`;
}
