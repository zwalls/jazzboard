# EXP-0000 clean-room live-author smoke report

- Report version: 1
- Status: final for attempts v1 and v2; measurement remediation in progress
- Product baseline: `48a52e0837144ea0db8a09e43217397226759f83`
- Research pre-execution checkpoint: `92b611a599c770b3ac284be3e90801a692a6dea7`
- Partition: development only
- Sealed data accessed: none

## Decision and permitted claim

The smoke did **not** pass its measurement-readiness gate. Both begun attempts
remain failures in the all-attempt record. V1 stopped before any mutation when
one response exhausted its 4,000-token response ceiling. The preregistered v2
supplement created and atomically committed a 16-object, one-Diagram candidate,
then crossed its cumulative input ceiling before the model's final inspection
call could execute. Independent spectator capture subsequently exposed a
numeric-expiry parsing defect in the research runner, leaving no final PNG.

The only permitted conclusion is that room provisioning, live WebMCP role
isolation, raw model/tool execution, progressive drafting, atomic finish,
semantic-state retention, author-evidence sealing, and provider-identity
retention worked, while token accounting and final evidence capture were not
yet ready for EXP-0001A. Neither attempt estimates task success probability,
reviewer accuracy, A/A bias, or harness improvement.

Recommendation: repair and re-freeze the measurement runner, run one new linked
diagnostic under a preregistered amendment, and do not begin the fixed 48-session
A/A calibration until exact final pixels and complete cost accounting pass.

## Frozen inputs and hashes

| Input | SHA-256 |
| --- | --- |
| Parent protocol | `c62ac0fd6dad99c21f7eb8aa4b5001c27224366d7e5aca0a0885e32a2706feab` |
| Amendment 1 | `59e28581a5a0038a8ca59eafb716b9e4fe9fc34288ccee8f39e06c1821608015` |
| V1 runner config | `6cb2004e123f67e2885f2057fb5f4a0c027ba2f5982fed3587afa79df1099790` |
| V2 runner config | `fb7b08b62ed8da156b94634ffe118ced119e1143372d82518140a71b8e5de9f2` |
| Pre-v2 live contract receipt | `d71dc2052428ac644ad09361358c65d4832823c2cc98ddb04773732f190716fd` |
| V1 runner | `03ab941fcf2663ed713b19258ae5e81f0dd581098fd5b3dff88a8b2c59584f04` |
| V2 runner | `c2cbeaf5b216a5699b7e7fcc88326ff78763988d33943256f8eb193112426c24` |
| Failure taxonomy | `d2c3b9613e66ef37395aabcbe5d58a7d065d604e2ba74313e31891e44678b9df` |

Both attempts used `gpt-5.6-sol` with reasoning effort `max`, Playwright
Chromium `151.0.7922.34`, a `1280 × 720` viewport, and the verified public
alias for production deployment `dpl_2m1qqwE4xXuTX1huy4nwoEqy5fmD` / build
`bld_crjsfx08s`. Participant and spectator contracts remained exactly 54 and
18 tools with digests `d64cf3d25b9e275003438597b3b01c35419063d71613082d45aaf2f97c388b8e`
and `1760c6b1ec8cc4d8814b3de6a8f4516b3f4c215da69069c50072f23128541be2`
respectively.

## Run accounting

| Item | V1 primary smoke | V2 supplemental diagnostic | Total |
| --- | ---: | ---: | ---: |
| Planned sessions | 1 | 1 | 2 |
| Attempts begun | 1 | 1 | 2 |
| Completed normally | 0 | 0 | 0 |
| Author noncompletion | 1 | 1 | 2 |
| Candidate mutation committed | 0 | 1 | 1 |
| Exact spectator PNG available | 0 | 0 | 0 |
| Attempts retained | 1 | 1 | 2 |

V2 is diagnostic and never replaces V1. Both count wherever this smoke's
all-attempt accounting is reported; neither enters a product-effect estimate.

## Attempt results

### V1 — `smoke-exp0000-checkout-solmax-v1`

- Terminal runner status: `responses_incomplete`
- Elapsed time: 75,121 ms
- Tool calls: 5
- Usage: 25,970 input, 4,398 output, 30,368 total tokens
- Canvas outcome: no object or Diagram created
- Primary failure class: `FAIL_AUTHOR_NONCOMPLETION`
- Mechanism tags: `AUTHOR_BUDGET_EXHAUSTED`,
  `INSPECT_REQUIRED_SCOPE_OMITTED`
- Attempt bundle SHA-256:
  `09b9712819c75ae56a8007c7efd6f3f5a9202eecbe6f1d30298223aa0e39af40`
- Author evidence root:
  `06aa04a7bdd8b14a9ae953f2e49889ddb6a6c8665bb22049dfb3651cb1118442`
- Artifact root:
  `4bc20628131328fd8757335d823e282f0a0dcd1dbe5b3ad503f9b8de585d7647a`

The last response returned `incomplete_details.reason=max_output_tokens` at the
frozen 4,000-token per-response ceiling. This is ordinary author-budget
noncompletion under failure-taxonomy v1, not an external-service incident.

### V2 — `smoke-exp0000-checkout-solmax-v2`

- Terminal runner status: `input_token_budget_exceeded`
- Elapsed time: 151,188 ms
- Tool calls: 9
- Usage: 184,024 input, 10,231 output, 194,255 total tokens
- Observed provider: `gpt-5.6-sol`, service tier `default`, reported on all 10
  completed turns
