#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  deriveExp0036ImmutableIsolationCalibrationV2,
  evaluateExp0036AttemptAdmissionV2,
  evaluateExp0036InfrastructurePreflightV2,
  signExp0036AdmissionV2Input,
} from "./exp0036-admission-v2.mjs";

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    if (!rest[index]?.startsWith("--") || rest[index + 1] === undefined) {
      throw new Error(`Invalid EXP0036 v2 builder argument ${rest[index] ?? ""}.`);
    }
    values[rest[index].slice(2)] = rest[index + 1];
  }
  return { command, values };
}

async function jsonFile(filePath) {
  return JSON.parse(await readFile(path.resolve(filePath), "utf8"));
}

async function writeNewJson(filePath, value) {
  await writeFile(path.resolve(filePath), `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
}

export async function runExp0036AdmissionV2Builder(argv) {
  const { command, values } = parseArgs(argv);
  if (!values.output) throw new Error("EXP0036 v2 builder requires --output.");
  if (command === "derive-calibration") {
    const config = await jsonFile(values.config);
    const result = deriveExp0036ImmutableIsolationCalibrationV2({
      ...config,
      probeA: { ...config.probeA, receipt: await jsonFile(config.probeA.receiptPath) },
      probeB: { ...config.probeB, receipt: await jsonFile(config.probeB.receiptPath) },
    });
    await writeNewJson(values.output, result);
    return { command, output: path.resolve(values.output), payloadSha256: result.payloadSha256 };
  }
  if (!["sign-infrastructure", "sign-admission"].includes(command)) {
    throw new Error("EXP0036 v2 builder command must be derive-calibration, sign-infrastructure, or sign-admission.");
  }
  const input = await jsonFile(values.input);
  const privateKeyPem = await readFile(path.resolve(values["private-key"]), "utf8");
  const kind = command === "sign-infrastructure"
    ? "infrastructure_preflight_v2_attestation" : "attempt_admission_v2_attestation";
  const signed = signExp0036AdmissionV2Input(input, {
    kind,
    signedAt: values["signed-at"],
    privateKeyPem,
  });
  const options = { now: values.now, maxAgeMs: Number(values["max-age-ms"] ?? 60_000) };
  const decision = command === "sign-infrastructure"
    ? evaluateExp0036InfrastructurePreflightV2(signed, options)
    : evaluateExp0036AttemptAdmissionV2(signed, {
      ...options,
      taskWindowMs: Number(values["task-window-ms"] ?? 15 * 60_000),
    });
  const accepted = command === "sign-infrastructure"
    ? decision.decision === "task_creation_ready"
    : decision.decision === "post_creation_evidence_complete";
  if (!accepted) throw new Error(`EXP0036 v2 evidence blocked: ${decision.reasons.join(", ")}`);
  await writeNewJson(values.output, { signed, decision });
  return { command, output: path.resolve(values.output), decision: decision.decision,
    payloadSha256: decision.payloadSha256 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runExp0036AdmissionV2Builder(process.argv.slice(2)).then(
    (result) => console.log(JSON.stringify(result)),
    (error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; },
  );
}
