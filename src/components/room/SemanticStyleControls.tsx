"use client";

import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Edit3,
  Lock,
  Palette,
  Tag,
  Unlock,
  X,
} from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type SyntheticEvent,
} from "react";

import type { SemanticObjectStylePatch } from "@/lib/canvas/semantic-transform-session";
import type {
  CanvasObject,
  ConnectorObject,
  ConnectorRoutingInput,
  ConnectorRoutingMode,
  DiagramNodeType,
  DrawObject,
  ImageObject,
  ShapeObject,
  TextObject,
} from "@/lib/domain/types";

import styles from "./semantic-style-controls.module.css";

export const SEMANTIC_STYLE_COLORS = [
  { value: "black", label: "Black", hex: "#1d1d1d" },
  { value: "grey", label: "Grey", hex: "#8b919a" },
  { value: "white", label: "White", hex: "#ffffff" },
  { value: "blue", label: "Blue", hex: "#4263eb" },
  { value: "light-blue", label: "Light blue", hex: "#a5d8ff" },
  { value: "violet", label: "Violet", hex: "#7950f2" },
  { value: "light-violet", label: "Light violet", hex: "#e9e7ff" },
  { value: "green", label: "Green", hex: "#2f9e44" },
  { value: "light-green", label: "Light green", hex: "#b2f2bb" },
  { value: "yellow", label: "Yellow", hex: "#f5d90a" },
  { value: "orange", label: "Orange", hex: "#f08c00" },
  { value: "red", label: "Red", hex: "#e03131" },
  { value: "light-red", label: "Light red", hex: "#ffc9c9" },
] as const;

export const SEMANTIC_NODE_TYPES = [
  null,
  "service",
  "component",
  "requirement",
  "decision",
  "open_question",
] as const satisfies readonly (DiagramNodeType | null)[];

export type SemanticStyleEditRequest =
  | Readonly<{ objectKind: "text"; field: "content"; objectIds: readonly string[] }>
  | Readonly<{ objectKind: "shape"; field: "label"; objectIds: readonly string[] }>
  | Readonly<{ objectKind: "connector"; field: "label"; objectIds: readonly string[] }>
  | Readonly<{ objectKind: "image"; field: "alt"; objectIds: readonly string[] }>;

export type SemanticStyleControlsProps = Readonly<{
  /** Authoritative semantic objects in the host's canonical selection order. */
  selectedObjects: readonly CanvasObject[];
  /** Spectators pass false and receive no style affordance. */
  editing: boolean;
  /** Optional transient disablement while the host reconciles or changes tools. */
  disabled?: boolean;
  /** Reports style intent only. The host owns leases, persistence, and rollback. */
  onStylePatch: (patch: SemanticObjectStylePatch) => void;
  /** Requests a host-owned text/label/alt editor without mutating the object. */
  onEditRequest: (request: SemanticStyleEditRequest) => void;
}>;

type ColorPanelId =
  | "text-color"
  | "shape-fill"
  | "shape-stroke"
  | "connector-color"
  | "draw-color";

type CommonValue<Value> = Readonly<{
  mixed: boolean;
  value: Value;
}>;

type ColorFieldProps = Readonly<{
  panelId: ColorPanelId;
  label: string;
  value: string;
  mixed: boolean;
  allowNone?: boolean;
  disabled: boolean;
  open: boolean;
  onOpen: (panelId: ColorPanelId, opener: HTMLButtonElement) => void;
  onDismiss: (restoreFocus?: boolean) => void;
  onSelect: (value: string) => void;
}>;

const COLOR_HEX_BY_NAME = Object.freeze(
  Object.fromEntries(SEMANTIC_STYLE_COLORS.map(({ value, hex }) => [value, hex])),
) as Readonly<Record<string, string>>;

const HEX_COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const MIXED_VALUE = "__mixed__";
const GENERIC_NODE_VALUE = "__generic__";

