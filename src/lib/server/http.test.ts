import { describe, expect, it, vi } from "vitest";

import { DomainError } from "@/lib/domain/errors";

import { markCurrentMutationReplayed } from "./mutation-context";
import { errorResponse, readJsonBody, runMutationRequest } from "./http";

describe("bounded JSON HTTP helpers", () => {
  it("parses a body within the configured byte budget", async () => {
    const request = new Request("https://jazzboard.test/mutate", {
      method: "POST",
      body: JSON.stringify({ ok: true }),
      headers: { "content-type": "application/json" },
    });
    await expect(readJsonBody(request, { maximumBytes: 64 })).resolves.toEqual({ ok: true });
  });

  it("rejects declared and streamed bodies beyond the budget with 413", async () => {
    const declared = new Request("https://jazzboard.test/mutate", {
      method: "POST",
      body: "{}",
      headers: { "content-length": "100" },
    });
    await expect(readJsonBody(declared, { maximumBytes: 10 })).rejects.toMatchObject({
      code: "REQUEST_TOO_LARGE",
    });

    const streamed = new Request("https://jazzboard.test/mutate", {
      method: "POST",
      body: JSON.stringify({ content: "private content" }),
    });
    const error = await readJsonBody(streamed, { maximumBytes: 8 }).catch((value) => value);
    expect(error).toMatchObject({ code: "REQUEST_TOO_LARGE" });
    const response = errorResponse(error);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "REQUEST_TOO_LARGE" } });
  });

  it("maps idempotency conflict, unknown outcome, and capacity errors truthfully", () => {
    expect(errorResponse(new DomainError("IDEMPOTENCY_CONFLICT", "conflict")).status).toBe(409);
    expect(errorResponse(new DomainError("MUTATION_OUTCOME_UNKNOWN", "unknown")).status).toBe(503);
    expect(errorResponse(new DomainError("ROOM_CAPACITY_EXCEEDED", "large")).status).toBe(413);
  });

  it("maps private agent-message lifecycle errors without leaking claim details", async () => {
    expect(errorResponse(new DomainError("MESSAGE_NOT_FOUND", "missing")).status).toBe(404);
    for (const code of [
      "MESSAGE_ALREADY_CLAIMED",
      "MESSAGE_ALREADY_ANSWERED",
      "MESSAGE_CLAIM_REQUIRED",
      "MESSAGE_CLAIM_EXPIRED",
    ] as const) {
      const response = errorResponse(new DomainError(code, "message conflict"));
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ error: { code } });
    }
  });

  it("treats invalid UTF-8 as invalid JSON instead of an internal failure", async () => {
    const request = new Request("https://jazzboard.test/mutate", {
      method: "POST",
      body: new Uint8Array([0xc3, 0x28]),
    });
    const error = await readJsonBody(request).catch((value) => value);
    expect(error).toBeInstanceOf(SyntaxError);
    expect(errorResponse(error).status).toBe(400);
  });

  it("never logs provider command arguments for an unknown Redis error", () => {
    const errorSink = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const providerError = Object.assign(new Error("ERR includes private board content"), {
      name: "ReplyError",
      command: {
        name: "SET",
        args: ["jazzboard:room:secret", "private board content"],
      },
    });

    expect(errorResponse(providerError).status).toBe(500);
    const logged = JSON.stringify(errorSink.mock.calls);
    expect(logged).toContain("server.error");
    expect(logged).toContain("ReplyError");
    expect(logged).toContain("providerCommand");
    expect(logged).not.toContain("private board content");
    expect(logged).not.toContain("jazzboard:room:secret");
    errorSink.mockRestore();
  });

  it("reports a verified successful replay truthfully", async () => {
    const infoSink = vi.spyOn(console, "info").mockImplementation(() => undefined);
    await runMutationRequest({
      request: new Request("https://jazzboard.test/api/rooms", { method: "POST" }),
      participantId: "p_private",
      operation: "room.create",
      actorKind: "human",
      parsedBody: { title: "private" },
      execute: async () => {
        markCurrentMutationReplayed();
        return { ok: true };
      },
    });

    const logged = String(infoSink.mock.calls.at(-1)?.[0]);
    expect(logged).toContain('"outcome":"replayed"');
    expect(logged).toContain('"replayed":true');
    expect(logged).not.toContain("private");
    infoSink.mockRestore();
  });

  it("retains verified replay attribution when later response reconstruction fails", async () => {
    const errorSink = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(runMutationRequest({
      request: new Request("https://jazzboard.test/api/snapshots", { method: "POST" }),
      participantId: "p_private",
      operation: "room.snapshot.create",
      actorKind: "human",
      parsedBody: { title: "private" },
      execute: async () => {
        markCurrentMutationReplayed();
        throw new DomainError("IDEMPOTENCY_CONFLICT", "Reconstructed response mismatch.");
      },
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    const logged = String(errorSink.mock.calls.at(-1)?.[0]);
    expect(logged).toContain('"event":"mutation.failed"');
    expect(logged).toContain('"replayed":true');
    expect(logged).not.toContain("private");
    errorSink.mockRestore();
  });
});
