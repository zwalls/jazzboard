"use client";

import { forwardRef } from "react";

import { SemanticCanvas } from "./SemanticCanvas";
import type { CanvasSurfaceHandle, CanvasSurfaceProps } from "./canvas-surface-types";
import styles from "./room.module.css";

export type { CanvasSurfaceHandle } from "./canvas-surface-types";

/** First-party semantic canvas, with mutations available only to participants. */
export const CanvasSurface = forwardRef<CanvasSurfaceHandle, CanvasSurfaceProps>(function CanvasSurface(props, ref) {
  return (
    <div
      className={styles.canvasShell}
      data-testid="jazzboard-canvas"
      data-canvas-surface="jazzboard-semantic-v1"
    >
      <SemanticCanvas
        ref={ref}
        boardMenuActions={props.boardMenuActions}
        persistentChromeHost={props.persistentChromeHost}
        cleanInspectionId={props.cleanInspectionId}
        room={props.room}
        agentDrafts={props.agentDrafts}
        initialAgentDraftIds={props.initialAgentDraftIds}
        self={props.self}
        renameRoom={props.renameRoom}
        followTarget={props.followTarget}
        presence={props.presence}
        transientPresence={props.transientPresence}
        connection={props.connection}
        onSelectionChange={props.onSelectionChange}
        onRuntimeChange={props.onRuntimeChange}
        onExitFollow={props.onExitFollow}
        editing={props.self.role === "participant" ? {
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
});
