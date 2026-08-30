# EXP-0000 Amendment 1 — Supplemental token-budget calibration

- Amendment version: 1
- Status: preregistered; supplemental brief not delivered
- Parent protocol: `research/protocols/exp-0000-live-author-smoke.md` (version 1, unchanged)
- Partition: development
- Supplemental attempt ID: `smoke-exp0000-checkout-solmax-v2`
- Frozen runner config: `research/data/exp-0000-run-config-v2.json`
- Final runner-config file SHA-256:
  `sha256:fb7b08b62ed8da156b94634ffe118ced119e1143372d82518140a71b8e5de9f2`
- Canonical JSON SHA-256:
  `sha256:dfc1884328ebdeb381950a7f9f4a130a5540805d17c73d6a29b1dbd894817146`
- Authorized runner script SHA-256:
  `sha256:c2cbeaf5b216a5699b7e7fcc88326ff78763988d33943256f8eb193112426c24`
- Pre-execution live-contract receipt file SHA-256:
  `sha256:d71dc2052428ac644ad09361358c65d4832823c2cc98ddb04773732f190716fd`
- Sealed data permitted: none

This digest was recorded after finalizing the v2 config and before brief
delivery or execution. The file SHA-256 commits to the exact checked-in bytes;
the canonical digest independently commits to the parsed JSON value.

## Purpose and interpretation

This is a supplemental infrastructure and resource-budget calibration attempt,
not a replacement for the original attempt and not a harness-improvement test.
It asks whether the same frozen author condition and task can complete when only
the cumulative input, cumulative output, and per-response output ceilings are
raised. The original v1 attempt and all of its evidence remain immutable.

The amendment cannot support a claim about product quality, task success rate,
model superiority, scorer accuracy, A/A bias, or harness improvement. A
different v1/v2 outcome is descriptive only because the attempts are stochastic
and the resource ceilings differ.

## Preregistered permitted differences

The v2 config must differ from v1 at exactly these four root fields:

| Field | v1 | v2 |
| --- | ---: | ---: |
| `attemptId` | `smoke-exp0000-checkout-solmax-v1` | `smoke-exp0000-checkout-solmax-v2` |
| `inputTokenBudget` | 80,000 | 150,000 |
| `outputTokenBudget` | 12,000 | 40,000 |
| `perResponseMaxOutputTokens` | 4,000 | 20,000 |

Every other byte-equivalent parsed field remains fixed, including the exact
public brief, task, model (`gpt-5.6-sol`), reasoning effort (`max`), tool
allowlist and order, participant and spectator contract hashes, product origin,
wall-time budget, tool-call budget, per-tool timeout, browser-origin policy,
actor labels, setup/event plans, and headless setting. Sampling remains at the
provider defaults declared by the parent protocol.

## Measurement-only runner amendment

Before this supplemental brief was delivered, the clean-room runner was
changed solely to retain provenance fields already returned by the provider.
Each completed response now records sanitized `model` and `service_tier`
values, and the author summary reports the unique observed values plus whether
every completed turn supplied them. Response IDs, credentials, encrypted
reasoning, and arbitrary provider payload fields remain excluded. The author
instructions, model request, reasoning setting, tool registry, room workflow,
browser behavior, budgets, stopping rules, and model-visible conversation are
unchanged.

This non-treatment instrumentation change replaces the parent protocol's
runner-script digest only for supplemental v2. Historical v1 artifacts remain
bound to runner digest
`sha256:03ab941fcf2663ed713b19258ae5e81f0dd581098fd5b3dff88a8b2c59584f04`
and are not rewritten. V2 execution requires a fresh contract-only receipt
binding the authorized runner digest above to unchanged participant and
spectator tool-contract hashes before its brief is delivered.

That required check completed as contract-only attempt
`contract-prod-baseline-v6` before supplemental execution. It made zero
Responses API calls, reverified the 54-tool participant digest
`sha256:d64cf3d25b9e275003438597b3b01c35419063d71613082d45aaf2f97c388b8e`
and 18-tool spectator digest
`sha256:1760c6b1ec8cc4d8814b3de6a8f4516b3f4c215da69069c50072f23128541be2`,
and produced attempt-bundle digest
`sha256:b2a5ee97e285ac6ee6cd99d3912e3a73f4f3acc8f1f56ec8e03ae66cec7c7dff`
with artifact root
`sha256:9f4676e385dbc0b40b72a4216f2d4183fa87a74839bf76e6545f2849fb63fd26`.

## Execution and retention rules

Before execution, recompute both recorded config digests and run the
permitted-difference test. The parent protocol's authenticated Vercel alias
preflight, live-contract checks, clean-room isolation, evidence requirements,
hard stops, and classification rules apply unchanged. Any mismatch stops the
attempt before brief delivery.

Once the v2 brief is delivered, every timeout, refusal, no-op, malformed call,
provider failure, product failure, or runner failure is retained under the v2
attempt ID. The v2 record supplements rather than overwrites or reruns v1. No
sealed, validation, or evaluator-only content may be accessed to prepare or
interpret this attempt.
