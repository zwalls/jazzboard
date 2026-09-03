# EXP-0027 compact-receipt dense-routing generalization

- Date: 2026-09-03
- Status: complete; cross-task speed-with-quality generalization failed
- Product candidate: `8ed1618` (unchanged from EXP-0025 and EXP-0026)
- Benchmark: frozen `dev-architecture-stress-dense-routing`
- Author: fresh projectless `gpt-5.6-terra`, reasoning `medium`
- Reviewers: two separate fresh projectless `gpt-5.6-sol`, reasoning `high`

## Result

The compact receipt did not generalize to this dense-routing task. The isolated
author reached a terminal result in 381,018 ms, 41.1% slower than the matched
EXP-0004 candidate's 270,038 ms. It used 20 WebMCP calls instead of 10 and nine
draft transactions instead of six. Because the artifact failed its visual
quality gate, 381,018 ms is not an accepted-completion time and must not be
reported as a speed result.

The draft correction sequence is the important diagnostic. An initial draft
with 18 findings fell to two warning-level findings after eight patches, but
the sequence was non-monotonic: finding counts were 18, 11, 9, 4, 3, 2, 5, 3,
and 2. After publication, the author spent another 75,485 ms on four direct
correction attempts, one rejected and three accepted, before restoring the
visually defective long route it had started with. Total draft-response payload
was 186,418 bytes.

## Quality result

Semantic correctness was perfect. The authoritative audit matched all nine
required nodes and all nine correctly directed relationships, with one coherent
first-class Diagram and no unsupported facts.

Visual routing failed. The final deterministic Diagram-only analysis reported
five warnings: two port-congestion facts, two connector crossings, and one
connector-label/edge collision. More importantly, it did not expose that the
Monitor-to-Service-A route left the separate fixed evaluation scaffold. Both
blinded pixel reviewers independently failed `criterion-dense-routing`, passed
facts and anti-gaming, and identified that same out-of-frame essential route.
One also identified central route intrusion over the fixture label; the other
identified shared-terminus and crossing ambiguity.

## Interpretation

Compact receipts remain worth retaining: two unchanged observability runs
passed every gate while reducing payload and wall time. EXP-0027 shows that
response size is not the dominant bottleneck for dense routing. The missing
context is an objective relationship between connector routes and the requested
containing scaffold. The agent could see and name the visual problem, but its
available scalar route controls and Diagram-only findings led to correction
oscillation instead of convergence.

The next intervention should expose fixed-frame and containing-scaffold route
facts in the narrow inspection/correction context. It must not choose a layout,
route, or aesthetic on the agent's behalf. The author retains creative control;
Jazzboard supplies better evidence for reasoning and self-correction. Rerun this
same frozen benchmark after that intervention before broadening the batch.

The complete sanitized record is
`research/data/exp-0027-compact-receipt-dense-routing-generalization-v1.json`.
Private room credentials, raw sessions, semantic state, and pixels remain
gitignored.
