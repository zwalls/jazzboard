// @vitest-environment node

import { createServer, type Server } from "node:http";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const modulePath: string = "./exp0036-terminal-watcher.mjs";
const { watchExp0036Terminal } = await import(modulePath);

const temporaryDirectories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe("EXP-0036 terminal watcher", () => {
  it("pins the task log and immediately issues the authenticated terminal close", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "exp0036-terminal-watcher-"));
    temporaryDirectories.push(directory);
    const sessionLogPath = path.join(directory, "session.jsonl");
    const launchPath = path.join(directory, "launch.json");
    const outputPath = path.join(directory, "receipt.json");
    const threadId = "thread-attempt02";
    const turnId = "turn-attempt02";
    const secret = "controller_secret_not_for_output_abcdefghijklmnopqrstuvwxyz";
    const requests: Array<{ method?: string; url?: string; token?: string; body: string }> = [];
    let sealed = false;
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        requests.push({
          method: request.method,
          url: request.url,
          token: request.headers["x-exp0036-attempt-secret"] as string,
          body,
        });
        response.setHeader("content-type", "application/json");
        if (request.url === "/close") {
          sealed = true;
          response.statusCode = 202;
          response.end(JSON.stringify({ ok: true }));
        } else {
          response.end(JSON.stringify({
            ok: true,
            receipt: { seal: { complete: sealed }, marker: "terminal-receipt" },
          }));
        }
      });
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server has no port.");
    const origin = `http://127.0.0.1:${address.port}`;
    await writeFile(sessionLogPath, `${JSON.stringify({
      timestamp: "2026-09-04T23:00:00.000Z",
      type: "session_meta",
      payload: { session_id: threadId },
    })}\n`);
    await writeFile(launchPath, JSON.stringify({
      collector: { closeUrl: `${origin}/close`, statusUrl: `${origin}/status`, secret },
    }));

    const watching = watchExp0036Terminal({
      sessionLogPath,
      launchPath,
      threadId,
      outputPath,
      timeoutMs: 2_000,
      sealTimeoutMs: 1_000,
      statusPollMs: 5,
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(requests).toHaveLength(0);
    await appendFile(sessionLogPath, `${JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "event_msg",
      payload: { type: "task_complete", turn_id: turnId, completed_at: Date.now() / 1_000 },
    })}\n`);

    const result = await watching;
    expect(result).toMatchObject({
      threadId,
      turnId,
      terminalReference: `${threadId}:${turnId}`,
      closeAccepted: true,
      sealed: true,
      receipt: { seal: { complete: true }, marker: "terminal-receipt" },
    });
    expect(requests[0]).toMatchObject({ method: "POST", url: "/close", token: secret });
    expect(JSON.parse(requests[0].body)).toEqual({
      taskTerminal: true,
      terminalReference: `${threadId}:${turnId}`,
    });
    expect(requests[1]).toMatchObject({ method: "GET", url: "/status", token: secret });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(await readFile(outputPath, "utf8")).not.toContain(secret);
    expect(result.taskCompleteToCloseRequestMs).toBeGreaterThanOrEqual(0);
  });
});