const TEXT_SIZES = ["s", "m", "l", "xl"] as const;
const TEXT_ALIGNS = ["start", "middle", "end"] as const;
const DRAW_SIZES = ["s", "m", "l"] as const;
const CONNECTOR_DIRECTIONS = ["none", "end", "both"] as const;
const CONNECTOR_ROUTING_MODES = ["auto", "straight", "curved", "elbow"] as const;

const SIZE_LABELS: Readonly<Record<(typeof TEXT_SIZES)[number], string>> = {
  s: "Small",
  m: "Medium",
  l: "Large",
  xl: "Extra large",
};

const ALIGN_LABELS: Readonly<Record<(typeof TEXT_ALIGNS)[number], string>> = {
  start: "Align left",
  middle: "Align center",
  end: "Align right",
};

const DRAW_SIZE_LABELS: Readonly<Record<(typeof DRAW_SIZES)[number], string>> = {
  s: "Thin",
  m: "Medium",
  l: "Thick",
};

const DIRECTION_LABELS: Readonly<Record<(typeof CONNECTOR_DIRECTIONS)[number], string>> = {
  none: "No arrows",
  end: "End arrow",
  both: "Both ends",
};

const ROUTING_LABELS: Readonly<Record<(typeof CONNECTOR_ROUTING_MODES)[number], string>> = {
  auto: "Auto route",
  straight: "Straight",
  curved: "Curved",
  elbow: "Elbow",
};

const NODE_TYPE_LABELS: Readonly<Record<DiagramNodeType, string>> = {
  service: "Service",
  component: "Component",
  requirement: "Requirement",
  decision: "Decision",
  open_question: "Open question",
};

function commonValue<Value>(values: readonly Value[]): CommonValue<Value> {
  const first = values[0]!;
  return {
    mixed: values.some((value) => value !== first),
    value: first,
  };
}

function homogeneousKind(objects: readonly CanvasObject[]): CanvasObject["kind"] | null {
  const kind = objects[0]?.kind;
  if (!kind || objects.some((object) => object.kind !== kind)) return null;
  return kind;
}

function normalizeHex(value: string): string | null {
  const candidate = value.trim().toLowerCase();
  return HEX_COLOR_PATTERN.test(candidate) ? candidate : null;
}

function safeSwatchColor(value: string, mixed: boolean): string | null {
  if (mixed || value === "none") return null;
  return COLOR_HEX_BY_NAME[value.toLowerCase()] ?? normalizeHex(value);
}

function stopCanvasEvent(event: SyntheticEvent): void {
  event.stopPropagation();
}

function selectValue<Value extends string>(common: CommonValue<Value>): Value | typeof MIXED_VALUE {
  return common.mixed ? MIXED_VALUE : common.value;
}

function editRequest(
  objectKind: SemanticStyleEditRequest["objectKind"],
  objectIds: readonly string[],
): SemanticStyleEditRequest {
  if (objectKind === "text") return { objectKind, field: "content", objectIds };
  if (objectKind === "image") return { objectKind, field: "alt", objectIds };
  return { objectKind, field: "label", objectIds };
}

