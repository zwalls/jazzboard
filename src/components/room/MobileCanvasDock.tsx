"use client";

import {
  ArrowRight,
  Circle,
  Diamond,
  Hand,
  ImagePlus,
  Maximize2,
  MousePointer2,
  Pencil,
  Redo2,
  SlidersHorizontal,
  Square,
  Type,
  Undo2,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type SyntheticEvent,
} from "react";

import {
  announceMobileSurfaceOpen,
  subscribeToMobileSurfaceOpen,
} from "./mobile-surface-coordinator";
import type {
  SemanticCanvasTool,
  SemanticConnectorDirectionIntent,
  SemanticConnectorRoutingIntent,
} from "./SemanticToolPalette";
import {
  SEMANTIC_CONNECTOR_DIRECTIONS,
  SEMANTIC_CONNECTOR_ROUTING_MODES,
} from "./SemanticToolPalette";
import styles from "./mobile-canvas-dock.module.css";

type ToolDefinition = Readonly<{
  id: SemanticCanvasTool;
  label: string;
  shortLabel: string;
  icon: LucideIcon;
}>;

const TOOLS: readonly ToolDefinition[] = [
  { id: "select", label: "Select and move", shortLabel: "Select", icon: MousePointer2 },
  { id: "hand", label: "Pan canvas", shortLabel: "Hand", icon: Hand },
  { id: "draw", label: "Draw freehand", shortLabel: "Draw", icon: Pencil },
  { id: "text", label: "Add text", shortLabel: "Text", icon: Type },
  { id: "rectangle", label: "Add rectangle", shortLabel: "Rectangle", icon: Square },
  { id: "ellipse", label: "Add ellipse", shortLabel: "Ellipse", icon: Circle },
  { id: "diamond", label: "Add diamond", shortLabel: "Diamond", icon: Diamond },
  { id: "connector", label: "Connect objects", shortLabel: "Connector", icon: ArrowRight },
  { id: "image", label: "Add image", shortLabel: "Image", icon: ImagePlus },
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

const DIALOG_FOCUSABLE = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export type MobileCanvasDockProps = Readonly<{
  activeTool: SemanticCanvasTool;
  canRedo: boolean;
  canUndo: boolean;
  connectorDirection: SemanticConnectorDirectionIntent;
  connectorRouting: SemanticConnectorRoutingIntent;
  editing: boolean;
  zoomPercent: number;
  onConnectorDirectionChange: (direction: SemanticConnectorDirectionIntent) => void;
  onConnectorRoutingChange: (routing: SemanticConnectorRoutingIntent) => void;
  onFitBoard: () => void;
  onRedo: () => void;
  onToolChange: (tool: SemanticCanvasTool) => void;
  onUndo: () => void;
}>;

function stopCanvasEvent(event: SyntheticEvent): void {
  event.stopPropagation();
}

export function MobileCanvasDock({
  activeTool,
  canRedo,
  canUndo,
  connectorDirection,
  connectorRouting,
  editing,
  zoomPercent,
  onConnectorDirectionChange,
  onConnectorRoutingChange,
  onFitBoard,
  onRedo,
  onToolChange,
  onUndo,
}: MobileCanvasDockProps) {
  const [open, setOpen] = useState(false);
  const dialogId = useId();
  const toolsButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLElement>(null);
  const activeDefinition = TOOLS.find(({ id }) => id === activeTool) ?? TOOLS[0];
  const ActiveIcon = activeDefinition.icon;

  useEffect(() => subscribeToMobileSurfaceOpen((surfaceId) => {
    if (surfaceId !== "canvas-tools") setOpen(false);
  }), []);

  useEffect(() => {
    if (!open) return;
    closeButtonRef.current?.focus({ preventScroll: true });
  }, [open]);

  function setToolsOpen(next: boolean): void {
    if (next) announceMobileSurfaceOpen("canvas-tools");
    setOpen(next);
  }

  function closeTools(restoreFocus = true): void {
    setOpen(false);
    if (restoreFocus) queueMicrotask(() => toolsButtonRef.current?.focus({ preventScroll: true }));
  }

  function handleDialogKeyDown(event: KeyboardEvent<HTMLElement>): void {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      closeTools();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(sheetRef.current?.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE) ?? []);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function handleBackdropPointerDown(event: PointerEvent<HTMLDivElement>): void {
    event.stopPropagation();
    if (event.target === event.currentTarget) closeTools();
  }

  function chooseTool(tool: SemanticCanvasTool): void {
    onToolChange(tool);
    if (tool !== "connector") closeTools();
  }

  return (
    <div
      className={styles.root}
      data-mobile-canvas-controls="true"
      onClick={stopCanvasEvent}
      onContextMenu={stopCanvasEvent}
      onDoubleClick={stopCanvasEvent}
      onPointerDown={stopCanvasEvent}
      onPointerMove={stopCanvasEvent}
      onPointerUp={stopCanvasEvent}
      onWheel={stopCanvasEvent}
    >
      <div className={styles.dock} role="toolbar" aria-label="Mobile canvas controls">
        {editing ? (
          <button
            ref={toolsButtonRef}
            className={styles.activeTool}
            type="button"
            aria-controls={dialogId}
            aria-expanded={open}
            aria-haspopup="dialog"
            aria-label={`${activeDefinition.shortLabel} active. Choose a canvas tool`}
            onClick={() => setToolsOpen(!open)}
          >
            <ActiveIcon aria-hidden="true" size={20} />
            <span>{activeDefinition.shortLabel}</span>
          </button>
        ) : null}
        {editing ? (
          <>
            <button type="button" aria-label="Undo" disabled={!canUndo} onClick={onUndo}>
              <Undo2 aria-hidden="true" size={20} />
            </button>
            <button type="button" aria-label="Redo" disabled={!canRedo} onClick={onRedo}>
              <Redo2 aria-hidden="true" size={20} />
            </button>
          </>
        ) : null}
        <span className={styles.zoomValue} aria-label={`Canvas zoom ${zoomPercent}%`}>{zoomPercent}%</span>
        <button type="button" aria-label="Fit board" onClick={onFitBoard}>
          <Maximize2 aria-hidden="true" size={20} />
        </button>
      </div>

      {open && editing ? (
        <div
          className={styles.backdrop}
          data-testid="mobile-tools-backdrop"
          onPointerDown={handleBackdropPointerDown}
          role="presentation"
        >
          <section
            ref={sheetRef}
            aria-label="Canvas tools"
            aria-modal="true"
            className={styles.sheet}
            id={dialogId}
            onKeyDown={handleDialogKeyDown}
            role="dialog"
          >
            <div className={styles.sheetHandle} aria-hidden="true" />
            <header>
              <div>
                <span>Canvas</span>
                <strong>Choose a tool</strong>
              </div>
              <button ref={closeButtonRef} type="button" aria-label="Close canvas tools" onClick={() => closeTools()}>
                <X aria-hidden="true" size={21} />
              </button>
            </header>

            <div className={styles.toolGrid} role="toolbar" aria-label="All canvas tools">
              {TOOLS.map(({ id, label, shortLabel, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  aria-label={label}
                  aria-pressed={activeTool === id}
                  data-tool={id}
                  onClick={() => chooseTool(id)}
                >
                  <Icon aria-hidden="true" size={22} />
                  <span>{shortLabel}</span>
                </button>
              ))}
            </div>

            {activeTool === "connector" ? (
              <div className={styles.connectorInspector}>
                <div className={styles.inspectorTitle}>
                  <SlidersHorizontal aria-hidden="true" size={16} />
                  Connector style
                </div>
                <div className={styles.optionGroup} role="group" aria-label="Connector routing">
                  <span>Routing</span>
                  <div>
                    {SEMANTIC_CONNECTOR_ROUTING_MODES.map((routing) => (
                      <button
                        key={routing}
                        type="button"
                        aria-pressed={connectorRouting === routing}
                        onClick={() => onConnectorRoutingChange(routing)}
                      >
                        {ROUTING_LABELS[routing]}
                      </button>
                    ))}
                  </div>
                </div>
                <div className={styles.optionGroup} role="group" aria-label="Connector direction">
                  <span>Arrows</span>
                  <div>
                    {SEMANTIC_CONNECTOR_DIRECTIONS.map((direction) => (
                      <button
                        key={direction}
                        type="button"
                        aria-pressed={connectorDirection === direction}
                        onClick={() => onConnectorDirectionChange(direction)}
                      >
                        {DIRECTION_LABELS[direction]}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ) : null}
          </section>
        </div>
      ) : null}
    </div>
  );
}
