// @vitest-environment node

import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import baselineFreeze from "../../../research/data/baseline-freeze-v1.json";
import baselineInventory from "../../../research/data/baseline-webmcp-inventory-v1.json";
import {
  EXPECTED_BASELINE_FREEZE,
  baselineFreezeReceiptSchema,
  computeBaselineFreezeReceiptDigest,
  findBaselineFreezeSensitiveFields,
  verifyBaselineFreezeReceipt,
  type BaselineFreezeReceipt,
} from "./baseline-freeze";
import { hashCanonicalJson } from "./provenance-crypto";

function receiptClone(): BaselineFreezeReceipt {
  return baselineFreezeReceiptSchema.parse(structuredClone(baselineFreeze));
}

describe("checked-in baseline freeze", () => {
  it("verifies its canonical identity, health body, and WebMCP inventory", () => {
    const verification = verifyBaselineFreezeReceipt(baselineFreeze, baselineInventory);

    expect(verification).toMatchObject({ ok: true });
    expect(computeBaselineFreezeReceiptDigest(receiptClone())).toBe(baselineFreeze.receiptDigest);
    expect(hashCanonicalJson(baselineFreeze.health.body)).toBe(EXPECTED_BASELINE_FREEZE.healthDigest);
    expect(hashCanonicalJson(baselineInventory)).toBe(EXPECTED_BASELINE_FREEZE.inventoryFileDigest);
    expect(baselineInventory.landing).toMatchObject({
      toolCount: EXPECTED_BASELINE_FREEZE.landingToolCount,
      inventoryDigest: EXPECTED_BASELINE_FREEZE.landingInventoryDigest,
    });
    expect(baselineInventory.participant).toMatchObject({
      toolCount: EXPECTED_BASELINE_FREEZE.participantToolCount,
      inventoryDigest: EXPECTED_BASELINE_FREEZE.participantInventoryDigest,
    });
  });

  it("binds the full commit to the exact checked-in Git tree", () => {
    const observedTree = execFileSync(
      "git",
      ["rev-parse", `${EXPECTED_BASELINE_FREEZE.gitCommit}^{tree}`],
      { encoding: "utf8" },
    ).trim();

    expect(observedTree).toBe(EXPECTED_BASELINE_FREEZE.gitTree);
    expect(baselineFreeze.deployment.buildIdentityDigest).toBe(EXPECTED_BASELINE_FREEZE.buildIdentityDigest);
  });

  it("rejects a different commit even when the attacker recomputes the receipt digest", () => {
    const tampered = receiptClone();
    tampered.product.gitCommit = "0".repeat(40);
    tampered.receiptDigest = computeBaselineFreezeReceiptDigest(tampered);

    expect(verifyBaselineFreezeReceipt(tampered, baselineInventory)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringMatching(/Git commit/)]),
    });
  });

  it("rejects health-body tampering by canonical digest", () => {
    const tampered = receiptClone();
    tampered.health.body.capacity.limits.objects += 1;
    tampered.receiptDigest = computeBaselineFreezeReceiptDigest(tampered);

    expect(verifyBaselineFreezeReceipt(tampered, baselineInventory)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringMatching(/canonical health digest/)]),
    });
  });

  it("rejects inventory count, digest, ordering, and file-identity drift", () => {
    const tampered = structuredClone(baselineInventory);
    tampered.landing.toolCount += 1;
    tampered.landing.inventoryDigest = `sha256:${"0".repeat(64)}`;
    [tampered.participant.tools[0], tampered.participant.tools[1]] = [
      tampered.participant.tools[1],
      tampered.participant.tools[0],
    ];

    expect(verifyBaselineFreezeReceipt(baselineFreeze, tampered)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        expect.stringMatching(/landing inventory count/),
        expect.stringMatching(/landing inventory digest/),
        expect.stringMatching(/participant inventory tools are not uniquely sorted/),
        expect.stringMatching(/canonical inventory file digest/),
      ]),
    });
  });

  it("uses strict schemas and rejects unknown fields", () => {
    const tampered = { ...baselineFreeze, unexpected: true };

    expect(baselineFreezeReceiptSchema.safeParse(tampered).success).toBe(false);
    expect(verifyBaselineFreezeReceipt(tampered, baselineInventory)).toMatchObject({ ok: false });
  });

  it("contains no secrets or raw room identifiers", () => {
    expect(findBaselineFreezeSensitiveFields(baselineFreeze)).toEqual([]);
    expect(findBaselineFreezeSensitiveFields({ ...baselineFreeze, evidence: "room_41130bc6-0bf5-842d" }))
      .toContain("/evidence:raw-room-id");
    expect(findBaselineFreezeSensitiveFields({ ...baselineFreeze, sessionToken: "do-not-publish" }))
      .toContain("/sessionToken:secret-key");
    const leakedHealthValue = structuredClone(baselineFreeze);
    (leakedHealthValue.health.body.checks as { sessionSecret: boolean | string }).sessionSecret = "do-not-publish";
    expect(findBaselineFreezeSensitiveFields(leakedHealthValue))
      .toContain("/health/body/checks/sessionSecret:secret-key");
    expect(JSON.stringify(baselineFreeze)).not.toMatch(/room_[A-Za-z0-9_-]{8,}/);
  });
});
