"use client";

import {
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import {
  ArrowDown,
  ArrowUp,
  ClipboardPaste,
  Copy,
  CopyPlus,
  ChevronsDown,
  ChevronsUp,
  Download,
  Group,
  ListChecks,
  Maximize2,
  Pencil,
  Scissors,
  Trash2,
  Ungroup,
  type LucideIcon,
} from "lucide-react";

import styles from "./semantic-canvas-context-menu.module.css";

const VIEWPORT_MARGIN = 8;

export type SemanticCanvasContextMenuActionId =
  | "edit"
  | "cut"
  | "copy"
  | "paste"
  | "duplicate"
  | "group"
  | "ungroup"
  | "bring-to-front"
  | "bring-forward"
  | "send-backward"
  | "send-to-back"
  | "delete"
  | "download-original"
  | "select-all"
  | "fit-board";

export type SemanticCanvasContextMenuItem = Readonly<{
  id: SemanticCanvasContextMenuActionId;
  label: string;
  shortcut?: string;
  dividerBefore?: boolean;
  danger?: boolean;
  disabled?: boolean;
  href?: string;
  download?: boolean;
}>;

export type SemanticCanvasContextMenuProps = Readonly<{
  x: number;
  y: number;
  label: "Object actions" | "Canvas actions";
  items: readonly SemanticCanvasContextMenuItem[];
  onAction: (actionId: SemanticCanvasContextMenuActionId) => void;
  onDismiss: () => void;
}>;

const ICONS: Readonly<Record<SemanticCanvasContextMenuActionId, LucideIcon>> = {
  edit: Pencil,
  cut: Scissors,
  copy: Copy,
  paste: ClipboardPaste,
  duplicate: CopyPlus,
  group: Group,
  ungroup: Ungroup,
  "bring-to-front": ChevronsUp,
  "bring-forward": ArrowUp,
  "send-backward": ArrowDown,
  "send-to-back": ChevronsDown,
  delete: Trash2,
  "download-original": Download,
  "select-all": ListChecks,
  "fit-board": Maximize2,
};

function stopPointer(event: PointerEvent<HTMLDivElement>) {
  event.stopPropagation();
}

function stopContextMenu(event: MouseEvent<HTMLDivElement>) {
  event.preventDefault();
  event.stopPropagation();
}

/**
 * Renderer-neutral context surface. Items carry semantic action IDs while the
 * canvas host owns selection, permissions, leases, persistence, and rollback.
 */
export function SemanticCanvasContextMenu({
  x,
  y,
  label,
  items,
  onAction,
  onDismiss,
}: SemanticCanvasContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const parent = menu.offsetParent as HTMLElement | null;
    const availableWidth = parent?.clientWidth ?? window.innerWidth;
    const availableHeight = parent?.clientHeight ?? window.innerHeight;
    const left = Math.min(
      Math.max(VIEWPORT_MARGIN, x),
      Math.max(VIEWPORT_MARGIN, availableWidth - menu.offsetWidth - VIEWPORT_MARGIN),
    );
    const top = Math.min(
      Math.max(VIEWPORT_MARGIN, y),
      Math.max(VIEWPORT_MARGIN, availableHeight - menu.offsetHeight - VIEWPORT_MARGIN),
    );
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu
      ?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled):not([aria-disabled="true"])')
      ?.focus();
  }, [x, y]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const enabledItems = [...event.currentTarget.querySelectorAll<HTMLElement>(
      '[role="menuitem"]:not(:disabled):not([aria-disabled="true"])',
    )];
    const currentIndex = enabledItems.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Tab") {
      onDismiss();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onDismiss();
      return;
    }
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown") nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % enabledItems.length;
    else if (event.key === "ArrowUp") nextIndex = currentIndex < 0
      ? enabledItems.length - 1
      : (currentIndex - 1 + enabledItems.length) % enabledItems.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = enabledItems.length - 1;
    if (nextIndex === null || !enabledItems[nextIndex]) return;
    event.preventDefault();
    event.stopPropagation();
    enabledItems.forEach((item, index) => { item.tabIndex = index === nextIndex ? 0 : -1; });
    enabledItems[nextIndex].focus();
  }

  const firstEnabledIndex = items.findIndex((item) => !item.disabled);

  return (
    <div
      ref={menuRef}
      className={styles.menu}
      data-semantic-context-menu="true"
      role="menu"
      aria-label={label}
      style={{ left: x, top: y }}
      onPointerDown={stopPointer}
      onContextMenu={stopContextMenu}
      onKeyDown={handleKeyDown}
    >
      {items.map((item, index) => {
        const Icon = ICONS[item.id];
        const className = [
          styles.item,
          item.dividerBefore ? styles.divider : "",
          item.danger ? styles.danger : "",
        ].filter(Boolean).join(" ");
        const content = (
          <>
            <Icon aria-hidden="true" size={15} />
            <span className={styles.label}>{item.label}</span>
            {item.shortcut ? <kbd aria-hidden="true">{item.shortcut}</kbd> : null}
          </>
        );

        if (item.href) {
          return (
            <a
              key={item.id}
              className={className}
              role="menuitem"
              href={item.href}
              download={item.download || undefined}
              aria-disabled={item.disabled || undefined}
              tabIndex={item.disabled || index !== firstEnabledIndex ? -1 : 0}
              onClick={(event) => {
                if (item.disabled) {
                  event.preventDefault();
                  return;
                }
                onDismiss();
              }}
            >
              {content}
            </a>
          );
        }

        return (
          <button
            key={item.id}
            className={className}
            role="menuitem"
            type="button"
            disabled={item.disabled}
            tabIndex={item.disabled || index !== firstEnabledIndex ? -1 : 0}
            onClick={() => onAction(item.id)}
          >
            {content}
          </button>
        );
      })}
    </div>
  );
}
