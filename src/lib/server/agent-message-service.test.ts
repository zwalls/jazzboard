// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CanvasCommand } from "@/lib/domain/types";

import { MemoryAgentMessageStore, setAgentMessageStoreForTests } from "./agent-message-store";
import {
  claimAgentMessage,
  createAgentMessage,
  listAgentMessages,
  replyAgentMessage,
} from "./agent-message-service";
import { runCanvasCommand } from "./room-service";
import { getRoomStore } from "./room-store";

const createNote: CanvasCommand = {
  type: "create",
  object: {
    id: "note_1",
    kind: "text",
    x: 10,
    y: 20,
    width: 200,
    height: 80,
    rotation: 0,
    zIndex: 0,
    groupId: null,
    content: "Original context",
    color: "black",
    size: "m",
    align: "start",
  },
};

describe("agent message service", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T12:00:00.000Z"));
    vi.stubEnv("REDIS_URL", "");
    globalThis.__jazzboardRoomStore = undefined;
    globalThis.__jazzboardLocalState = undefined;
    globalThis.__jazzboardRedis = undefined;
    setAgentMessageStoreForTests(new MemoryAgentMessageStore());
  });

  afterEach(() => {
    setAgentMessageStoreForTests(undefined);
    globalThis.__jazzboardRoomStore = undefined;
    globalThis.__jazzboardLocalState = undefined;
    globalThis.__jazzboardRedis = undefined;
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("derives the human author and snapshots authoritative selection context immutably", async () => {
    const room = await getRoomStore().createRoom({
      participantId: "p_owner",
      displayName: "Owner",
      title: "Architecture review",
    });
    await runCanvasCommand({ roomId: room.id, participantId: "p_owner", actorKind: "human", command: createNote });

    const message = await createAgentMessage({
      roomId: room.id,
      participantId: "p_owner",
      messageId: "message_1",
      prompt: "What should change?",
      selectedObjectIds: ["note_1", "deleted_during_submit"],
    });

    expect(message).toMatchObject({
      author: { participantId: "p_owner", displayName: "Owner", kind: "human" },
      context: {
        room: { id: room.id, title: "Architecture review", roomRevision: 2 },
        selection: {
          objectIds: ["note_1", "deleted_during_submit"],
          objects: [{ id: "note_1", content: "Original context", revision: 1 }],
          missingObjectIds: ["deleted_during_submit"],
          bounds: { x: 10, y: 20, width: 200, height: 80 },
        },
      },
    });

    await runCanvasCommand({
      roomId: room.id,
      participantId: "p_owner",
      actorKind: "human",
      command: {
        type: "update",
        objectId: "note_1",
        expectedRevision: 1,
        operation: "edit",
        patch: { content: "Changed later" },
      },
    });
    const listed = await listAgentMessages({ roomId: room.id, participantId: "p_owner", limit: 10 });
    expect(listed.messages[0].context.selection.objects[0]).toMatchObject({ content: "Original context", revision: 1 });
  });

  it("derives agent reply attribution and denies every private-channel operation to spectators", async () => {
    const store = getRoomStore();
    const room = await store.createRoom({ participantId: "p_owner", displayName: "Owner", title: "Private asks" });
    await runCanvasCommand({ roomId: room.id, participantId: "p_owner", actorKind: "human", command: createNote });
    await createAgentMessage({ roomId: room.id, participantId: "p_owner", messageId: "message_1", prompt: "Please review", selectedObjectIds: ["note_1"] });
    const claim = await claimAgentMessage({ roomId: room.id, participantId: "p_owner", messageId: "message_1", claimId: "claim_1", leaseSeconds: 60 });
    const answered = await replyAgentMessage({ roomId: room.id, participantId: "p_owner", messageId: "message_1", replyId: "reply_1", claimToken: claim.claimToken, text: "Looks sound.", outcome: "completed" });
    expect(answered.reply?.author).toMatchObject({ participantId: "p_owner", displayName: "Owner", kind: "agent" });

    await store.joinRoom({ participantId: "p_viewer", displayName: "Viewer", code: room.code, role: "spectator" });
    await expect(listAgentMessages({ roomId: room.id, participantId: "p_viewer", limit: 10 }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(createAgentMessage({ roomId: room.id, participantId: "p_viewer", messageId: "message_spoof", prompt: "No", selectedObjectIds: ["note_1"] }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
