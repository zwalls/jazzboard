import { z } from "zod";

import { hashCanonicalJson, sha256Digest, SHA256_DIGEST_PATTERN } from "./provenance-crypto";

export const EXP0001A_PER_ATTEMPT_ALIAS_VERIFIER_SOURCE_PATH =
  "src/lib/research/exp0001a-per-attempt-alias-verifier.ts" as const;

const digest = z.string().regex(SHA256_DIGEST_PATTERN);
const timestamp = z.string().datetime({ offset: true });
const contentSchema = z.object({
  schemaVersion: z.literal("exp-0001a-per-attempt-alias-verification/v1"),
  protocolId: z.literal("EXP-0001A"),
  attemptId: z.string().min(1).max(160),
  manifestPosition: z.number().int().min(0).max(47),
  alias: z.literal("https://www.jazzboard.xyz"),
  expectedDeploymentId: z.string().regex(/^dpl_[A-Za-z0-9]+$/),
  resolvedDeploymentId: z.string().regex(/^dpl_[A-Za-z0-9]+$/),
  method: z.literal("authenticated-vercel-api-immediately-before-brief"),
  releaseGateRequestedAt: timestamp,
  releaseGateInvocationDigest: digest,
  verifiedAt: timestamp,
  providerResponseDigest: digest,
}).strict();

export const exp0001aPerAttemptAliasReceiptSchema = contentSchema.extend({ receiptDigest: digest }).strict();
export type Exp0001aPerAttemptAliasReceipt = z.infer<typeof exp0001aPerAttemptAliasReceiptSchema>;

export type Exp0001aPerAttemptAliasVerifier = (input: {
  attemptId: string;
  manifestPosition: number;
  expectedDeploymentId: string;
  releaseGateRequestedAt: string;
  releaseGateRegistryDigest: string;
}) => Promise<Exp0001aPerAttemptAliasReceipt>;

export function computeExp0001aReleaseGateInvocationDigest(input: {
  attemptId: string;
  manifestPosition: number;
  expectedDeploymentId: string;
  releaseGateRequestedAt: string;
  releaseGateRegistryDigest: string;
}): string {
  const parsed = z.object({
    attemptId: z.string().min(1).max(160),
    manifestPosition: z.number().int().min(0).max(47),
    expectedDeploymentId: z.string().regex(/^dpl_[A-Za-z0-9]+$/),
    releaseGateRequestedAt: timestamp,
    releaseGateRegistryDigest: digest,
  }).strict().parse(input);
  return hashCanonicalJson({
    schemaVersion: "exp-0001a-release-gate-invocation/v1",
    protocolId: "EXP-0001A",
    ...parsed,
  });
}

export function computeExp0001aPerAttemptAliasReceiptDigest(receipt: Exp0001aPerAttemptAliasReceipt): string {
  const { receiptDigest: _ignored, ...content } = receipt;
  void _ignored;
  return hashCanonicalJson(content);
}

export function verifyExp0001aPerAttemptAliasReceipt(
  input: unknown,
  expected: {
    attemptId: string;
    manifestPosition: number;
    deploymentId: string;
    releaseGateRequestedAt: string;
    releaseGateRegistryDigest: string;
  },
): Exp0001aPerAttemptAliasReceipt {
  const receipt = exp0001aPerAttemptAliasReceiptSchema.parse(input);
  const expectedInvocationDigest = computeExp0001aReleaseGateInvocationDigest({
    attemptId: expected.attemptId,
    manifestPosition: expected.manifestPosition,
    expectedDeploymentId: expected.deploymentId,
    releaseGateRequestedAt: expected.releaseGateRequestedAt,
    releaseGateRegistryDigest: expected.releaseGateRegistryDigest,
  });
  if (computeExp0001aPerAttemptAliasReceiptDigest(receipt) !== receipt.receiptDigest
      || receipt.attemptId !== expected.attemptId
      || receipt.manifestPosition !== expected.manifestPosition
      || receipt.expectedDeploymentId !== expected.deploymentId
      || receipt.resolvedDeploymentId !== expected.deploymentId
      || receipt.releaseGateRequestedAt !== expected.releaseGateRequestedAt
      || receipt.releaseGateInvocationDigest !== expectedInvocationDigest
      || Date.parse(receipt.verifiedAt) < Date.parse(receipt.releaseGateRequestedAt)) {
    throw new Error("Per-attempt alias receipt is invalid or the production alias drifted from the frozen deployment.");
  }
  return receipt;
}

export function createAuthenticatedVercelAliasVerifier(input: {
  token: string;
  now?: () => string;
  fetch?: typeof fetch;
}): Exp0001aPerAttemptAliasVerifier {
  if (!input.token.trim()) throw new Error("Authenticated Vercel alias verification requires VERCEL_TOKEN.");
  const request = input.fetch ?? fetch;
  const now = input.now ?? (() => new Date().toISOString());
  return async (expected) => {
    const response = await request("https://api.vercel.com/v13/deployments/www.jazzboard.xyz", {
      method: "GET",
      headers: { authorization: `Bearer ${input.token}`, accept: "application/json" },
      redirect: "error",
    });
    const bytes = await response.text();
    if (!response.ok) throw new Error(`Authenticated Vercel alias verification failed (${response.status}).`);
    let raw: unknown;
    try { raw = JSON.parse(bytes); } catch { throw new Error("Vercel alias response was not JSON."); }
    const resolvedDeploymentId = z.object({ id: z.string().regex(/^dpl_[A-Za-z0-9]+$/) }).passthrough().parse(raw).id;
    const content = contentSchema.parse({
      schemaVersion: "exp-0001a-per-attempt-alias-verification/v1",
      protocolId: "EXP-0001A",
      attemptId: expected.attemptId,
      manifestPosition: expected.manifestPosition,
      alias: "https://www.jazzboard.xyz",
      expectedDeploymentId: expected.expectedDeploymentId,
      resolvedDeploymentId,
      method: "authenticated-vercel-api-immediately-before-brief",
      releaseGateRequestedAt: expected.releaseGateRequestedAt,
      releaseGateInvocationDigest: computeExp0001aReleaseGateInvocationDigest(expected),
      verifiedAt: now(),
      providerResponseDigest: sha256Digest(bytes),
    });
    return exp0001aPerAttemptAliasReceiptSchema.parse({
      ...content,
      receiptDigest: hashCanonicalJson(content),
    });
  };
}
