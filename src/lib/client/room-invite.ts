const ROOM_CODE_PATTERN = /^\d{4}$/;

export function roomInviteCodeFromHash(hash: string): string | null {
  const parameters = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const code = parameters.get("join")?.trim() ?? "";
  return ROOM_CODE_PATTERN.test(code) ? code : null;
}

export function buildRoomInvite(input: {
  origin: string;
  roomCode: string;
  roomTitle: string;
}): { text: string; url: string } {
  if (!ROOM_CODE_PATTERN.test(input.roomCode)) {
    throw new Error("A Jazzboard invite requires an exact four-digit room code.");
  }
  const url = new URL("/", input.origin);
  url.hash = `join=${input.roomCode}`;
  const title = input.roomTitle.replace(/\s+/g, " ").trim() || "this board";
  return {
    url: url.toString(),
    text: `Join “${title}” on Jazzboard\n${url.toString()}\nRoom code: ${input.roomCode}`,
  };
}
