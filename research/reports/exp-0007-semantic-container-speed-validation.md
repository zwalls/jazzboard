# EXP-0007 semantic-container speed validation

- Date: 2026-09-02
- Status: complete; quality passed, speed improvement not observed
- Product candidate: `842d986a80bc5c36f3b0e587243a3180f7eac437`
- Author: fresh projectless `gpt-5.6-terra`, reasoning `medium`
- Reviewer: separate fresh projectless `gpt-5.6-sol`, reasoning `high`

## Result

A fresh isolated author completed the unchanged checkout architecture task in
228,378 ms. A separate blinded reviewer passed facts, trust-boundary semantics,
and readability, with zero blocking pixel defects and no duplicate semantic
credit.

This run did not demonstrate a speed improvement. The preceding accepted
checkout candidate in EXP-0005 completed in 171,941 ms and used three draft
transaction calls. EXP-0007 used four draft transaction calls, three of which
were accepted. The descriptive wall-time delta is +56,437 ms. Because this is
a sequential n=1 comparison rather than a randomized replication, it is not a
treatment-effect estimate and cannot support a percentage claim.

## What improved

The initial valid draft included a first-class commerce trust-boundary shape,
three fully contained service nodes, one external browser, and the required
connectors. The new semantic-container behavior did not report the contained
services as overlapping the boundary. The final artifact remained a semantic
Diagram and passed blinded review.

## What the trace exposed

Two avoidable costs remained:

1. The author copied root `intent` and `summary` activity metadata onto each
   create operation. The strict transaction schema rejected the all-or-nothing
   call, supplied exact recovery, and changed no state. The corrected retry
   succeeded, but the rejected round trip consumed author time.
2. The required Shopper Browser to Checkout API connection crosses from outside
   to inside the commerce trust boundary. Jazzboard continued to report that
   intentional crossing as `CONNECTOR_OBJECT_INTRUSION`. The boundary requested
   z-index 0, while the first omitted connector z-index also became 0; the
   transaction-local default did not advance past earlier explicit candidates.

The accepted draft still required real corrections for oversized connector
labels and text fit. Removing false positives must not suppress those useful
signals.

## Timing attribution

- Total wall time: 228,378 ms
- Accounted wall time: 228,000 ms
- Host execution: 45,169 ms (19.8%)
- Model and coordination: 182,831 ms
- Initial authoring: 115,622 ms
- Capability discovery: 30,594 ms
- Inspection: 22,144 ms
- Draft finish: 8,167 ms

The run made 12 WebMCP calls: four canvas transactions, one draft finish, two
inspections, one room read, three post-publication semantic corrections, and one
capability read. Exact model reasoning time, tokens, and per-task subscription
usage remain unobservable.

## Decision

Keep the semantic-container containment behavior because the isolated artifact
passed and the former contained-member noise was absent. Do not claim a speed
gain.

The next narrow intervention is evidence-driven:

- transaction-local omitted z-indexes should advance beyond both existing and
  earlier explicit candidates, preserving the documented paint order;
- redundant per-operation activity metadata should be tolerated as inert,
  non-persisted annotations so a semantically valid atomic transaction is not
  rejected for harmless repetition; and
- required outside-to-inside boundary crossings should not be treated as
  generic intrusions when endpoint containment proves the crossing is structural.

After those changes, rerun the same isolated author and blinded-review gates.
The full sanitized record is
`research/data/exp-0007-semantic-container-speed-validation-v1.json`. Private
room credentials, raw sessions, semantic packets, and pixels remain outside
Git.
