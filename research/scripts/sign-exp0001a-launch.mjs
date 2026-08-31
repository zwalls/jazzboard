#!/usr/bin/env node

/**
 * RETIRED EXP-0001A provider-era launch signer.
 *
 * The active experiment uses fresh ChatGPT-authenticated, projectless Codex
 * tasks and deliberately has no dollar-denominated spend authorization. Keep
 * this fail-closed tombstone so an old command, automation, or copied runbook
 * cannot mint a provider-billed launch authorization.
 */

export const EXP0001A_RETIRED_LAUNCH_SIGNER_ERROR =
  "EXP0001A_CODEX_NATIVE_SUBSCRIPTION_TRANSPORT_REQUIRED";

export function rejectRetiredExp0001aProviderLaunchSigner() {
  throw new Error(EXP0001A_RETIRED_LAUNCH_SIGNER_ERROR);
}

function main() {
  rejectRetiredExp0001aProviderLaunchSigner();
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
