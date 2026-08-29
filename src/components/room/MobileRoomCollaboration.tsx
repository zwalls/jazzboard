"use client";

import { type ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import {
  ChevronLeft,
  ChevronRight,
  Focus,
  Presentation,
  Share2,
  Users,
  X,
} from "lucide-react";

import {
  announceMobileSurfaceOpen,
  subscribeToMobileSurfaceOpen,
} from "./mobile-surface-coordinator";
import styles from "./room.module.css";

export type MobileCollaborationSurface = "closed" | "menu" | "people" | "follow";

type MobileRoomCollaborationProps = {
  activeSurface: MobileCollaborationSurface;
  canSpotlight: boolean;
  connectionLabel: string;
  connectionState: "connecting" | "live" | "offline" | "polling";
  followContent: ReactNode;
  followSummary: string;
  peopleContent: ReactNode;
  peopleLabel: string;
  participantCount: number;
  spotlightLabel: string;
  onOpen(): void;
  onShare(): void;
  onSpotlight(): void;
  onSurfaceChange(surface: MobileCollaborationSurface): void;
};

const focusableSelector = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function MobileCollaborationPortal({ children }: Readonly<{ children: ReactNode }>) {
  return typeof document === "undefined" ? children : createPortal(children, document.body);
}

export function MobileRoomCollaboration({
  activeSurface,
  canSpotlight,
  connectionLabel,
  connectionState,
  followContent,
  followSummary,
  peopleContent,
  peopleLabel,
  participantCount,
  spotlightLabel,
  onOpen,
  onShare,
  onSpotlight,
  onSurfaceChange,
}: MobileRoomCollaborationProps) {
  const launcherRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLElement>(null);
  const open = activeSurface !== "closed";

  useEffect(() => {
    if (!open) return;
    const sheet = sheetRef.current;
    sheet?.querySelector<HTMLElement>(focusableSelector)?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onSurfaceChange("closed");
        window.requestAnimationFrame(() => launcherRef.current?.focus());
        return;
      }
      if (event.key !== "Tab" || !sheet) return;
      const focusable = Array.from(sheet.querySelectorAll<HTMLElement>(focusableSelector));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeSurface, onSurfaceChange, open]);

  useEffect(() => subscribeToMobileSurfaceOpen((surfaceId) => {
    if (surfaceId !== "collaboration" && open) onSurfaceChange("closed");
  }), [onSurfaceChange, open]);

  function closeAndRestoreFocus() {
    onSurfaceChange("closed");
    window.requestAnimationFrame(() => launcherRef.current?.focus());
  }

  function openSheet() {
    onOpen();
    announceMobileSurfaceOpen("collaboration");
    onSurfaceChange("menu");
  }

  const title = activeSurface === "people" ? "People" : activeSurface === "follow" ? "Follow" : "Collaborate";

  return (
    <div className={styles.mobileCollaboration} data-testid="mobile-room-collaboration">
      <button
        ref={launcherRef}
        aria-controls="mobile-collaboration-sheet"
        aria-expanded={open}
        aria-label={open ? "Collapse collaboration menu" : "Open collaboration menu"}
        className={styles.mobileCollaborationLauncher}
        data-testid="mobile-collaboration-launcher"
        onClick={() => {
          if (open) closeAndRestoreFocus();
          else openSheet();
        }}
      >
        <i
          aria-hidden="true"
          className={`${styles.connectionDot} ${
            connectionState === "offline"
              ? styles.mobileConnectionOffline
              : connectionState === "connecting"
                ? styles.mobileConnectionConnecting
                : ""
          }`}
        />
        <Users aria-hidden="true" size={17} />
        <span>{participantCount}</span>
        <ChevronRight aria-hidden="true" size={16} />
      </button>

      {open ? (
        <MobileCollaborationPortal>
          <div
          className={styles.mobileCollaborationBackdrop}
          data-testid="mobile-collaboration-backdrop"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) closeAndRestoreFocus();
          }}
          role="presentation"
          >
            <section
            ref={sheetRef}
            aria-labelledby="mobile-collaboration-title"
            aria-modal="true"
            className={styles.mobileCollaborationSheet}
            id="mobile-collaboration-sheet"
            onPointerDown={(event) => event.stopPropagation()}
            role="dialog"
          >
            <div className={styles.mobileSheetHandle} aria-hidden="true" />
            <header className={styles.mobileSheetHeader}>
              {activeSurface === "people" || activeSurface === "follow" ? (
                <button
                  aria-label="Back to collaboration menu"
                  className={styles.mobileSheetIconButton}
                  onClick={() => onSurfaceChange("menu")}
                >
                  <ChevronLeft size={20} />
                </button>
              ) : <span className={styles.mobileSheetHeaderSpacer} />}
              <div>
                <span>Room controls</span>
                <h2 id="mobile-collaboration-title">{title}</h2>
              </div>
              <button
                aria-label="Close collaboration menu"
                className={styles.mobileSheetIconButton}
                onClick={closeAndRestoreFocus}
              >
                <X size={20} />
              </button>
            </header>

            {activeSurface === "menu" ? (
              <div className={styles.mobileCollaborationMenu}>
                <div className={styles.mobileConnectionRow} role="status" aria-label={`Connection: ${connectionLabel}`}>
                  <i
                    aria-hidden="true"
                    className={`${styles.connectionDot} ${
                      connectionState === "offline"
                        ? styles.mobileConnectionOffline
                        : connectionState === "connecting"
                          ? styles.mobileConnectionConnecting
                          : ""
                    }`}
                  />
                  <span><strong>{connectionLabel}</strong><small>Canvas connection</small></span>
                </div>
                <button className={styles.mobileCollaborationRow} onClick={() => onSurfaceChange("people")}>
                  <span className={styles.mobileRowIcon}><Users size={19} /></span>
                  <span><strong>People</strong><small>{peopleLabel}</small></span>
                  <ChevronRight aria-hidden="true" size={18} />
                </button>
                <button className={styles.mobileCollaborationRow} onClick={() => onSurfaceChange("follow")}>
                  <span className={styles.mobileRowIcon}><Focus size={19} /></span>
                  <span><strong>Follow</strong><small>{followSummary}</small></span>
                  <ChevronRight aria-hidden="true" size={18} />
                </button>
                {canSpotlight ? (
                  <button className={styles.mobileCollaborationRow} onClick={onSpotlight}>
                    <span className={`${styles.mobileRowIcon} ${styles.mobileRowIconBrand}`}><Presentation size={19} /></span>
                    <span><strong>Spotlight</strong><small>{spotlightLabel}</small></span>
                    <ChevronRight aria-hidden="true" size={18} />
                  </button>
                ) : null}
                <button className={styles.mobileCollaborationRow} onClick={onShare}>
                  <span className={`${styles.mobileRowIcon} ${styles.mobileRowIconSoft}`}><Share2 size={19} /></span>
                  <span><strong>Share</strong><small>Invite people or copy the room link</small></span>
                  <ChevronRight aria-hidden="true" size={18} />
                </button>
              </div>
            ) : (
              <div className={styles.mobileSurfaceBody}>
                {activeSurface === "people" ? peopleContent : followContent}
              </div>
            )}
            </section>
          </div>
        </MobileCollaborationPortal>
      ) : null}
    </div>
  );
}
