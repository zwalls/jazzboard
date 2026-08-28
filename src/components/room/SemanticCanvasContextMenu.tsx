"use client";

import {
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { Download } from "lucide-react";

import styles from "./semantic-canvas-context-menu.module.css";

export type SemanticCanvasContextMenuProps = Readonly<{
  x: number;
  y: number;
  downloadUrl: string;
  onDismiss: () => void;
}>;

function stopPointer(event: PointerEvent<HTMLDivElement>) {
  event.stopPropagation();
}

function stopContextMenu(event: MouseEvent<HTMLDivElement>) {
  event.preventDefault();
  event.stopPropagation();
}

/**
 * Small renderer-owned context surface for capabilities that belong to one
 * semantic object instead of the board export menu. The original asset URL is
 * already guest-session authorized by the room asset route; no bytes or
 * snapshot are retained by this component.
 */
export function SemanticCanvasContextMenu({
  x,
  y,
  downloadUrl,
  onDismiss,
}: SemanticCanvasContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, []);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const currentIndex = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onDismiss();
      return;
    }
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown") nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
    else if (event.key === "ArrowUp") nextIndex = currentIndex < 0 ? items.length - 1 : (currentIndex - 1 + items.length) % items.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = items.length - 1;
    if (nextIndex === null || !items[nextIndex]) return;
    event.preventDefault();
    event.stopPropagation();
    items[nextIndex].focus();
  }

  return (
    <div
      ref={menuRef}
      className={styles.menu}
      role="menu"
      aria-label="Image actions"
      style={{ left: x, top: y }}
      onPointerDown={stopPointer}
      onContextMenu={stopContextMenu}
      onKeyDown={handleKeyDown}
    >
      <a
        className={styles.item}
        role="menuitem"
        href={downloadUrl}
        download
        onClick={onDismiss}
      >
        <Download aria-hidden="true" size={15} />
        Download original
      </a>
    </div>
  );
}
