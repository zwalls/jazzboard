import { z } from "zod";

import {
  hashCanonicalJson,
  SHA256_DIGEST_PATTERN,
  type JsonValue,
} from "./provenance-crypto";

const digestSchema = z.string().regex(SHA256_DIGEST_PATTERN);
const timestampSchema = z.string().datetime({ offset: true });

export const EXP0001A_QUALIFICATION_V3_BINDING_PATH =
  "research/data/exp0001a-model-role-qualification-launch-binding-v3.json" as const;
export const EXP0001A_QUALIFICATION_V3_BINDING_SIGNATURE_PATH =
  "research/data/exp0001a-model-role-qualification-launch-binding-signature-v3.json" as const;
export const EXP0001A_QUALIFICATION_V2_PREDECESSOR_BINDING_DIGEST =
  "sha256:4efb96a5bb2a0e49f6e6c17782a4b5b290b3ff540e8ea6f9fc8cd34afd546272" as const;
export const EXP0001A_QUALIFICATION_V2_PREDECESSOR_BINDING_SIGNATURE_DIGEST =
  "sha256:bb824d77b067262a7ca0ef65c3b8b4bb7d7d3106bb8ff5717eb55513d561c267" as const;

const qualificationV3ProductionBindingContentSchema = z.object({
  schemaVersion: z.literal("exp-0001a-qualification-production-binding/v3"),
  planDigest: digestSchema,
  planDeclaredSuccessorCommit: z.literal("88919b8e0070fbd1b2be4f3e4121cfdcf50638a6"),
  predecessorPlanBytesMutated: z.literal(false),
  supersessionReason: z.literal("production_commit_4eb6d98_and_baseline_freeze_v3"),
  predecessorProductionBinding: z.object({
    schemaVersion: z.literal("exp-0001a-qualification-production-binding/v2"),
    bindingPath: z.literal("research/data/exp0001a-model-role-qualification-launch-binding-v2.json"),
    bindingDigest: z.literal(EXP0001A_QUALIFICATION_V2_PREDECESSOR_BINDING_DIGEST),
    authoritySignaturePath: z.literal(
      "research/data/exp0001a-model-role-qualification-launch-binding-signature-v2.json",
    ),
    authoritySignatureDigest: z.literal(
      EXP0001A_QUALIFICATION_V2_PREDECESSOR_BINDING_SIGNATURE_DIGEST,
    ),
  }).strict(),
  baselineReceiptSchema: z.literal("baseline-freeze/v3"),
  baselineFreezeDigest: digestSchema,
  baselineAuthoritySignatureDigest: digestSchema,
  productionCommit: z.literal("4eb6d9862cd1e805906a338d524529b6b7019639"),
  productionTree: z.literal("100447743f672f103d9cbe7c8c3d6d48e2bca4eb"),
  deploymentId: z.literal("dpl_CePet5gs1u52rMvQUGye92qByJAQ"),
  buildId: z.literal("bld_nuf9lecj0"),
  productionAlias: z.literal("https://www.jazzboard.xyz"),
  toolContractDigests: z.object({
    landing: digestSchema,
    participant: digestSchema,
    spectator: digestSchema,
  }).strict(),
  verifiedAt: timestampSchema,
  aliasAndContractDriftObserved: z.literal(false),
  semanticExportPreflightPassed: z.literal(true),
  exactRevisionPngPreflightPassed: z.literal(true),
  browserWebMcpContractPassed: z.literal(true),
}).strict();

export const qualificationV3ProductionBindingSchema =
  qualificationV3ProductionBindingContentSchema.extend({ bindingDigest: digestSchema }).strict()
    .superRefine((binding, context) => {
  const { bindingDigest: _bindingDigest, ...content } = binding;
  void _bindingDigest;
  if (hashCanonicalJson(content as unknown as JsonValue) !== binding.bindingDigest) {
    context.addIssue({
      code: "custom",
      path: ["bindingDigest"],
      message: "Production binding digest is invalid.",
    });
  }
    });

export type QualificationV3ProductionBinding = z.infer<
  typeof qualificationV3ProductionBindingSchema
>;

export function sealQualificationV3ProductionBinding(input: unknown) {
  const content = qualificationV3ProductionBindingContentSchema.parse(input);
  return Object.freeze(qualificationV3ProductionBindingSchema.parse({
    ...content,
    bindingDigest: hashCanonicalJson(content as unknown as JsonValue),
  }));
}
