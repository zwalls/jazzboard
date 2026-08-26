"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Clock3,
  Copy,
  Download,
  FileJson,
  FileUp,
  ImageDown,
  Link2,
  LoaderCircle,
  Share2,
  Trash2,
  Workflow,
  X,
} from "lucide-react";

import { apiRequest, JazzboardApiError } from "@/lib/client/api";
import { downloadPngFromSvg, downloadTextFile, svgDownloadDimensions } from "@/lib/client/download";
import type { Point, RoomState } from "@/lib/domain/types";

import styles from "./durability-panel.module.css";

export type DurabilityScope = "room" | "diagram" | "selection";
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

type SnapshotScope =
  | { kind: "room" }
  | { kind: "diagram"; diagramId: string; expectedDiagramRevision: number };

type SnapshotSummary = {
  id: string;
  title: string;
  scope: SnapshotScope;
  sourceRoomRevision: number;
  createdAt: number;
  expiresAt: number;
};

type CreatedSnapshot = SnapshotSummary & { path: string };

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

function dateLabel(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(value);
}

export function DurabilityPanel({
  room,
  role,
  selection,
  getImportOrigin,
  acceptRoom,
  onClose,
  onAnnounce,
}: {
  room: RoomState;
  role: "participant" | "spectator";
  selection: string[];
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
  const [snapshots, setSnapshots] = useState<SnapshotSummary[]>([]);
  const [createdSnapshot, setCreatedSnapshot] = useState<CreatedSnapshot | null>(null);
  const [expiresInHours, setExpiresInHours] = useState(24);
  const templateInput = useRef<HTMLInputElement>(null);

  const effectiveDiagramId = room.diagrams[diagramId] ? diagramId : diagrams[0]?.id ?? "";
  const selectedDiagram = room.diagrams[effectiveDiagramId] ?? null;
  const effectiveScope: DurabilityScope =
    scope === "diagram" && !selectedDiagram
      ? "room"
      : scope === "selection" && !validSelection.length
        ? "room"
        : scope;
  const scopeReady = effectiveScope === "room" || (effectiveScope === "diagram" ? Boolean(selectedDiagram) : validSelection.length > 0);
  const snapshotsUrl = `/api/rooms/${encodeURIComponent(room.id)}/snapshots`;

  useEffect(() => {
    if (role !== "participant") return;
    const controller = new AbortController();
    void apiRequest<{ ok: true; snapshots: SnapshotSummary[] }>(snapshotsUrl, {
      method: "GET",
      signal: controller.signal,
    })
      .then((result) => setSnapshots(result.snapshots))
      .catch((requestError) => {
        if (!(requestError instanceof DOMException && requestError.name === "AbortError")) {
          setError(messageFor(requestError));
        }
      });
    return () => controller.abort();
  }, [role, snapshotsUrl]);

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
    if (!scopeReady) return;
    setBusyAction(format);
    setError(null);
    setWarnings([]);
    try {
      const serverFormat = format === "png" ? "svg" : format;
      const response = await apiRequest<{ ok: true; export: ArtifactExport }>(artifactUrl(serverFormat));
      setWarnings(response.export.warnings.map((warning) => warning.message));
      if (format === "png") {
        const dimensions = svgDownloadDimensions(response.export.content);
        await downloadPngFromSvg({
          svg: response.export.content,
          width: dimensions.width,
          height: dimensions.height,
          filename: response.export.filename.replace(/\.svg$/i, ".png"),
        });
      } else {
        downloadTextFile({
          content: response.export.content,
          filename: response.export.filename,
          mimeType: response.export.mediaType,
        });
      }
      onAnnounce(`${format === "png" ? "PNG" : response.export.filename} downloaded.`);
    } catch (requestError) {
      setError(messageFor(requestError));
    } finally {
      setBusyAction(null);
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

  function currentSnapshotScope(): SnapshotScope | null {
    if (effectiveScope === "room") return { kind: "room" };
    if (effectiveScope === "diagram" && selectedDiagram) {
      return {
        kind: "diagram",
        diagramId: selectedDiagram.id,
        expectedDiagramRevision: selectedDiagram.revision,
      };
    }
    return null;
  }

  async function createSnapshot() {
    const snapshotScope = currentSnapshotScope();
    if (!snapshotScope) return;
    setBusyAction("snapshot");
    setError(null);
    try {
      const response = await apiRequest<{ ok: true; snapshot: CreatedSnapshot }>(snapshotsUrl, {
        method: "POST",
        body: JSON.stringify({
          expectedRoomRevision: room.roomRevision,
          scope: snapshotScope,
          expiresInHours,
        }),
      });
      setCreatedSnapshot(response.snapshot);
      setSnapshots((current) => [response.snapshot, ...current.filter((item) => item.id !== response.snapshot.id)]);
      onAnnounce("Read-only snapshot created. Copy its private link now.");
    } catch (requestError) {
      setError(messageFor(requestError));
    } finally {
      setBusyAction(null);
    }
  }

  async function copySnapshotPath(path: string) {
    await navigator.clipboard.writeText(new URL(path, window.location.origin).toString());
    onAnnounce("Private snapshot link copied.");
  }

  async function revokeSnapshot(snapshotId: string) {
    if (!window.confirm("Revoke this read-only snapshot? Its private link will stop working immediately.")) return;
    setBusyAction(snapshotId);
    setError(null);
    try {
      await apiRequest(snapshotsUrl, {
        method: "DELETE",
        body: JSON.stringify({ snapshotId }),
      });
      setSnapshots((current) => current.filter((snapshot) => snapshot.id !== snapshotId));
      if (createdSnapshot?.id === snapshotId) setCreatedSnapshot(null);
      onAnnounce("Snapshot revoked.");
    } catch (requestError) {
      setError(messageFor(requestError));
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <aside className={styles.panel} aria-label="Share and export">
      <div className={styles.heading}>
        <span className={styles.headingIcon}><Share2 size={17} /></span>
        <div><span>Durable work</span><strong>Share &amp; export</strong></div>
        <button className={styles.closeButton} onClick={onClose} aria-label="Close share and export">
          <X size={16} />
        </button>
      </div>

      <div className={styles.body}>
        <section>
          <div className={styles.sectionHeading}>
            <div><strong>Choose scope</strong><span>Export only what you mean to share.</span></div>
          </div>
          <div className={styles.scopeTabs}>
            <button className={effectiveScope === "room" ? styles.selected : ""} onClick={() => setScope("room")}>Board</button>
            <button disabled={!diagrams.length} className={effectiveScope === "diagram" ? styles.selected : ""} onClick={() => setScope("diagram")}>Diagram</button>
            <button disabled={!validSelection.length} className={effectiveScope === "selection" ? styles.selected : ""} onClick={() => setScope("selection")}>Selection · {validSelection.length}</button>
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

        <section>
          <div className={styles.sectionHeading}>
            <div><strong>Download</strong><span>Portable, privacy-safe artifacts from semantic state.</span></div>
          </div>
          <div className={styles.exportGrid}>
            <ExportButton icon={<FileJson size={16} />} label="Semantic JSON" busy={busyAction === "semantic_json"} disabled={!scopeReady || busyAction !== null} onClick={() => void exportArtifact("semantic_json")} />
            <ExportButton icon={<Workflow size={16} />} label="Mermaid" busy={busyAction === "mermaid"} disabled={effectiveScope !== "diagram" || busyAction !== null} onClick={() => void exportArtifact("mermaid")} />
            <ExportButton icon={<Download size={16} />} label="SVG" busy={busyAction === "svg"} disabled={!scopeReady || busyAction !== null} onClick={() => void exportArtifact("svg")} />
            <ExportButton icon={<ImageDown size={16} />} label="PNG" busy={busyAction === "png"} disabled={!scopeReady || busyAction !== null} onClick={() => void exportArtifact("png")} />
          </div>
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
        ) : null}

        {role === "participant" ? (
          <section>
            <div className={styles.sectionHeading}>
              <div><strong>Read-only snapshot</strong><span>An immutable private link—not room access.</span></div>
            </div>
            <div className={styles.snapshotCreate}>
              <label>
                <Clock3 size={14} />
                <select value={expiresInHours} onChange={(event) => setExpiresInHours(Number(event.target.value))}>
                  <option value={24}>24 hours</option>
                  <option value={72}>3 days</option>
                  <option value={168}>7 days</option>
                </select>
              </label>
              <button disabled={!currentSnapshotScope() || busyAction !== null} onClick={() => void createSnapshot()}>
                {busyAction === "snapshot" ? <LoaderCircle className={styles.spin} size={15} /> : <Link2 size={15} />} Create link
              </button>
            </div>
            {effectiveScope === "selection" ? <p className={styles.hint}>Snapshots cover a board or one exact Diagram revision.</p> : null}
            {createdSnapshot ? (
              <div className={styles.freshLink} role="status">
                <div><strong>Copy this link now</strong><span>The secret path cannot be recovered from the snapshot list.</span></div>
                <button onClick={() => void copySnapshotPath(createdSnapshot.path)}><Copy size={14} /> Copy</button>
              </div>
            ) : null}
            {snapshots.length ? (
              <div className={styles.snapshotList}>
                {snapshots.map((snapshot) => (
                  <div key={snapshot.id}>
                    <div><strong>{snapshot.title}</strong><span>Expires {dateLabel(snapshot.expiresAt)}</span></div>
                    <button disabled={busyAction !== null} onClick={() => void revokeSnapshot(snapshot.id)} aria-label={`Revoke ${snapshot.title}`}>
                      {busyAction === snapshot.id ? <LoaderCircle className={styles.spin} size={14} /> : <Trash2 size={14} />}
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </section>
        ) : (
          <p className={styles.spectatorNote}>Spectators can download passive exports. Creating templates, importing, and issuing share links require participant permission.</p>
        )}

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
