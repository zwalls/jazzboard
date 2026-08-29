import {
  formatRoomCode,
  isSupportedRoomCode,
  normalizeRoomCode,
} from "@/lib/domain/room-code";

export function roomInviteCodeFromHash(hash: string): string | null {
  const parameters = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  return normalizeRoomCode(parameters.get("join") ?? "");
}

export function buildRoomInvite(input: {
  origin: string;
  roomCode: string;
  roomTitle: string;
}): { text: string; url: string } {
  if (!isSupportedRoomCode(input.roomCode)) {
    throw new Error("A Jazzboard invite requires an exact supported room code.");
  }
  const url = new URL("/", input.origin);
  url.hash = `join=${input.roomCode}`;
  const title = input.roomTitle.replace(/\s+/g, " ").trim() || "this board";
  return {
    url: url.toString(),
    text: `Join “${title}” on Jazzboard\n${url.toString()}\nRoom code: ${formatRoomCode(input.roomCode)}`,
  };
}
