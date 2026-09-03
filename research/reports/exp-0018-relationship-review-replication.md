# EXP-0018 relationship-review replication

- Date: 2026-09-02
- Status: complete; factual gate passed, visual and speed gates failed
- Product candidate: `b3f3e83d2f4cf2aadb1abf5f4df7e1132b73762f`
- Benchmark: unchanged `dev-architecture-create-observability`
- Author: fresh projectless `gpt-5.6-terra`, reasoning `medium`
- Primary reviewer and adjudicator: separate fresh projectless `gpt-5.6-sol`, reasoning `high`

## Result

The relationship-review intervention fixed the exact factual failure from
EXP-0017. The initial candidate and all five later draft revisions exposed the
five connectors as a joined actual-start-to-actual-end table, and every
revision matched the requested direction. Both valid blinded judges passed all
six components, all five directed facts, all three planes, viewport
readability, first-class Diagram membership, and the no-invention constraint.

The overall artifact still fails. Both judges independently found the same
single visual blocker: the `write` and `evaluate` connectors terminate only 5.5
canvas units apart on the left edge of Telemetry Store, merging their terminal
geometry and arrowheads. The deterministic analyzer reported
`congestedPortCount=0` because its existing attachment-port signal requires
three nearby connectors.

Wall time rose to 282,595 ms: 93,832 ms (49.7%) slower than EXP-0017 and
100,211 ms (54.9%) slower than the fastest prior passing run, EXP-0013. The
author spent 172,419 ms across one initial draft and five targeted patches.
This is positive mechanism evidence for endpoint truth, but not a
speed-quality win. No population percentage claim is permitted.

## What improved

- `relationshipReview` was present in every draft receipt and joined connector
  tempRefs, labels, prose names, and authoritative endpoints in one place.
- The author never reversed Query UI → Telemetry Store or Alert Engine →
  Telemetry Store, the two facts that failed EXP-0017.
- One first-class Diagram contains all 12 intended plane/title/component
  members and all five connectors.
- No Jazzboard WebMCP call returned a business failure, and no post-commit edit
  was needed.

## What still failed

- Six accepted draft transactions took 172,419 ms before finish.
- Two incoming connectors used near-coincident explicit ports on one edge.
- The current congestion detector deliberately ignores clusters smaller than
  three connectors, so the final receipt incorrectly described the
  conventional geometry as having no deterministic findings.
- Pixel review by the author did not override that false-negative signal, while
  both blinded judges identified the same obstruction.

One adjudication attempt is retained as technically invalid: its browser read
the image but blocked the separately served semantic-state file. A new isolated
adjudicator received the identical sanitized state inline and no author or
primary-review context.

## Next intervention

Lower the existing attachment-port congestion threshold from three connectors
to two within the same 12-unit radius. Keep it a warning with explicitly
intent-unaware language. The analyzer should name the involved connector and
object IDs so the agent can choose whether and how to distribute ports; it must
not move endpoints, reroute edges, or infer design intent.

Then rerun the unchanged observability benchmark and measure whether the author
resolves the ingress collision without adding another long correction loop.

The complete sanitized record is
`research/data/exp-0018-relationship-review-replication-v1.json`. Room
credentials, raw sessions, semantic state, and pixels remain private and
gitignored.