function ColorField({
  panelId,
  label,
  value,
  mixed,
  allowNone = false,
  disabled,
  open,
  onOpen,
  onDismiss,
  onSelect,
}: ColorFieldProps) {
  const dialogId = useId();
  const [customHex, setCustomHex] = useState(() => normalizeHex(value) ?? "#5965e8");
  const [customInvalid, setCustomInvalid] = useState(false);
  const swatchColor = safeSwatchColor(value, mixed);
  const triggerStyle = swatchColor
    ? ({ "--semantic-style-swatch": swatchColor } as CSSProperties)
    : undefined;

  function choose(valueToApply: string): void {
    if (disabled) return;
    onSelect(valueToApply);
    onDismiss(true);
  }

  function submitCustom(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    event.stopPropagation();
    if (disabled) return;
    const normalized = normalizeHex(customHex);
    if (!normalized) {
      setCustomInvalid(true);
      return;
    }
    setCustomInvalid(false);
    choose(normalized);
  }

  function changeCustom(event: ChangeEvent<HTMLInputElement>): void {
    setCustomHex(event.target.value.slice(0, 9));
    setCustomInvalid(false);
  }

  return (
    <div className={styles.colorField}>
      <button
        type="button"
        className={styles.colorTrigger}
        data-color-field={panelId}
        data-mixed={mixed ? "true" : "false"}
        aria-label={`${label}: ${mixed ? "mixed" : value}`}
        aria-controls={dialogId}
        aria-expanded={open}
        aria-haspopup="dialog"
        disabled={disabled}
        onClick={(event) => onOpen(panelId, event.currentTarget)}
      >
        <span
          className={`${styles.colorPreview} ${swatchColor ? "" : styles.colorPreviewMixed}`}
          style={triggerStyle}
          aria-hidden="true"
        />
        <span>{label}</span>
      </button>

      {open ? (
        <div
          id={dialogId}
          className={styles.colorPopover}
          role="dialog"
          aria-label={`${label} picker`}
          aria-modal="false"
        >
          <div className={styles.popoverHeading}>
            <span>{label}</span>
            <button
              type="button"
              className={styles.dismissButton}
              aria-label={`Close ${label.toLowerCase()} picker`}
              onClick={() => onDismiss(true)}
            >
              <X aria-hidden="true" size={13} />
            </button>
          </div>

          <div className={styles.swatchGrid} role="group" aria-label={`${label} colors`}>
            {allowNone ? (
              <button
                type="button"
                className={`${styles.swatch} ${styles.noneSwatch}`}
                aria-label={`No ${label.toLowerCase()}`}
                aria-pressed={!mixed && value.toLowerCase() === "none"}
                disabled={disabled}
                onClick={() => choose("none")}
              />
            ) : null}
            {SEMANTIC_STYLE_COLORS.map((color) => (
              <button
                key={color.value}
                type="button"
                className={styles.swatch}
                style={{ "--semantic-style-swatch": color.hex } as CSSProperties}
                aria-label={`${color.label} ${label.toLowerCase()}`}
                aria-pressed={!mixed && value.toLowerCase() === color.value}
                disabled={disabled}
                onClick={() => choose(color.value)}
              />
            ))}
          </div>

          <form className={styles.customColorForm} onSubmit={submitCustom} noValidate>
            <label htmlFor={`${dialogId}-custom`}>Custom hex</label>
            <div className={styles.customColorRow}>
              <input
                id={`${dialogId}-custom`}
                type="text"
                inputMode="text"
                autoComplete="off"
                spellCheck={false}
                maxLength={9}
                pattern="#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?([0-9a-fA-F]{2})?"
                value={customHex}
                aria-invalid={customInvalid}
                aria-describedby={customInvalid ? `${dialogId}-error` : undefined}
                disabled={disabled}
                onChange={changeCustom}
              />
              <button type="submit" disabled={disabled}>Apply</button>
            </div>
            {customInvalid ? (
              <span id={`${dialogId}-error`} className={styles.fieldError} role="alert">
                Enter a 3, 6, or 8 digit hex color.
              </span>
            ) : null}
          </form>
        </div>
      ) : null}
    </div>
  );
}

