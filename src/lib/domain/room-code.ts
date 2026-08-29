export const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const ROOM_CODE_LENGTH = 6;
export const ROOM_CODE_GROUP_LENGTH = 3;
export const ROOM_CODE_INPUT_MAX_LENGTH = 32;

export const CURRENT_ROOM_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{6}$/;
export const LEGACY_ROOM_CODE_PATTERN = /^\d{4}$/;
export const SUPPORTED_ROOM_CODE_PATTERN = /^(?:[A-HJ-NP-Z2-9]{6}|\d{4})$/;

const ROOM_CODE_INPUT_PATTERN = /^[A-Za-z0-9 -]+$/;

/**
 * Converts a human-entered room code into the exact value used by the room
 * index. Jazzboard accepts ASCII case differences plus spaces and hyphens as
 * visual separators, but deliberately rejects Unicode lookalikes and fuzzy
 * substitutions such as O-for-0.
 */
export function normalizeRoomCode(value: string): string | null {
  if (value.length < 4 || value.length > ROOM_CODE_INPUT_MAX_LENGTH) return null;
  if (!ROOM_CODE_INPUT_PATTERN.test(value)) return null;
  const normalized = value.replace(/[ -]/g, "").toUpperCase();
  return SUPPORTED_ROOM_CODE_PATTERN.test(normalized) ? normalized : null;
}

export function isCurrentRoomCode(value: string): boolean {
  return CURRENT_ROOM_CODE_PATTERN.test(value);
}

export function isLegacyRoomCode(value: string): boolean {
  return LEGACY_ROOM_CODE_PATTERN.test(value);
}

export function isSupportedRoomCode(value: string): boolean {
  return SUPPORTED_ROOM_CODE_PATTERN.test(value);
}

export function formatRoomCode(value: string): string {
  if (!isCurrentRoomCode(value)) return value;
  return `${value.slice(0, ROOM_CODE_GROUP_LENGTH)}-${value.slice(ROOM_CODE_GROUP_LENGTH)}`;
}

export const ROOM_CODE_INPUT_JSON_SCHEMA = {
  type: "string",
  minLength: 4,
  maxLength: ROOM_CODE_INPUT_MAX_LENGTH,
  pattern:
    "^(?:[ -]*(?:[A-HJ-NP-Za-hj-np-z2-9][ -]*){6}|[ -]*(?:[0-9][ -]*){4})$",
  description:
    "A private Jazzboard room code: six unambiguous letters/numbers for current rooms, or four digits for a legacy room. ASCII case, spaces, and hyphens are normalized; guessing or enumerating codes is prohibited.",
} as const;
