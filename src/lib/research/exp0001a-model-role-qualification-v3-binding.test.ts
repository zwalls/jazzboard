import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import bindingJson from "../../../research/data/exp0001a-model-role-qualification-launch-binding-v3.json";
import signatureJson from "../../../research/data/exp0001a-model-role-qualification-launch-binding-signature-v3.json";
import predecessorBindingJson from "../../../research/data/exp0001a-model-role-qualification-launch-binding-v2.json";
import predecessorSignatureJson from "../../../research/data/exp0001a-model-role-qualification-launch-binding-signature-v2.json";
import {
  exp0001aQualificationV2AuthoritySignatureSchema,
  verifyExp0001aQualificationV2AuthoritySignature,
} from "./exp0001a-model-role-qualification-v2-authority";
import { qualificationV2ProductionBindingSchema } from "./exp0001a-model-role-qualification-v2-coordinator";
import {
  qualificationV3ProductionBindingSchema,
  sealQualificationV3ProductionBinding,
} from "./exp0001a-model-role-qualification-v3-binding";
import { hashCanonicalJson, sha256Digest, type JsonValue } from "./provenance-crypto";

describe("EXP-0001A qualification launch binding v3", () => {
  it("verifies the signed current binding and its immutable v2 predecessor", () => {
    const binding = qualificationV3ProductionBindingSchema.parse(bindingJson);
    const predecessor = qualificationV2ProductionBindingSchema.parse(predecessorBindingJson);
    expect(binding.predecessorProductionBinding.bindingDigest).toBe(predecessor.bindingDigest);
    expect(binding.predecessorProductionBinding.authoritySignatureDigest).toBe(
      hashCanonicalJson(predecessorSignatureJson as unknown as JsonValue),
    );
    expect(verifyExp0001aQualificationV2AuthoritySignature({
      payload: binding as unknown as JsonValue,
      signature: exp0001aQualificationV2AuthoritySignatureSchema.parse(signatureJson),
      purpose: "qualification_launch_binding",
      notBefore: binding.verifiedAt,
    })).toEqual(signatureJson);
    const { bindingDigest: _bindingDigest, ...content } = binding;
    void _bindingDigest;
    expect(sealQualificationV3ProductionBinding(content)).toEqual(binding);
  });

  it("fails closed on current or predecessor binding drift", () => {
    expect(() => qualificationV3ProductionBindingSchema.parse({
      ...bindingJson,
      deploymentId: "dpl_drift",
    })).toThrow();
    expect(() => qualificationV3ProductionBindingSchema.parse({
      ...bindingJson,
      predecessorProductionBinding: {
        ...bindingJson.predecessorProductionBinding,
        bindingDigest: `sha256:${"0".repeat(64)}`,
      },
    })).toThrow();
  });

  it("does not mutate the checked-in v2 binding or signature bytes", () => {
    expect(sha256Digest(readFileSync(
      "research/data/exp0001a-model-role-qualification-launch-binding-v2.json",
    ))).toBe("sha256:019a95d07b140bf356e6e9000ed2d9bed6b6c3cc32f0e2f70e093f57bf8b481c");
    expect(sha256Digest(readFileSync(
      "research/data/exp0001a-model-role-qualification-launch-binding-signature-v2.json",
    ))).toBe("sha256:9daef55a5b5efe8a6400ce67ca82db8aac17bfe4e2be3b9202abce094fae8d4f");
  });
});
