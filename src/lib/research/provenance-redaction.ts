import type { JsonValue } from "./provenance-crypto";
import { SUPPORTED_ROOM_CODE_PATTERN } from "@/lib/domain/room-code";

const SECRET_KEY = /(?:authorization|cookie|password|room[_-]?(?:id|code)|session|secret|token)/i;
const RAW_ROOM_ID = /^room_[A-Za-z0-9_-]{8,}$/;

function isRawRoomCode(value: string): boolean {
  return SUPPORTED_ROOM_CODE_PATTERN.test(value);
}

export type RedactionResult = {
  value: JsonValue;
  redactedPaths: string[];
};

function pointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

/** Removes secret-bearing fields entirely; it never publishes hashes of short room codes. */
export function redactResearchSecrets(value: unknown, knownSecrets: readonly string[] = []): RedactionResult {
  const exactSecrets = new Set(knownSecrets.filter((secret) => secret.length > 0));
  const redactedPaths: string[] = [];

  function visit(input: unknown, path: string): JsonValue {
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "number") {
      if (!Number.isFinite(input)) throw new TypeError(`Non-finite number at ${path}.`);
      return Object.is(input, -0) ? 0 : input;
    }
    if (typeof input === "string") {
      if (exactSecrets.has(input) || RAW_ROOM_ID.test(input) || isRawRoomCode(input)) {
        redactedPaths.push(path);
        return "[REDACTED]";
      }
      return input;
    }
    if (Array.isArray(input)) return input.map((item, index) => visit(item, `${path}/${index}`));
    if (typeof input !== "object" || Object.getPrototypeOf(input) !== Object.prototype) throw new TypeError(`Non-JSON value at ${path}.`);

    const output: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(input as Record<string, unknown>)) {
      const itemPath = `${path}/${pointerSegment(key)}`;
      if (SECRET_KEY.test(key)) {
        redactedPaths.push(itemPath);
        continue;
      }
      output[key] = visit(item, itemPath);
    }
    return output;
  }

  return { value: visit(value, ""), redactedPaths: [...new Set(redactedPaths)].sort() };
}

export function findSecretLeakage(value: unknown, knownSecrets: readonly string[] = []): string[] {
  const exactSecrets = new Set(knownSecrets.filter((secret) => secret.length > 0));
  const findings: string[] = [];

  function visit(input: unknown, path: string): void {
    if (typeof input === "string") {
      if (exactSecrets.has(input)) findings.push(`${path}:known-secret`);
      if (RAW_ROOM_ID.test(input)) findings.push(`${path}:raw-room-id`);
      if (isRawRoomCode(input)) findings.push(`${path}:raw-room-code`);
      return;
    }
    if (Array.isArray(input)) return input.forEach((item, index) => visit(item, `${path}/${index}`));
    if (input === null || typeof input !== "object") return;
    for (const [key, item] of Object.entries(input as Record<string, unknown>)) {
      const itemPath = `${path}/${pointerSegment(key)}`;
      if (SECRET_KEY.test(key)) findings.push(`${itemPath}:secret-key`);
      visit(item, itemPath);
    }
  }

  visit(value, "");
  return [...new Set(findings)].sort();
}

export function assertNoSecretLeakage(value: unknown, knownSecrets: readonly string[] = []): void {
  const findings = findSecretLeakage(value, knownSecrets);
  if (findings.length > 0) throw new Error(`Secret material is not publishable: ${findings.join(", ")}`);
}
