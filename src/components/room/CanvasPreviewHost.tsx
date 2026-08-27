"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

import type {
  CanvasPreviewArtifact,
  CanvasPreviewPresentation,
  CanvasPreviewPresenter,
} from "@/lib/webmcp";

import styles from "./canvas-preview-host.module.css";

const PREVIEW_TTL_MS = 60_000;

type ActivePreview = {
  previewId: string;
  objectUrl: string;
  artifact: CanvasPreviewArtifact;
  expiresAt: number;
};

type PendingPresentation = {
  previewId: string;
  resolve: (value: CanvasPreviewPresentation) => void;
  reject: (error: unknown) => void;
  signal: AbortSignal;
  onAbort: () => void;
};

export type CanvasPreviewHostHandle = {
  present: CanvasPreviewPresenter;
  dismiss(): void;
};

function previewId(): string {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return `preview_${suffix}`;
}

function abortError(message = "The canvas preview was cancelled."): DOMException {
  return new DOMException(message, "AbortError");
}

export const CanvasPreviewHost = forwardRef<CanvasPreviewHostHandle>(function CanvasPreviewHost(_, ref) {
  const [active, setActive] = useState<ActivePreview | null>(null);
  const activeRef = useRef<ActivePreview | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const expiryTimerRef = useRef<number | null>(null);
  const paintFramesRef = useRef<number[]>([]);
  const pendingRef = useRef<PendingPresentation | null>(null);

  const clearPaintFrames = useCallback(() => {
    for (const frame of paintFramesRef.current) window.cancelAnimationFrame(frame);
    paintFramesRef.current = [];
  }, []);

  const settlePending = useCallback((error?: unknown) => {
    const pending = pendingRef.current;
    if (!pending) return;
    pending.signal.removeEventListener("abort", pending.onAbort);
    pendingRef.current = null;
    if (error) pending.reject(error);
  }, []);

  const dismiss = useCallback(() => {
    clearPaintFrames();
    if (expiryTimerRef.current !== null) window.clearTimeout(expiryTimerRef.current);
    expiryTimerRef.current = null;
    const current = activeRef.current;
    activeRef.current = null;
    setActive(null);
    if (current) URL.revokeObjectURL(current.objectUrl);
    settlePending(abortError("The temporary canvas preview was dismissed before it finished painting."));
  }, [clearPaintFrames, settlePending]);

  const present = useCallback<CanvasPreviewPresenter>(
    async (artifact, signal) => {
      if (signal.aborted) throw abortError();
      dismiss();

      const id = previewId();
      const objectUrl = URL.createObjectURL(artifact.blob);
      const expiresAt = Date.now() + PREVIEW_TTL_MS;
      const next = { previewId: id, objectUrl, artifact, expiresAt };
      activeRef.current = next;
      setActive(next);
      expiryTimerRef.current = window.setTimeout(dismiss, PREVIEW_TTL_MS);

      return await new Promise<CanvasPreviewPresentation>((resolve, reject) => {
        const onAbort = () => {
          if (activeRef.current?.previewId === id) dismiss();
          else reject(abortError());
        };
        pendingRef.current = { previewId: id, resolve, reject, signal, onAbort };
        signal.addEventListener("abort", onAbort, { once: true });
      });
    },
    [dismiss],
  );

  const finishPresentation = useCallback(() => {
    const pending = pendingRef.current;
    const current = activeRef.current;
    if (!pending || !current || pending.previewId !== current.previewId) return;
    clearPaintFrames();
    const first = window.requestAnimationFrame(() => {
      const second = window.requestAnimationFrame(() => {
        paintFramesRef.current = [];
        const latestPending = pendingRef.current;
        const latest = activeRef.current;
        const image = imageRef.current;
        if (!latestPending || !latest || latestPending.previewId !== latest.previewId || !image) return;
        const rect = image.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
          const error = new Error("The temporary preview painted without visible bounds.");
          settlePending(error);
          dismiss();
          return;
        }
        latestPending.signal.removeEventListener("abort", latestPending.onAbort);
        pendingRef.current = null;
        latestPending.resolve({
          previewId: latest.previewId,
          clip: {
            coordinateSpace: "viewport-css-pixels",
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          },
          expiresAt: latest.expiresAt,
        });
      });
      paintFramesRef.current.push(second);
    });
    paintFramesRef.current.push(first);
  }, [clearPaintFrames, dismiss, settlePending]);

  const failPresentation = useCallback(() => {
    settlePending(new Error("The rendered canvas preview image could not be painted."));
    dismiss();
  }, [dismiss, settlePending]);

  useImperativeHandle(ref, () => ({ present, dismiss }), [dismiss, present]);

  useEffect(() => dismiss, [dismiss]);

  if (!active) return null;
  return (
    <div className={styles.backdrop} role="dialog" aria-modal="true" aria-label="Canvas preview">
      <div className={styles.panel}>
        {/* A transient Blob URL cannot be optimized or persisted by next/image. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={imageRef}
          className={styles.image}
          src={active.objectUrl}
          alt="Exact rendered Jazzboard canvas preview"
          width={active.artifact.metadata.width}
          height={active.artifact.metadata.height}
          onLoad={finishPresentation}
          onError={failPresentation}
        />
        <div className={styles.controls}>
          <span>Temporary agent preview · closes automatically</span>
          <button type="button" onClick={dismiss} aria-label="Dismiss canvas preview">
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
});
