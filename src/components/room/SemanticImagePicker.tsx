"use client";

import { ImagePlus, LoaderCircle, Upload, X } from "lucide-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type SyntheticEvent,
} from "react";

import {
  uploadJazzboardRoomImage,
  type JazzboardRoomImageUpload,
} from "@/lib/client/assets";
import { isSupportedImageMimeType } from "@/lib/assets/policy";

import styles from "./semantic-image-picker.module.css";

export const SEMANTIC_IMAGE_PICKER_LIMITS = Object.freeze({
  maxAltLength: 2_000,
  maxPlacedWidth: 720,
  maxPlacedHeight: 540,
});

const IMAGE_ACCEPT = "image/jpeg,image/png,image/webp,image/gif,.jpg,.jpeg,.png,.webp,.gif";

type PickerPhase = "idle" | "decoding" | "review" | "uploading" | "error";

type ImageCandidate = Readonly<{
  file: File;
  previewUrl: string;
  naturalWidth: number;
  naturalHeight: number;
  width: number;
  height: number;
}>;

export type SemanticImagePickerReady = Readonly<{
  /** Exact response returned after Jazzboard authorizes and finalizes the room asset. */
  asset: JazzboardRoomImageUpload;
  /** Suggested initial canvas dimensions, capped while preserving the source aspect ratio. */
  width: number;
  height: number;
  /** User-reviewed accessible description. */
  alt: string;
}>;

export type SemanticImagePickerHandle = Readonly<{
  /** Opens the native local-file chooser. It is a no-op while disabled or already busy. */
  open(): void;
  /** Offers a pasted or dropped file to the same reviewed, authorized upload flow. */
  offerFile(file: File): boolean;
}>;

export type SemanticImagePickerProps = Readonly<{
  roomId: string;
  disabled?: boolean;
  onReady(result: SemanticImagePickerReady): void;
  onError(error: Error): void;
  onDismiss?(): void;
}>;

type NaturalDimensions = Readonly<{ width: number; height: number }>;
type DecodedDimensions = Readonly<{
  naturalWidth: number;
  naturalHeight: number;
  width: number;
  height: number;
}>;

function abortError(message = "Image selection was cancelled."): DOMException {
  return new DOMException(message, "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("The selected image could not be prepared.");
}

function suggestedAltFromFilename(filename: string): string {
  const leaf = filename.split(/[\\/]/).at(-1) ?? "";
  const withoutExtension = leaf.replace(/\.(?:jpe?g|png|webp|gif)$/i, "");
  const description = withoutExtension
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[_.-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SEMANTIC_IMAGE_PICKER_LIMITS.maxAltLength);
  return description || "Uploaded image";
}

export function defaultSemanticImageDimensions(
  naturalWidth: number,
  naturalHeight: number,
): NaturalDimensions {
  if (
    !Number.isFinite(naturalWidth) ||
    !Number.isFinite(naturalHeight) ||
    naturalWidth <= 0 ||
    naturalHeight <= 0
  ) {
    throw new Error("The selected image does not report valid dimensions.");
  }
  const scale = Math.min(
    1,
    SEMANTIC_IMAGE_PICKER_LIMITS.maxPlacedWidth / naturalWidth,
    SEMANTIC_IMAGE_PICKER_LIMITS.maxPlacedHeight / naturalHeight,
  );
  return Object.freeze({
    width: Math.max(1, Math.round(naturalWidth * scale)),
    height: Math.max(1, Math.round(naturalHeight * scale)),
  });
}

function decodeNaturalDimensions(objectUrl: string, signal: AbortSignal): Promise<DecodedDimensions> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }

    const image = new Image();
    let settled = false;

    const cleanup = () => {
      image.onload = null;
      image.onerror = null;
      signal.removeEventListener("abort", handleAbort);
    };
    const settle = (result: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      result();
    };
    const handleAbort = () => settle(() => reject(abortError()));

    image.onload = () => {
      settle(() => {
        try {
          const naturalWidth = image.naturalWidth;
          const naturalHeight = image.naturalHeight;
          const placed = defaultSemanticImageDimensions(naturalWidth, naturalHeight);
          resolve({ naturalWidth, naturalHeight, ...placed });
        } catch (error) {
          reject(error);
        }
      });
    };
    image.onerror = () => {
      settle(() => reject(new Error("The browser could not decode the selected image.")));
    };
    signal.addEventListener("abort", handleAbort, { once: true });
    image.decoding = "async";
    image.src = objectUrl;
  });
}

function stopCanvasEvent(event: SyntheticEvent): void {
  event.stopPropagation();
}

export const SemanticImagePicker = forwardRef<
  SemanticImagePickerHandle,
  SemanticImagePickerProps
