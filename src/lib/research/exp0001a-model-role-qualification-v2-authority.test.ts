// @vitest-environment node

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { exp0001aModelRoleQualificationV2PlanSchema } from "./exp0001a-model-role-qualification-v2";
import {
  exp0001aQualificationV2AuthoritySignatureSchema,
  verifyExp0001aQualificationV2AuthoritySignature,
} from "./exp0001a-model-role-qualification-v2-authority";
import { qualificationV2ProductionBindingSchema } from "./exp0001a-model-role-qualification-v2-coordinator";
import type { JsonValue } from "./provenance-crypto";

describe("EXP-0001A qualification-v2 authority", () => {
  it("verifies the checked-in prospective plan signature", () => {
    const plan = exp0001aModelRoleQualificationV2PlanSchema.parse(JSON.parse(readFileSync(
      "research/data/exp0001a-model-role-qualification-plan-v2.json",
      "utf8",
    )));
    const signature = exp0001aQualificationV2AuthoritySignatureSchema.parse(JSON.parse(readFileSync(
      "research/data/exp0001a-model-role-qualification-plan-signature-v2.json",
      "utf8",
    )));
    expect(verifyExp0001aQualificationV2AuthoritySignature({
      payload: plan as unknown as JsonValue,
      signature,
      purpose: "qualification_plan",
      notBefore: plan.frozenAt,
    })).toEqual(signature);
  });

  it("rejects payload and purpose substitution", () => {
    const plan = JSON.parse(readFileSync(
      "research/data/exp0001a-model-role-qualification-plan-v2.json",
      "utf8",
    ));
    const signature = JSON.parse(readFileSync(
      "research/data/exp0001a-model-role-qualification-plan-signature-v2.json",
      "utf8",
    ));
    expect(() => verifyExp0001aQualificationV2AuthoritySignature({
      payload: { ...plan, classification: "changed" },
      signature,
      purpose: "qualification_plan",
    })).toThrow("PAYLOAD_BINDING_INVALID");
    expect(() => verifyExp0001aQualificationV2AuthoritySignature({
      payload: plan,
      signature,
      purpose: "qualification_result",
    })).toThrow("PAYLOAD_BINDING_INVALID");
  });

  it("verifies the prospective successor launch binding without changing plan bytes", () => {
    const binding = qualificationV2ProductionBindingSchema.parse(JSON.parse(readFileSync(
      "research/data/exp0001a-model-role-qualification-launch-binding-v2.json",
      "utf8",
    )));
    const signature = exp0001aQualificationV2AuthoritySignatureSchema.parse(JSON.parse(readFileSync(
      "research/data/exp0001a-model-role-qualification-launch-binding-signature-v2.json",
      "utf8",
    )));
    expect(binding).toMatchObject({
      predecessorPlanBytesMutated: false,
      productionCommit: "66a546aaef9e006891a4cf619ed310fd9fc1c4cc",
      baselineFreezeDigest: "sha256:e5568148fa6175bfb59692422da3785920b2beebc127bbab4da804e1362cbd68",
    });
    expect(verifyExp0001aQualificationV2AuthoritySignature({
      payload: binding as unknown as JsonValue,
      signature,
      purpose: "qualification_launch_binding",
      notBefore: binding.verifiedAt,
    })).toEqual(signature);
  });
});
