import { createPublicKey, verify as verifyEd25519 } from "node:crypto";

import { z } from "zod";

import {
  canonicalJson,
  hashCanonicalJson,
  SHA256_DIGEST_PATTERN,
  type JsonValue,
} from "./provenance-crypto";

export const BASELINE_FREEZE_V2_AUTHORITY_SIGNATURE_VERSION =
  "baseline-freeze-v2-authority-signature/v1" as const;
export const BASELINE_FREEZE_V2_AUTHORITY_KEY_ID =
  "exp0001a-launch-authority-2026-08-30" as const;
export const BASELINE_FREEZE_V2_AUTHORITY_KEY_PURPOSE = "baseline_freeze_v2" as const;
export const BASELINE_FREEZE_V2_AUTHORITY_PUBLIC_KEY_PATH =
  "research/data/exp0001a-execution-authority-public.pem" as const;
export const BASELINE_FREEZE_V2_AUTHORITY_PUBLIC_KEY_DIGEST =
  "sha256:6fdb285e74644254c72c0e58b098bb1f7d9f8091dc861f830750e89464e503de" as const;
export const BASELINE_FREEZE_V2_AUTHORITY_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAUZAwZF98QVsVG2ZzKS7T0aONXtiQOK5/clo0X0kdghw=
-----END PUBLIC KEY-----
` as const;
export const BASELINE_FREEZE_V2_AUTHORITY_SIGNATURE_DOMAIN =
  "Jazzboard EXP-0001A baseline freeze authority v2\0" as const;

const digestSchema = z.string().regex(SHA256_DIGEST_PATTERN);

export const baselineFreezeV2AuthoritySignatureContentSchema = z.object({
  schemaVersion: z.literal(BASELINE_FREEZE_V2_AUTHORITY_SIGNATURE_VERSION),
  protocolId: z.literal("EXP-0001A"),
  kind: z.literal("baseline-freeze-authority-signature"),
  algorithm: z.literal("Ed25519"),
  keyId: z.literal(BASELINE_FREEZE_V2_AUTHORITY_KEY_ID),
  keyPurpose: z.literal(BASELINE_FREEZE_V2_AUTHORITY_KEY_PURPOSE),
  publicKeyPath: z.literal(BASELINE_FREEZE_V2_AUTHORITY_PUBLIC_KEY_PATH),
  publicKeyDigest: z.literal(BASELINE_FREEZE_V2_AUTHORITY_PUBLIC_KEY_DIGEST),
  signedAt: z.string().datetime({ offset: true }),
  payloadSchema: z.literal("baseline-freeze/v2"),
  payloadDigest: digestSchema,
}).strict();

export const baselineFreezeV2AuthoritySignatureSchema =
  baselineFreezeV2AuthoritySignatureContentSchema.extend({
    signatureBase64: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
  }).strict();

export type BaselineFreezeV2AuthoritySignature = z.infer<
  typeof baselineFreezeV2AuthoritySignatureSchema
>;

export function baselineFreezeV2AuthoritySignatureMessage(
  input: z.input<typeof baselineFreezeV2AuthoritySignatureContentSchema>,
): Buffer {
  const content = baselineFreezeV2AuthoritySignatureContentSchema.parse(input);
  return Buffer.from(
    `${BASELINE_FREEZE_V2_AUTHORITY_SIGNATURE_DOMAIN}${canonicalJson(content)}`,
    "utf8",
  );
}

export function verifyBaselineFreezeV2AuthoritySignature(input: Readonly<{
  receipt: JsonValue;
  signature: unknown;
  notBefore?: string;
}>): BaselineFreezeV2AuthoritySignature {
  const signature = baselineFreezeV2AuthoritySignatureSchema.parse(input.signature);
  if (signature.payloadDigest !== hashCanonicalJson(input.receipt)) {
    throw new Error("BASELINE_FREEZE_V2_AUTHORITY_PAYLOAD_BINDING_INVALID");
  }
  if (input.notBefore !== undefined
      && Date.parse(signature.signedAt) < Date.parse(z.string().datetime({ offset: true }).parse(input.notBefore))) {
    throw new Error("BASELINE_FREEZE_V2_AUTHORITY_SIGNATURE_PREDATES_FREEZE");
  }
  const { signatureBase64, ...content } = signature;
  const publicKey = createPublicKey(BASELINE_FREEZE_V2_AUTHORITY_PUBLIC_KEY_PEM);
  if (publicKey.asymmetricKeyType !== "ed25519"
      || !verifyEd25519(
        null,
        baselineFreezeV2AuthoritySignatureMessage(content),
        publicKey,
        Buffer.from(signatureBase64, "base64"),
      )) {
    throw new Error("BASELINE_FREEZE_V2_AUTHORITY_SIGNATURE_INVALID");
  }
  return Object.freeze(signature);
}
