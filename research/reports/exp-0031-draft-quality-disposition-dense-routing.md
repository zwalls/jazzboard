# EXP-0031 draft-quality-disposition replication

- Date: 2026-09-03
- Status: complete; factual gate passed, visual quality gate failed
- Product candidate: `da45a40`
- Benchmark: unchanged frozen `dev-architecture-stress-dense-routing`
- Author: fresh projectless `gpt-5.6-terra`, reasoning `medium`
- Reviewers: two separate fresh projectless `gpt-5.6-sol`, reasoning `high`

## Result

The autonomous draft-quality-disposition contract changed author behavior in
the intended direction. The author created all nine required entities and all
nine directed relationships. It reduced the initial draft from 19 fail-level
and four warning-level findings to zero fail-level and one warning-level
finding before committing. The commit required no user confirmation, carried
the `passed` quality disposition, and did not use an intentional-failure
acknowledgement.

The quality improvement was substantial but incomplete. Both independent
blinded reviewers passed factual accuracy and anti-gaming, then failed routing
on the same remaining crossing: the Monitor-to-Service-A observation route
intersects the Service-A-to-Event-Bus event route beside Service A, creating a
tangled junction. The authoritative analyzer independently reported the same
single `CONNECTOR_CROSSING` warning.

Author wall time was 553,909 ms. That is 281,077 ms slower than EXP-0030
(+103.02%) and 252,518 ms slower than EXP-0029 (+83.78%). The author used 24
WebMCP business calls, including 16 accepted draft transactions, and consumed
253,607 accepted draft response bytes. It reached a zero-finding draft at
revision 5, then pixel inspection found an obscured preserved frame title.
Moving the Gateway to fix that visual defect triggered a long sequence of
route corrections. Revisions 6 through 16 alternated between fail and warning
states around Service A without eliminating the final crossing.

This is a real quality gain and a real speed regression. It is not an accepted
speed-quality improvement.

## Scientific interpretation

The commit contract closed EXP-0030's premature-termination failure mode. A
conventional architecture author no longer committed a draft with known
fail-level findings. The live WebMCP QA also proved the intended autonomy
boundary: an unresolved fail was rejected with `stateChanged:false`, exact
finding keys, and an active recoverable draft; the same geometry committed
without human approval when a separate deliberate-overlap QA task supplied an
exact agent-authored rationale.

The new bottleneck is counterfactual route reasoning. Each applied connector
patch reveals only the conflicts created by that chosen patch. The author
therefore serially explores route alternatives by mutating the visible draft,
and a local improvement can introduce a new collision or crossing. The current
tools describe the resulting scene well, but do not let the agent compare
several self-authored correction strategies before selecting one.

The next intervention should be a bounded, read-only draft patch-candidate
evaluator. Given the exact draft revision and two to eight agent-authored
alternative patch sets, Jazzboard should apply each alternative only in memory
and return deterministic deltas: fail/warning counts, finding keys, affected
routes, route-conflict clusters, spacing, and whether the alternative improves
or regresses the baseline. The tool must not select, apply, route, lay out, or
render on the agent's behalf. The agent remains the decision-maker, applies one
chosen patch through the existing transaction tool, then performs pixel QA on
that selected result.

This targets correction-loop latency without reducing author capability or
hiding visible construction progress.

## Protocol notes

The author used WebMCP for every canvas read and write. No WebMCP business call
failed. The author inspected draft pixels before commit and authoritative
semantic state and pixels after commit. Both reviewers received only the
frozen public requirement, rubric, sanitized semantic state, and final PNG.
They received no room credential, condition label, author transcript, paired
result, or repository access.

Exact tokens, resolved model snapshot, and subscription usage were
unobservable and were not estimated.

The complete sanitized record is
`research/data/exp-0031-draft-quality-disposition-dense-routing-v1.json`.
Private room credentials, raw sessions, semantic state, pixels, and exact
canvas object identifiers remain gitignored.
