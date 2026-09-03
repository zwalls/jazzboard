# EXP-0021 lossless-quickstart replication

- Date: 2026-09-03
- Status: complete; mechanism and quality gates passed, total-speed gain not established
- Product candidate: `32648280b11f869a10d59863f058b753af392bbc`
- Benchmark: unchanged `dev-architecture-create-observability`
- Author: fresh projectless `gpt-5.6-terra`, reasoning `medium`
- Reviewers: two separate fresh projectless `gpt-5.6-sol`, reasoning `high`

## Result

The lossless quickstart fixed the exact failure mode observed in EXP-0020. The
author read `quickstart_architecture` once and immediately submitted a valid
transaction containing the correct operation, endpoint, Diagram membership,
and relationship-assertion fields. It made zero schema-invalid WebMCP calls and
never requested the deeper architecture bundle.

All quality gates passed. Authoritative state contains all six components,
three planes, and all five required directed relationships. Both independent
reviewers passed facts, plane distinction, fixed-viewport readability, Diagram
coherence, and unsupported-assertion checks with zero blocking geometry
violations.

Tool efficiency improved substantially: WebMCP calls fell from 13 to 8 (38.5%)
and measured host execution fell from 49,241 ms to 34,711 ms (29.5%). Total
wall time was 204,504 ms, 3,466 ms (1.7%) slower than EXP-0020, because this
author used the saved interaction budget to find and repair a real visible
heading truncation after publication. The result validates the mechanism but
does not establish a general speed improvement.

## What improved

- The first transaction was valid; schema failures fell from two to zero.
- One quickstart read replaced three capability reads.
- Two accepted draft transactions replaced five.
- Caller-authored assertions still verified all five connector relationships
  before publication.
- Exact semantic audit and two blinded pixel reviews all passed.

## New bottleneck

The author widened the telemetry-platform heading in its draft patch, but not
enough to fit it. The corrected draft receipt still reported
`TEXT_CONTENT_LIKELY_TRUNCATED`; because `failCount` was zero, the author
published with that task-relevant warning unresolved. Pixel inspection then
showed the truncation and prompted a post-commit edit. This is an instruction
and error-recovery gap, not a renderer-measurement mismatch.

Making that warning more actionable should remove a mutation, a second
inspection, and several reasoning steps without choosing layout for the
author. It preserves the core product principle: Jazzboard supplies truthful
perceptual evidence; the agent decides how to respond.

## Next intervention

Give text-fit findings exact non-mutating correction bounds—for example, the
minimum width for one line and minimum height at the current width—and make the
quickstart explicitly state that task-relevant truncation warnings remain
unresolved even when `failCount` is zero. Add a regression fixture for
`TELEMETRY PLATFORM` at the same size and width seen here, then run the
unchanged observability task again. The target is a quality pass with zero
post-commit correction and no regression in schema-valid first-pass authoring.

The complete sanitized record is
`research/data/exp-0021-lossless-quickstart-replication-v1.json`. Room
credentials, raw sessions, semantic state, and pixels remain private and
gitignored.
