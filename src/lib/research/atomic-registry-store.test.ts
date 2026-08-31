// @vitest-environment node

import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createAtomicRegistryStore } from "./atomic-registry-store";
import { canonicalJson, hashCanonicalJson } from "./provenance-crypto";

const contentSchema = z.object({ schemaVersion: z.literal(1), sequence: z.number().int().nonnegative() }).strict();
const registrySchema = contentSchema.extend({ identity: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict();
type Registry = z.infer<typeof registrySchema>;

const temporaryRoots: string[] = [];

function registry(sequence: number): Registry {
  const content = { schemaVersion: 1 as const, sequence };
  return { ...content, identity: hashCanonicalJson(content) };
}

async function temporaryFile(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "jazzboard-registry-store-"));
  temporaryRoots.push(root);
  return path.join(root, "registry.json");
}

function store(filePath: string) {
  return createAtomicRegistryStore({
    filePath,
    validate: (input) => {
      const parsed = registrySchema.parse(input);
      const content = { schemaVersion: parsed.schemaVersion, sequence: parsed.sequence };
      if (hashCanonicalJson(content) !== parsed.identity) throw new Error("Registry self-hash is invalid.");
      return parsed;
    },
    identity: (value) => value.identity,
    now: () => "2026-08-31T00:00:00.000Z",
  });
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("atomic registry store", () => {
  it("creates a private durable registry and idempotently reads the same identity", async () => {
    const filePath = await temporaryFile();
    const registryStore = store(filePath);

    await expect(registryStore.initialize(registry(0))).resolves.toEqual(registry(0));
    await expect(registryStore.initialize(registry(0))).resolves.toEqual(registry(0));
    await expect(registryStore.read()).resolves.toEqual(registry(0));
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    await expect(registryStore.initialize(registry(1))).rejects.toThrow(/differs/);
  });

  it("replaces only the exact expected identity and rejects stale or redundant writes", async () => {
    const filePath = await temporaryFile();
    const registryStore = store(filePath);
    const first = await registryStore.initialize(registry(0));

    await expect(registryStore.persist(registry(1), first.identity)).resolves.toEqual(registry(1));
    expect(await readFile(filePath, "utf8")).toBe(canonicalJson(registry(1)));
    await expect(registryStore.persist(registry(2), first.identity)).rejects.toThrow(/changed/);
    await expect(registryStore.persist(registry(1), registry(1).identity)).rejects.toThrow(/redundant/);
    await expect(registryStore.read()).resolves.toEqual(registry(1));
  });

  it("fails closed for an existing lock, tampered JSON, or a symbolic-link registry", async () => {
    const filePath = await temporaryFile();
    const registryStore = store(filePath);
    await registryStore.initialize(registry(0));

    await writeFile(`${filePath}.lock`, "uncertain prior writer");
    await expect(registryStore.persist(registry(1), registry(0).identity)).rejects.toThrow(/lock already exists/);
    await rm(`${filePath}.lock`);

    await writeFile(filePath, JSON.stringify({ ...registry(0), sequence: 99 }));
    await expect(registryStore.read()).rejects.toThrow(/self-hash/);

    const linkPath = path.join(path.dirname(filePath), "linked-registry.json");
    await symlink(filePath, linkPath);
    await expect(store(linkPath).read()).rejects.toThrow();
  });

  it("rejects relative paths and invalid identities before touching disk", async () => {
    expect(() => store("registry.json")).toThrow(/absolute/);
    const filePath = await temporaryFile();
    const unsafe = createAtomicRegistryStore({
      filePath,
      validate: () => ({ identity: "not-a-digest" }),
      identity: (value) => value.identity,
    });
    await expect(unsafe.initialize({})).rejects.toThrow(/SHA-256/);
  });

  it("treats the immutable hash-chained journal as authority and rejects journal recreation or extra evidence", async () => {
    const filePath = await temporaryFile();
    const registryStore = store(filePath);
    await registryStore.initialize(registry(0));
    await registryStore.persist(registry(1), registry(0).identity);

    // A crash or attacker can roll back the replaceable convenience snapshot,
    // but cannot make it authoritative over the retained append-only head.
    await writeFile(filePath, `${JSON.stringify(registry(0))}\n`, "utf8");
    await expect(registryStore.read()).resolves.toEqual(registry(1));
    await expect(registryStore.initialize(registry(0))).resolves.toEqual(registry(1));
    await expect(registryStore.read()).resolves.toEqual(registry(1));

    const journalDirectory = `${filePath}.journal`;
    await writeFile(path.join(journalDirectory, "unexpected.json"), "{}", "utf8");
    await expect(registryStore.read()).rejects.toThrow(/unexpected entries/i);
    await rm(path.join(journalDirectory, "unexpected.json"));
    await rm(journalDirectory, { recursive: true });
    await expect(registryStore.read()).rejects.toThrow(/journal is missing/i);
  });
});
