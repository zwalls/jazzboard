# EXP-0015 correction-loop replication

- Date: 2026-09-02
- Status: complete; blinded quality gate passed, speed gate failed
- Product candidate: `8a1a018f25a362400e24bd490aaf9aa8d492b34d`
- Benchmark: unchanged `dev-architecture-create-observability`
- Author: fresh projectless `gpt-5.6-terra`, reasoning `medium`
- Reviewer: separate fresh projectless `gpt-5.6-sol`, reasoning `high`

## Result

The product intervention recovered quality but did not improve speed. The fresh
author produced a readable 20-object, three-plane observability diagram with all
six supplied components and all five visibly identified directed relationships.
The exact final deterministic check had zero failures and four non-blocking
spacing warnings. A fresh blinded reviewer passed facts, planes, viewport,
membership, uncertainty handling, and overall quality with zero blocking
geometry violations.

The run took 298,952 ms. That is 31,568 ms (11.8%) slower than failed EXP-0014
and 116,568 ms (63.9%) slower than the fastest prior passing run, EXP-0013.
This is a quality recovery, not a speed improvement, and it does not support a
population percentage claim.

## What the intervention fixed

EXP-0014 made two rejected direct-correction calls, moved nodes into occupied
space, obscured relationships, retained a deterministic failure, and still
claimed completion. EXP-0015 had no WebMCP business rejection. Its correction
kept routes and relationship meaning visible, introduced no overlap or
truncation, and did not terminate until the deterministic failure count reached
zero. The blinded reviewer independently confirmed the result.

This supports keeping the exact direct-correction shape, correction-safety
invariants, visible-semantic preservation guidance, and final-failure completion
blocker.

## Why speed still failed

- Capability discovery took 63,187 ms. The author printed the large tool
  inventory, truncating the first combined quickstart response, then fetched the
  quickstart a second time.
- Initial authoring took 145,214 ms across three accepted draft transactions.
  Draft failures progressed from 10 to 2 to 0.
- The first draft used two-line nodes below the documented safe size and straight
  connector gaps too short for their visible labels. These were predictable
  failures, not a storage or transaction-size bottleneck.
- After commit, the author noticed that the evaluation relationship had semantic
  identity but no visible caption. It created text, added it to Diagram
  membership, and moved it in three separate calls.
- Host execution was 64,590 ms (21.6%). Model and coordination time was 234,410
  ms, so reducing reasoning loops and calls matters more than Redis tuning.

## Next intervention

Improve the quickstart as reasoning context, without imposing layout:

1. Describe conventional node dimensions as conservative floors rather than
   approximate targets.
2. Give a compact label-width-derived connector-gap check and tell the author to
   reserve an empty curve/elbow lane when a direct gap cannot fit the visible
   label.
3. Reserve a clear title band inside semantic containers before placing nodes or
   routes.
4. Add one canonical atomic post-commit correction example that can create a
   visible semantic caption and update Diagram membership in the same
   transaction.

Then run the unchanged benchmark again. Separately investigate progressive tool
discovery because printing the complete participant registry remains expensive,
but do not combine that larger transport change with the geometry-planning
replication.

The complete sanitized record is
`research/data/exp-0015-correction-loop-replication-v1.json`. Room credentials,
raw sessions, semantic state, and pixels remain private and gitignored.