function TextControls({
  objects,
  disabled,
  openPanel,
  onOpenPanel,
  onDismissPanel,
  onPatch,
  onEdit,
}: Readonly<{
  objects: readonly TextObject[];
  disabled: boolean;
  openPanel: ColorPanelId | null;
  onOpenPanel: ColorFieldProps["onOpen"];
  onDismissPanel: ColorFieldProps["onDismiss"];
  onPatch: (patch: SemanticObjectStylePatch) => void;
  onEdit: () => void;
}>) {
  const color = commonValue(objects.map((object) => object.color));
  const size = commonValue(objects.map((object) => object.size));
  const align = commonValue(objects.map((object) => object.align));

  return (
    <>
      <ColorField
        panelId="text-color"
        label="Text color"
        value={color.value}
        mixed={color.mixed}
        disabled={disabled}
        open={openPanel === "text-color"}
        onOpen={onOpenPanel}
        onDismiss={onDismissPanel}
        onSelect={(value) => onPatch({ kind: "text", color: value })}
      />

      <label className={styles.compactSelect}>
        <span className={styles.srOnly}>Text size</span>
        <select
          aria-label="Text size"
          value={selectValue(size)}
          disabled={disabled}
          onChange={(event) => onPatch({ kind: "text", size: event.target.value as TextObject["size"] })}
        >
          {size.mixed ? <option value={MIXED_VALUE}>Mixed size</option> : null}
          {TEXT_SIZES.map((value) => <option key={value} value={value}>{SIZE_LABELS[value]}</option>)}
        </select>
      </label>

      <div className={styles.segmented} role="group" aria-label="Text alignment" data-mixed={align.mixed ? "true" : "false"}>
        {TEXT_ALIGNS.map((value) => {
          const Icon = value === "start" ? AlignLeft : value === "middle" ? AlignCenter : AlignRight;
          return (
            <button
              key={value}
              type="button"
              aria-label={ALIGN_LABELS[value]}
              aria-pressed={!align.mixed && align.value === value}
              disabled={disabled}
              onClick={() => onPatch({ kind: "text", align: value })}
            >
              <Icon aria-hidden="true" size={14} />
            </button>
          );
        })}
      </div>

      <button type="button" className={styles.editButton} disabled={disabled} onClick={onEdit}>
        <Edit3 aria-hidden="true" size={13} />
        Edit text
      </button>
    </>
  );
}

function ShapeControls({
  objects,
  disabled,
  openPanel,
  onOpenPanel,
  onDismissPanel,
  onPatch,
  onEdit,
}: Readonly<{
  objects: readonly ShapeObject[];
  disabled: boolean;
  openPanel: ColorPanelId | null;
  onOpenPanel: ColorFieldProps["onOpen"];
  onDismissPanel: ColorFieldProps["onDismiss"];
  onPatch: (patch: SemanticObjectStylePatch) => void;
  onEdit: () => void;
}>) {
  const fill = commonValue(objects.map((object) => object.fill));
  const stroke = commonValue(objects.map((object) => object.stroke));
  const nodeType = commonValue(objects.map((object) => object.nodeType));
  const nodeTypeValue = nodeType.mixed
    ? MIXED_VALUE
    : nodeType.value === null
      ? GENERIC_NODE_VALUE
      : nodeType.value;

  function changeNodeType(event: ChangeEvent<HTMLSelectElement>): void {
    if (event.target.value === MIXED_VALUE) return;
    const nextNodeType = event.target.value === GENERIC_NODE_VALUE
      ? null
      : event.target.value as DiagramNodeType;
    onPatch({ kind: "shape", nodeType: nextNodeType });
  }

  return (
    <>
      <ColorField
        panelId="shape-fill"
        label="Fill"
        value={fill.value}
        mixed={fill.mixed}
        allowNone
        disabled={disabled}
        open={openPanel === "shape-fill"}
        onOpen={onOpenPanel}
        onDismiss={onDismissPanel}
        onSelect={(value) => onPatch({ kind: "shape", fill: value })}
      />
      <ColorField
        panelId="shape-stroke"
        label="Stroke"
        value={stroke.value}
        mixed={stroke.mixed}
        disabled={disabled}
        open={openPanel === "shape-stroke"}
        onOpen={onOpenPanel}
        onDismiss={onDismissPanel}
        onSelect={(value) => onPatch({ kind: "shape", stroke: value })}
      />

      <label className={styles.compactSelect}>
        <span className={styles.srOnly}>Node type</span>
        <select aria-label="Node type" value={nodeTypeValue} disabled={disabled} onChange={changeNodeType}>
          {nodeType.mixed ? <option value={MIXED_VALUE}>Mixed types</option> : null}
          <option value={GENERIC_NODE_VALUE}>Generic</option>
          {SEMANTIC_NODE_TYPES.filter((value): value is DiagramNodeType => value !== null).map((value) => (
            <option key={value} value={value}>{NODE_TYPE_LABELS[value]}</option>
          ))}
        </select>
      </label>

      <button type="button" className={styles.editButton} disabled={disabled} onClick={onEdit}>
        <Tag aria-hidden="true" size={13} />
        Edit label
      </button>
    </>
  );
}