- Canvas outcome: 16 authoritative objects and one first-class Diagram at room
  revision 3
- Primary failure class: `FAIL_INFRASTRUCTURE` (provisional until independent
  failure review can consume complete evidence)
- Mechanism tags: `INFRA_CAPTURE_PIPELINE_FAILURE`,
  `EVAL_CAPTURE_MISSING_OR_CORRUPT`, `AUTHOR_BUDGET_EXHAUSTED`,
  `INSPECT_REQUIRED_SCOPE_OMITTED`, `TOOL_SCHEMA_MISMATCH`
- Attempt bundle SHA-256:
  `c58208cc39a221042faa5faf009f992e9a459c1f5e8d96dd1a37d17188c42640`
- Author evidence root:
  `5fc241bcecd1c03196eb481441fece97ed3b1cd896c888d0923a8bac23b2b83e`
- Artifact root:
  `52386ec4de33301051f70ea772d4ebb5874baf7831ed1ddc629242638c6b6fb5`

V2's first coherent transaction conformed to the browser-advertised generic
operation schema but the server rejected operation-specific node style,
metadata, and connector-width fields that the generic schema did not exclude.
The author recovered, staged a corrected progressive draft, waited for its
presentation, and atomically committed it. On turn 10 the response requested
`inspect_canvas_scope`; cumulative input rose from 142,697 to 184,024 tokens,
so the runner correctly rejected that call under the preregistered 150,000
ceiling.

The fresh spectator then read the exact revision and obtained an inspection
receipt, but the runner called `Date.parse` on the production numeric
epoch-millisecond `expiresAt`. That evaluates as invalid and produced
`inspect_canvas_scope pixel lease has expired` before capture. This is a
verified research capture defect. No visual acceptance decision is permitted
from semantic state, geometry summaries, or author prose alone.

## Cost accounting

The historical runners retained total input/output usage but not cached-input
or cache-write detail. Consequently exact billed cost is unavailable and must
not be labeled "actual cost." At the published standard rates of $4.00/M input
and $20.00/M output, treating every input token as uncached gives conservative
nominal amounts of $0.19184 for V1 and $0.940716 for V2. The combined nominal
amount is $1.132556. Actual billed cost may be lower because cached input is
priced separately; the remediated runner must retain provider
`input_tokens_details` before pilot budgeting.

## Evaluator preflight incident

A no-network invocation of the blinded evaluator against V2 failed closed and
retained review record
`research/results/runs/_reviews/c58208cc39a221042faa5faf/primary-opaque-reviewer-smoke-v2.json`
with SHA-256
`11e24a65ab667b2bf1a7213ccbc338beccd463f5e6373fda6064269e017c008e`.
It revealed a second evaluator-side fixture mismatch: the evaluator expected
`author-brief.json` to contain a raw string, while the live runner correctly
sealed a strict author-visible spec object containing the brief, model,
allowlist, and budgets. The failure occurred before any API request and remains
an immutable failed review. The evaluator must bind the live object shape
strictly before a new reviewer invocation may reach the expected missing-PNG
failure.

That binding was then corrected without altering either attempt. A new opaque
reviewer invocation verified the exact live spec and failed at the intended
evidence gate with `SPECTATOR_PIXELS_MISSING`, before any input-token count or
Responses request. Its separately retained record is
`research/results/runs/_reviews/c58208cc39a221042faa5faf/primary-opaque-reviewer-smoke-v2b.json`
with file SHA-256
`734c3a27d927534b2f02a55ebec3f95d15c90efd96b448125edc08c127abd424`.
The earlier task-binding failure remains retained; it was not overwritten.

## Protocol adherence and deviations

| Check | Result | Evidence |
| --- | --- | --- |
| Exact product deployment and contracts | pass | v6 live receipt |
| V1 retained after failure | pass | V1 attempt root |
| V2 preregistered before brief | pass | Amendment 1 and checkpoint `92b611a` |
| No sealed data accessed | pass | coordinator and protocol scope |
| Author/evaluator context separation | pass | both attempt bundles |
| Final exact-revision PNG | fail | V2 spectator inspection `pixelError`; V1 no inspectable object |
| Exact billed-cost accounting | fail | cached/cache-write usage not retained |
| Independent accepted score | fail | evidence incomplete and evaluator binding incident |

No result was excluded, overwritten, or promoted to success. The v2 budget
change was preregistered and its provenance-only runner change was explicitly
authorized before execution. The capture and evaluator defects were discovered
after v2 and are not retrospectively repaired in its artifacts.

## Required remediation before EXP-0001A

1. Parse numeric and ISO inspection expiries and prove exact screenshot capture
   against a live-shaped fixture.
2. Retain cached-input, cache-write, and reasoning-token details and compute
   cost from frozen rates.
3. Bind the evaluator to the strict live author-visible spec object and prove
   it rejects extra or secret-bearing fields.
4. Re-freeze every changed runner digest and publish a new supplemental
   amendment before another brief.
5. Require one linked diagnostic to finish with exact semantic state, exact
   revision-bound PNG, recomputable seals, and a fail-closed blinded review
   before freezing the 48-session A/A profile.

## Claim audit

This report makes no product-quality, architecture-quality, drawing-quality,
model-superiority, evaluator-accuracy, causal, equivalence, or harness-lift
claim. The attractive or complete-looking parts of V2's semantic artifact are
not scored evidence without the required exact pixels and independent review.
