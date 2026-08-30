# EXP-0000 clean-room live-author smoke report

- Report version: 1
- Status: final for attempts v1–v3; measurement-readiness diagnostic passed
- Product baseline: `48a52e0837144ea0db8a09e43217397226759f83`
- Research pre-execution checkpoint: `92b611a599c770b3ac284be3e90801a692a6dea7`
- Partition: development only
- Sealed data accessed: none

## Decision and permitted claim

The linked smoke series now **passes its narrow measurement-readiness gate**.
V1 and v2 remain immutable failures in the all-attempt record. The separately
preregistered v3 diagnostic completed normally, retained detailed provider
usage, captured exact author inspection pixels and a fresh spectator PNG bound
to authoritative room revision 4, recomputed every evidence commitment, and
received one accepted decision from a preregistered blinded primary reviewer.

The permitted conclusion is only that the development-only author, evidence,
cost-accounting, and individual-review path can complete fail-closed against
the frozen production baseline. This is sufficient to proceed to a separately
frozen A/A calibration gate. It does not erase v1/v2, estimate task success
probability, validate inter-rater reliability or adjudication, measure A/A bias,
or show harness improvement.

## Frozen inputs and hashes

| Input | SHA-256 |
| --- | --- |
| Parent protocol | `c62ac0fd6dad99c21f7eb8aa4b5001c27224366d7e5aca0a0885e32a2706feab` |
| Amendment 1 | `59e28581a5a0038a8ca59eafb716b9e4fe9fc34288ccee8f39e06c1821608015` |
| Amendment 2 | `d7ad62fcaf410ca98970976c2bf7734e98204e4bf7f9d60fb0d2e15850ab8a7e` |
| Evaluator supplement 1 | `17aedeade29e5a8b0f99aed3b81009005800feb4a0f954dee38370aebcf3ae89` |
| V1 runner config | `6cb2004e123f67e2885f2057fb5f4a0c027ba2f5982fed3587afa79df1099790` |
| V2 runner config | `fb7b08b62ed8da156b94634ffe118ced119e1143372d82518140a71b8e5de9f2` |
| V3 runner config | `a46f725395f1884ca0551862c8f6eef604967b7068bdc0641010c71fa2423add` |
| Pre-v2 live contract receipt | `d71dc2052428ac644ad09361358c65d4832823c2cc98ddb04773732f190716fd` |
| Pre-v3 live contract receipt | `799997c344a5525be92824380e8115d65f4c7224aeb6f64f6c3938d607a12cff` |
| V1 runner | `03ab941fcf2663ed713b19258ae5e81f0dd581098fd5b3dff88a8b2c59584f04` |
| V2 runner | `c2cbeaf5b216a5699b7e7fcc88326ff78763988d33943256f8eb193112426c24` |
| V3 runner | `699d803722f6425547246c9a70c7ec96e56ff525043638a6c21f48f94ca5ec12` |
| V3 blinded evaluator | `1888105ca84a46a69f16a1439b704222201f7d04a7bb9afa3d8c87a462c4c5a6` |
| V3 reviewer config | `4f004adeaccdd52c0e4f7595a5401e0b00f5e388bbf2b7b70c21ffdc3de31805` |
| Failure taxonomy | `d2c3b9613e66ef37395aabcbe5d58a7d065d604e2ba74313e31891e44678b9df` |

All three author attempts used `gpt-5.6-sol` with reasoning effort `max`, Playwright
Chromium `151.0.7922.34`, a `1280 × 720` viewport, and the verified public
alias for production deployment `dpl_2m1qqwE4xXuTX1huy4nwoEqy5fmD` / build
`bld_crjsfx08s`. Participant and spectator contracts remained exactly 54 and
18 tools with digests `d64cf3d25b9e275003438597b3b01c35419063d71613082d45aaf2f97c388b8e`
and `1760c6b1ec8cc4d8814b3de6a8f4516b3f4c215da69069c50072f23128541be2`
respectively.

## Run accounting

| Item | V1 primary smoke | V2 supplemental diagnostic | V3 remediation diagnostic | Total |
| --- | ---: | ---: | ---: | ---: |
| Planned sessions | 1 | 1 | 1 | 3 |
| Attempts begun | 1 | 1 | 1 | 3 |
| Completed normally | 0 | 0 | 1 | 1 |
| Author noncompletion | 1 | 1 | 0 | 2 |
| Candidate mutation committed | 0 | 1 | 1 | 2 |
| Exact spectator PNG available | 0 | 0 | 1 | 1 |
| Attempts retained | 1 | 1 | 1 | 3 |

V2 and v3 are linked diagnostics and never replace an earlier result. All three
count wherever this smoke's all-attempt accounting is reported; none enters a
product-effect estimate.

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

### V3 — `smoke-exp0000-checkout-solmax-v3`

- Terminal runner status: `author_completed`
- Elapsed time: 182,080 ms
- Tool calls: 14
- Completed Responses turns: 15
- Usage: 332,150 input, 11,801 output, 343,951 total tokens
- Detailed input: 5,927 uncached, 275,817 cached, 50,406 cache-write
- Reasoning output: 7,623 tokens, already included in output totals
- Observed provider: `gpt-5.6-sol`, service tier `default`, reported on every
  completed turn
- Canvas outcome: 12 authoritative objects and one first-class Diagram at room
  revision 4
