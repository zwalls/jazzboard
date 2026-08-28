"use client";

import {
  ArrowRight,
  ChevronDown,
  Circle,
  Diamond,
  Hand,
  ImagePlus,
  MousePointer2,
  Pencil,
  SlidersHorizontal,
  Square,
  Type,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type SyntheticEvent,
} from "react";

import styles from "./semantic-tool-palette.module.css";

export const SEMANTIC_CANVAS_TOOLS = [
  "select",
  "hand",
  "draw",
  "text",
  "rectangle",
  "ellipse",
  "diamond",
  "connector",
  "image",
] as const;

export const SEMANTIC_CONNECTOR_ROUTING_MODES = [
  "auto",
  "straight",
  "curved",
  "elbow",
] as const;

export const SEMANTIC_CONNECTOR_DIRECTIONS = ["none", "end", "both"] as const;

export type SemanticCanvasTool = (typeof SEMANTIC_CANVAS_TOOLS)[number];
export type SemanticConnectorRoutingIntent = (typeof SEMANTIC_CONNECTOR_ROUTING_MODES)[number];
export type SemanticConnectorDirectionIntent = (typeof SEMANTIC_CONNECTOR_DIRECTIONS)[number];

export type SemanticToolPaletteProps = Readonly<{
  activeTool: SemanticCanvasTool;
  connectorRouting: SemanticConnectorRoutingIntent;
  connectorDirection: SemanticConnectorDirectionIntent;
  /** Reports user intent only. The host owns tool state and every resulting canvas action. */
  onToolChange: (tool: SemanticCanvasTool) => void;
  onConnectorRoutingChange: (routing: SemanticConnectorRoutingIntent) => void;
  onConnectorDirectionChange: (direction: SemanticConnectorDirectionIntent) => void;
  /** Optional host-level disablement, for example while the room is reconciling. */
  disabled?: boolean;
}>;

type ToolDefinition = Readonly<{
  id: SemanticCanvasTool;
  label: string;
  hint: string;
  icon: LucideIcon;
}>;

const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  { id: "select", label: "Select tool", hint: "Select and move objects", icon: MousePointer2 },
  { id: "hand", label: "Hand tool", hint: "Pan around the board", icon: Hand },
  { id: "draw", label: "Draw tool", hint: "Draw a freehand line", icon: Pencil },
  { id: "text", label: "Text tool", hint: "Add text", icon: Type },
  { id: "rectangle", label: "Rectangle tool", hint: "Add a rectangle", icon: Square },
  { id: "ellipse", label: "Ellipse tool", hint: "Add an ellipse", icon: Circle },
  { id: "diamond", label: "Diamond tool", hint: "Add a diamond", icon: Diamond },
  { id: "connector", label: "Connector tool", hint: "Connect canvas objects", icon: ArrowRight },
  { id: "image", label: "Image tool", hint: "Ask the host to add an image", icon: ImagePlus },
];

const ROUTING_LABELS: Readonly<Record<SemanticConnectorRoutingIntent, string>> = {
  auto: "Auto",
  straight: "Straight",
  curved: "Curved",
  elbow: "Elbow",
};

const DIRECTION_LABELS: Readonly<Record<SemanticConnectorDirectionIntent, string>> = {
  none: "No arrows",
  end: "End arrow",
  both: "Both ends",
};

function stopCanvasEvent(event: SyntheticEvent): void {
  event.stopPropagation();
}

/**
 * Renderer-neutral tool controls for Jazzboard's first-party semantic canvas.
 *
 * The palette is deliberately controlled and presentation-only. It emits
 * semantic intent, while the host owns gestures, image picking, leases,
 * persistence, authorization, and rollback.
 */
