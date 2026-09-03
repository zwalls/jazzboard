# EXP-0032 draft-route-comparison replication

- Date: 2026-09-03
- Status: complete; factual gate passed, routing and anti-gaming gates failed
- Product candidate: `136e725`
- Benchmark: unchanged frozen `dev-architecture-stress-dense-routing`
- Author: fresh projectless `gpt-5.6-terra`, reasoning `medium`
- Reviewers: two separate fresh projectless `gpt-5.6-sol`, reasoning `high`

## Result

The author created all nine required entities and all nine directed
relationships with coherent Diagram membership. Both blinded reviewers passed
the factual criterion and found no unsupported architecture claims or reversed
relationships.

The artifact did not pass visual acceptance. The authoritative analyzer found
three fail-level and three warning-level findings: one connector crossing, one
connector-label/edge collision, one connector-label/object collision, one
connector intrusion, one out-of-frame route, and one route-ambiguity cluster.
Both blinded reviewers independently failed routing and anti-gaming. They
agreed that the Gateway-to-Service-B and Monitor-to-Service-A routes form an
ambiguous crossing and that the replication route breaches the preserved
frame. The reviewers counted two and three blocking violations respectively.

Author wall time was 320,287 ms, 233,622 ms faster than EXP-0031 (-42.18%).
WebMCP business calls fell from 24 to 14 (-41.67%), accepted draft transactions
fell from 16 to seven (-56.25%), and accepted draft response bytes fell from
253,607 to 146,439 (-42.26%). This recovered much of EXP-0031's latency, but
the output quality regressed from zero failures and one warning to three
failures and three warnings.

The candidate mechanism was not behaviorally exercised. The author never
called `analyze_diagram_layout`, never supplied `routeCandidates`, and instead
serially replaced or patched the draft seven times. It committed revision 7 by
acknowledging all three remaining fail-level findings as intentional, including
the frame-title intrusion and dense central crossing. Those rationales did not
make the artifact satisfy the frozen visual requirement.

This is not an accepted speed-quality improvement. It is evidence that merely
registering and documenting a useful correction primitive is insufficient when
the concise receipt and quickstart fast path do not place it directly in the
agent's correction loop.

## Scientific interpretation

The read-only evaluator itself remains mechanically valid: unit, schema,
descriptor-budget, type, build, and live WebMCP tests passed. In live QA, an
exact draft with two failures, three warnings, one crossing, and one ambiguity
cluster was compared against two agent-authored alternatives. The unchanged
alternative preserved every finding; an outer-lane alternative reduced all
five findings to zero. Draft and room revisions remained unchanged. Jazzboard
did not rank, select, apply, lay out, route, or render either alternative.

EXP-0032 tests discoverability and behavioral uptake, not evaluator
effectiveness. The author followed the concise mutation receipts and
`inspect_canvas_scope`; it did not consult the longer public documents where
the candidate workflow had been added. The next intervention should therefore
add a bounded `recommendedRouteComparison` to finding-bearing concise draft
receipts and their canonical correction JSON whenever connector conflicts are
present. It should carry only exact draft identity/revision, affected connector
tempRefs, the accepted operation shape, and a direction to supply two to eight
agent-authored alternatives. It must not generate candidates or claim that
comparison replaces pixel inspection. The architecture quickstart should state
the same recovery step in compact form.

## Protocol notes

The author used WebMCP for every canvas read and write. No WebMCP business call
failed. The author inspected uncommitted pixels before commit and authoritative
semantic state and pixels after commit. Both reviewers received only the
frozen public requirement, rubric, sanitized semantic state, and final PNG.
They received no room credential, condition label, author transcript, paired
result, or repository access.

Exact tokens, resolved model snapshot, and subscription usage were
unobservable and were not estimated.

The complete sanitized record is
`research/data/exp-0032-draft-route-comparison-dense-routing-v1.json`. Private
room credentials, raw sessions, semantic state, pixels, and exact canvas object
identifiers remain gitignored.