- Exact author inspection PNGs: revisions 2 and 3
- Exact spectator PNG: 1,125 × 576 at revision 4, SHA-256
  `15552c1d0ec0213def7b82928417eee014816d7a52cdf93301c6bf5e5757f0df`
- Primary failure class: `SUCCESS` from the one preregistered measurement-smoke
  reviewer; this is not an inter-rater or product-effect result
- Attempt-bundle file SHA-256:
  `4d688dbfa7f7b1dc6e17511a44a9596c49fc069cb1d417547f00741a0adc98ae`
- Author-evidence root:
  `51e0cd6a857773d7cd78b0ca1b9b9a27e78d5a52ee13fc3fbdd41834b5b130e1`
- Artifact root:
  `7a33f2e367bc0c70cfbace8db24fcc6c395313f8553231f85cfaaaa38a9745b5`

V3 differed from v2 only in its opaque attempt ID and preregistered cumulative
input ceiling. The author created the requested entities, three semantically
bound directed relationships, an explicit trust-boundary shape, and a
first-class Diagram, inspected revisions 2 and 3, and completed. A new spectator
then read room revision 4 and captured the clean exact-revision render. The
evaluator preflight independently recomputed the attempt bundle, artifact root,
author root, exact semantic state, author-visible execution contract, rubric,
PNG digest, dimensions, and room revision before making a model request.

## Cost accounting

The historical v1/v2 runners retained total input/output usage but not
cached-input or cache-write detail. Their exact billed cost remains unavailable
and must not be labeled actual: all-uncached nominal amounts are $0.19184 for
v1 and $0.940716 for v2, or $1.132556 combined.

V3 retained all pricing inputs. At the frozen $4.00/M uncached input, $0.40/M
cached input, $5.00/M cache-write input, and $20.00/M output rates, its
reconstructable estimate is:

| Component | Tokens | Estimated USD |
| --- | ---: | ---: |
| Uncached input | 5,927 | $0.0237080 |
| Cached input | 275,817 | $0.1103268 |
| Cache-write input | 50,406 | $0.2520300 |
| Output | 11,801 | $0.2360200 |
| **V3 author total** | 343,951 total provider tokens | **$0.6220848** |

The independent v3 reviewer used 6,531 input and 878 output tokens and records
an estimated $0.043684. The v3 author-plus-review measurement-path estimate is
$0.6657688. This does not retroactively make v1/v2 exact and is not yet a
48-session pilot cost estimate.

## Evaluator incidents and v3 validation

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

After v3 evidence sealed, evaluator supplement 1 preregistered a new opaque
reviewer, exact evidence commitments, `gpt-5.6-sol` at high reasoning, token
budgets, and frozen pricing before prompt delivery. The evaluator verified the
entire package and locked an accepted `SUCCESS` record at
`research/results/runs/_reviews/4d688dbfa7f7b1dc6e17511a/primary-rvw-7f4c2d91.json`.
Its file SHA-256 is
`534cfdf843c1ed4677c1ae7846b0fd4109ca26b0f417a8402268cb1b95bfa482`
and internal record commitment is
`8e1c093ccdae1fdf14a939683305f0dfb4bd235ec61c681441f652fd2271bf2d`.
The reviewer saw no paired artifact or treatment label, invoked no tools, and
marked correction, progressive presentation, and efficiency `not_observable`
rather than inferring them from final-state evidence.

## Protocol adherence and deviations

| Check | V1/V2 result | V3 result | Evidence |
| --- | --- | --- | --- |
| Exact product deployment and contracts | pass | pass | v6 before v2; v7 plus immediate Vercel preflight before v3 |
| Earlier attempts retained after failure | pass | pass | v1/v2 attempt roots remain unchanged |
| Attempt preregistered before brief | pass | pass | Amendments 1–2 and checkpoints `92b611a`, `98b0c87` |
| No sealed data accessed | pass | pass | coordinator and protocol scope |
| Author/evaluator context separation | pass | pass | all attempt bundles and evaluator input commitments |
| Final exact-revision PNG | fail | pass | v3 spectator revision 4 PNG; v1/v2 lacked accepted pixels |
| Reconstructable cost accounting | fail | pass | v3 detailed provider usage and frozen rates |
| Independent accepted score | fail | pass | preregistered v3 reviewer record |

No result was excluded, overwritten, or promoted to success. The v2 budget
change was preregistered and its provenance-only runner change was explicitly
authorized before execution. The capture and evaluator defects were discovered
after v2 and are not retrospectively repaired in its artifacts.

## Gate disposition and remaining work before EXP-0001A

The five measurement-remediation items identified after v2 are complete: lease
parsing, detailed usage, strict author-visible-spec binding, digest re-freeze,
and one complete exact-state/pixel/reviewer diagnostic all passed.

EXP-0001A still requires a separate pre-brief freeze of realistic author and
reviewer budgets informed by v3, two distinct primary reviewers per artifact,
an independently tested adjudication path for disagreements, exact all-attempt
cost and denominator reconciliation, and a fresh production/contract receipt.
No A/A brief has been delivered as part of EXP-0000.

## Claim audit

This report makes no product-quality, architecture-quality, drawing-quality,
model-superiority, evaluator-accuracy, causal, equivalence, or harness-lift
claim. V2 remains unscored because its required pixels are absent; v3's one
accepted reviewer proves only that the individual measurement path can run,
not that the reviewer is accurate or reliable across artifacts.
