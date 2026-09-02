# EXP-0008 transaction-friction validation

- Date: 2026-09-02
- Status: complete; transport improved, frozen quality gate failed
- Product candidate: `69798824fb114c4e1fbf8fd8f5e978c889b0d3ae`
- Author: fresh projectless `gpt-5.6-terra`, reasoning `medium`
- Reviewer: separate fresh projectless `gpt-5.6-sol`, reasoning `high`

## Result

The isolated author completed in 145,615 ms using two accepted draft
transactions and no WebMCP business failure. Raw wall time was 82,763 ms lower
than EXP-0007 and 26,326 ms lower than the preceding accepted checkout candidate
from EXP-0005.

That is not an accepted speed improvement. A separate blinded reviewer passed
the supplied facts and trust-boundary placement but failed readability: the
orange `order-created` connector label covered almost all of the visible
`Commerce trust boundary` label. The current run has no accepted-completion
time and cannot be used in a percentage claim.

## What worked

- The author did not repeat the former invalid-transaction failure.
- The first draft used explicit z-index 0 for the boundary and 2 for the nodes;
  omitted connectors correctly received 3, 4, and 5.
- The author reduced five real connector-label/object findings to zero in one
  exact-revision draft patch.
- The final semantic state contained exactly four required nodes, three required
  connectors, and one first-class Diagram.

## What failed

The semantic-container intervention was too broad for connector labels. It is
correct to avoid treating an intentional boundary fill or an outside-to-inside
path as a generic collision. It is not correct to ignore the container's own
rendered title. In the final pixels, the connector's white label background
covered that title. Deterministic geometry reported `pass`, so the author had
no semantic signal to correct before its bounded pixel-capture recovery ended.

This is a valuable harness result: accepting the 145.6-second number without a
blinded pixel gate would have rewarded a faster but worse surface.

## Timing attribution

- Total wall time: 145,615 ms
- Accounted wall time: 146,000 ms
- Host execution: 31,265 ms (21.4%)
- Model and coordination: 114,735 ms
- Initial authoring: 59,024 ms
- Capability discovery: 39,248 ms
- Inspection: 22,891 ms
- Draft finish: 9,439 ms

The run made seven WebMCP calls: two draft transactions, one draft finish, one
scope inspection, one preview reframe, one PNG export, and one capability read.
Exact model reasoning time, tokens, and per-task subscription usage remain
unobservable.

## Decision

Keep the operation-metadata tolerance and transaction-local paint-order fix.
Keep endpoint-proven structural boundary crossings. Tighten only the label
exception: connector labels may overlap the semantic container's fill, but a
collision with the shared renderer estimate of the container's own visible
label must remain a blocking finding.

Then rerun the same author and blinded-review gates. Only a run that both passes
the quality gate and improves accepted completion time counts as progress.

The full sanitized record is
`research/data/exp-0008-transaction-friction-validation-v1.json`. Private room
credentials, raw sessions, semantic packets, and pixels remain outside Git.
