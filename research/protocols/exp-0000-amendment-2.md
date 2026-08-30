# EXP-0000 Amendment 2 — Evidence-capture and usage-accounting diagnostic

- Amendment version: 2
- Status: preregistered; v3 brief not delivered and v3 not executed
- Parent protocol: `research/protocols/exp-0000-live-author-smoke.md` (unchanged)
- Prior amendment: `research/protocols/exp-0000-amendment-1.md` (unchanged)
- Partition: development
- Supplemental attempt ID: `smoke-exp0000-checkout-solmax-v3`
- Frozen runner config: `research/data/exp-0000-run-config-v3.json`
- Final v3 runner-config file SHA-256:
  `sha256:a46f725395f1884ca0551862c8f6eef604967b7068bdc0641010c71fa2423add`
- Final v3 canonical JSON SHA-256:
  `sha256:530a33e0ae1e14f15d25de015899f4854e3ecbd648fa0ce6a5d842f671555cfd`
- Authorized runner SHA-256:
  `sha256:699d803722f6425547246c9a70c7ec96e56ff525043638a6c21f48f94ca5ec12`
- Authorized blinded-evaluator SHA-256:
  `sha256:1888105ca84a46a69f16a1439b704222201f7d04a7bb9afa3d8c87a462c4c5a6`
- Pre-execution live-contract receipt file SHA-256:
  `sha256:799997c344a5525be92824380e8115d65f4c7224aeb6f64f6c3938d607a12cff`
- Sealed data permitted: none

The v3 config digests above were recorded after finalizing the file and before
brief delivery or execution. The byte digest commits to the checked-in file;
the canonical digest independently commits to its parsed JSON value.

## Retained failures and purpose

V3 is a linked measurement diagnostic only. It does not replace, repair,
exclude, or rerun either retained failure:

- [V1 retained attempt bundle](../results/runs/smoke-exp0000-checkout-solmax-v1/attempt-bundle.json)
  remains `FAIL_AUTHOR_NONCOMPLETION`: its final response exhausted the frozen
  4,000-token response limit before mutation. Its attempt-bundle SHA-256 is
  `09b9712819c75ae56a8007c7efd6f3f5a9202eecbe6f1d30298223aa0e39af40`
  and artifact root is
  `4bc20628131328fd8757335d823e282f0a0dcd1dbe5b3ad503f9b8de585d7647a`.
- [V2 retained attempt bundle](../results/runs/smoke-exp0000-checkout-solmax-v2/attempt-bundle.json)
  remains `FAIL_INFRASTRUCTURE`: it committed a candidate, crossed the frozen
  cumulative input limit before closing inspection, and lacked the required
  exact spectator PNG after the research lease-parser defect. Its
  attempt-bundle SHA-256 is
  `c58208cc39a221042faa5faf009f992e9a459c1f5e8d96dd1a37d17188c42640`
  and artifact root is
  `52386ec4de33301051f70ea772d4ebb5874baf7831ed1ddc629242638c6b6fb5`.

The consolidated [EXP-0000 smoke report](../reports/exp-0000-smoke-v1.md)
remains the authoritative all-attempt account for v1 and v2. If v3 begins, it
is a third retained smoke attempt regardless of outcome. V3 cannot support a
product-quality, task-success-rate, model-superiority, evaluator-accuracy,
causal, equivalence, A/A-bias, or harness-improvement claim.

## Preregistered config difference and budget rationale

V3 differs from v2 at exactly two root fields:

| Field | v2 | v3 |
| --- | ---: | ---: |
| `attemptId` | `smoke-exp0000-checkout-solmax-v2` | `smoke-exp0000-checkout-solmax-v3` |
| `inputTokenBudget` | 150,000 | 400,000 |

The output-token budget remains 40,000 and the per-response output ceiling
remains 20,000. Every other parsed field is byte-equivalent, including the
exact compiler-rendered public brief, task, product origin, model, reasoning
effort, tool allowlist and order, live tool-contract hashes, wall and tool-call
limits, per-tool timeout, browser-origin policy, actor labels, setup/event
plans, and headless setting.