function connectorRoutingIntent(
  mode: ConnectorRoutingMode,
  objects: readonly ConnectorObject[],
): ConnectorRoutingInput {
  const representative = objects[0]?.routing;
  const labelPosition = representative?.labelPosition;
  if (mode === "curved") {
    const bend = representative?.kind === "curved" && Math.abs(representative.bend) >= 8
      ? representative.bend
      : 64;
    return { mode, bend, ...(labelPosition === undefined ? {} : { labelPosition }) };
  }
  if (mode === "elbow") {
    return {
      mode,
      elbowMidPoint: representative?.elbowMidPoint ?? 0.5,
      ...(labelPosition === undefined ? {} : { labelPosition }),
    };
  }
  return { mode, ...(labelPosition === undefined ? {} : { labelPosition }) };
}

function ConnectorControls({
  objects,
  disabled,
  openPanel,
  onOpenPanel,
  onDismissPanel,
  onPatch,
  onEdit,
}: Readonly<{
  objects: readonly ConnectorObject[];
  disabled: boolean;
  openPanel: ColorPanelId | null;
  onOpenPanel: ColorFieldProps["onOpen"];
  onDismissPanel: ColorFieldProps["onDismiss"];
  onPatch: (patch: SemanticObjectStylePatch) => void;
  onEdit: () => void;
}>) {
  const color = commonValue(objects.map((object) => object.color));
  const direction = commonValue(objects.map((object) => object.direction));
  const routing = commonValue(objects.map((object) => object.routing?.mode ?? "straight"));

  return (
    <>
      <ColorField
        panelId="connector-color"
        label="Line color"
        value={color.value}
        mixed={color.mixed}
        disabled={disabled}
        open={openPanel === "connector-color"}
        onOpen={onOpenPanel}
        onDismiss={onDismissPanel}
        onSelect={(value) => onPatch({ kind: "connector", color: value })}
      />

      <label className={styles.compactSelect}>
        <span className={styles.srOnly}>Connector routing</span>
        <select
          aria-label="Connector routing"
          value={selectValue(routing)}
          disabled={disabled}
          onChange={(event) => {
            const mode = event.target.value as (typeof CONNECTOR_ROUTING_MODES)[number];
            onPatch({ kind: "connector", routing: connectorRoutingIntent(mode, objects) });
          }}
        >
          {routing.mixed ? <option value={MIXED_VALUE}>Mixed routes</option> : null}
          {CONNECTOR_ROUTING_MODES.map((value) => (
            <option key={value} value={value}>{ROUTING_LABELS[value]}</option>
          ))}
        </select>
      </label>

      <div className={styles.segmented} role="group" aria-label="Connector arrows" data-mixed={direction.mixed ? "true" : "false"}>
        {CONNECTOR_DIRECTIONS.map((value) => (
          <button
            key={value}
            type="button"
            aria-label={DIRECTION_LABELS[value]}
            aria-pressed={!direction.mixed && direction.value === value}
            disabled={disabled}
            onClick={() => onPatch({ kind: "connector", direction: value })}
          >
            {value === "none" ? "—" : value === "end" ? "→" : "↔"}
          </button>
        ))}
      </div>

      <button type="button" className={styles.editButton} disabled={disabled} onClick={onEdit}>
        <Tag aria-hidden="true" size={13} />
        Edit label
      </button>
    </>
  );
}

