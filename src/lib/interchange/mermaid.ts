import { parseJazzboardArtifactV1 } from "./schemas";
import { sortArtifactWarnings } from "./project";
import {
  JazzboardInterchangeError,
  type JazzboardArtifactV1,
  type JazzboardArtifactWarning,
  type MermaidExport,
  type PortableCanvasObject,
  type TemplateCanvasObject,
} from "./types";

type RenderableObject = PortableCanvasObject | TemplateCanvasObject;

function selectDiagram(artifact: JazzboardArtifactV1, diagramId?: string) {
  if (diagramId) {
    const diagram = artifact.diagrams.find((candidate) => candidate.id === diagramId);
    if (!diagram) {
      throw new JazzboardInterchangeError(
        "DIAGRAM_NOT_FOUND",
        `Diagram ${diagramId} is not present in this portable artifact.`,
        { diagramId },
      );
    }
    return diagram;
  }
  if (artifact.diagrams.length !== 1) {
    throw new JazzboardInterchangeError(
      "DIAGRAM_REQUIRED",
      "Choose one Diagram when rendering an artifact that does not contain exactly one Diagram.",
      { diagramIds: artifact.diagrams.map((diagram) => diagram.id) },
    );
  }
  return artifact.diagrams[0];
}

/**
 * Mermaid labels remain plain text. Line breaks and every character that can
 * terminate a node/edge label or begin a Mermaid directive are encoded.
 */
function safeLabel(value: string, fallback: string, maxEncodedLength = Number.POSITIVE_INFINITY): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500) || fallback;
  const replacements: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
    "[": "&#91;",
    "]": "&#93;",
    "{": "&#123;",
    "}": "&#125;",
    "(": "&#40;",
    ")": "&#41;",
    "|": "&#124;",
    "%": "&#37;",
    "`": "&#96;",
    "\\": "&#92;",
  };
  let encoded = "";
  for (const character of normalized) {
    const replacement = replacements[character] ?? character;
    if (encoded.length + replacement.length > maxEncodedLength) break;
    encoded += replacement;
  }
  return encoded || fallback;
}

function objectLabel(object: RenderableObject): string {
  if (object.kind === "shape") return safeLabel(object.label, object.nodeType ?? "Untitled node");
  if (object.kind === "text") return safeLabel(object.content, "Untitled text");
  return "";
}

function groupLabel(object: RenderableObject): string {
  if (object.kind !== "text") return "Untitled group";
  // The importer accepts group labels up to 160 parsed characters. Mermaid
  // retains numeric entities in its group title, so bound the encoded form.
  return safeLabel(object.content, "Untitled group", 160);
}

function nodeLine(alias: string, object: RenderableObject): string {
  const label = objectLabel(object);
  if (object.kind === "shape" && object.shape === "ellipse") return `  ${alias}(["${label}"])`;
  if (object.kind === "shape" && object.shape === "diamond") return `  ${alias}{"${label}"}`;
  return `  ${alias}["${label}"]`;
}

function isGroupContainer(object: RenderableObject): boolean {
  return object.kind === "shape" && object.semanticRole === "diagram.group_container";
}

function isGroupTitle(object: RenderableObject): boolean {
  return object.kind === "text" && object.semanticRole === "diagram.group_title";
}

function isGroupDecoration(object: RenderableObject): boolean {
  return isGroupContainer(object) || isGroupTitle(object);
}

function connectorLine(
  connector: Extract<RenderableObject, { kind: "connector" }>,
  aliases: ReadonlyMap<string, string>,
): string | null {
  if (!connector.start.objectId || !connector.end.objectId) return null;
  const start = aliases.get(connector.start.objectId);
  const end = aliases.get(connector.end.objectId);
  if (!start || !end) return null;
  const dotted = connector.semanticRole === "diagram.dotted_relationship";
  const arrow = dotted
    ? connector.direction === "none" ? "-.-" : connector.direction === "both" ? "<-.->" : "-.->"
    : connector.direction === "none" ? "---" : connector.direction === "both" ? "<-->" : "-->";
  const label = connector.label.trim() ? `|${safeLabel(connector.label, "relationship")}|` : "";
  return `  ${start} ${arrow}${label} ${end}`;
}