The 400,000-token input ceiling is a diagnostic allowance based on v2's
observed cumulative 184,024 input tokens before the requested closing
inspection could execute. At the frozen standard rates of $4.00 per million
uncached input tokens and $20.00 per million output tokens, treating all input
as uncached gives a conservative nominal amount of $1.60 at the input cap plus
$0.80 at the output cap: $2.40 before any one-turn input overshoot. The runner
learns cumulative input only after a provider response, so the response that
crosses 400,000 may raise the nominal amount above $2.40; no subsequent request
or tool call is allowed after crossing. An exact billed estimate requires v3's
retained cached-input and cache-write details and must not be inferred from the
historical aggregate totals.

## Authorized measurement-only code changes

Runner digest
`sha256:699d803722f6425547246c9a70c7ec96e56ff525043638a6c21f48f94ca5ec12`
is authorized only for the already-tested measurement changes below, together
with v2's previously authorized provider-identity retention:

1. parse pixel-lease expiry as either a safe numeric epoch-millisecond value or
   a valid ISO timestamp, normalize it to ISO, and reject invalid or expired
   values;
2. validate and retain provider `cached_tokens`, `cache_write_tokens`, and
   `reasoning_tokens` details by turn and cumulatively; and
3. keep reasoning tokens within reported output totals rather than double
   counting them.

These changes do not alter the author brief, system instructions, Responses
request model or reasoning effort, sampling defaults, tools or schemas exposed
to the author, room workflow, canvas operations, or product deployment.

Blinded-evaluator digest
`sha256:1888105ca84a46a69f16a1439b704222201f7d04a7bb9afa3d8c87a462c4c5a6`
is authorized only for strict binding to the live versioned author-visible spec
object and its exact embedded compiler brief. It may not relax evidence gates,
infer pixels from semantics, reveal treatment labels, or communicate with the
author. Evaluation remains fail-closed if exact revision-bound pixels or any
committed evidence are absent.

## Frozen product, tools, and contract-v7 evidence

The product and tool condition remains unchanged:

- product commit `48a52e0837144ea0db8a09e43217397226759f83`;
- Git tree `a25e8ec9f8fcc08b227d710a8517333af90f491e`;
- deployment `dpl_2m1qqwE4xXuTX1huy4nwoEqy5fmD`, build
  `bld_crjsfx08s`;
- baseline receipt
  `sha256:32fddd038f6ec696f633bc5ee28ec587540282dbbd1e451e5d2debeb67069b23`;
- build identity
  `sha256:0342169d87c8c5b4aa770745222488fe934e83940a01e296872daa096e6465d4`;
- participant live contract, 54 tools,
  `sha256:d64cf3d25b9e275003438597b3b01c35419063d71613082d45aaf2f97c388b8e`;
- spectator live contract, 18 tools,
  `sha256:1760c6b1ec8cc4d8814b3de6a8f4516b3f4c215da69069c50072f23128541be2`;
- participant contract artifact
  `sha256:2d30a59151eca6a0764256d82694b463a4111c84699ac5ad221581b1b846f62a`;
  and
- spectator contract artifact
  `sha256:1fdd0cfcfe657f94921946cebd5aa085cbd5a63cf5685becd783318d15b11149`.

The no-model contract-only attempt `contract-prod-baseline-v7` binds the exact
runner digest above to attempt-bundle SHA-256
`sha256:69d4f769bbd0be98c9a5ab144d35913533e5db86ad214df61c56d9411dee121b`
and artifact root
`sha256:e32b76c48f4e651fa5dcc69a514756807b1846a3883df2ea21297e91ce871cb7`.
Its live receipt is the exact file digest frozen at the top of this amendment.
The authenticated Vercel alias preflight must still be repeated immediately
before v3; any deployment, tool-contract, runner, evaluator, config, or receipt
digest mismatch stops before brief delivery.

## Execution, retention, and stopping

Before execution, recompute the v3 byte and canonical digests, the runner and
evaluator script digests, the live receipt digest, and the contract-v7
bundle/artifact roots. Run the permitted-difference and exact-public-brief
tests. No v3 execution is authorized by the act of writing this amendment.

If separately invoked, the parent protocol's clean-room separation,
origin/contract checks, usage and event retention, revision-bound pixel
requirements, evidence seals, evaluator blinding, and hard stops remain in
force. Once the v3 brief is delivered, every timeout, refusal, no-op, malformed
call, provider failure, product failure, runner failure, evidence failure, and
cost-accounting failure remains the v3 outcome. Stop immediately for any
credential leak, condition drift, non-WebMCP mutation, evidence corruption, or
unaccounted provider-usage detail. Do not access validation, sealed, or
evaluator-only content to prepare or interpret v3.
