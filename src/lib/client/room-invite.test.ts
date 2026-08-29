import { describe, expect, it } from "vitest";

import { buildRoomInvite, roomInviteCodeFromHash } from "./room-invite";

describe("Jazzboard room invitations", () => {
  it("builds a fragment invite that keeps the exact code out of the server request URL", () => {
    expect(buildRoomInvite({
      origin: "https://jazzboard.example",
      roomCode: "ABC234",
      roomTitle: "  Authentication\nflow  ",
    })).toEqual({
      url: "https://jazzboard.example/#join=ABC234",
      text: "Join “Authentication flow” on Jazzboard\nhttps://jazzboard.example/#join=ABC234\nRoom code: ABC-234",
    });
  });

  it("normalizes current join fragments while retaining exact legacy links", () => {
    expect(roomInviteCodeFromHash("#join=abc-234")).toBe("ABC234");
    expect(roomInviteCodeFromHash("join=AB+C234&source=invite")).toBe("ABC234");
    expect(roomInviteCodeFromHash("#join=1234")).toBe("1234");
    expect(roomInviteCodeFromHash("join=1234&source=invite")).toBe("1234");
    expect(roomInviteCodeFromHash("#join=12345")).toBeNull();
    expect(roomInviteCodeFromHash("#join=ABO234")).toBeNull();
  });

  it("builds legacy-room invites without rewriting their persisted code", () => {
    expect(buildRoomInvite({
      origin: "https://jazzboard.example",
      roomCode: "1234",
      roomTitle: "Legacy board",
    })).toMatchObject({
      url: "https://jazzboard.example/#join=1234",
      text: expect.stringContaining("Room code: 1234"),
    });
  });
});
