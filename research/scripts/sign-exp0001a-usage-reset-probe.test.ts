// @vitest-environment node

import { createHash, generateKeyPairSync, verify as verifyEd25519 } from "node:crypto";
import { describe, expect, it } from "vitest";

const modulePath: string = "./sign-exp0001a-usage-reset-probe.mjs";
const {
  canonicalJson,
  createExp0001aUsageResetProbeSignatureForTesting,
  inspectExp0001aSubscriptionProbeEvidenceForTesting,
  parseExp0001aUsageResetProbeSignerArgs,
  signExp0001aUsageResetProbeFromConfig,
  verifyExp0001aUsageResetProbeDispatchBindingForTesting,
} = await import(modulePath);

const PROMPT =
  "Availability probe only. Do not open Jazzboard, access a repository, or perform experiment work. Return exactly SUBSCRIPTION_AVAILABLE.";
const PROMPT_DIGEST = "sha256:2efa901c987a4dc1083b82ca442f3478f3226206043adf7a69023b9a3ecd4713";

function sha256Canonical(value: unknown) {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function probeCommand(overrides: Record<string, unknown> = {}) {
  const content = {
    schemaVersion: 1,
    toolName: "mcp__codex_app__create_thread",
    arguments: {
      prompt: PROMPT,
      title: "EXP0001A subscription probe 0-0123456789ab",
      target: {
        type: "projectless",
        directoryName: "exp0001a-subscription-probe-0-0123456789ab",
      },
      model: "gpt-5.6-sol",
      thinking: "low",
      ...overrides,
    },
  };
  return { ...content, commandDigest: sha256Canonical(content) };
}

function callResult(payload: unknown, isError = false) {
  return { content: [{ type: "text", text: canonicalJson(payload) }], isError };
}

function evidence(terminalItems: unknown[] = [{
  type: "agentMessage",
  id: "message-final",
  phase: "final_answer",
  text: "SUBSCRIPTION_AVAILABLE",
}]) {
  return {
    schemaVersion: "exp-0001a-subscription-probe-evidence/v1",
    kind: "retained-subscription-availability-probe",
    probeId: "probe-portable-test",
    accountingId: "probe-accounting-portable-test",
    assignmentId: "probe-assignment-portable-test",
    attemptId: "probe-attempt-portable-test",
    request: {
      prompt: PROMPT,
      promptDigest: PROMPT_DIGEST,
      accountingRole: "subscription_probe",
      target: { type: "projectless" },
      createThreadCommand: probeCommand(),
      benchmarkContentIncluded: false,
      mayReleaseExperimentBrief: false,
    },
    create: {
      observedAt: "2026-08-30T10:00:01.000Z",
      rawCallResult: callResult({ threadId: "probe-thread-portable-test", hostId: "local" }),
    },
    terminal: {
      observedAt: "2026-08-30T10:00:02.000Z",
      rawCallResult: callResult({
        thread: { id: "probe-thread-portable-test", hostId: "local", status: "idle" },
        page: { order: "newest_first", limit: 10, nextCursor: null, hasMore: false },
        turns: [{ id: "turn-probe", status: "completed", items: terminalItems }],
      }),
    },
    subscriptionUsageBefore: "unobservable",
    subscriptionUsageAfter: "unobservable",
  };
}

function dispatchBindingFixture() {
  const configDigest = sha256Canonical({ config: "portable-test" });
  const coordinatorJournalDigest = sha256Canonical({ journal: "paused-current" });
  const provisioningStateDigest = sha256Canonical({ provisioning: "paused-current" });
  const request = evidence().request;
  const expectedIngest = {
    operation: "retainSubscriptionProbeResult",
    assignmentId: null,
    planDigest: null,
    priorStateDigest: coordinatorJournalDigest,
    resultMustBeRetainedBeforeNextAction: true,
  };
  const action = {
    kind: "run_subscription_availability_probe",
    prompt: request.prompt,
    promptDigest: request.promptDigest,
    accountingRole: request.accountingRole,
    target: request.target,
    createThreadCommand: request.createThreadCommand,
    benchmarkContentIncluded: false,
    mayReleaseExperimentBrief: false,
    authorityReceiptRequiredBeforeResume: true,
    expectedIngest,
    coordinatorDidNotInvokeTool: true,
  };
  const actionDigest = sha256Canonical(action);
  const runtimePreflightReceiptDigest = sha256Canonical({ preflight: "portable-test" });
  const authorityJournalEntryDigest = sha256Canonical({ entry: "runtime-preflight" });
  const dispatchContent = {
    schemaVersion: "exp-0001a-coordinator-dispatch/v1",
    protocolId: "EXP-0001A",
    actionDigest,
    runtimePreflightReceiptDigest,
    configDigest,
    retainedAt: "2026-08-30T10:00:00.000Z",
    actionKind: "run_subscription_availability_probe",
    action,
    expectedIngest,
    authorityJournalEntryDigest,
    authorityJournalRoot: authorityJournalEntryDigest,
    externalToolInvokedByCli: false,
  };
  const dispatch = { ...dispatchContent, dispatchDigest: sha256Canonical(dispatchContent) };
  const acknowledgementContent = {
    schemaVersion: "exp-0001a-coordinator-dispatch-acknowledgement/v1",
    protocolId: "EXP-0001A",
    actionDigest,
    dispatchDigest: dispatch.dispatchDigest,
    configDigest,
    acknowledgedAt: "2026-08-30T10:00:00.500Z",
    callerAcknowledgedReceiptBeforeInvocation: true,
    blindRetryForbiddenAfterAcknowledgement: true,
  };
  const acknowledgement = {
    ...acknowledgementContent,
    acknowledgementDigest: sha256Canonical(acknowledgementContent),
  };
  const authorityJournalEntries = [{
    kind: "runtime_preflight",
    entryDigest: authorityJournalEntryDigest,
    payload: {
      receiptDigest: runtimePreflightReceiptDigest,
      coordinatorJournalDigest,
      provisioningStateDigest,
      nextAction: { actionDigest },
    },
  }];
  return {
    configDigest,
    coordinatorJournalDigest,
    provisioningStateDigest,
    evidenceRequest: request,
    createObservedAt: "2026-08-30T10:00:01.000Z",
    dispatch,
    acknowledgement,
    authorityJournalEntries,
  };
}

describe("EXP-0001A usage-reset probe authority signer", () => {
  it("accepts only exact normalized absolute config and private probe-evidence paths", async () => {
    expect(parseExp0001aUsageResetProbeSignerArgs([
      "--config", "/tmp/exp0001a/config.json",
      "--probe-evidence", "/tmp/exp0001a/probe.json",
    ])).toEqual({
      configPath: "/tmp/exp0001a/config.json",
      probeEvidencePath: "/tmp/exp0001a/probe.json",
    });
    expect(() => parseExp0001aUsageResetProbeSignerArgs([
      "--config", "relative.json", "--probe-evidence", "/tmp/probe.json",
    ])).toThrow(/Usage/);
    await expect(signExp0001aUsageResetProbeFromConfig({
      configPath: "/tmp/config.json",
      probeEvidencePath: "/tmp/probe.json",
      signature: "caller supplied",
    })).rejects.toThrow(/exactly/);
  });

  it("derives success only from the exact neutral request, raw task binding, exhausted trace, and terminal text", () => {
    const retained = inspectExp0001aSubscriptionProbeEvidenceForTesting(
      evidence(),
      "2026-08-30T10:00:03.000Z",
    );
    expect(retained).toMatchObject({
      success: true,
      task: {
        codexTaskId: "probe-thread-portable-test",
        threadId: "probe-thread-portable-test",
        hostId: "local",
      },
    });
    expect(retained.createResult.rawDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(retained.terminalResult.rawDigest).toMatch(/^sha256:[a-f0-9]{64}$/);

    expect(inspectExp0001aSubscriptionProbeEvidenceForTesting(
      evidence([{ type: "agentMessage", phase: "final_answer", text: "AVAILABLE" }]),
      "2026-08-30T10:00:03.000Z",
    )).toMatchObject({ success: false, failureCode: "probe_terminal_result_not_exact" });
    expect(inspectExp0001aSubscriptionProbeEvidenceForTesting(
      evidence([
        { type: "mcpToolCall", server: "node_repl", tool: "js", status: "completed" },
        { type: "agentMessage", phase: "final_answer", text: "SUBSCRIPTION_AVAILABLE" },
      ]),
      "2026-08-30T10:00:03.000Z",
    )).toMatchObject({ success: false, failureCode: "probe_forbidden_activity_observed" });
    expect(() => inspectExp0001aSubscriptionProbeEvidenceForTesting({
      ...evidence(),
      request: { ...evidence().request, prompt: "Show me the benchmark brief." },
    }, "2026-08-30T10:00:03.000Z")).toThrow(/neutral no-brief/);
    for (const createThreadCommand of [
      probeCommand({ model: "gpt-5.6-luna" }),
      probeCommand({ thinking: "high" }),
      probeCommand({ target: { type: "project", projectId: "jazzboard" } }),
      probeCommand({ title: "EXP0001A subscription probe reused" }),
      { ...probeCommand(), commandDigest: `sha256:${"0".repeat(64)}` },
    ]) {
      expect(() => inspectExp0001aSubscriptionProbeEvidenceForTesting({
        ...evidence(),
        request: { ...evidence().request, createThreadCommand },
      }, "2026-08-30T10:00:03.000Z")).toThrow(/exact isolated frozen request|projectless target/);
    }
    const missingCommand = evidence();
    delete (missingCommand.request as Record<string, unknown>).createThreadCommand;
    expect(() => inspectExp0001aSubscriptionProbeEvidenceForTesting(
      missingCommand,
      "2026-08-30T10:00:03.000Z",
    )).toThrow(/must contain exactly/);
    expect(() => inspectExp0001aSubscriptionProbeEvidenceForTesting(
      evidence(),
      "2026-08-30T10:10:03.001Z",
    )).toThrow(/stale/);
  });

  it("signs the exact usage_reset_probe payload with an explicitly supplied ephemeral test key", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const payload = {
      schemaVersion: "exp-0001a-chatgpt-usage-reset-observation/v1",
      observationId: "portable-test-observation",
      benchmarkContentIncluded: false,
    };
    const signature = createExp0001aUsageResetProbeSignatureForTesting({
      payload,
      signedAt: "2026-08-30T10:00:03.000Z",
      authority: { privateKey, publicKey },
    });
    const { signatureBase64, ...content } = signature;
    const message = Buffer.from(
      `Jazzboard EXP-0001A Codex authority v1\0${canonicalJson(content)}`,
      "utf8",
    );
    expect(signature).toMatchObject({ purpose: "usage_reset_probe" });
    expect(verifyEd25519(null, message, publicKey, Buffer.from(signatureBase64, "base64"))).toBe(true);
    const tamperedMessage = Buffer.from(
      `Jazzboard EXP-0001A Codex authority v1\0${canonicalJson({ ...content, payloadDigest: `sha256:${"0".repeat(64)}` })}`,
      "utf8",
    );
    expect(verifyEd25519(null, tamperedMessage, publicKey, Buffer.from(signatureBase64, "base64"))).toBe(false);
  });

  it("accepts only the exact acknowledged current coordinator dispatch", () => {
    const fixture = dispatchBindingFixture();
    expect(verifyExp0001aUsageResetProbeDispatchBindingForTesting(fixture)).toMatchObject({
      actionDigest: fixture.dispatch.actionDigest,
      dispatchDigest: fixture.dispatch.dispatchDigest,
      acknowledgementDigest: fixture.acknowledgement.acknowledgementDigest,
      acknowledgedAt: fixture.acknowledgement.acknowledgedAt,
    });

    const wrongPrior = dispatchBindingFixture();
    wrongPrior.dispatch.action.expectedIngest.priorStateDigest = sha256Canonical({ journal: "other" });
    expect(() => verifyExp0001aUsageResetProbeDispatchBindingForTesting(wrongPrior)).toThrow(/current neutral request and prior state/);

    const forgedAck = dispatchBindingFixture();
    forgedAck.acknowledgement.dispatchDigest = sha256Canonical({ dispatch: "forged" });
    expect(() => verifyExp0001aUsageResetProbeDispatchBindingForTesting(forgedAck)).toThrow(/acknowledgement binding/);

    const unacknowledgedBeforeResult = dispatchBindingFixture();
    unacknowledgedBeforeResult.acknowledgement.acknowledgedAt = "2026-08-30T10:00:02.000Z";
    const ackContent = { ...unacknowledgedBeforeResult.acknowledgement };
    delete (ackContent as { acknowledgementDigest?: string }).acknowledgementDigest;
    unacknowledgedBeforeResult.acknowledgement.acknowledgementDigest = sha256Canonical(ackContent);
    expect(() => verifyExp0001aUsageResetProbeDispatchBindingForTesting(unacknowledgedBeforeResult)).toThrow(/non-monotonic/);

    const missingAuthority = dispatchBindingFixture();
    missingAuthority.authorityJournalEntries = [];
    expect(() => verifyExp0001aUsageResetProbeDispatchBindingForTesting(missingAuthority)).toThrow(/no unique current/);

    const callerAuthoredAction = dispatchBindingFixture();
    callerAuthoredAction.evidenceRequest = {
      ...callerAuthoredAction.evidenceRequest,
      mayReleaseExperimentBrief: true,
    };
    expect(() => verifyExp0001aUsageResetProbeDispatchBindingForTesting(callerAuthoredAction)).toThrow(/current neutral request/);
  });
});