>(function SemanticImagePicker(
  { roomId, disabled = false, onReady, onError, onDismiss },
  ref,
) {
  const [phase, setPhase] = useState<PickerPhase>("idle");
  const [selectedName, setSelectedName] = useState("");
  const [candidate, setCandidate] = useState<ImageCandidate | null>(null);
  const [alt, setAlt] = useState("");
  const [progress, setProgress] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  const sessionRef = useRef(0);
  const mountedRef = useRef(true);
  const titleId = useId();
  const descriptionId = useId();
  const altHelpId = useId();

  const releasePreviewUrl = useCallback(() => {
    const previewUrl = previewUrlRef.current;
    previewUrlRef.current = null;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, []);

  const invalidateSession = useCallback(() => {
    sessionRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    releasePreviewUrl();
  }, [releasePreviewUrl]);

  const restorePreviousFocus = useCallback(() => {
    const previous = previousFocusRef.current;
    previousFocusRef.current = null;
    previous?.focus();
  }, []);

  const resetView = useCallback(() => {
    setPhase("idle");
    setSelectedName("");
    setCandidate(null);
    setAlt("");
    setProgress(0);
    setErrorMessage(null);
  }, []);

  const close = useCallback(() => {
    invalidateSession();
    if (mountedRef.current) resetView();
    restorePreviousFocus();
    onDismiss?.();
  }, [invalidateSession, onDismiss, resetView, restorePreviousFocus]);

  const reportError = useCallback(
    (error: unknown) => {
      const normalized = asError(error);
      setErrorMessage(normalized.message);
      onError(normalized);
    },
    [onError],
  );

  const open = useCallback(() => {
    if (disabled || phase === "decoding" || phase === "uploading") return;
    if (!previousFocusRef.current && document.activeElement instanceof HTMLElement) {
      previousFocusRef.current = document.activeElement;
    }
    const input = inputRef.current;
    if (!input) return;
    input.value = "";
    input.click();
  }, [disabled, phase]);

  function offerFile(file: File): boolean {
    if (
      disabled
      || phase === "decoding"
      || phase === "uploading"
      || !isSupportedImageMimeType(file.type)
    ) return false;
    if (!previousFocusRef.current && document.activeElement instanceof HTMLElement) {
      previousFocusRef.current = document.activeElement;
    }
    void prepareFile(file);
    return true;
  }

  useImperativeHandle(ref, () => ({ open, offerFile }));

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      invalidateSession();
      previousFocusRef.current = null;
    };
  }, [invalidateSession]);

  async function prepareFile(file: File): Promise<void> {
    invalidateSession();
    const session = sessionRef.current;
    const controller = new AbortController();
    abortRef.current = controller;

    setSelectedName(file.name);
    setCandidate(null);
    setAlt("");
    setProgress(0);
    setErrorMessage(null);

    if (!isSupportedImageMimeType(file.type)) {
      const error = new Error("Jazzboard accepts JPEG, PNG, WebP, and GIF images only.");
      setPhase("error");
      reportError(error);
      return;
    }

    setPhase("decoding");
    const previewUrl = URL.createObjectURL(file);
    previewUrlRef.current = previewUrl;

    try {
      const dimensions = await decodeNaturalDimensions(previewUrl, controller.signal);
      if (!mountedRef.current || session !== sessionRef.current || controller.signal.aborted) return;
      setCandidate({
        file,
        previewUrl,
        naturalWidth: dimensions.naturalWidth,
        naturalHeight: dimensions.naturalHeight,
        width: dimensions.width,
        height: dimensions.height,
      });
      setAlt(suggestedAltFromFilename(file.name));
      setPhase("review");
    } catch (error) {
      if (!mountedRef.current || session !== sessionRef.current || isAbortError(error)) return;
      releasePreviewUrl();
      setPhase("error");
      reportError(error);
    }
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) void prepareFile(file);
  }

  async function uploadCandidate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!candidate || disabled || phase !== "review") return;
    const finalizedAlt = alt.trim();
    if (!finalizedAlt) return;

    const session = sessionRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase("uploading");
    setProgress(0);
    setErrorMessage(null);

    try {
      const asset = await uploadJazzboardRoomImage(roomId, candidate.file, {
        signal: controller.signal,
        onProgress: (percentage) => {
          if (!mountedRef.current || session !== sessionRef.current || controller.signal.aborted) {
            return;
          }
          setProgress(Math.min(100, Math.max(0, Math.round(percentage))));
        },
      });
      if (!mountedRef.current || session !== sessionRef.current || controller.signal.aborted) return;

      const result: SemanticImagePickerReady = Object.freeze({
        asset,
        width: candidate.width,
        height: candidate.height,
        alt: finalizedAlt,
      });
      invalidateSession();
      resetView();
      restorePreviousFocus();
      onReady(result);
    } catch (error) {
      if (
        !mountedRef.current ||
        session !== sessionRef.current ||
        controller.signal.aborted ||
        isAbortError(error)
      ) {
        return;
      }
      controller.abort();
      abortRef.current = null;
      sessionRef.current += 1;
      setPhase("review");
      reportError(error);
    }
  }

  function handleDialogKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    event.stopPropagation();
    if (event.key !== "Escape") return;
    event.preventDefault();
    close();
  }

  function handleBackdropMouseDown(event: MouseEvent<HTMLDivElement>): void {
    event.stopPropagation();
    if (event.target === event.currentTarget) close();
  }

  const dialogOpen = phase !== "idle";
  const uploadAllowed = Boolean(candidate && alt.trim() && !disabled);

  return (
    <>
      <input
        ref={inputRef}
        hidden
        type="file"
        accept={IMAGE_ACCEPT}
        disabled={disabled || phase === "decoding" || phase === "uploading"}
        data-semantic-image-input="true"
        aria-label="Choose an image for the canvas"
        onChange={handleFileChange}
      />

      {dialogOpen ? (
        <div
          className={styles.backdrop}
          onClick={stopCanvasEvent}
          onContextMenu={stopCanvasEvent}
          onDoubleClick={stopCanvasEvent}
          onKeyDown={handleDialogKeyDown}
          onMouseDown={handleBackdropMouseDown}
          onPointerCancel={stopCanvasEvent}
          onPointerDown={stopCanvasEvent}
          onPointerMove={stopCanvasEvent}
          onPointerUp={stopCanvasEvent}
          onWheel={stopCanvasEvent}
        >
          <section
            className={styles.panel}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
          >
            <button
              className={styles.closeButton}
              type="button"
              autoFocus
              aria-label={phase === "uploading" ? "Cancel image upload" : "Cancel image selection"}
              onClick={close}
            >
              <X aria-hidden="true" size={17} />
            </button>

            <div className={styles.heading}>
              <span className={styles.headingIcon}>
                <ImagePlus aria-hidden="true" size={20} />
              </span>
              <div>
                <h2 id={titleId}>Add an accessible image</h2>
                <p id={descriptionId}>
                  Review what the image communicates before it joins the board.
                </p>
              </div>
            </div>

            {phase === "decoding" ? (
              <div className={styles.loadingState} role="status" aria-live="polite">
                <LoaderCircle className={styles.spin} aria-hidden="true" size={22} />
                <strong>Reading image dimensions</strong>
                <span>{selectedName}</span>
              </div>
            ) : null}

            {phase === "error" ? (
              <div className={styles.errorState}>
                <div className={styles.error} role="alert">{errorMessage}</div>
                <button className={styles.secondaryButton} type="button" onClick={open} disabled={disabled}>
                  Choose another image
                </button>
              </div>
            ) : null}

            {candidate && (phase === "review" || phase === "uploading") ? (
              <form className={styles.form} onSubmit={(event) => void uploadCandidate(event)}>
                <div className={styles.previewFrame}>
                  {/* This is a local, short-lived Blob URL and must never be persisted. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={candidate.previewUrl} alt="" />
                </div>

                <div className={styles.fileSummary}>
                  <strong>{candidate.file.name}</strong>
                  <span>
                    {candidate.width} × {candidate.height} canvas units
                  </span>
                </div>

                <label className={styles.field}>
                  <span>Image description</span>
                  <textarea
                    autoFocus
                    value={alt}
                    maxLength={SEMANTIC_IMAGE_PICKER_LIMITS.maxAltLength}
                    rows={3}
                    required
                    disabled={phase === "uploading"}
                    aria-label="Image description"
                    aria-describedby={altHelpId}
                    onChange={(event) => setAlt(event.target.value)}
                  />
                  <small id={altHelpId}>
                    Describe the image’s useful content, not just its filename.
                  </small>
                </label>

                {errorMessage ? <div className={styles.error} role="alert">{errorMessage}</div> : null}

                {phase === "uploading" ? (
                  <div className={styles.progressBlock} role="status" aria-live="polite">
                    <div>
                      <span>Uploading securely</span>
                      <strong>{progress}%</strong>
                    </div>
                    <progress aria-label="Image upload progress" max={100} value={progress} />
                  </div>
                ) : null}

                <div className={styles.actions}>
                  <button className={styles.secondaryButton} type="button" onClick={close}>
                    {phase === "uploading" ? "Cancel upload" : "Cancel"}
                  </button>
                  <button
                    className={styles.primaryButton}
                    type="submit"
                    disabled={!uploadAllowed || phase === "uploading"}
                  >
                    {phase === "uploading" ? (
                      <LoaderCircle className={styles.spin} aria-hidden="true" size={16} />
                    ) : (
                      <Upload aria-hidden="true" size={16} />
                    )}
                    {phase === "uploading" ? "Uploading…" : "Add to canvas"}
                  </button>
                </div>
              </form>
            ) : null}
          </section>
        </div>
      ) : null}
    </>
  );
});
