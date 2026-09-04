// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import { applySemanticTransaction, normalizeRoomSemanticState } from "@/lib/domain/engine";
import type { Participant, RoomState } from "@/lib/domain/types";
import { createJazzboardSemanticWebMcpTools } from "@/lib/webmcp/semantic-tools";
import type { JazzboardToolResult, JazzboardWebMcpBinding, WebMcpRequest } from "@/lib/webmcp/types";

const modulePath: string = "./exp0035-context-fixture.mjs";
const {
  createExp0035ContextFixture,
  gradeExp0035ContextFixture,
  EXP0035_REPAIR_RESOLUTION,
} = await import(modulePath);

const NOW = 35_000_000;

function participant(): Participant {
  const presence = { cursor: null, viewport: null, lastSeenAt: NOW, activity: null };
  return {
    participantId: "controller",
    displayName: "Controller",
    color: "blue",
    role: "participant",
    joinedAt: NOW,
    lastSeenAt: NOW,
    connected: true,
    agentActive: false,
    human: { ...presence },
    agent: { ...presence },
  };
}

function emptyRoom(): RoomState {
  return normalizeRoomSemanticState({
    id: "exp0035-room",
    code: "X0035A",
    title: "EXP-0035 development fixture",
    roomRevision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    participants: { controller: participant() },
    objects: {},
    diagrams: {},
    leases: {},
    spotlight: null,
    agentEditPolicy: "live",
    reviewProposals: [],
  });
}

function transactionToolHarness() {
  let room = emptyRoom();
  let createIndex = 0;
  const request = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "GET") return { room };
    const body = JSON.parse(String(init?.body)) as {
      transaction: Parameters<typeof applySemanticTransaction>[3];
    };
    const result = applySemanticTransaction(room, "controller", "agent", body.transaction, NOW + room.roomRevision);
    room = result.room;
    return { ok: true, outcome: "applied", ...result, activity: null, proposal: null };
  }) as unknown as WebMcpRequest;
  const binding: JazzboardWebMcpBinding = {
    roomId: room.id,
    participantId: "controller",
    role: "participant",
    context: {
      getRoom: () => room,
      getSelection: () => [],
      getViewport: () => null,
      getFollowTarget: () => null,
      acceptRoom: (next) => { room = next; },
      setFollowTarget: () => {},
      setDeclinedSpotlight: () => {},
      leaveRoomView: () => {},
    },
  };
  const tool = createJazzboardSemanticWebMcpTools(binding, {
    request,
    createId: (prefix) => `${prefix}_exp0035_${++createIndex}`,
  }).find((candidate) => candidate.name === "apply_canvas_transaction");
  if (!tool) throw new Error("Missing apply_canvas_transaction test tool.");
  return {
    getRoom: () => room,
    async apply(input: Record<string, unknown>) {
      return await tool.execute(input, { signal: new AbortController().signal }) as JazzboardToolResult;
    },
  };
}