function DrawControls({
  objects,
  disabled,
  openPanel,
  onOpenPanel,
  onDismissPanel,
  onPatch,
}: Readonly<{
  objects: readonly DrawObject[];
  disabled: boolean;
  openPanel: ColorPanelId | null;
  onOpenPanel: ColorFieldProps["onOpen"];
  onDismissPanel: ColorFieldProps["onDismiss"];
  onPatch: (patch: SemanticObjectStylePatch) => void;
}>) {
  const color = commonValue(objects.map((object) => object.color));
  const size = commonValue(objects.map((object) => object.size));

  return (
    <>
      <ColorField
        panelId="draw-color"
        label="Draw color"
        value={color.value}
        mixed={color.mixed}
        disabled={disabled}
        open={openPanel === "draw-color"}
        onOpen={onOpenPanel}
        onDismiss={onDismissPanel}
        onSelect={(value) => onPatch({ kind: "draw", color: value })}
      />
      <div className={styles.segmented} role="group" aria-label="Draw width" data-mixed={size.mixed ? "true" : "false"}>
        {DRAW_SIZES.map((value) => (
          <button
            key={value}
            type="button"
            aria-label={DRAW_SIZE_LABELS[value]}
            aria-pressed={!size.mixed && size.value === value}
            disabled={disabled}
            onClick={() => onPatch({ kind: "draw", size: value })}
          >
            <span className={styles[`drawSize-${value}`]} aria-hidden="true" />
          </button>
        ))}
      </div>
    </>
  );
}

function ImageControls({
  objects,
  disabled,
  onPatch,
  onEdit,
}: Readonly<{
  objects: readonly ImageObject[];
  disabled: boolean;
  onPatch: (patch: SemanticObjectStylePatch) => void;
  onEdit: () => void;
}>) {
  const locked = commonValue(objects.map((object) => object.locked));
  const willLock = locked.mixed || !locked.value;
  const LockIcon = willLock ? Lock : Unlock;
  const countLabel = objects.length === 1 ? "image" : "images";

  return (
    <>
      <button type="button" className={styles.editButton} disabled={disabled} onClick={onEdit}>
        <Edit3 aria-hidden="true" size={13} />
        Edit alt text
      </button>
      <button
        type="button"
        className={styles.editButton}
        aria-label={`${willLock ? "Lock" : "Unlock"} ${countLabel}`}
        aria-pressed={locked.mixed ? "mixed" : locked.value}
        disabled={disabled}
        onClick={() => onPatch({ kind: "image", locked: willLock })}
      >
        <LockIcon aria-hidden="true" size={13} />
        {willLock ? "Lock" : "Unlock"}
      </button>
    </>
  );
}

/**
 * Compact, renderer-neutral style controls for a homogeneous semantic selection.
 *
 * This component intentionally has no canvas, layout, lease, persistence, or
 * tldraw knowledge. It only reflects authoritative object fields and reports
 * typed user intent back to the owning canvas host.
 */
