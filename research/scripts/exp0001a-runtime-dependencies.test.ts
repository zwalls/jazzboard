// @vitest-environment node

import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const modulePath: string = "./exp0001a-runtime-dependencies.mjs";
const {
  EXP0001A_FORBIDDEN_RUNTIME_ENVIRONMENT,
  EXP0001A_RUNTIME_DEPENDENCY_COMPONENT_IDS,
  assertExp0001aRuntimeEnvironmentOverridesAbsent,
  captureExp0001aRuntimeDependencyReceipt,
  parseExp0001aRuntimeDependencyReceipt,
  verifyExp0001aCriticalRuntimeDependencies,
  verifyExp0001aRuntimeDependencies,
} = await import(modulePath);

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "exp0001a-runtime-dependencies-")));
  roots.push(root);
  const locations: Array<{ id: string; kind: "file" | "tree"; absolutePath: string; version: string }> = [];
  for (const id of EXP0001A_RUNTIME_DEPENDENCY_COMPONENT_IDS as readonly string[]) {
    const absolutePath = path.join(root, id);
    if (id === "nodeExecutable") {
      await writeFile(absolutePath, "trusted-node", { mode: 0o755, flag: "wx" });
      locations.push({ id, kind: "file", absolutePath, version: "22.22.0" });
      continue;
    }
    await mkdir(path.join(absolutePath, "lib"), { recursive: true });
    await writeFile(path.join(absolutePath, "package.json"), JSON.stringify({ name: id, version: "1.0.0" }), { flag: "wx" });
    await writeFile(path.join(absolutePath, "lib", "runtime.js"), `export const id = ${JSON.stringify(id)};\n`, { flag: "wx" });
    await writeFile(path.join(absolutePath, "README.txt"), "non-runtime documentation\n", { flag: "wx" });
    if (id === "chromiumRuntime") {
      const executable = path.join(absolutePath, "lib", "Chromium");
      await writeFile(executable, "chromium-binary", { mode: 0o755, flag: "wx" });
      await chmod(executable, 0o755);
      await symlink("lib/Chromium", path.join(absolutePath, "current"));
    }
    locations.push({ id, kind: "tree", absolutePath, version: "1.0.0" });
  }
  const host = {
    nodeVersion: "22.22.0",
    platform: "darwin",
    architecture: "arm64",
    operatingSystemBuild: "25G83",
  };
  const { receipt, verificationDurationMs } = await captureExp0001aRuntimeDependencyReceipt({
    locations,
    host,
    capturedAt: "2026-08-30T20:00:00.000Z",
  });
  return { root, locations, host, receipt, verificationDurationMs };
}

describe("EXP-0001A runtime dependency receipt", () => {
  it("publishes only logical IDs and exact roots, then reproduces complete and critical bytes", async () => {
    const value = await fixture();
    expect(value.verificationDurationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(value.receipt)).not.toContain(value.root);
    expect(JSON.stringify(value.receipt)).not.toContain(os.homedir());
    expect(value.receipt.components.map((component: { id: string }) => component.id))
      .toEqual(EXP0001A_RUNTIME_DEPENDENCY_COMPONENT_IDS);

    await expect(verifyExp0001aRuntimeDependencies(value)).resolves.toMatchObject({
      receiptDigest: value.receipt.receiptDigest,
      componentSetRoot: value.receipt.componentSetRoot,
      verificationScope: "complete",
    });
    await expect(verifyExp0001aCriticalRuntimeDependencies(value)).resolves.toMatchObject({
      receiptDigest: value.receipt.receiptDigest,
      verificationScope: "critical-load-and-executable-subset",
    });
  });

  it("rejects critical code tamper in both the launch and per-attempt checks", async () => {
    const value = await fixture();
    const playwright = value.locations.find((location) => location.id === "playwrightPackage");
    if (!playwright) throw new Error("Fixture lacks playwrightPackage.");
    await writeFile(path.join(playwright.absolutePath, "lib", "runtime.js"), "export const compromised = true;\n");
    await expect(verifyExp0001aRuntimeDependencies(value)).rejects.toThrow(/complete tree differs/i);
    await expect(verifyExp0001aCriticalRuntimeDependencies(value)).rejects.toThrow(/critical.*differs/i);
  });

  it("rejects a non-code artifact mutation in the complete launch verification", async () => {
    const value = await fixture();
    const sharp = value.locations.find((location) => location.id === "sharpPackage");
    if (!sharp) throw new Error("Fixture lacks sharpPackage.");
    await writeFile(path.join(sharp.absolutePath, "README.txt"), "mutated after capture\n");
    await expect(verifyExp0001aRuntimeDependencies(value)).rejects.toThrow(/complete tree differs/i);
  });

  it("rejects omitted, duplicated, reordered, and self-consistently forged components", async () => {
    const value = await fixture();
    type MutableReceipt = { components: Array<{ treeRoot: string }> };
    const mutations: Array<(receipt: MutableReceipt) => void> = [
      (receipt) => { receipt.components.pop(); },
      (receipt) => { receipt.components[1] = structuredClone(receipt.components[0]!); },
      (receipt) => { [receipt.components[0], receipt.components[1]] = [receipt.components[1]!, receipt.components[0]!]; },
      (receipt) => { receipt.components[0]!.treeRoot = `sha256:${"0".repeat(64)}`; },
    ];
    for (const mutate of mutations) {
      const forged = structuredClone(value.receipt);
      mutate(forged);
      expect(() => parseExp0001aRuntimeDependencyReceipt(forged)).toThrow(/invalid|root|digest/i);
    }
  });

  it("rejects component-root and escaping-symlink attacks", async () => {
    const value = await fixture();
    const chromium = value.locations.find((location) => location.id === "chromiumRuntime");
    if (!chromium) throw new Error("Fixture lacks chromiumRuntime.");
    await symlink("../../outside", path.join(chromium.absolutePath, "escape"));
    await expect(captureExp0001aRuntimeDependencyReceipt({
      locations: value.locations,
      host: value.host,
      capturedAt: "2026-08-30T20:01:00.000Z",
    })).rejects.toThrow(/symlink escapes/i);
  });

  it("fails closed on runtime resolution environment overrides", () => {
    for (const name of EXP0001A_FORBIDDEN_RUNTIME_ENVIRONMENT as readonly string[]) {
      expect(() => assertExp0001aRuntimeEnvironmentOverridesAbsent({ [name]: "attacker-controlled" }))
        .toThrow(new RegExp(name));
    }
    expect(() => assertExp0001aRuntimeEnvironmentOverridesAbsent({})).not.toThrow();
  });

  it.runIf(process.platform === "darwin" && process.arch === "arm64")(
    "matches the checked-in logical receipt against this exact local runtime",
    async () => {
      const receiptPath = path.join(process.cwd(), "research/data/exp0001a-runtime-dependencies-v1.json");
      const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
      const runtime = await import(modulePath);
      const context = await runtime.resolveFixedExp0001aRuntimeDependencyContext(process.cwd());
      const result = await verifyExp0001aRuntimeDependencies({ receipt, ...context });
      expect(result.verificationScope).toBe("complete");
      expect(result.verificationDurationMs).toBeGreaterThan(0);
    },
  );
});
