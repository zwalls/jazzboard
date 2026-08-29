"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Copy,
  Download,
  FileJson,
  FileUp,
  ImageDown,
  LoaderCircle,
  Share2,
  Workflow,
  X,
} from "lucide-react";

import type { CanvasRuntime } from "@/lib/canvas/runtime";
import { apiRequest, JazzboardApiError } from "@/lib/client/api";
import { downloadCanvasPng, downloadTextFile } from "@/lib/client/download";
import { safeDownloadStem } from "@/lib/export-filename";
import { buildRoomInvite } from "@/lib/client/room-invite";
import { formatRoomCode } from "@/lib/domain/room-code";
import type { Point, RoomState } from "@/lib/domain/types";

import styles from "./durability-panel.module.css";

export type DurabilityScope = "room" | "diagram" | "selection";
export type DurabilityPanelMode = "share" | "export";
type ArtifactFormat = "semantic_json" | "mermaid" | "svg" | "template";

type ArtifactExport = {
  format: ArtifactFormat;
  mediaType: string;
  filename: string;
  content: string;
  warnings: Array<{ code: string; message: string }>;
  sourceRoomRevision: number;
  sourceDiagramRevision: number | null;
};

type MutationResponse = {
  ok: true;
  room: RoomState;
  changedObjectIds: string[];
  changedDiagramIds: string[];
  warnings: Array<{ code: string; message: string }>;
};

export function buildArtifactUrl(input: {
  roomId: string;
  format: ArtifactFormat;
  scope: DurabilityScope;
  diagramId?: string;
  selection?: string[];
}): string {
  const params = new URLSearchParams({ format: input.format, scope: input.scope });
  if (input.scope === "diagram" && input.diagramId) params.set("diagramId", input.diagramId);
  if (input.scope === "selection") {
    for (const objectId of [...new Set(input.selection ?? [])].sort()) params.append("objectId", objectId);
  }
  return `/api/rooms/${encodeURIComponent(input.roomId)}/artifacts?${params.toString()}`;
}

function messageFor(error: unknown): string {
  if (error instanceof JazzboardApiError) return error.failure.message;
  return error instanceof Error ? error.message : "Jazzboard could not complete that request.";
}

