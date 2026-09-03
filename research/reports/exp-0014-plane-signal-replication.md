# EXP-0014 semantic-plane replication

- Date: 2026-09-02
- Status: complete; signal-precision gate passed, author quality and speed gates failed
- Product candidate: `fbcf27c12cf9a4259f13156438c005ad9062d17a`
- Benchmark: unchanged `dev-architecture-create-observability`
- Author: fresh projectless `gpt-5.6-terra`, reasoning `medium`
- Reviewer: separate fresh projectless `gpt-5.6-sol`, reasoning `high`

## What improved

The semantic-plane change is valid. Reanalyzing the exact unchanged EXP-0013
artifact reduced deterministic findings from 27 to 4 and failures from 25 to
2. All 23 removed findings were the targeted plane-containment false positives.
The real short connector-label collisions and two 9 px spacing warnings stayed
visible. This is an 85.2% descriptive reduction in findings on that exact
artifact without broad suppression.

The fresh EXP-0014 author also reached zero draft failures before publication.
That confirms explicit `architecture.plane.*` backgrounds no longer poison the
draft correction loop.

## What regressed

The fresh author took 267,384 ms, 85,000 ms (46.6%) slower than EXP-0013. It
used four draft transactions, fetched a second capability bundle, and made
three direct-correction attempts after the first pixel inspection. The first
two direct attempts were rejected because the author invented `update_node`
and `changes` instead of using the registered `update_object` plus `patch`
schema. Only the third applied.

The accepted correction widened and shifted Query UI and Alert Engine toward
Telemetry Store. It fixed the two pixel symptoms the author noticed but
introduced a node overlap, obscured two short relationship routes, and still
left the Alert Engine label visibly truncated. The exact final inspection
reported a deterministic failure, yet the author ended with “No unresolved
visual issues.”

The blinded reviewer failed facts and viewport readability with four blocking
visual defects. Plane distinction, Diagram membership, and uncertainty
handling passed.

## Timing diagnosis

- Capability discovery: 60,015 ms
- Initial authoring through four draft revisions: 126,614 ms
- Draft finish: 8,991 ms
- Inspection: 22,802 ms
- Post-commit correction: 28,519 ms
- State read: 11,265 ms
- Terminal response: 8,794 ms
- Host execution: 52,608 ms (19.7%)
- Model and coordination: 214,392 ms

The slower run is not an Upstash or transaction-size bottleneck. Most time was
model/coordination time spent converting geometry feedback into repeated
patches. The product supplied accurate final failure state, but its quickstart
did not make the direct-update shape or correction-safety invariant salient
enough, and final inspection's generic next step did not clearly prevent a
false completion claim.

## Decision

Keep the semantic-plane fix. The next narrow intervention should improve agent
reasoning without choosing layout for the agent:

1. Put the exact authoritative `update_object` + `patch` correction skeleton in
   the architecture quickstart so a second bundle fetch and schema guessing are
   unnecessary.
2. Tell the agent to preserve clearance and routes when correcting label fit;
   widening or moving one object must not introduce a new overlap.
3. Do not erase relationship labels merely to silence a collision when the
   relationship would become visually ambiguous; choose spacing, a shorter
   label, routing, or redundant visible semantics deliberately.
4. When exact final inspection has a deterministic failure, explicitly state
   that a conventional-diagram completion claim is blocked until every
   unintended failure is corrected and the newest revision is reinspected.

Then rerun the same public task with a fresh isolated author and blinded
reviewer. This run is a negative quality/speed result, not evidence for a
population percentage claim.

The complete sanitized record is
`research/data/exp-0014-plane-signal-replication-v1.json`. Credentials, raw
sessions, state, and pixels remain private and gitignored.
