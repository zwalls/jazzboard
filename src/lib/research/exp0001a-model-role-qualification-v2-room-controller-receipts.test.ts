import { describe, expect, it } from "vitest";

import baselineReceiptJson from "../../../research/data/baseline-freeze-v2.json";
import baselineInventoryJson from "../../../research/data/baseline-webmcp-inventory-v2.json";
import {
  parseQualificationV2CaptureControllerReceipt,
  parseQualificationV2ProvisionControllerReceipt,
  sealQualificationV2CaptureControllerReceipt,
  sealQualificationV2ProvisionControllerReceipt,
} from "./exp0001a-model-role-qualification-v2-room-controller-receipts";

const DIGEST = `sha256:${"a".repeat(64)}`;
const deploymentObservations = [
  baselineReceiptJson.deployment.deploymentId,
  baselineReceiptJson.deployment.deploymentId,
] as [string, string];
const runtime = { node: "v24.0.0", platform: "darwin", architecture: "arm64" };
const harnessRuntimeProvenance = {
  controllerBundleDigest: DIGEST,
  wrapperSourceDigest: DIGEST,
  dependencyLockfileDigest: DIGEST,
  gitCommit: "b".repeat(40),
  gitTree: "c".repeat(40),
  worktreeClean: true as const,
};

describe("EXP-0001A qualification-v2 controller receipt authority", () => {
  it("seals and verifies provision evidence without importing the coordinator", () => {
    const receipt = sealQualificationV2ProvisionControllerReceipt({
      schemaVersion: "exp-0001a-qualification-room-controller-provision/v2",
      taskId: "dev-architecture-create-checkout",
      roomReceiptDigest: DIGEST,
      storageStateDigest: DIGEST,
      deploymentId: baselineReceiptJson.deployment.deploymentId,
      deploymentObservations,
      landingToolContractDigest: baselineInventoryJson.landing.contractDigest,
      participantToolContractDigest: baselineInventoryJson.participant.contractDigest,
      playwrightVersion: "1.55.0",
      chromiumVersion: "140.0.0",
      runtime,
      harnessRuntimeProvenance,
      createRoomCallResultDigest: DIGEST,
      blankReadCallResultDigest: DIGEST,
      fixtureTransactionCallResultDigest: null,
      preAuthorReadCallResultDigest: DIGEST,
      frozenFixtureDeclarationDigest: null,
      authoritativeInitialStateDigest: DIGEST,
      initialRoomRevision: 0,
      initialObjectCount: 0,
      retainedAt: "2026-08-31T23:00:00.000Z",
    });
    expect(parseQualificationV2ProvisionControllerReceipt(receipt)).toEqual(receipt);
    expect(() => parseQualificationV2ProvisionControllerReceipt({
      ...receipt,
      initialObjectCount: 1,
    })).toThrow("QUALIFICATION_V2_PROVISION_CONTROLLER_RECEIPT_DIGEST_INVALID");
  });

  it("binds capture evidence to the provision receipt and authorized storage state", () => {
    const receipt = sealQualificationV2CaptureControllerReceipt({
      schemaVersion: "exp-0001a-qualification-room-controller-capture/v2",
      taskId: "dev-drawing-create-wayfinding-icon",
      roomReceiptDigest: DIGEST,
      provisionControllerReceiptDigest: DIGEST,
      storageStateDigest: DIGEST,
      deploymentId: baselineReceiptJson.deployment.deploymentId,
      deploymentObservations,
      participantToolContractDigest: baselineInventoryJson.participant.contractDigest,
      playwrightVersion: "1.55.0",
      chromiumVersion: "140.0.0",
      runtime,
      harnessRuntimeProvenance,
      roomRevision: 7,
      objectCount: 12,
      diagramCount: 0,
      closingReadCallResultDigest: DIGEST,
      inspectionCallResultDigest: DIGEST,
      pngCallResultDigest: DIGEST,
      pngByteDigest: DIGEST,
      pngByteLength: 2048,
      persistedByJazzboard: false,
      retainedAt: "2026-08-31T23:30:00.000Z",
    });
    expect(parseQualificationV2CaptureControllerReceipt(receipt)).toEqual(receipt);
  });
});