export function DurabilityPanel({
  mode,
  room,
  role,
  selection,
  runtime,
  getImportOrigin,
  acceptRoom,
  onClose,
  onAnnounce,
}: {
  mode: DurabilityPanelMode;
  room: RoomState;
  role: "participant" | "spectator";
  selection: string[];
  runtime: CanvasRuntime | null;
  getImportOrigin(): Point;
  acceptRoom(room: RoomState): void;
  onClose(): void;
  onAnnounce(message: string): void;
}) {
  const diagrams = useMemo(
    () => Object.values(room.diagrams).sort((left, right) => right.updatedAt - left.updatedAt),
    [room.diagrams],
  );
  const validSelection = useMemo(
    () => selection.filter((objectId) => Boolean(room.objects[objectId])),
    [room.objects, selection],
  );
  const [scope, setScope] = useState<DurabilityScope>("room");
  const [diagramId, setDiagramId] = useState(diagrams[0]?.id ?? "");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [canvasVersion, setCanvasVersion] = useState(0);
  const templateInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const pngExportController = useRef<AbortController | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pngExportController.current?.abort();
      pngExportController.current = null;
    };
  }, []);

  useEffect(() => {
    if (!runtime) return;
    return runtime.onDocumentChange(() => setCanvasVersion((version) => version + 1));
  }, [runtime]);

  const effectiveDiagramId = room.diagrams[diagramId] ? diagramId : diagrams[0]?.id ?? "";
  const selectedDiagram = room.diagrams[effectiveDiagramId] ?? null;
  const liveSelection = useMemo(
    () => {
      void canvasVersion;
      return runtime ? [...runtime.getSelectedObjectIds()] : validSelection;
    },
    [canvasVersion, runtime, validSelection],
  );
  const effectiveScope: DurabilityScope =
    scope === "diagram" && !selectedDiagram
      ? "room"
      : scope === "selection" && !liveSelection.length
        ? "room"
        : scope;
  const scopeReady = effectiveScope === "room" || (effectiveScope === "diagram" ? Boolean(selectedDiagram) : liveSelection.length > 0);

  const pngObjectIds = useMemo(() => {
    void canvasVersion;
    if (!runtime) return [];
    if (effectiveScope === "selection") return [...runtime.getSelectedObjectIds()];
    if (effectiveScope === "diagram" && selectedDiagram) {
      return [...new Set([...selectedDiagram.memberObjectIds, ...selectedDiagram.connectorIds])]
        .filter((objectId) => Boolean(room.objects[objectId] && runtime.hasObject(objectId)));
    }
    return [...runtime.getDocumentObjectIds()];
  }, [canvasVersion, runtime, effectiveScope, room.objects, selectedDiagram]);
  const pngReady = Boolean(runtime?.capabilities.renderPng && pngObjectIds.length);

  function artifactUrl(format: ArtifactFormat): string {
    return buildArtifactUrl({
      roomId: room.id,
      format,
      scope: effectiveScope,
      diagramId: effectiveDiagramId,
      selection: validSelection,
    });
  }

  async function exportArtifact(format: ArtifactFormat | "png") {
    if (format !== "png" && !scopeReady) return;
    setBusyAction(format);
    setError(null);
    setWarnings([]);
    let exportController: AbortController | null = null;
    try {
      if (format === "png") {
        const currentObjectIds = !runtime
          ? []
          : effectiveScope === "selection"
            ? [...runtime.getSelectedObjectIds()]
            : effectiveScope === "diagram" && selectedDiagram
              ? [...new Set([...selectedDiagram.memberObjectIds, ...selectedDiagram.connectorIds])]
                .filter((objectId) => Boolean(room.objects[objectId] && runtime.hasObject(objectId)))
              : [...runtime.getDocumentObjectIds()];
        if (!runtime || !currentObjectIds.length) {
          throw new Error("This canvas scope has no visible objects to export.");
        }
        exportController = new AbortController();
        pngExportController.current?.abort();
        pngExportController.current = exportController;
        const label = effectiveScope === "diagram" && selectedDiagram
          ? selectedDiagram.title
          : effectiveScope === "selection"
            ? `${room.title} selection`
            : room.title;
        const result = await downloadCanvasPng({
          runtime,
          objectIds: currentObjectIds,
          filename: `${safeDownloadStem(label, "jazzboard")}.png`,
          signal: exportController.signal,
        });
        if (exportController.signal.aborted || !mounted.current) return;
        setWarnings(result.warnings);
        onAnnounce("PNG downloaded.");
        return;
      } else {
        const response = await apiRequest<{ ok: true; export: ArtifactExport }>(artifactUrl(format));
        setWarnings(response.export.warnings.map((warning) => warning.message));
        downloadTextFile({
          content: response.export.content,
          filename: response.export.filename,
          mimeType: response.export.mediaType,
        });
        onAnnounce(`${response.export.filename} downloaded.`);
      }
    } catch (requestError) {
      if (!exportController?.signal.aborted && mounted.current) setError(messageFor(requestError));
    } finally {
      if (exportController && pngExportController.current === exportController) {
        pngExportController.current = null;
      }
      if (mounted.current) setBusyAction(null);
    }
  }

  async function importTemplate(file: File) {
    setBusyAction("import");
    setError(null);
    setWarnings([]);
    try {
      if (file.size > 2_000_000) throw new Error("Template files must be smaller than 2 MB.");
      const template = JSON.parse(await file.text()) as unknown;
      const response = await apiRequest<MutationResponse>(`/api/rooms/${encodeURIComponent(room.id)}/artifacts`, {
        method: "POST",
        body: JSON.stringify({
          expectedRoomRevision: room.roomRevision,
          template,
          origin: getImportOrigin(),
          intent: "Instantiate a reusable Jazzboard diagram template",
          summary: `Imported ${file.name}`,
        }),
      });
      acceptRoom(response.room);
      setWarnings(response.warnings.map((warning) => warning.message));
      onAnnounce(`Template added with ${response.changedObjectIds.length} objects.`);
    } catch (requestError) {
      setError(messageFor(requestError));
    } finally {
      if (templateInput.current) templateInput.current.value = "";
      setBusyAction(null);
    }
  }

  async function copyLiveInvite() {
    setError(null);
    try {
      const invite = buildRoomInvite({
        origin: window.location.origin,
        roomCode: room.code,
        roomTitle: room.title,
      });
      await navigator.clipboard.writeText(invite.text);
      onAnnounce("Live collaboration invite copied.");
    } catch (copyError) {
      setError(messageFor(copyError));
    }
  }

  const sharing = mode === "share";
  const scopePicker = (
    <section>
      <div className={styles.sectionHeading}>
        <div>
          <strong>Export scope</strong>
          <span>Download only what you mean to export.</span>
        </div>
      </div>
      <div className={styles.scopeTabs}>
        <button className={effectiveScope === "room" ? styles.selected : ""} onClick={() => setScope("room")}>Board</button>
        <button disabled={!diagrams.length} className={effectiveScope === "diagram" ? styles.selected : ""} onClick={() => setScope("diagram")}>Diagram</button>
        <button disabled={!liveSelection.length} className={effectiveScope === "selection" ? styles.selected : ""} onClick={() => setScope("selection")}>Selection · {liveSelection.length}</button>
      </div>
      {effectiveScope === "diagram" ? (
        <label className={styles.selectField}>
          <span>Diagram</span>
          <select value={effectiveDiagramId} onChange={(event) => setDiagramId(event.target.value)}>
            {diagrams.map((diagram) => <option value={diagram.id} key={diagram.id}>{diagram.title}</option>)}
          </select>
        </label>
      ) : null}
    </section>
  );

  return (
    <aside className={`${styles.panel} ${sharing ? styles.sharePanel : ""}`} aria-label={sharing ? "Share board" : "Export board"}>
      <div className={styles.heading}>
        <span className={styles.headingIcon}>{sharing ? <Share2 size={17} /> : <Download size={17} />}</span>
        <div><span>{sharing ? "Live collaboration" : "Portable work"}</span><strong>{sharing ? "Share board" : "Export"}</strong></div>
        <button className={styles.closeButton} onClick={onClose} aria-label={sharing ? "Close share board" : "Close export"}>
          <X size={16} />
        </button>
      </div>

      <div className={styles.body}>
        {sharing ? (
          <section>
            <div className={styles.sectionHeading}>
              <div><strong>Collaborate live</strong><span>Invite someone into this live room with their own identity.</span></div>
            </div>
            <div className={styles.liveInvite}>
              <div><span>Room code</span><strong aria-label={`Room code ${formatRoomCode(room.code)}`}>{formatRoomCode(room.code)}</strong></div>
              <button onClick={() => void copyLiveInvite()}><Copy size={15} /> Copy invite</button>
            </div>
            <p className={styles.hint}>The invite opens Jazzboard with this exact code filled in. Your friend chooses participant or spectator and joins through normal room authorization.</p>
            <p className={styles.hint}>For a frozen visual copy, use Export → PNG. Jazzboard creates the file locally and does not store it.</p>
          </section>
        ) : null}

        {!sharing ? (
          <>
            {scopePicker}
            <section>
              <div className={styles.sectionHeading}>
                <div><strong>Download</strong><span>Portable, privacy-safe artifacts from semantic state.</span></div>
              </div>
              <div className={styles.exportGrid}>
                <ExportButton icon={<FileJson size={16} />} label="Semantic JSON" busy={busyAction === "semantic_json"} disabled={!scopeReady || busyAction !== null} onClick={() => void exportArtifact("semantic_json")} />
                <ExportButton icon={<Workflow size={16} />} label="Mermaid" busy={busyAction === "mermaid"} disabled={effectiveScope !== "diagram" || busyAction !== null} onClick={() => void exportArtifact("mermaid")} />
                <ExportButton icon={<Download size={16} />} label="SVG" busy={busyAction === "svg"} disabled={!scopeReady || busyAction !== null} onClick={() => void exportArtifact("svg")} />
                <ExportButton icon={<ImageDown size={16} />} label="PNG" busy={busyAction === "png"} disabled={!pngReady || busyAction !== null} onClick={() => void exportArtifact("png")} />
              </div>
              {!pngObjectIds.length ? <p className={styles.hint}>PNG becomes available when this scope contains a visible canvas object.</p> : null}
              {effectiveScope !== "diagram" ? <p className={styles.hint}>Mermaid exports one explicit first-class Diagram.</p> : null}
            </section>
            {role === "participant" ? (
              <section>
                <div className={styles.sectionHeading}>
                  <div><strong>Reuse</strong><span>Templates create fresh semantic IDs and preserve classifications.</span></div>
                </div>
                <div className={styles.inlineActions}>
                  <button disabled={effectiveScope !== "diagram" || busyAction !== null} onClick={() => void exportArtifact("template")}>
                    {busyAction === "template" ? <LoaderCircle className={styles.spin} size={15} /> : <Download size={15} />} Save diagram template
                  </button>
                  <button disabled={busyAction !== null} onClick={() => templateInput.current?.click()}>
                    {busyAction === "import" ? <LoaderCircle className={styles.spin} size={15} /> : <FileUp size={15} />} Add template here
                  </button>
                  <input
                    ref={templateInput}
                    hidden
                    type="file"
                    accept="application/json,.json"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void importTemplate(file);
                    }}
                  />
                </div>
              </section>
            ) : (
              <p className={styles.spectatorNote}>Spectators can download passive exports. Creating and importing reusable templates requires participant permission.</p>
            )}
          </>
        ) : null}

        {warnings.length ? <div className={styles.warning} role="status">{warnings.join(" ")}</div> : null}
        {error ? <div className={styles.error} role="alert">{error}</div> : null}
      </div>
    </aside>
  );
}

function ExportButton({
  icon,
  label,
  busy,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  busy: boolean;
  disabled: boolean;
  onClick(): void;
}) {
  return (
    <button disabled={disabled} onClick={onClick}>
      {busy ? <LoaderCircle className={styles.spin} size={16} /> : icon}
      <span>{label}</span>
    </button>
  );
}
