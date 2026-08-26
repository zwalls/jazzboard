import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const COOKIE_NAME = "jazzboard_guest";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

declare global {
  var __jazzboardLocalSessionSecret: string | undefined;
}

function sessionSecret(): string {
  if (process.env.SESSION_SECRET) {
    if (process.env.SESSION_SECRET.length < 32) {
      throw new Error("SESSION_SECRET must contain at least 32 characters.");
    }
    return process.env.SESSION_SECRET;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("SESSION_SECRET must be configured in production.");
  }
  globalThis.__jazzboardLocalSessionSecret ??= randomBytes(32).toString("base64url");
  return globalThis.__jazzboardLocalSessionSecret;
}

function signature(payload: string): string {
  return createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) {
      try {
        return decodeURIComponent(value.join("="));
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function parseGuestParticipantId(request: Request): string | null {
  const token = cookieValue(request, COOKIE_NAME);
  if (!token) return null;
  const separator = token.lastIndexOf(".");
  if (separator < 1) return null;
  const payload = token.slice(0, separator);
  const suppliedSignature = token.slice(separator + 1);
  if (!safeEqual(signature(payload), suppliedSignature)) return null;
  const [participantId, issuedAtRaw] = payload.split("~");
  const issuedAt = Number(issuedAtRaw);
  if (!participantId?.startsWith("p_") || !Number.isFinite(issuedAt)) return null;
  if (Date.now() - issuedAt > COOKIE_MAX_AGE_SECONDS * 1_000) return null;
  return participantId;
}

export function getOrCreateGuestSession(request: Request): {
  participantId: string;
  setCookie: string | null;
} {
  const existing = parseGuestParticipantId(request);
  if (existing) return { participantId: existing, setCookie: null };

  const participantId = `p_${randomBytes(18).toString("base64url")}`;
  const payload = `${participantId}~${Date.now()}`;
  const token = `${payload}.${signature(payload)}`;
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return {
    participantId,
    setCookie: `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_SECONDS}${secure}`,
  };
}

export function requireGuestParticipantId(request: Request): string {
  const participantId = parseGuestParticipantId(request);
  if (!participantId) throw new Error("AUTH_REQUIRED");
  return participantId;
}
