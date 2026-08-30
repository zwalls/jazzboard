import { createHash } from "node:crypto";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export const SHA256_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

function canonicalize(value: unknown, path: string): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;

  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`Non-finite number at ${path}.`);
    return Object.is(value, -0) ? 0 : value;
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => canonicalize(item, `${path}/${index}`));
  }

  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`Only plain JSON objects are supported at ${path}.`);
    }

    const result: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined || typeof item === "function" || typeof item === "symbol" || typeof item === "bigint") {
        throw new TypeError(`Non-JSON value at ${path}/${key}.`);
      }
      result[key] = canonicalize(item, `${path}/${key}`);
    }
    return result;
  }

  throw new TypeError(`Non-JSON value at ${path}.`);
}

/** Stable JSON for provenance hashing. Object keys are recursively sorted. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, "$"));
}

export function sha256Digest(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function hashCanonicalJson(value: unknown): string {
  return sha256Digest(canonicalJson(value));
}

/**
 * Deterministic binary Merkle root. Entries are ordered by the caller before
 * reaching this function; an odd final node is promoted unchanged.
 */
export function merkleRoot(digests: readonly string[]): string {
  if (digests.length === 0) return hashCanonicalJson({ empty: true, schemaVersion: 1 });
  for (const digest of digests) {
    if (!SHA256_DIGEST_PATTERN.test(digest)) throw new TypeError(`Invalid SHA-256 digest: ${digest}`);
  }

  let level = [...digests];
  while (level.length > 1) {
    const next: string[] = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index];
      const right = level[index + 1];
      next.push(right === undefined ? left : hashCanonicalJson({ left, right }));
    }
    level = next;
  }
  return level[0];
}
