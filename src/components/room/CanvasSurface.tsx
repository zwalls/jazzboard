"use client";

import dynamic from "next/dynamic";
import { forwardRef } from "react";

import { getCanvasRendererMode } from "@/lib/canvas/renderer-mode";

import { SemanticCanvas } from "./SemanticCanvas";
import type { CanvasSurfaceHandle, CanvasSurfaceProps } from "./canvas-surface-types";
import styles from "./room.module.css";

const TldrawCanvasAdapter = dynamic(() => import("./TldrawCanvasAdapter"), {
  ssr: false,
  loading: () => (
    <div
      className={`${styles.canvasShell} ${styles.canvasRendererLoading}`}
      role="status"
      aria-label="Loading canvas renderer"
    />
  ),
});

export type { CanvasSurfaceHandle } from "./canvas-surface-types";

/**
 * Feature-gated renderer facade. The first-party surface remains an explicit
 * participant canary until editing, sync, accessibility, and export gates pass.
 */
export const CanvasSurface = forwardRef<CanvasSurfaceHandle, CanvasSurfaceProps>(function CanvasSurface(props, ref) {
  const mode = getCanvasRendererMode(props.self.role);
  if (mode === "semantic" || mode === "semantic-edit") {
    return (
      <div
        className={styles.canvasShell}
        data-testid="jazzboard-canvas"
        data-canvas-surface="jazzboard-semantic-v1"
      >
        <SemanticCanvas
          ref={ref}
          boardMenuActions={props.boardMenuActions}
          room={props.room}
          self={props.self}
          followTarget={props.followTarget}
          presence={props.presence}
          transientPresence={props.transientPresence}
          connection={props.connection}
          onSelectionChange={props.onSelectionChange}
          onRuntimeChange={props.onRuntimeChange}
          onExitFollow={props.onExitFollow}
          editing={mode === "semantic-edit" ? {
            command: props.command,
            semanticTransaction: props.semanticTransaction,
            lease: props.lease,
            leaseMany: props.leaseMany,
            refresh: props.refresh,
            onError: props.onError,
          } : null}
        />
      </div>
    );
  }
  // Shadow mode intentionally keeps the proven renderer visible. Geometry
  // comparison can run alongside it without exposing an incomplete editor.
  return <TldrawCanvasAdapter canvasRef={ref} shadowParity={mode === "shadow"} {...props} />;
});
