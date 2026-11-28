"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";

import { apiRequest, JazzboardApiError } from "@/lib/client/api";
import type { RemoteGrantAccess } from "@/lib/server/remote-mcp-auth";

import styles from "./remote-mcp-connections.module.css";

type Connection = { id: string; label: string; access: RemoteGrantAccess; expiresAt: number };
type Connections = { endpoint: string; canEdit: boolean; connections: Connection[] };
type Receipt = Connection & { token: string };

async function changeConnection<T>(path: string, input: Record<string, string>): Promise<T> {
  // Creation returns the secret once. A dropped response must not silently create a second token.
  const response = await fetch(path, {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = await response.json();
  if (!response.ok) throw new JazzboardApiError(response.status, data.error ?? {
    code: "CONNECTION_REQUEST_FAILED", message: "Jazzboard could not update these connections.",
  });
  return data as T;
}

function errorMessage(error: unknown) {
  if (error instanceof JazzboardApiError) return error.failure.message;
  return "Jazzboard could not update these connections.";
}

export function RemoteMcpConnections({ roomId }: { roomId: string }) {
  const path = `/api/rooms/${encodeURIComponent(roomId)}/mcp-connections`;
  const [data, setData] = useState<Connections | null>(null);
  const [label, setLabel] = useState("");
  const [access, setAccess] = useState<RemoteGrantAccess>("read");
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void apiRequest<Connections>(path, { signal: controller.signal })
      .then((response) => { if (!controller.signal.aborted) setData(response); })
      .catch((failure) => { if (!controller.signal.aborted) setError(errorMessage(failure)); });
    return () => controller.abort();
  }, [path]);

  async function createConnection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || receipt) return;
    setPending(true);
    setError("");
    setNotice("");
    try {
      const { connection } = await changeConnection<{ connection: Receipt }>(path, { action: "create", label, access });
      const { token, ...summary } = connection;
      setData((current) => current && { ...current, connections: [...current.connections, summary] });
      setReceipt({ ...summary, token });
      setLabel("");
    } catch (failure) {
      setError(failure instanceof JazzboardApiError
        ? failure.failure.message
        : "The connection response was interrupted. Reload and check your active connections before trying again.");
    } finally {
      setPending(false);
    }
  }

  async function revokeConnection(id: string) {
    setPending(true);
    setError("");
    setNotice("");
    try {
      await changeConnection(path, { action: "revoke", id });
      setData((current) => current && { ...current, connections: current.connections.filter((item) => item.id !== id) });
      setReceipt((current) => current?.id === id ? null : current);
      setNotice("Connection revoked.");
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  }

  async function copyToken(token: string) {
    try {
      await navigator.clipboard.writeText(token);
      setNotice("Connection token copied.");
    } catch {
      setNotice("Select and copy the token below.");
    }
  }

  return (
    <main className={styles.page}>
      <Link href={`/room/${encodeURIComponent(roomId)}`}>Back to board</Link>
      <h1>MCP connections</h1>
      <p>Give an MCP client access to this room. Anyone who has a connection token can use its permissions as your agent until it expires or you revoke it.</p>
      {error && <p role="alert" className={styles.error}>{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {!data && !error && <p role="status">Loading connections…</p>}
      {data && <>
        <form className={styles.card} onSubmit={(event) => void createConnection(event)}>
          <label>Connection name
            <input required maxLength={64} value={label} onChange={(event) => setLabel(event.target.value)} />
          </label>
          <label>Permission
            <select value={access} onChange={(event) => setAccess(event.target.value === "write" ? "write" : "read")}>
              <option value="read">View canvas and previews</option>
              {data.canEdit && <option value="write">View and edit canvas</option>}
            </select>
          </label>
          <button type="submit" disabled={pending || !label.trim() || Boolean(receipt)}>Create connection</button>
        </form>
        {receipt && <section className={styles.card} aria-label="Connection details">
          <p>Copy the token into your MCP client’s private bearer-token setting. It is shown here once.</p>
          <label>Server URL<input readOnly value={data.endpoint} /></label>
          <label>Room ID<input readOnly value={roomId} /></label>
          <label>Bearer token<input readOnly autoComplete="off" spellCheck={false} value={receipt.token} /></label>
          <div className={styles.actions}>
            <button type="button" onClick={() => void copyToken(receipt.token)}>Copy token</button>
            <button type="button" onClick={() => setReceipt(null)}>Hide token</button>
          </div>
        </section>}
        <h2>Your active connections</h2>
        {data.connections.length === 0 && <p>No active connections.</p>}
        {data.connections.length > 0 && <ul className={styles.list}>
          {data.connections.map((connection) => <li key={connection.id}>
            <div>
              <strong>{connection.label}</strong>
              <span>{connection.access === "write" ? "Can edit" : "View only"} · Expires {new Date(connection.expiresAt).toLocaleDateString()}</span>
            </div>
            <button type="button" disabled={pending} onClick={() => void revokeConnection(connection.id)} aria-label={`Revoke ${connection.label}`}>Revoke</button>
          </li>)}
        </ul>}
      </>}
    </main>
  );
}
