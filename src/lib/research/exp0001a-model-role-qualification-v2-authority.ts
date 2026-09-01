import { createPublicKey, verify as verifyEd25519 } from "node:crypto";

import { z } from "zod";

import {
  canonicalJson,
  hashCanonicalJson,
  SHA256_DIGEST_PATTERN,
  type JsonValue,
} from "./provenance-crypto";

export const EXP0001A_QUALIFICATION_V2_AUTHORITY_SIGNATURE_VERSION =
  "exp-0001a-model-role-qualification-authority-signature/v2" as const;
export const EXP0001A_QUALIFICATION_V2_AUTHORITY_KEY_ID =
  "exp0001a-launch-authority-2026-08-30" as const;
export const EXP0001A_QUALIFICATION_V2_AUTHORITY_PUBLIC_KEY_DIGEST =
  "sha256:6fdb285e74644254c72c0e58b098bb1f7d9f8091dc861f830750e89464e503de" as const;
export const EXP0001A_QUALIFICATION_V2_AUTHORITY_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAUZAwZF98QVsVG2ZzKS7T0aONXtiQOK5/clo0X0kdghw=
-----END PUBLIC KEY-----
` as const;
export const EXP0001A_QUALIFICATION_V2_AUTHORITY_SIGNATURE_DOMAIN =
  "Jazzboard EXP-0001A model-role qualification authority v2\0" as const;

const digestSchema = z.string().regex(SHA256_DIGEST_PATTERN);

const qualificationAuthoritySignatureContentSchema = z.object({
  schemaVersion: z.literal(EXP0001A_QUALIFICATION_V2_AUTHORITY_SIGNATURE_VERSION),
  protocolId: z.literal("EXP-0001A-MODEL-ROLE-QUALIFICATION-V2"),
  kind: z.literal("model-role-qualification-authority-signature"),
  algorithm: z.literal("Ed25519"),
  keyId: z.literal(EXP0001A_QUALIFICATION_V2_AUTHORITY_KEY_ID),
  publicKeyDigest: z.literal(EXP0001A_QUALIFICATION_V2_AUTHORITY_PUBLIC_KEY_DIGEST),
  signedAt: z.string().datetime({ offset: true }),
  purpose: z.enum(["qualification_plan", "qualification_launch_binding", "qualification_result"]),
  payloadDigest: digestSchema,
}).strict();

export const exp0001aQualificationV2AuthoritySignatureSchema =
  qualificationAuthoritySignatureContentSchema.extend({
    signatureBase64: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
  }).strict();

export type Exp0001aQualificationV2AuthoritySignature = z.infer<
  typeof exp0001aQualificationV2AuthoritySignatureSchema
>;

export function exp0001aQualificationV2AuthoritySignatureMessage(
  input: z.input<typeof qualificationAuthoritySignatureContentSchema>,
): Buffer {
  const content = qualificationAuthoritySignatureContentSchema.parse(input);
  return Buffer.from(
    `${EXP0001A_QUALIFICATION_V2_AUTHORITY_SIGNATURE_DOMAIN}${canonicalJson(content)}`,
    "utf8",
  );
}

export function verifyExp0001aQualificationV2AuthoritySignature(input: Readonly<{
  payload: JsonValue;
  signature: Exp0001aQualificationV2AuthoritySignature;
  purpose: "qualification_plan" | "qualification_launch_binding" | "qualification_result";
  notBefore?: string;
}>): Exp0001aQualificationV2AuthoritySignature {
  const signature = exp0001aQualificationV2AuthoritySignatureSchema.parse(input.signature);
  if (signature.purpose !== input.purpose
      || signature.payloadDigest !== hashCanonicalJson(input.payload)) {
    throw new Error("QUALIFICATION_V2_AUTHORITY_PAYLOAD_BINDING_INVALID");
  }
  if (input.notBefore !== undefined
      && Date.parse(signature.signedAt) < Date.parse(z.string().datetime({ offset: true }).parse(input.notBefore))) {
    throw new Error("QUALIFICATION_V2_AUTHORITY_SIGNATURE_PREDATES_EVIDENCE");
  }
  const { signatureBase64, ...content } = signature;
  const publicKey = createPublicKey(EXP0001A_QUALIFICATION_V2_AUTHORITY_PUBLIC_KEY_PEM);
  if (publicKey.asymmetricKeyType !== "ed25519"
      || !verifyEd25519(
        null,
        exp0001aQualificationV2AuthoritySignatureMessage(content),
        publicKey,
        Buffer.from(signatureBase64, "base64"),
      )) {
    throw new Error("QUALIFICATION_V2_AUTHORITY_SIGNATURE_INVALID");
  }
  return Object.freeze(signature);
}