export function SemanticToolPalette({
  activeTool,
  connectorRouting,
  connectorDirection,
  onToolChange,
  onConnectorRoutingChange,
  onConnectorDirectionChange,
  disabled = false,
}: SemanticToolPaletteProps) {
  const [connectorOptionsOpen, setConnectorOptionsOpen] = useState(false);
  const connectorOptionsId = useId();
  const connectorOptionsButtonRef = useRef<HTMLButtonElement>(null);
  const connectorOptionsRootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!connectorOptionsOpen) return;
    const dismissOutside = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || connectorOptionsRootRef.current?.contains(target)) return;
      setConnectorOptionsOpen(false);
    };
    document.addEventListener("pointerdown", dismissOutside, true);
    return () => document.removeEventListener("pointerdown", dismissOutside, true);
  }, [connectorOptionsOpen]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    event.stopPropagation();
    if (event.key !== "Escape" || !connectorOptionsOpen) return;
    event.preventDefault();
    setConnectorOptionsOpen(false);
    connectorOptionsButtonRef.current?.focus();
  }

  function chooseTool(tool: SemanticCanvasTool): void {
    if (disabled) return;
    onToolChange(tool);
  }

  return (
    <div
      className={styles.root}
      data-semantic-tool-palette="true"
      onClick={stopCanvasEvent}
      onDoubleClick={stopCanvasEvent}
      onContextMenu={stopCanvasEvent}
      onKeyDown={handleKeyDown}
      onPointerCancel={stopCanvasEvent}
      onPointerDown={stopCanvasEvent}
      onPointerMove={stopCanvasEvent}
      onPointerUp={stopCanvasEvent}
      onWheel={stopCanvasEvent}
    >
      <div className={styles.palette} role="toolbar" aria-label="Canvas tools">
        {TOOL_DEFINITIONS.map(({ id, label, hint, icon: Icon }, index) => (
          <div
            key={id}
            ref={id === "connector" ? connectorOptionsRootRef : undefined}
            className={`${styles.toolSlot} ${index === 2 || index === 7 ? styles.groupStart : ""}`}
          >
            <button
              type="button"
              className={styles.toolButton}
              data-tool={id}
              data-active={activeTool === id ? "true" : "false"}
              aria-label={label}
              aria-pressed={activeTool === id}
              title={hint}
              disabled={disabled}
              onClick={() => chooseTool(id)}
            >
              <Icon aria-hidden="true" size={18} strokeWidth={2} />
            </button>

            {id === "connector" ? (
              <>
                <button
                  ref={connectorOptionsButtonRef}
                  type="button"
                  className={styles.optionsButton}
                  aria-label="Connector options"
                  aria-controls={connectorOptionsId}
                  aria-expanded={connectorOptionsOpen}
                  aria-haspopup="dialog"
                  title="Connector routing and arrow direction"
                  disabled={disabled}
                  onClick={() => setConnectorOptionsOpen((open) => !open)}
                >
                  <ChevronDown aria-hidden="true" size={12} strokeWidth={2.25} />
                </button>

                {connectorOptionsOpen ? (
                  <div
                    className={styles.connectorOptions}
                    id={connectorOptionsId}
                    role="dialog"
                    aria-label="Connector options"
                  >
                    <div className={styles.optionsHeading}>
                      <SlidersHorizontal aria-hidden="true" size={14} />
                      Connector style
                    </div>

                    <div className={styles.optionGroup} role="group" aria-label="Connector routing">
                      <span className={styles.optionLabel}>Routing</span>
                      <div className={styles.optionGrid}>
                        {SEMANTIC_CONNECTOR_ROUTING_MODES.map((routing) => (
                          <button
                            key={routing}
                            type="button"
                            aria-label={`${ROUTING_LABELS[routing]} connector routing`}
                            aria-pressed={connectorRouting === routing}
                            data-connector-routing={routing}
                            disabled={disabled}
                            onClick={() => onConnectorRoutingChange(routing)}
                          >
                            {ROUTING_LABELS[routing]}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className={styles.optionGroup} role="group" aria-label="Connector direction">
                      <span className={styles.optionLabel}>Arrows</span>
                      <div className={styles.optionGrid}>
                        {SEMANTIC_CONNECTOR_DIRECTIONS.map((direction) => (
                          <button
                            key={direction}
                            type="button"
                            aria-label={`${DIRECTION_LABELS[direction]} direction`}
                            aria-pressed={connectorDirection === direction}
                            data-connector-direction={direction}
                            disabled={disabled}
                            onClick={() => onConnectorDirectionChange(direction)}
                          >
                            {DIRECTION_LABELS[direction]}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