/** Render one first-class Diagram as deterministic, directive-free Mermaid. */
export function renderDiagramMermaid(input: JazzboardArtifactV1, diagramId?: string): MermaidExport {
  const artifact = parseJazzboardArtifactV1(input);
  const diagram = selectDiagram(artifact, diagramId);
  const objectsById = new Map<string, RenderableObject>(
    artifact.objects.map((object) => [object.id, object]),
  );
  const warnings: JazzboardArtifactWarning[] = [...artifact.warnings];
  const memberObjects = [...diagram.memberObjectIds]
    .sort((left, right) => left.localeCompare(right))
    .flatMap((objectId) => {
      const object = objectsById.get(objectId);
      if (!object || (object.kind !== "shape" && object.kind !== "text")) {
        warnings.push({
          code: "MERMAID_OBJECT_OMITTED",
          message: `Diagram member ${objectId} is not a Mermaid node and was omitted from this rendering.`,
          objectId,
          diagramId: diagram.id,
        });
        return [];
      }
      return [object];
    });
  const decorativeObjects = memberObjects.filter(isGroupDecoration);
  const decorativeObjectIds = new Set(decorativeObjects.map((object) => object.id));
  const nodeObjects = memberObjects.filter((object) => !isGroupDecoration(object));
  const aliases = new Map(nodeObjects.map((object, index) => [object.id, `n${index}`]));
  const direction = diagram.diagramType === "hierarchy" ? "TD" : "LR";
  const containersByGroup = new Map<string, RenderableObject[]>();
  const titlesByGroup = new Map<string, RenderableObject[]>();
  for (const object of decorativeObjects) {
    if (!object.groupId) {
      warnings.push({
        code: "MERMAID_OBJECT_OMITTED",
        message: `Diagram group decoration ${object.id} has no group ID and was omitted from this rendering.`,
        objectId: object.id,
        diagramId: diagram.id,
      });
      continue;
    }
    const index = isGroupContainer(object) ? containersByGroup : titlesByGroup;
    const objects = index.get(object.groupId) ?? [];
    objects.push(object);
    index.set(object.groupId, objects);
  }

  const recognizedGroupIds = [...containersByGroup.keys()]
    .filter((groupId) => titlesByGroup.has(groupId))
    .sort((left, right) => left.localeCompare(right));
  const recognizedGroupIdSet = new Set(recognizedGroupIds);
  for (const object of decorativeObjects) {
    if (object.groupId && !recognizedGroupIdSet.has(object.groupId)) {
      warnings.push({
        code: "MERMAID_OBJECT_OMITTED",
        message: `Diagram group decoration ${object.id} has no matching container and title pair and was omitted from this rendering.`,
        objectId: object.id,
        diagramId: diagram.id,
      });
    }
  }

  const groupedNodeIds = new Set<string>();
  const lines = [`flowchart ${direction}`];
  recognizedGroupIds.forEach((groupId, groupIndex) => {
    const title = titlesByGroup.get(groupId)!
      .sort((left, right) => left.id.localeCompare(right.id))[0];
    const members = nodeObjects.filter((object) => object.groupId === groupId);
    if (!members.length) {
      warnings.push({
        code: "MERMAID_OBJECT_OMITTED",
        message: `Empty native group ${groupId} was omitted from Mermaid output.`,
        objectId: containersByGroup.get(groupId)![0].id,
        diagramId: diagram.id,
      });
      return;
    }
    lines.push(`  subgraph g${groupIndex}["${groupLabel(title)}"]`);
    for (const member of members) {
      groupedNodeIds.add(member.id);
      lines.push(`  ${nodeLine(aliases.get(member.id)!, member)}`);
    }
    lines.push("  end");
  });
  lines.push(
    ...nodeObjects
      .filter((object) => !groupedNodeIds.has(object.id))
      .map((object) => nodeLine(aliases.get(object.id)!, object)),
  );

  for (const connectorId of [...diagram.connectorIds].sort((left, right) => left.localeCompare(right))) {
    const connector = objectsById.get(connectorId);
    const line = connector?.kind === "connector" ? connectorLine(connector, aliases) : null;
    if (line) {
      lines.push(line);
    } else {
      const decorationEndpoint = connector?.kind === "connector"
        ? [connector.start.objectId, connector.end.objectId]
            .find((objectId) => {
              const endpoint = objectId ? objectsById.get(objectId) : undefined;
              return Boolean(endpoint && (decorativeObjectIds.has(endpoint.id) || isGroupDecoration(endpoint)));
            })
        : undefined;
      warnings.push({
        code: "MERMAID_CONNECTOR_OMITTED",
        message: decorationEndpoint
          ? `Diagram connector ${connectorId} targets group decoration ${decorationEndpoint}; Mermaid group decorations cannot be connector endpoints, so the connector was omitted.`
          : `Diagram connector ${connectorId} could not be represented because both semantic endpoints must be rendered nodes.`,
        objectId: connectorId,
        diagramId: diagram.id,
      });
    }
  }

  return {
    source: `${lines.join("\n")}\n`,
    warnings: sortArtifactWarnings(warnings),
  };
}
