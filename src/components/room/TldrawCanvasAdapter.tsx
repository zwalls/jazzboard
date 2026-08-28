"use client";

import type { ForwardedRef } from "react";

import { JazzboardCanvas } from "./JazzboardCanvas";
import type { CanvasSurfaceHandle, CanvasSurfaceProps } from "./canvas-surface-types";

type TldrawCanvasAdapterProps = CanvasSurfaceProps & {
  canvasRef: ForwardedRef<CanvasSurfaceHandle>;
  shadowParity?: boolean;
};

/** Lazy adapter boundary that keeps the legacy renderer out of semantic-only chunks. */
export default function TldrawCanvasAdapter({ canvasRef, shadowParity, ...props }: TldrawCanvasAdapterProps) {
  return <JazzboardCanvas ref={canvasRef} shadowParity={shadowParity} {...props} />;
}
