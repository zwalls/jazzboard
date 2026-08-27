import { describe, expect, it, vi } from "vitest";

import { evaluateRoomCapacity } from "./capacity";
import {
  emitTelemetry,
  hashTelemetryIdentifier,
  shouldSampleTelemetry,
  telemetryRecord,
  unknownErrorTelemetryFields,
} from "./telemetry";
import type { RoomState } from "@/lib/domain/types";

function emptyRoom(): RoomState {
  return {
    id: "private_room",
    code: "1234",
    title: "Private title",
    roomRevision: 1,
    stateRevision: 1,
    createdAt: 1,
    updatedAt: 1,
    participants: {},
    objects: {},
    diagrams: {},
    leases: {},
    spotlight: null,
    agentEditPolicy: "live",
    reviewProposals: [],
  };
}

describe("privacy-safe telemetry", () => {
  it("emits structured numeric capacity and hashed correlation without private source values", () => {
    const sink = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const participantHash = hashTelemetryIdentifier("p_private", "test-secret");
    const roomHash = hashTelemetryIdentifier("room_private", "test-secret");
    emitTelemetry({
      event: "mutation.completed",
      level: "info",
      requestId: "request_test",
      operation: "canvas.command",
      actorKind: "human",
      outcome: "applied",
      replayed: false,
      durationMs: 12,
      participantHash,
      roomHash,
      capacity: evaluateRoomCapacity(emptyRoom()),
    }, { sink, now: () => 123 });
    expect(sink.info).toHaveBeenCalledTimes(1);
    const encoded = String(sink.info.mock.calls[0][0]);
    expect(encoded).toContain('"schemaVersion":1');
    expect(encoded).toContain(participantHash);
    expect(encoded).not.toContain("p_private");
    expect(encoded).not.toContain("room_private");
    expect(encoded).not.toContain("Private title");
  });

  it("drops uncontrolled strings instead of turning logs into a content sink", () => {
    const record = telemetryRecord({
      event: "mutation.failed",
      level: "error",
      operation: "private content with spaces",
      errorCode: "PRIVATE MESSAGE WITH SPACES",
    }, 1);
    expect(record).not.toHaveProperty("operation");
    expect(record).not.toHaveProperty("errorCode");
  });

  it("samples deterministically", () => {
    expect(shouldSampleTelemetry("same", 0.5)).toBe(shouldSampleTelemetry("same", 0.5));
    expect(shouldSampleTelemetry("anything", 0)).toBe(false);
    expect(shouldSampleTelemetry("anything", 1)).toBe(true);
  });

  it("extracts a provider command name without retaining Redis arguments or messages", () => {
    const error = Object.assign(new Error("ERR private serialized room"), {
      name: "ReplyError",
      command: {
        name: "SET",
        args: ["jazzboard:room:private", "private board content"],
      },
    });

    const fields = unknownErrorTelemetryFields(error);
    expect(fields).toEqual({ errorClass: "ReplyError", providerCommand: "set" });
    expect(JSON.stringify(fields)).not.toContain("private");
    expect(JSON.stringify(fields)).not.toContain("jazzboard:room");
  });
});
