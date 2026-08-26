"use client";

import { Clock3, Download, Eye, FileJson2, Network, ShieldCheck, Sparkles } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { JazzboardLogo } from "@/components/brand/JazzboardLogo";
import { renderDiagramMermaid } from "@/lib/interchange/mermaid";
import { serializeJazzboardArtifact } from "@/lib/interchange/project";
import { renderJazzboardSvg } from "@/lib/interchange/svg";
import type { PortableCanvasObject } from "@/lib/interchange/types";
import type { PublicReadonlySnapshot } from "@/lib/server/snapshot-service";
import { JazzboardSnapshotWebMcpRegistrar } from "@/lib/webmcp/snapshot-registration";
import { JAZZBOARD_SNAPSHOT_WEBMCP_TOOL_NAMES } from "@/lib/webmcp/snapshot-tools";

import styles from "./snapshot.module.css";

function readableDate(timestamp: number): string {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(timestamp) + " UTC";
}

function dataHref(content: string, mimeType: string): string {
  return `data:${mimeType};charset=utf-8,${encodeURIComponent(content)}`;
}

function objectLabel(object: PortableCanvasObject): string {
  if (object.kind === "shape") return object.label || object.nodeType || "Untitled shape";
  if (object.kind === "text") return object.content || "Untitled text";
  if (object.kind === "connector") return object.label || "Unlabelled connector";
  if (object.kind === "image") return object.alt || "Image placeholder";
  return "Drawing";
}

export function JazzboardSnapshot({ snapshot }: { snapshot: PublicReadonlySnapshot }) {
  const [webMcpSupported, setWebMcpSupported] = useState<boolean | null>(null);
  const rendered = useMemo(
    () => renderJazzboardSvg(snapshot.artifact, { maxWidth: 1_600, maxHeight: 1_000 }),
    [snapshot.artifact],
  );
  const semanticJson = useMemo(
    () => serializeJazzboardArtifact(snapshot.artifact),
    [snapshot.artifact],
  );
  const mermaid = useMemo(() => {
    if (snapshot.artifact.diagrams.length !== 1) return null;
    return renderDiagramMermaid(snapshot.artifact, snapshot.artifact.diagrams[0].id).source;
  }, [snapshot.artifact]);
  const svgHref = useMemo(() => dataHref(rendered.svg, "image/svg+xml"), [rendered.svg]);

  useEffect(() => {
    const registrar = new JazzboardSnapshotWebMcpRegistrar();
    let active = true;
    void registrar
      .update(snapshot)
      .then((status) => {
        if (active) setWebMcpSupported(status.supported);
      })
      .catch(() => {
        if (active) setWebMcpSupported(false);
      });
    return () => {
      active = false;
      registrar.dispose();
    };
  }, [snapshot]);

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link aria-label="Jazzboard home" className={styles.brand} href="/">
          <JazzboardLogo />
        </Link>
        <div className={styles.headerSignals}>
          <span className={styles.readOnlyBadge}>
            <Eye aria-hidden="true" size={14} /> Read-only snapshot
          </span>
          <span className={webMcpSupported ? styles.agentReady : styles.agentEnabled}>
            <Sparkles aria-hidden="true" size={13} />
            {webMcpSupported ? "Agent ready" : "WebMCP-enabled"} · {JAZZBOARD_SNAPSHOT_WEBMCP_TOOL_NAMES.length} tools
          </span>
        </div>
      </header>

      <section className={styles.intro}>
        <div>
          <p className={styles.eyebrow}>Frozen semantic canvas</p>
          <h1>{snapshot.title}</h1>
          <p className={styles.description}>{snapshot.artifact.description}</p>
        </div>
        <dl className={styles.metadata}>
          <div>
            <dt>Shared by</dt>
            <dd>{snapshot.creator.displayName} · {snapshot.creator.kind}</dd>
          </div>
          <div>
            <dt>Captured</dt>
            <dd>{readableDate(snapshot.createdAt)}</dd>
          </div>
          <div>
            <dt>Available until</dt>
            <dd>{readableDate(snapshot.expiresAt)}</dd>
          </div>
        </dl>
      </section>

      <section aria-label="Snapshot canvas" className={styles.workspace}>
        <div className={styles.canvasCard}>
          <div className={styles.canvasHeader}>
            <div>
              <span className={styles.canvasKicker}>Board revision {snapshot.artifact.source.roomRevision}</span>
              <strong>{snapshot.artifact.objects.length} semantic objects</strong>
            </div>
            <span><ShieldCheck aria-hidden="true" size={15} /> Frozen and immutable</span>
          </div>
          <div className={styles.canvasViewport}>
            {/* Sanitized renderer emits a fixed, script-free SVG vocabulary; an image data URL adds a second isolation boundary. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              alt={`Frozen canvas: ${snapshot.title}`}
              height={rendered.height}
              src={svgHref}
              width={rendered.width}
            />
          </div>
        </div>

        <aside className={styles.sidebar}>
          <section className={styles.panel}>
            <div className={styles.panelTitle}>
              <Network aria-hidden="true" size={17} />
              <h2>Diagrams</h2>
              <span>{snapshot.artifact.diagrams.length}</span>
            </div>
            {snapshot.artifact.diagrams.length ? (
              <ul className={styles.diagramList}>
                {snapshot.artifact.diagrams.map((diagram) => (
                  <li key={diagram.id}>
                    <strong>{diagram.title}</strong>
                    <p>{diagram.description || "No description provided."}</p>
                    <small>{diagram.diagramType} · revision {diagram.revision}</small>
                  </li>
                ))}
              </ul>
            ) : (
              <p className={styles.empty}>This snapshot has no first-class Diagram containers.</p>
            )}
          </section>

          <section className={styles.panel}>
            <div className={styles.panelTitle}>
              <FileJson2 aria-hidden="true" size={17} />
              <h2>Semantic index</h2>
              <span>{snapshot.artifact.objects.length}</span>
            </div>
            <ul className={styles.objectList}>
              {snapshot.artifact.objects.slice(0, 60).map((object) => (
                <li key={object.id}>
                  <span>{object.kind === "shape" && object.nodeType ? object.nodeType : object.kind}</span>
                  <strong>{objectLabel(object)}</strong>
                  <code>{object.id}</code>
                </li>
              ))}
            </ul>
            {snapshot.artifact.objects.length > 60 ? (
              <p className={styles.empty}>
                Showing 60 of {snapshot.artifact.objects.length}. WebMCP can query the full frozen index.
              </p>
            ) : null}
          </section>

          <section className={styles.panel}>
            <div className={styles.panelTitle}>
              <Download aria-hidden="true" size={17} />
              <h2>Portable exports</h2>
            </div>
            <div className={styles.downloads}>
              <a
                download="jazzboard-snapshot.jazzboard.json"
                href={dataHref(semanticJson, "application/vnd.jazzboard.semantic+json")}
              >
                Semantic JSON
              </a>
              <a download="jazzboard-snapshot.svg" href={svgHref}>Safe SVG</a>
              {mermaid ? (
                <a download="jazzboard-snapshot.mmd" href={dataHref(mermaid, "text/vnd.mermaid")}>Mermaid</a>
              ) : null}
            </div>
          </section>
        </aside>
      </section>

      <footer className={styles.footer}>
        <Clock3 aria-hidden="true" size={15} />
        This exact private link expires automatically. It cannot discover rooms, join a session, or edit the source board.
      </footer>
    </main>
  );
}
