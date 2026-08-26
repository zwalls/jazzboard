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
function safeLabel(value: string, fallback: string): string {
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
  return [...normalized].map((character) => replacements[character] ?? character).join("");
}

function objectLabel(object: RenderableObject): string {
  if (object.kind === "shape") return safeLabel(object.label, object.nodeType ?? "Untitled node");
  if (object.kind === "text") return safeLabel(object.content, "Untitled text");
  return "";
}

function nodeLine(alias: string, object: RenderableObject): string {
  const label = objectLabel(object);
  if (object.kind === "shape" && object.shape === "ellipse") return `  ${alias}(["${label}"])`;
  if (object.kind === "shape" && object.shape === "diamond") return `  ${alias}{"${label}"}`;
  return `  ${alias}["${label}"]`;
}

function connectorLine(
  connector: Extract<RenderableObject, { kind: "connector" }>,
  aliases: ReadonlyMap<string, string>,
): string | null {
  if (!connector.start.objectId || !connector.end.objectId) return null;
  const start = aliases.get(connector.start.objectId);
  const end = aliases.get(connector.end.objectId);
  if (!start || !end) return null;
  const arrow = connector.direction === "none" ? "---" : connector.direction === "both" ? "<-->" : "-->";
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
  const nodeObjects = [...diagram.memberObjectIds]
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
  const aliases = new Map(nodeObjects.map((object, index) => [object.id, `n${index}`]));
  const direction = diagram.diagramType === "hierarchy" ? "TD" : "LR";
  const lines = [`flowchart ${direction}`, ...nodeObjects.map((object) => nodeLine(aliases.get(object.id)!, object))];

  for (const connectorId of [...diagram.connectorIds].sort((left, right) => left.localeCompare(right))) {
    const connector = objectsById.get(connectorId);
    const line = connector?.kind === "connector" ? connectorLine(connector, aliases) : null;
    if (line) {
      lines.push(line);
    } else {
      warnings.push({
        code: "MERMAID_CONNECTOR_OMITTED",
        message: `Diagram connector ${connectorId} could not be represented because both semantic endpoints must be rendered nodes.`,
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
