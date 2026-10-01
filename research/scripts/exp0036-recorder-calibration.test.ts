// @vitest-environment node

import { describe, expect, it } from "vitest";

const modulePath: string = "./exp0036-recorder-calibration.mjs";
const {
  EXP0036_RECORDER_CALIBRATION_SCHEMA_VERSION,
  runExp0036RecorderCalibration,
} = await import(modulePath);

describe("EXP-0036 recorder calibration", () => {
  it("calibrates the generated adapter and collector without making native-browser claims", async () => {
    const result = await runExp0036RecorderCalibration({
      samples: 2,
      warmups: 1,
      targetOutputJsonUtf8Bytes: 2_048,
    });

    expect(result).toMatchObject({
      schemaVersion: EXP0036_RECORDER_CALIBRATION_SCHEMA_VERSION,
      classification: "synthetic_node_esm_generated_adapter_and_loopback_collector",
      claims: {
        nativeBrowserWebMcpMeasured: false,
        authorOutcomeMeasured: false,
        agentSpeedMeasured: false,
        collectorNetworkExcludedFromWrappedCompletion: true,
      },
      settings: {
        samples: 2,
        warmups: 1,
        targetOutputJsonUtf8Bytes: 2_048,
        alternatingOrder: true,
      },
      proof: {
        recordedInvocationCount: 3,
        rejectedEventCount: 0,
        rejectedAuxiliaryRequestCount: 0,
        gapCount: 0,
        collectorSealComplete: true,
      },
    });
    expect(result.timing.baselineExecutor.count).toBe(2);
    expect(result.timing.generatedAdapterCompletion.count).toBe(2);
    expect(result.timing.pairedAddedCompletionCost.count).toBe(2);
    expect(result.timing.collectorAckAfterCompletion.count).toBe(2);
    expect(result.proof.acceptedEventCount).toBe(10);
    expect(result.proof.terminalLedgerJsonSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.proof.collectorReceiptSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
