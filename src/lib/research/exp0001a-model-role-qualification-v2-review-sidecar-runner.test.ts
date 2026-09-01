// @vitest-environment node

import { chmod, mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertQualificationV2ReviewSidecarStateRoot,
  resolveQualificationV2ReviewSidecarPrivatePaths,
} from "./exp0001a-model-role-qualification-v2-review-sidecar-runner";

async function fixture() {
  const repositoryRoot = await realpath(
    await mkdtemp(path.join(tmpdir(), "qualification-review-sidecar-root-")),
  );
  const privateParent = path.join(repositoryRoot, ".research-private");
  const v2Root = path.join(privateParent, "exp0001a-qualification-v2");
  const v3Root = path.join(privateParent, "exp0001a-qualification-v3");
  await mkdir(v2Root, { recursive: true, mode: 0o700 });
  await mkdir(v3Root, { recursive: true, mode: 0o700 });
  await chmod(privateParent, 0o700);
  await chmod(v2Root, 0o700);
  await chmod(v3Root, 0o700);

  async function retained(root: string, name: string) {
    const filePath = path.join(root, name);
    await writeFile(filePath, "{}\n", { mode: 0o600 });
    return filePath;
  }
  const v2State = await retained(v2Root, "state.json");
  const v2Semantic = await retained(v2Root, "semantic.json");
  const v2Png = await retained(v2Root, "evidence.png");
  const v2RequestPath = await retained(v2Root, "request.json");
  const v3State = await retained(v3Root, "state.json");
  const semantic = await retained(v3Root, "semantic.json");
  const png = await retained(v3Root, "evidence.png");
  const requestPath = await retained(v3Root, "request.json");
  return {
    repositoryRoot, v2Root, v3Root, v2State, v2Semantic, v2Png, v2RequestPath,
    v3State, semantic, png, requestPath,
  };
}

function request(input: Awaited<ReturnType<typeof fixture>>) {
  return {
    operation: "serve_review_evidence" as const,
    statePath: input.v3State,
    sanitizedSemanticStatePath: input.semantic,
    exactRevisionPngPath: input.png,
    outputDirectory: path.join(input.v3Root, "review-output"),
    at: "2026-09-01T22:30:00.000Z",
  };
}

describe("qualification review-sidecar private-root selection", () => {
  it("selects the v3 private root for a v3 coordinator binding", async () => {
    const item = await fixture();
    const resolved = await resolveQualificationV2ReviewSidecarPrivatePaths({
      repositoryRoot: item.repositoryRoot,
      requestPath: item.requestPath,
      request: request(item),
    });
    expect(resolved).toMatchObject({
      privateRootVersion: "v3",
      privateRoot: item.v3Root,
      statePath: item.v3State,
      semanticPath: item.semantic,
      pngPath: item.png,
      outputDirectory: path.join(item.v3Root, "review-output"),
    });
    expect(() => assertQualificationV2ReviewSidecarStateRoot({
      productionBinding: { schemaVersion: "exp-0001a-qualification-production-binding/v3" },
    } as Parameters<typeof assertQualificationV2ReviewSidecarStateRoot>[0], "v3")).not.toThrow();
  });

  it("preserves v2 path and binding-to-root selection and rejects a mixed state/root", async () => {
    const item = await fixture();
    const resolved = await resolveQualificationV2ReviewSidecarPrivatePaths({
      repositoryRoot: item.repositoryRoot,
      requestPath: item.v2RequestPath,
      request: {
        operation: "serve_review_evidence",
        statePath: item.v2State,
        sanitizedSemanticStatePath: item.v2Semantic,
        exactRevisionPngPath: item.v2Png,
        outputDirectory: path.join(item.v2Root, "review-output"),
        at: "2026-09-01T22:30:00.000Z",
      },
    });
    expect(resolved).toMatchObject({ privateRootVersion: "v2", privateRoot: item.v2Root });
    expect(() => assertQualificationV2ReviewSidecarStateRoot({
      productionBinding: { schemaVersion: "exp-0001a-qualification-production-binding/v2" },
    } as Parameters<typeof assertQualificationV2ReviewSidecarStateRoot>[0], "v2")).not.toThrow();
    expect(() => assertQualificationV2ReviewSidecarStateRoot({
      productionBinding: { schemaVersion: "exp-0001a-qualification-production-binding/v3" },
    } as Parameters<typeof assertQualificationV2ReviewSidecarStateRoot>[0], "v2"))
      .toThrow("QUALIFICATION_V2_REVIEW_SIDECAR_STATE_ROOT_MISMATCH");
  });

  it("rejects an evidence request that crosses from the v3 root into v2", async () => {
    const item = await fixture();
    await expect(resolveQualificationV2ReviewSidecarPrivatePaths({
      repositoryRoot: item.repositoryRoot,
      requestPath: item.requestPath,
      request: { ...request(item), statePath: item.v2State },
    })).rejects.toThrow("QUALIFICATION_V2_REVIEW_SIDECAR_PATH_NOT_PRIVATE");
  });

  it("rejects a symlink that escapes the selected v3 realpath root", async () => {
    const item = await fixture();
    const symlinked = path.join(item.v3Root, "state-link.json");
    await symlink(item.v2State, symlinked);
    await expect(resolveQualificationV2ReviewSidecarPrivatePaths({
      repositoryRoot: item.repositoryRoot,
      requestPath: item.requestPath,
      request: { ...request(item), statePath: symlinked },
    })).rejects.toThrow("QUALIFICATION_V2_REVIEW_SIDECAR_PATH_NOT_PRIVATE");
  });
});
