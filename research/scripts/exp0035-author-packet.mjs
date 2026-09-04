/** The complete common author instructions. No controller expectations belong here. */
export function createExp0035AuthorPacket({ origin, code, brief }) {
  if (!/^http:\/\/127\.0\.0\.1:310[12]$/.test(origin)) throw new Error("Expected a frozen localhost origin.");
  if (!/^[A-HJ-NP-Z2-9]{6}$/.test(code)) throw new Error("Expected an exact room code.");
  if (typeof brief !== "string" || !brief) throw new Error("Missing public task brief.");
  return `Complete the following task in Jazzboard using the Codex in-app browser.

Open ${origin}/ and join the exact private room code ${code} as a participant with display name "Board author". This exact room is authorized for the requested work.

${brief}

Use only this room's native browser WebMCP tools, public application guidance, and browser pixels. Do not use terminal commands, filesystem access, repository context, direct HTTP requests, page evaluation, private APIs, other rooms, other tasks, or other authors' transcripts. Do not delegate or create additional tasks. Choose your own application workflow from the tools and guidance available in the room.

Finish within 15 minutes. If blocked, state the blocker rather than guessing or claiming completion. Otherwise return the exact JSON requested by the task, without surrounding prose or Markdown fences.`;
}
