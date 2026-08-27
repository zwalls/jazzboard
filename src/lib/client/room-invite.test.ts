import { describe, expect, it } from "vitest";

import { buildRoomInvite, roomInviteCodeFromHash } from "./room-invite";

describe("Jazzboard room invitations", () => {
  it("builds a fragment invite that keeps the exact code out of the server request URL", () => {
    expect(buildRoomInvite({
      origin: "https://jazzboard.example",
      roomCode: "1234",
      roomTitle: "  Authentication\nflow  ",
    })).toEqual({
      url: "https://jazzboard.example/#join=1234",
      text: "Join “Authentication flow” on Jazzboard\nhttps://jazzboard.example/#join=1234\nRoom code: 1234",
    });
  });

  it("accepts only an exact four-digit join fragment", () => {
    expect(roomInviteCodeFromHash("#join=1234")).toBe("1234");
    expect(roomInviteCodeFromHash("join=1234&source=invite")).toBe("1234");
    expect(roomInviteCodeFromHash("#join=12345")).toBeNull();
    expect(roomInviteCodeFromHash("#join=12ab")).toBeNull();
  });
});
