import { memo } from "react";

import type { SemanticScene } from "@/lib/canvas/semantic-scene";

import { SemanticCanvasObject, type SemanticCanvasObjectProps } from "./SemanticCanvasObject";
import styles from "./semantic-canvas.module.css";

type SemanticCanvasObjectLayerProps = Readonly<{
  scene: SemanticScene;
  selectedObjectIds: ReadonlySet<string>;
  focusedObjectId: string | null;
  cleanInspectionActive: boolean;
  presentingObjectIds: ReadonlySet<string>;
  tabStopObjectId: string | null;
}> & Pick<SemanticCanvasObjectProps, "onSelect" | "onPointerStart" | "onEditRequested" | "onFocus" | "onBlur">;

/** Camera and marquee updates stay outside this layer, including object-list reconciliation. */
export const SemanticCanvasObjectLayer = memo(function SemanticCanvasObjectLayer({
  scene,
  selectedObjectIds,
  focusedObjectId,
  cleanInspectionActive,
  presentingObjectIds,
  tabStopObjectId,
  onSelect,
  onPointerStart,
  onEditRequested,
  onFocus,
  onBlur,
}: SemanticCanvasObjectLayerProps) {
  return (
    <>
      {scene.objects.map(({ object, bounds }) => (
        <SemanticCanvasObject
          key={`object:${object.id}`}
          object={object}
          bounds={bounds}
          connectorRoute={object.kind === "connector" ? scene.connectorRoutes[object.id] : undefined}
          selected={!cleanInspectionActive && selectedObjectIds.has(object.id)}
          focused={!cleanInspectionActive && focusedObjectId === object.id}
          suppressFocusVisual={cleanInspectionActive}
          presentationHidden={!cleanInspectionActive && presentingObjectIds.has(object.id)}
          tabIndex={!cleanInspectionActive && tabStopObjectId === object.id ? 0 : -1}
          className={styles.objectHitTarget}
          onSelect={onSelect}
          onPointerStart={onPointerStart}
          onEditRequested={onEditRequested}
          onFocus={onFocus}
          onBlur={onBlur}
        />
      ))}
    </>
  );
});
