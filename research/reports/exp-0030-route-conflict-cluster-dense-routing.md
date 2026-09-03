# EXP-0030 route-conflict-cluster replication

- Date: 2026-09-03
- Status: complete; factual gate passed, visual quality gate failed
- Product candidate: `f3c9ceb`
- Benchmark: unchanged frozen `dev-architecture-stress-dense-routing`
- Author: fresh projectless `gpt-5.6-terra`, reasoning `medium`
- Reviewers: two separate fresh projectless `gpt-5.6-sol`, reasoning `high`

## Result

The route-conflict-cluster candidate correctly exposed two fail-level conflict
clusters before commit. The author created all nine required entities and all
nine directed relationships, but committed after only two accepted draft
transactions while the deterministic inspector still reported 17 fail-level
and nine warning-level findings. Eight endpoint re-entry findings, two route
ambiguity clusters, label collisions, object intrusions, crossings, and tight
spacing remained in authoritative state.

Both blinded reviewers failed factual readability, routing, and anti-gaming.
The underlying semantic state contained every requested fact, but the rendered
artifact did not visibly communicate several of them: the `write` label was
hidden by `replication`, the Client request label covered its short route and
arrowhead, multiple curves formed ambiguous junctions, and central labels and
nodes occluded one another.

Author wall time was 272,832 ms, 28,559 ms faster than EXP-0029 (-9.48%). That
is not a quality-qualified speed improvement. The author used only nine WebMCP
business calls, two accepted draft transactions, and 60,564 accepted draft
response bytes because it stopped correcting an artifact it explicitly knew
still had geometry failures. Compared with EXP-0029, accepted draft traffic
fell 58.14%; the reviewers show that this was premature termination rather
than more efficient convergence.

## Scientific interpretation

The candidate worked as an evidence mechanism: its two holistic clusters
matched the reviewers' central false-junction and label-association concerns.
Passive evidence alone was insufficient to make the author continue. The
current `finish_canvas_draft` contract allows an agent to acknowledge in prose
that quality remains poor and still commit without accounting for those exact
findings.

The next intervention should be an autonomy-preserving commit contract. When a
draft has fail-level deterministic findings, the agent must either resolve them
or explicitly acknowledge every stable finding key with a short rationale
explaining why that geometry is intentional. The server must reject missing,
unknown, or stale acknowledgements without mutating the room, while retaining
the draft and returning exact recovery instructions. This preserves deliberate
overlap for illustration and freeform drawing; it does not auto-route, move,
or compose anything for the agent.

Any acknowledged failure remains visible experimental evidence and cannot
count as a quality pass. Conventional architecture authors should normally
resolve these findings, whereas an illustration author may intentionally
preserve them.

## Protocol notes

The author used WebMCP for all canvas reads and writes. Two host calls failed
before the authoring path stabilized; two WebMCP business calls failed without
an accepted room mutation. The author inspected both unpublished draft pixels
and authoritative pixels. Exact tokens, resolved model snapshot, and
subscription usage were unobservable and were not estimated.

The complete sanitized record is
`research/data/exp-0030-route-conflict-cluster-dense-routing-v1.json`.
Private room credentials, raw sessions, semantic state, pixels, and exact canvas
object identifiers remain gitignored.
