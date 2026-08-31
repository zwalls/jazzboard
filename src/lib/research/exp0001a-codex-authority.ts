import { createPublicKey, verify as verifyEd25519 } from "node:crypto";

import { z } from "zod";

import { canonicalJson, hashCanonicalJson, SHA256_DIGEST_PATTERN, type JsonValue } from "./provenance-crypto";

export const EXP0001A_CODEX_AUTHORITY_SIGNATURE_VERSION = "exp-0001a-codex-authority-signature/v1" as const;
export const EXP0001A_CODEX_AUTHORITY_KEY_ID = "exp0001a-launch-authority-2026-08-30" as const;
export const EXP0001A_CODEX_AUTHORITY_PUBLIC_KEY_DIGEST =
  "sha256:6fdb285e74644254c72c0e58b098bb1f7d9f8091dc861f830750e89464e503de" as const;
export const EXP0001A_CODEX_AUTHORITY_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAUZAwZF98QVsVG2ZzKS7T0aONXtiQOK5/clo0X0kdghw=
-----END PUBLIC KEY-----
` as const;
export const EXP0001A_CODEX_AUTHORITY_SIGNATURE_DOMAIN = "Jazzboard EXP-0001A Codex authority v1\0" as const;

const digestSchema = z.string().regex(SHA256_DIGEST_PATTERN);
const signatureContentSchema = z.object({
  schemaVersion: z.literal(EXP0001A_CODEX_AUTHORITY_SIGNATURE_VERSION),
  protocolId: z.literal("EXP-0001A"),
  kind: z.literal("codex-authority-signature"),
  algorithm: z.literal("Ed25519"),
  keyId: z.literal(EXP0001A_CODEX_AUTHORITY_KEY_ID),
  publicKeyDigest: z.literal(EXP0001A_CODEX_AUTHORITY_PUBLIC_KEY_DIGEST),
  signedAt: z.string().datetime({ offset: true }),
  purpose: z.enum([
    "spike_gate",
    "prebrief_freeze",
    "coordinator_checkpoint",
    "usage_reset_probe",
    "completion_attestation",
  ]),
  payloadDigest: digestSchema,
}).strict();

export const exp0001aCodexAuthoritySignatureSchema = signatureContentSchema.extend({
  signatureBase64: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
}).strict();
export type Exp0001aCodexAuthoritySignature = z.infer<typeof exp0001aCodexAuthoritySignatureSchema>;

export function exp0001aCodexAuthoritySignatureMessage(
  contentInput: z.input<typeof signatureContentSchema>,
): Buffer {
  const content = signatureContentSchema.parse(contentInput);
  return Buffer.from(`${EXP0001A_CODEX_AUTHORITY_SIGNATURE_DOMAIN}${canonicalJson(content)}`, "utf8");
}

export function verifyExp0001aCodexAuthoritySignature(input: Readonly<{
  payload: JsonValue;
  signature: Exp0001aCodexAuthoritySignature;
  purpose: z.infer<typeof signatureContentSchema>["purpose"];
  notBefore?: string;
}>): Exp0001aCodexAuthoritySignature {
  const signature = exp0001aCodexAuthoritySignatureSchema.parse(input.signature);
  if (signature.purpose !== input.purpose
      || signature.payloadDigest !== hashCanonicalJson(input.payload)) {
    throw new Error("EXP0001A_CODEX_AUTHORITY_PAYLOAD_BINDING_INVALID");
  }
  return verifyExp0001aCodexAuthoritySignatureEnvelope({
    signature,
    purpose: input.purpose,
    notBefore: input.notBefore,
  });
}

/** Verifies the fixed-key signature envelope when an intentionally redacted
 * public projection retains only the signed payload digest, not private bytes. */
export function verifyExp0001aCodexAuthoritySignatureEnvelope(input: Readonly<{
  signature: Exp0001aCodexAuthoritySignature;
  purpose: z.infer<typeof signatureContentSchema>["purpose"];
  notBefore?: string;
}>): Exp0001aCodexAuthoritySignature {
  const signature = exp0001aCodexAuthoritySignatureSchema.parse(input.signature);
  if (signature.purpose !== input.purpose) {
    throw new Error("EXP0001A_CODEX_AUTHORITY_PURPOSE_INVALID");
  }
  if (input.notBefore !== undefined
      && Date.parse(signature.signedAt) < Date.parse(z.string().datetime({ offset: true }).parse(input.notBefore))) {
    throw new Error("EXP0001A_CODEX_AUTHORITY_SIGNATURE_PREDATES_EVIDENCE");
  }
  const { signatureBase64, ...content } = signature;
  const publicKey = createPublicKey(EXP0001A_CODEX_AUTHORITY_PUBLIC_KEY_PEM);
  if (publicKey.asymmetricKeyType !== "ed25519"
      || !verifyEd25519(
        null,
        exp0001aCodexAuthoritySignatureMessage(content),
        publicKey,
        Buffer.from(signatureBase64, "base64"),
      )) {
    throw new Error("EXP0001A_CODEX_AUTHORITY_SIGNATURE_INVALID");
  }
  return Object.freeze(signature);
}
