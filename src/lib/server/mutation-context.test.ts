import { describe, expect, it } from "vitest";

import {
  createMutationContext,
  currentMutationContext,
  markCurrentMutationReplayed,
  mutationDurationMs,
  runWithMutationContext,
} from "./mutation-context";

function request(idempotencyKey?: string): Pick<Request, "headers" | "method"> {
  return {
    method: "POST",
    headers: new Headers(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
  };
}

describe("mutation context", () => {
  it("supports legacy callers while retaining only privacy-safe hashes", () => {
    const context = createMutationContext({
      request: request(),
      participantId: "p_private",
      roomId: "room_private",
      operation: "canvas.command",
      actorKind: "human",
      parsedBody: { content: "private content" },
      now: () => 100,
      createRequestId: () => "request_test",
    });
    expect(context.idempotency).toBeNull();
    expect(context).toMatchObject({ requestId: "request_test", startedAt: 100 });
    const encoded = JSON.stringify(context);
    expect(encoded).not.toContain("p_private");
    expect(encoded).not.toContain("room_private");
    expect(encoded).not.toContain("private content");
  });

  it("creates a request-bound identity without retaining the raw key", () => {
    const context = createMutationContext({
      request: request("mutation_12345678"),
      participantId: "p_private",
      roomId: "room_private",
      operation: "canvas.command",
      actorKind: "agent",
      parsedBody: { command: "private" },
      now: () => 1_000,
      createRequestId: () => "request_test",
    });
    expect(context.idempotency?.namespace).toBe("canvas.command");
    expect(JSON.stringify(context)).not.toContain("mutation_12345678");
    expect(mutationDurationMs(context, 1_250)).toBe(250);
  });

  it("binds the request digest to the target room without retaining its identifier", () => {
    const base = {
      request: request("mutation_room_scope_1234"),
      participantId: "p_private",
      operation: "canvas.command",
      actorKind: "human" as const,
      parsedBody: { command: "same" },
      createRequestId: () => "request_test",
    };
    const first = createMutationContext({ ...base, roomId: "room_one" });
    const second = createMutationContext({ ...base, roomId: "room_two" });

    expect(first.idempotency?.receiptKey).toBe(second.idempotency?.receiptKey);
    expect(first.idempotency?.requestDigest).not.toBe(second.idempotency?.requestDigest);
    expect(JSON.stringify(first)).not.toContain("room_one");
  });

  it("keeps concurrent mutation identities isolated across awaits", async () => {
    const first = createMutationContext({
      request: request("mutation_first_0001"),
      participantId: "p_first",
      operation: "canvas.command",
      actorKind: "human",
      parsedBody: { value: 1 },
    });
    const second = createMutationContext({
      request: request("mutation_second_001"),
      participantId: "p_second",
      operation: "canvas.command",
      actorKind: "human",
      parsedBody: { value: 2 },
    });

    const seen = await Promise.all([
      runWithMutationContext(first, async () => {
        await Promise.resolve();
        return currentMutationContext()?.idempotency?.scopedKeyHash;
      }),
      runWithMutationContext(second, async () => {
        await Promise.resolve();
        return currentMutationContext()?.idempotency?.scopedKeyHash;
      }),
    ]);

    expect(seen).toEqual([
      first.idempotency?.scopedKeyHash,
      second.idempotency?.scopedKeyHash,
    ]);
    expect(currentMutationContext()).toBeNull();
  });

  it("marks only the active verified mutation context as replayed", () => {
    const context = createMutationContext({
      request: request("mutation_replay_0001"),
      participantId: "p_private",
      roomId: "room_private",
      operation: "room.create",
      actorKind: "human",
      parsedBody: { title: "private" },
    });

    expect(context.replayed).toBe(false);
    runWithMutationContext(context, () => markCurrentMutationReplayed());
    expect(context.replayed).toBe(true);
  });
});
