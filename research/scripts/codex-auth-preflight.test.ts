// @vitest-environment node

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

const preflightModulePath: string = "./codex-auth-preflight.mjs";
const {
  assertCodexNativeExperimentAuthorized,
  canonicalJson,
  classifyCodexLoginStatus,
  CODEX_CHATGPT_APP_EXECUTABLE,
  createCodexAuthPreflightReceipt,
  invokeCodexLoginStatus,
  runCodexAuthPreflight,
  verifyCodexAuthPreflightReceipt,
} = await import(preflightModulePath);

const checkedAt = "2026-08-30T20:00:00.000Z";

function observation(overrides: Record<string, unknown> = {}) {
  return {
    stdout: "Logged in using ChatGPT\n",
    stderr: "",
    exitCode: 0,
    signal: null,
    invocationError: false,
    outputLimitExceeded: false,
    ...overrides,
  };
}

describe("Codex ChatGPT authentication preflight", () => {
  it("accepts only the exact successful ChatGPT status and emits an immutable, credential-free receipt", () => {
    const receipt = createCodexAuthPreflightReceipt(observation(), { checkedAt });

    expect(receipt).toMatchObject({
      schemaVersion: "codex-chatgpt-auth-preflight/v1",
      checkedAt,
      command: { executable: "codex", arguments: ["login", "status"] },
      authentication: {
        method: "chatgpt",
        accountIdentifier: { observability: "unobservable", value: null },
        subscriptionPlan: { observability: "unobservable", value: null },
      },
      decision: { allowCodexNativeExperiment: true, reasonCode: "CHATGPT_AUTHENTICATED" },
      observation: { rawOutputRetained: false },
    });
    expect(receipt.receiptSha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.authentication)).toBe(true);
    expect(Object.isFrozen(receipt.command.arguments)).toBe(true);
    expect(() => assertCodexNativeExperimentAuthorized(receipt)).not.toThrow();
    expect(canonicalJson(receipt)).not.toContain("Logged in using ChatGPT");
  });

  it("accepts the supported CLI's restricted-environment warning framing", () => {
    const receipt = createCodexAuthPreflightReceipt(observation({
      stdout: "",
      stderr: "WARNING: proceeding, even though we could not create PATH aliases: Operation not permitted (os error 1)\nLogged in using ChatGPT\n",
    }), { checkedAt });

    expect(receipt.authentication.method).toBe("chatgpt");
    expect(receipt.decision.allowCodexNativeExperiment).toBe(true);
  });

  it("rejects API-key authentication with a stable hard-failure code", () => {
    const receipt = createCodexAuthPreflightReceipt(
      observation({ stdout: "Logged in using an API key\n" }),
      { checkedAt },
    );

    expect(receipt.authentication.method).toBe("api_key");
    expect(receipt.decision).toEqual({
      allowCodexNativeExperiment: false,
      reasonCode: "API_KEY_AUTHENTICATION_FORBIDDEN",
    });
    expect(() => assertCodexNativeExperimentAuthorized(receipt)).toThrow(/CODEX_CHATGPT_AUTH_REQUIRED/);
  });

  it.each([
    "prefix Logged in using ChatGPT\n",
    "Logged in using ChatGPT suffix\n",
    "\u001b[32mLogged in using ChatGPT\u001b[0m\n",
    "Logged in using ChatGPT\nLogged in using an API key\n",
    "Logged in using ChatGPT\n\n",
    "logged in using chatgpt\n",
    "WARNING: Logged in using an API key\nLogged in using ChatGPT\n",
  ])("rejects adversarial or ambiguous successful-looking output: %j", (stdout) => {
    expect(classifyCodexLoginStatus(observation({ stdout }))).toEqual({
      method: "unknown",
      allowed: false,
      reasonCode: "AUTH_METHOD_UNKNOWN",
    });
  });

  it("rejects failed, signaled, invocation-error, and oversized observations", () => {
    expect(classifyCodexLoginStatus(observation({ exitCode: 1 }))).toMatchObject({
      allowed: false,
      reasonCode: "AUTH_STATUS_COMMAND_FAILED",
    });
    expect(classifyCodexLoginStatus(observation({ signal: "SIGTERM" }))).toMatchObject({
      allowed: false,
      reasonCode: "AUTH_STATUS_COMMAND_FAILED",
    });
    expect(classifyCodexLoginStatus(observation({ invocationError: true }))).toMatchObject({
      method: "unobservable",
      allowed: false,
      reasonCode: "AUTH_STATUS_COMMAND_ERROR",
    });
    expect(classifyCodexLoginStatus(observation({ outputLimitExceeded: true }))).toMatchObject({
      allowed: false,
      reasonCode: "AUTH_STATUS_OUTPUT_LIMIT",
    });
  });

  it("never retains raw command output or invocation errors in evidence", () => {
    const secret = "sk-do-not-retain-this-value";
    const receipt = createCodexAuthPreflightReceipt(
      observation({ stdout: secret, stderr: `failure: ${secret}`, invocationError: true }),
      { checkedAt },
    );

    const serialized = canonicalJson(receipt);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("failure:");
    expect(receipt.observation.stdoutSha256.value).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(receipt.observation.stderrSha256.value).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("verifies the complete retained receipt and rejects digest, shape, and decision forgery", () => {
    const receipt = createCodexAuthPreflightReceipt(observation(), { checkedAt });
    expect(verifyCodexAuthPreflightReceipt(receipt)).toBe(receipt);

    expect(() => verifyCodexAuthPreflightReceipt({
      ...receipt,
      receiptSha256: `sha256:${"0".repeat(64)}`,
    })).toThrow(/DIGEST_INVALID/);
    expect(() => verifyCodexAuthPreflightReceipt({
      ...receipt,
      rawOutput: "credential-bearing output",
    })).toThrow(/RECEIPT_INVALID/);
    expect(() => verifyCodexAuthPreflightReceipt({
      ...receipt,
      authentication: { ...receipt.authentication, method: "api_key" },
    })).toThrow(/INCONSISTENT|DIGEST_INVALID/);
  });

  it("invokes only `codex login status` without a shell and parses the result", async () => {
    const spawnImpl = vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        kill: ReturnType<typeof vi.fn>;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn();
      queueMicrotask(() => {
        child.stdout.write("Logged in using ChatGPT\n");
        child.stdout.end();
        child.stderr.end();
        child.emit("close", 0, null);
      });
      return child;
    });

    const observed = await invokeCodexLoginStatus({ spawn: spawnImpl, timeoutMs: 1000 });
    expect(spawnImpl).toHaveBeenCalledWith(CODEX_CHATGPT_APP_EXECUTABLE, ["login", "status"], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(observed).toMatchObject({ stdout: "Logged in using ChatGPT\n", exitCode: 0, invocationError: false });

    const receipt = await runCodexAuthPreflight({ invoke: async () => observed, checkedAt });
    expect(receipt.decision.allowCodexNativeExperiment).toBe(true);
  });

  it("refuses PATH aliases and caller-selected Codex executables", async () => {
    await expect(invokeCodexLoginStatus({
      executable: "/tmp/codex",
      spawn: vi.fn(),
    })).rejects.toThrow(/refuses PATH or caller-selected executables/i);
  });
});
