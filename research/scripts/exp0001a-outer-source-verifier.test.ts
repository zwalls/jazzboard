// @vitest-environment node

import { createHash } from "node:crypto";
import { link, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error committed ESM verifier intentionally has no declarations
import { verifyExp0001aOuterExecutionSourceCommitments } from "./exp0001a-outer-source-verifier.mjs";

const roots: string[] = [];
const digest = (bytes: Buffer | string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("EXP-0001A outer execution source verifier", () => {
  it("accepts only the exact committed nofollow plain source bytes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "exp0001a-outer-source-"));
    roots.push(root);
    await writeFile(path.join(root, "runner.mjs"), "export const value = 1;\n");
    const freeze = { outerExecution: { sourceCommitments: [
      { path: "runner.mjs", digest: digest("export const value = 1;\n") },
    ] } };
    await expect(verifyExp0001aOuterExecutionSourceCommitments({ freeze, repositoryRoot: root }))
      .resolves.toMatchObject({ sourceCount: 1 });
    await writeFile(path.join(root, "runner.mjs"), "export const value = 2;\n");
    await expect(verifyExp0001aOuterExecutionSourceCommitments({ freeze, repositoryRoot: root }))
      .rejects.toThrow(/DIGEST_DRIFT/);
  });

  it("rejects traversal, symlinks, hardlinks, duplicates, and malformed digests", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "exp0001a-outer-source-adversarial-"));
    roots.push(root);
    await writeFile(path.join(root, "source.mjs"), "safe\n");
    await symlink(path.join(root, "source.mjs"), path.join(root, "link.mjs"));
    await link(path.join(root, "source.mjs"), path.join(root, "hardlink.mjs"));
    for (const sourceCommitments of [
      [{ path: "../outside.mjs", digest: digest("safe\n") }],
      [{ path: "link.mjs", digest: digest("safe\n") }],
      [{ path: "hardlink.mjs", digest: digest("safe\n") }],
      [{ path: "source.mjs", digest: digest("safe\n") }, { path: "source.mjs", digest: digest("safe\n") }],
      [{ path: "source.mjs", digest: `sha256:${"0".repeat(63)}` }],
    ]) {
      await expect(verifyExp0001aOuterExecutionSourceCommitments({
        freeze: { outerExecution: { sourceCommitments } }, repositoryRoot: root,
      })).rejects.toThrow(/OUTER_SOURCE/);
    }
  });
});