export function SemanticStyleControls({
  selectedObjects,
  editing,
  disabled = false,
  onStylePatch,
  onEditRequest,
}: SemanticStyleControlsProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const [openPanel, setOpenPanel] = useState<ColorPanelId | null>(null);
  const kind = homogeneousKind(selectedObjects);
  const objectIds = selectedObjects.map((object) => object.id);
  const interactive = editing && !disabled;

  useEffect(() => {
    if (!openPanel || !interactive) return;

    function dismissOutside(event: PointerEvent): void {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) return;
      setOpenPanel(null);
    }

    document.addEventListener("pointerdown", dismissOutside, true);
    return () => document.removeEventListener("pointerdown", dismissOutside, true);
  }, [interactive, openPanel]);

  if (!editing || !kind || selectedObjects.length === 0) return null;

  const kindLabel = kind === "draw" ? "drawing" : kind;
  const controlLabel = `${kindLabel[0]!.toUpperCase()}${kindLabel.slice(1)} styles for ${selectedObjects.length} selected object${selectedObjects.length === 1 ? "" : "s"}`;
  const visibleOpenPanel = disabled ? null : openPanel;

  function emitPatch(patch: SemanticObjectStylePatch): void {
    if (!interactive || patch.kind !== kind) return;
    onStylePatch(patch);
  }

  function requestEdit(): void {
    if (
      !interactive ||
      (kind !== "text" && kind !== "shape" && kind !== "connector" && kind !== "image")
    ) return;
    onEditRequest(editRequest(kind, objectIds));
  }

  function openColorPanel(panelId: ColorPanelId, opener: HTMLButtonElement): void {
    if (!interactive) return;
    openerRef.current = opener;
    setOpenPanel((current) => current === panelId ? null : panelId);
  }

  function dismissColorPanel(restoreFocus = false): void {
    setOpenPanel(null);
    if (restoreFocus) openerRef.current?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    event.stopPropagation();
    if (event.key !== "Escape" || !visibleOpenPanel) return;
    event.preventDefault();
    dismissColorPanel(true);
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    event.stopPropagation();
  }

  return (
    <div
      ref={rootRef}
      className={styles.root}
      role="toolbar"
      aria-label={controlLabel}
      data-semantic-style-controls={kind}
      data-selection-count={selectedObjects.length}
      onClick={stopCanvasEvent}
      onContextMenu={stopCanvasEvent}
      onDoubleClick={stopCanvasEvent}
      onKeyDown={handleKeyDown}
      onPointerCancel={stopCanvasEvent}
      onPointerDown={handlePointerDown}
      onPointerMove={stopCanvasEvent}
      onPointerUp={stopCanvasEvent}
      onWheel={stopCanvasEvent}
    >
      <Palette className={styles.paletteIcon} aria-hidden="true" size={14} />

      {kind === "text" ? (
        <TextControls
          objects={selectedObjects as readonly TextObject[]}
          disabled={disabled}
          openPanel={visibleOpenPanel}
          onOpenPanel={openColorPanel}
          onDismissPanel={dismissColorPanel}
          onPatch={emitPatch}
          onEdit={requestEdit}
        />
      ) : null}

      {kind === "shape" ? (
        <ShapeControls
          objects={selectedObjects as readonly ShapeObject[]}
          disabled={disabled}
          openPanel={visibleOpenPanel}
          onOpenPanel={openColorPanel}
          onDismissPanel={dismissColorPanel}
          onPatch={emitPatch}
          onEdit={requestEdit}
        />
      ) : null}

      {kind === "connector" ? (
        <ConnectorControls
          objects={selectedObjects as readonly ConnectorObject[]}
          disabled={disabled}
          openPanel={visibleOpenPanel}
          onOpenPanel={openColorPanel}
          onDismissPanel={dismissColorPanel}
          onPatch={emitPatch}
          onEdit={requestEdit}
        />
      ) : null}

      {kind === "draw" ? (
        <DrawControls
          objects={selectedObjects as readonly DrawObject[]}
          disabled={disabled}
          openPanel={visibleOpenPanel}
          onOpenPanel={openColorPanel}
          onDismissPanel={dismissColorPanel}
          onPatch={emitPatch}
        />
      ) : null}

      {kind === "image" ? (
        <ImageControls
          objects={selectedObjects as readonly ImageObject[]}
          disabled={disabled}
          onPatch={emitPatch}
          onEdit={requestEdit}
        />
      ) : null}
    </div>
  );
}
