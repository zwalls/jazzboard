export const GUEST_BOOTSTRAP_HEADER = "x-jazzboard-guest-bootstrap";
export const GUEST_BOOTSTRAP_MAX_AGE_MS = 10 * 60 * 1_000;
export const GUEST_BOOTSTRAP_FUTURE_SKEW_MS = 60 * 1_000;

const TOKEN_PATTERN = /^gb1_([0-9a-z]{8,12})_([a-f0-9]{64})$/;

export type ParsedGuestBootstrapToken = {
  token: string;
  issuedAt: number;
};

/**
 * Creates a short-lived, 256-bit browser proof used only while the first
 * HttpOnly guest-session cookie is in flight. It is kept on the request and
 * reused for a bounded transport retry; it is not persisted as authorization.
 */
export function createGuestBootstrapToken(
  now = Date.now(),
  fillRandom: (bytes: Uint8Array) => Uint8Array = (bytes) => crypto.getRandomValues(bytes),
): string {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error("Guest bootstrap time must be a nonnegative safe integer.");
  }
  const random = fillRandom(new Uint8Array(32));
  if (random.byteLength !== 32) {
    throw new Error("Guest bootstrap entropy must contain exactly 32 bytes.");
  }
  const entropy = Array.from(random, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `gb1_${now.toString(36)}_${entropy}`;
}

/** Parse only fresh, canonical bootstrap proofs. No raw proof is retained. */
export function parseGuestBootstrapToken(
  value: string | null | undefined,
  now = Date.now(),
): ParsedGuestBootstrapToken | null {
  if (!value || !Number.isSafeInteger(now) || now < 0) return null;
  const match = TOKEN_PATTERN.exec(value);
  if (!match) return null;
  const issuedAt = Number.parseInt(match[1], 36);
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) return null;
  if (issuedAt > now + GUEST_BOOTSTRAP_FUTURE_SKEW_MS) return null;
  if (now - issuedAt > GUEST_BOOTSTRAP_MAX_AGE_MS) return null;
  return { token: value, issuedAt };
}
