"use client";

import {
  useLayoutEffect,
  useRef,
  type ChangeEvent,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type SyntheticEvent,
} from "react";

import { pageToViewportPoint } from "@/lib/canvas/camera";
import {
  SEMANTIC_TEXT_EDIT_LIMITS,
  type SemanticTextEditableObject,
} from "@/lib/canvas/semantic-text-edit-session";
import type { Viewport } from "@/lib/domain/types";

import styles from "./semantic-text-editor.module.css";

export type SemanticTextEditorProps = Readonly<{
  /** Identity for one edit attempt. A new ID restores focus and terminal behavior. */
  sessionId: string;
  /** Authoritative geometry and semantic field selection for the edited object. */
  object: SemanticTextEditableObject;
  /** Renderer-neutral page-space camera. */
  viewport: Viewport;
  /** Controlled, frame-immediate draft supplied by the edit-session host. */
  draft: string;
  onDraftChange: (value: string) => void;
  onCommit: () => void;
  /** Dedicated cancellation path. This component only invokes it for Escape. */
  onCancel: () => void;
  /** New text creation is single-line and commits with an unmodified Enter. */
  commitOnEnter?: boolean;
  ariaLabel?: string;
}>;

type TerminalAction = "commit" | "cancel";

const TEXT_FONT_SIZES = Object.freeze({
  s: 16,
  m: 20,
  l: 28,
  xl: 36,
});

function usableZoom(viewport: Viewport): number {
  return Number.isFinite(viewport.zoom) && viewport.zoom > 0 ? viewport.zoom : 1;
}

function editorLabel(object: SemanticTextEditableObject): string {
  if (object.kind === "text") return `Edit text content for object ${object.id}`;
  if (object.kind === "shape") return `Edit shape label for object ${object.id}`;
  if (object.kind === "connector") return `Edit connector label for object ${object.id}`;
  return `Edit image alt text for object ${object.id}`;
}

function stopCanvasEvent(event: SyntheticEvent): void {
  event.stopPropagation();
}

/**
 * Presentation-only first-party text overlay.
 *
 * The host owns the draft, semantic edit session, persistence, leases, and
 * reconciliation. This component only maps page geometry to CSS pixels and
 * reports user intent through callbacks.
 */
export function SemanticTextEditor({
  sessionId,
  object,
  viewport,
  draft,
  onDraftChange,
  onCommit,
  onCancel,
  commitOnEnter = false,
  ariaLabel,
}: SemanticTextEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const terminalActionRef = useRef<TerminalAction | null>(null);
  const zoom = usableZoom(viewport);
  const topLeft = pageToViewportPoint({ x: object.x, y: object.y }, viewport);
  const field = object.kind === "text" ? "content" : object.kind === "image" ? "alt" : "label";
  const maxLength = SEMANTIC_TEXT_EDIT_LIMITS[field];
  const fontSize = object.kind === "text" ? TEXT_FONT_SIZES[object.size] : 15;
  const textAlign = object.kind === "text"
    ? object.align === "middle"
      ? "center"
      : object.align === "end"
        ? "right"
        : "left"
    : "center";

  const frameStyle: CSSProperties = {
    left: topLeft.x,
    top: topLeft.y,
    width: object.width * zoom,
    height: object.height * zoom,
    transform: `rotate(${object.rotation}rad)`,
    transformOrigin: "center center",
    // Above canvas objects and presence, below the semantic toolbar/menu.
    zIndex: 370,
  };
  const editorStyle: CSSProperties = {
    fontSize: fontSize * zoom,
    lineHeight: object.kind === "text" ? 1.25 : 1.2,
    textAlign,
  };

  useLayoutEffect(() => {
    terminalActionRef.current = null;
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.focus({ preventScroll: true });
    textarea.select();
  }, [sessionId]);

  function commitOnce(): void {
    if (terminalActionRef.current) return;
    terminalActionRef.current = "commit";
    onCommit();
  }

  function cancelOnce(): void {
    if (terminalActionRef.current) return;
    terminalActionRef.current = "cancel";
    onCancel();
  }

  function handleChange(event: ChangeEvent<HTMLTextAreaElement>): void {
    if (terminalActionRef.current) return;
    const value = event.currentTarget.value;
    onDraftChange(value.length <= maxLength ? value : value.slice(0, maxLength));
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      cancelOnce();
      return;
    }
    if (event.key === "Enter" && (commitOnEnter || event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      commitOnce();
    }
  }

  function handleBlur(event: FocusEvent<HTMLTextAreaElement>): void {
    event.stopPropagation();
    commitOnce();
  }

  return (
    <div
      className={styles.frame}
      style={frameStyle}
      data-semantic-text-editor="true"
      data-edit-session-id={sessionId}
      data-object-id={object.id}
      data-edit-field={field}
      onClick={stopCanvasEvent}
      onDoubleClick={stopCanvasEvent}
      onMouseDown={stopCanvasEvent}
      onMouseMove={stopCanvasEvent}
      onMouseUp={stopCanvasEvent}
      onPointerCancel={stopCanvasEvent}
      onPointerDown={stopCanvasEvent}
      onPointerMove={stopCanvasEvent}
      onPointerUp={stopCanvasEvent}
      onTouchEnd={stopCanvasEvent}
      onTouchMove={stopCanvasEvent}
      onTouchStart={stopCanvasEvent}
      onWheel={stopCanvasEvent}
    >
      <textarea
        ref={textareaRef}
        className={styles.editor}
        style={editorStyle}
        aria-label={ariaLabel ?? editorLabel(object)}
        value={draft}
        maxLength={maxLength}
        rows={1}
        spellCheck
        onBlur={handleBlur}
        onChange={handleChange}
        onClick={stopCanvasEvent}
        onDoubleClick={stopCanvasEvent}
        onFocus={stopCanvasEvent}
        onKeyDown={handleKeyDown}
        onKeyPress={stopCanvasEvent}
        onKeyUp={stopCanvasEvent}
        onPointerCancel={stopCanvasEvent}
        onPointerDown={stopCanvasEvent}
        onPointerMove={stopCanvasEvent}
        onPointerUp={stopCanvasEvent}
        onWheel={stopCanvasEvent}
      />
    </div>
  );
}
