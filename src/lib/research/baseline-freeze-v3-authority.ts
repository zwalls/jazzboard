import { createPublicKey, verify as verifyEd25519 } from "node:crypto";

import { z } from "zod";

import {
  canonicalJson,
  hashCanonicalJson,
  SHA256_DIGEST_PATTERN,
  type JsonValue,
} from "./provenance-crypto";

export const BASELINE_FREEZE_V3_AUTHORITY_SIGNATURE_VERSION =
  "baseline-freeze-v3-authority-signature/v1" as const;
export const BASELINE_FREEZE_V3_AUTHORITY_KEY_PURPOSE = "baseline_freeze_v3" as const;
export const BASELINE_FREEZE_V3_AUTHORITY_KEY_ID = "exp0001a-launch-authority-2026-08-30" as const;
export const BASELINE_FREEZE_V3_AUTHORITY_PUBLIC_KEY_PATH =
  "research/data/exp0001a-execution-authority-public.pem" as const;
export const BASELINE_FREEZE_V3_AUTHORITY_PUBLIC_KEY_DIGEST =
  "sha256:6fdb285e74644254c72c0e58b098bb1f7d9f8091dc861f830750e89464e503de" as const;
export const BASELINE_FREEZE_V3_AUTHORITY_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAUZAwZF98QVsVG2ZzKS7T0aONXtiQOK5/clo0X0kdghw=
-----END PUBLIC KEY-----
` as const;
export const BASELINE_FREEZE_V3_AUTHORITY_SIGNATURE_DOMAIN =
  "Jazzboard baseline freeze v3 authority\0" as const;

const digestSchema = z.string().regex(SHA256_DIGEST_PATTERN);

const signatureContentSchema = z.object({
  schemaVersion: z.literal(BASELINE_FREEZE_V3_AUTHORITY_SIGNATURE_VERSION),
  kind: z.literal("baseline-freeze-authority-signature"),
  algorithm: z.literal("Ed25519"),
  keyId: z.literal(BASELINE_FREEZE_V3_AUTHORITY_KEY_ID),
  publicKeyDigest: z.literal(BASELINE_FREEZE_V3_AUTHORITY_PUBLIC_KEY_DIGEST),
  signedAt: z.string().datetime({ offset: true }),
  keyPurpose: z.literal(BASELINE_FREEZE_V3_AUTHORITY_KEY_PURPOSE),
  payloadSchema: z.literal("baseline-freeze/v3"),
  payloadDigest: digestSchema,
}).strict();

export const baselineFreezeV3AuthoritySignatureSchema = signatureContentSchema.extend({
  signatureBase64: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
}).strict();

export type BaselineFreezeV3AuthoritySignature = z.infer<
  typeof baselineFreezeV3AuthoritySignatureSchema
>;

export function baselineFreezeV3AuthoritySignatureMessage(
  input: z.input<typeof signatureContentSchema>,
): Buffer {
  return Buffer.from(
    `${BASELINE_FREEZE_V3_AUTHORITY_SIGNATURE_DOMAIN}${canonicalJson(signatureContentSchema.parse(input))}`,
    "utf8",
  );
}

export function verifyBaselineFreezeV3AuthoritySignature(input: Readonly<{
  receipt: JsonValue;
  signature: BaselineFreezeV3AuthoritySignature;
  notBefore?: string;
}>): BaselineFreezeV3AuthoritySignature {
  const signature = baselineFreezeV3AuthoritySignatureSchema.parse(input.signature);
  if (signature.payloadDigest !== hashCanonicalJson(input.receipt)) {
    throw new Error("BASELINE_V3_AUTHORITY_PAYLOAD_BINDING_INVALID");
  }
  if (input.notBefore !== undefined
      && Date.parse(signature.signedAt) < Date.parse(z.string().datetime({ offset: true }).parse(input.notBefore))) {
    throw new Error("BASELINE_V3_AUTHORITY_SIGNATURE_PREDATES_EVIDENCE");
  }
  const { signatureBase64, ...content } = signature;
  const publicKey = createPublicKey(BASELINE_FREEZE_V3_AUTHORITY_PUBLIC_KEY_PEM);
  if (publicKey.asymmetricKeyType !== "ed25519"
      || !verifyEd25519(
        null,
        baselineFreezeV3AuthoritySignatureMessage(content),
        publicKey,
        Buffer.from(signatureBase64, "base64"),
      )) {
    throw new Error("BASELINE_V3_AUTHORITY_SIGNATURE_INVALID");
  }
  return Object.freeze(signature);
}
