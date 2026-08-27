/// <reference types="webmcp-types" />

import { describe, expect, it, vi } from "vitest";

import {
  createJazzboardSnapshotRoomWebMcpTools,
  JAZZBOARD_SNAPSHOT_ROOM_TOOL_NAMES,
} from "./snapshot-room-tools";
import type { JazzboardWebMcpBinding, WebMcpRequest } from "./types";

function binding(role: "participant" | "spectator"): JazzboardWebMcpBinding {
  return {
    roomId: "room_private",
    participantId: "p_owner",
    role,
    context: {
      getRoom: () => null,
      getSelection: () => [],
      getViewport: () => null,
      getFollowTarget: () => null,
      acceptRoom: () => undefined,
      setFollowTarget: () => undefined,
      setDeclinedSpotlight: () => undefined,
      leaveRoomView: () => undefined,
    },
  };
}

describe("retired room snapshot WebMCP tools", () => {
  it("exposes no hosted snapshot lifecycle tools for either room role", () => {
    const request = vi.fn() as unknown as WebMcpRequest;

    expect(JAZZBOARD_SNAPSHOT_ROOM_TOOL_NAMES).toEqual([]);
    expect(createJazzboardSnapshotRoomWebMcpTools(binding("participant"), { request })).toEqual([]);
    expect(createJazzboardSnapshotRoomWebMcpTools(binding("spectator"), { request })).toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });
});