async function compileFixture(family: "inventory" | "repair", seed = "seed-alpha") {
  const fixture = createExp0035ContextFixture({ family, seed });
  const harness = transactionToolHarness();
  for (const transaction of fixture.provisioning.transactions) {
    const result = await harness.apply(transaction);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  }
  return { fixture, harness };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function targets(room: RoomState) {
  return Object.values(room.objects).filter((object) => object.kind === "shape"
    && object.nodeType === "open_question"
    && object.nodeMetadata?.kind === "open_question"
    && object.nodeMetadata.status === "open"
    && object.nodeMetadata.owner === "Mira");
}

describe("EXP-0035 deterministic public development fixtures", () => {
  it("is byte-stable by family and seed while changing identity and placement across seeds", () => {
    for (const family of ["inventory", "repair"] as const) {
      const first = createExp0035ContextFixture({ family, seed: "same-seed" });
      const second = createExp0035ContextFixture({ family, seed: "same-seed" });
      const other = createExp0035ContextFixture({ family, seed: "other-seed" });
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
      expect(JSON.stringify(other)).not.toBe(JSON.stringify(first));
      expect(first.provisioning.mode).toBe("create-only");
      expect(first.provisioning.transactions.every((chunk: { operations: unknown[] }) => chunk.operations.length <= 200)).toBe(true);
      expect(first.public.brief).not.toMatch(/apply_canvas_transaction|query_objects|\bx\s*[:=]|\by\s*[:=]/i);
      expect(first.public.brief).not.toContain(first.controller.expectedAnswer.openQuestionNames?.[0] ?? "impossible-answer-token");
      expect(first.public.brief).not.toContain(first.controller.expectedAnswer.updatedOpenQuestionNames?.[0] ?? "impossible-answer-token");
    }
  });

  it("compiles both fixture families through the real WebMCP transaction validator and semantic engine", async () => {
    const inventory = await compileFixture("inventory");
    expect(Object.keys(inventory.harness.getRoom().objects)).toHaveLength(360);
    expect(Object.keys(inventory.harness.getRoom().diagrams)).toHaveLength(6);
    expect(Object.values(inventory.harness.getRoom().objects).reduce<Record<string, number>>((counts, object) => {
      counts[object.kind] = (counts[object.kind] ?? 0) + 1;
      return counts;
    }, {})).toEqual({ shape: 180, path: 90, text: 90 });
    expect(new Set(Object.values(inventory.harness.getRoom().objects).map((object) => object.semanticName)).size).toBe(360);
    expect(inventory.fixture.controller.expectedAnswer.openQuestionNames).toHaveLength(8);

    const repair = await compileFixture("repair");
    expect(Object.keys(repair.harness.getRoom().objects)).toHaveLength(240);
    expect(Object.keys(repair.harness.getRoom().diagrams)).toHaveLength(0);
    expect(targets(repair.harness.getRoom())).toHaveLength(12);
  }, 30_000);

  it("authoritatively grades inventory state and exact answer ordering", async () => {
    const { fixture, harness } = await compileFixture("inventory", "grade-inventory");
    const before = clone(harness.getRoom());
    const correct = gradeExp0035ContextFixture({
      family: "inventory",
      beforeRoom: before,
      afterRoom: clone(before),
      finalAnswer: JSON.stringify(fixture.controller.expectedAnswer),
    });
    expect(correct).toMatchObject({ passed: true, score: 1, failedCheckCount: 0 });

    const reversedAnswer = clone(fixture.controller.expectedAnswer);
    reversedAnswer.openQuestionNames.reverse();
    expect(gradeExp0035ContextFixture({
      family: "inventory",
      beforeRoom: before,
      afterRoom: clone(before),
      finalAnswer: reversedAnswer,
    })).toMatchObject({ passed: false, score: 0 });

    const mutated = clone(before);
    const first = Object.values(mutated.objects)[0]!;
    first.x += 1;
    expect(gradeExp0035ContextFixture({
      family: "inventory",
      beforeRoom: before,
      afterRoom: mutated,
      finalAnswer: fixture.controller.expectedAnswer,
    })).toMatchObject({ passed: false, score: 0 });
  }, 30_000);

  it("accepts the exact repair and rejects missing, extra, and reversed lifecycle changes", async () => {
    const { fixture, harness } = await compileFixture("repair", "grade-repair");
    const before = clone(harness.getRoom());
    const result = await harness.apply({
      intent: "Defer Mira's open questions pending dependency review.",
      summary: "Deferred all matching questions.",
      operations: targets(before).map((object) => ({
        op: "update_object",
        objectId: object.id,
        expectedRevision: object.revision,
        patch: {
          nodeMetadata: {
            kind: "open_question",
            status: "deferred",
            owner: "Mira",
            resolution: EXP0035_REPAIR_RESOLUTION,
          },
        },
      })),
    });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    const after = clone(harness.getRoom());
    expect(gradeExp0035ContextFixture({
      family: "repair",
      beforeRoom: before,
      afterRoom: after,
      finalAnswer: fixture.controller.expectedAnswer,
    })).toMatchObject({ passed: true, score: 1 });

    const multiEdit = clone(after);
    for (const object of targets(before)) multiEdit.objects[object.id]!.revision += 2;
    expect(gradeExp0035ContextFixture({ family: "repair", beforeRoom: before, afterRoom: multiEdit, finalAnswer: fixture.controller.expectedAnswer }))
      .toMatchObject({ passed: true, score: 1 });

    const missing = clone(after);
    const missed = targets(before)[0]!;
    missing.objects[missed.id] = clone(missed);
    expect(gradeExp0035ContextFixture({ family: "repair", beforeRoom: before, afterRoom: missing, finalAnswer: fixture.controller.expectedAnswer }))
      .toMatchObject({ passed: false, score: 0 });

    const extra = clone(after);
    const protectedOpen = Object.values(before.objects).find((object) => object.kind === "shape"
      && object.nodeMetadata?.kind === "open_question"
      && object.nodeMetadata.status === "open"
      && object.nodeMetadata.owner !== "Mira")!;
    const changedProtected = clone(protectedOpen);
    if (changedProtected.kind !== "shape") throw new Error("Expected shape.");
    changedProtected.nodeMetadata = {
      kind: "open_question",
      status: "deferred",
      owner: protectedOpen.kind === "shape" ? protectedOpen.nodeMetadata?.owner ?? null : null,
      resolution: EXP0035_REPAIR_RESOLUTION,
      resolvedAt: NOW + 999,
    };
    changedProtected.revision += 1;
    extra.objects[changedProtected.id] = changedProtected;
    expect(gradeExp0035ContextFixture({ family: "repair", beforeRoom: before, afterRoom: extra, finalAnswer: fixture.controller.expectedAnswer }))
      .toMatchObject({ passed: false, score: 0 });

    const protectedRuntimeRewrite = clone(after);
    const protectedText = Object.values(protectedRuntimeRewrite.objects).find((object) => object.kind === "text")!;
    protectedText.revision += 1;
    protectedText.updatedAt += 1;
    expect(gradeExp0035ContextFixture({ family: "repair", beforeRoom: before, afterRoom: protectedRuntimeRewrite, finalAnswer: fixture.controller.expectedAnswer }))
      .toMatchObject({ passed: false, score: 0 });

    const unexpectedMetadata = clone(after);
    const firstTargetAfter = unexpectedMetadata.objects[targets(before)[0]!.id]!;
    if (firstTargetAfter.kind !== "shape" || !firstTargetAfter.nodeMetadata) throw new Error("Expected lifecycle shape.");
    (firstTargetAfter.nodeMetadata as unknown as Record<string, unknown>).unexpected = "not preserved";
    expect(gradeExp0035ContextFixture({ family: "repair", beforeRoom: before, afterRoom: unexpectedMetadata, finalAnswer: fixture.controller.expectedAnswer }))
      .toMatchObject({ passed: false, score: 0 });

    const reversed = clone(after);
    reversed.objects[missed.id] = clone(missed);
    reversed.objects[changedProtected.id] = changedProtected;
    expect(gradeExp0035ContextFixture({ family: "repair", beforeRoom: before, afterRoom: reversed, finalAnswer: fixture.controller.expectedAnswer }))
      .toMatchObject({ passed: false, score: 0 });
  }, 30_000);
});
