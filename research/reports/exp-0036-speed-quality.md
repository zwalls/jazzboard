# EXP-0036 — Speed with diagram and illustration quality

Status: completed. The user elected to retain the implementation on
`codex/webmcp-context-recovery` for now. This is a branch-retention decision,
not a finding of proven improvement or authorization to merge or deploy.

## Change tested

The baseline was `f7762da4ea7d1603671a35b4912143c4bff83f34`; the frozen
candidate was `5a67b21505b50c643bf282774f0e7bf4698edf05`.
The candidate combines bounded summaries and scoped reads with task-aware
WebMCP descriptions and guidance: broad inventory starts with a summary,
known scopes go directly to queries, related metadata edits use atomic
revision-guarded batches, and blank creation skips unnecessary reads.
Full records, correctness checks, draft delivery, and final pixel inspection
remain available. Research-only changes after those commits did not change
the frozen author builds.

## Results

All eight authorized authors and four independent blinded reviewers completed.
Authors were fresh projectless Terra/medium tasks, run sequentially in the
frozen order. Reviewers were Sol/high, with neutral labels and reversed order,
public criteria, sanitized state, and exact-revision PNGs only.

| Task | Baseline wall time | Candidate wall time | Observed difference | Task acceptance |
| --- | ---: | ---: | ---: | --- |
| Inventory | 48.325 s | 43.756 s | −4.569 s | Both pass |
| Metadata edit | 79.686 s | 69.159 s | −10.527 s | Both pass |
| Checkout diagram | 146.956 s | 121.740 s | −25.216 s | Both pass |
| Layered portrait | 233.038 s | 137.717 s | −95.321 s | Both pass |

These are descriptive host-clock observations, not valid paired causal speed
estimates. Every pair includes an attempt with incomplete measurement evidence.
No replacement attempt was run and no missing byte total was estimated.

Inventory and metadata edits passed the frozen exact-answer and protected-state
checks. Both diagrams passed the authoritative audit: four required entities,
three directed relationships, no unmatched connectors, and zero blocking
findings. All four creation artifacts passed every criterion with both reviewers.

Diagram preferences split: one reviewer preferred baseline's compact composition,
contrast, and legend; the other preferred candidate's explicit relationship
labels and spacious curved routing. Both portrait reviewers preferred baseline,
citing its cleaner silhouette, more legible hand, stronger face-first hierarchy,
and fewer distracting details. The candidate's larger hand and low-contrast
caption reduced polish despite passing the task criteria.

The prospective advancement rule was not met: it required no baseline visual
preference and complete measurement evidence. Speed-and-quality improvement
remains unproven. The user's decision is to keep the candidate isolated on its
feature branch, without promotion to main.

## Measurement validity and limitations

| Attempt | Task/build | Comparative native telemetry |
| --- | --- | --- |
| 01 | Inventory baseline | Ineligible: delayed closure was not acknowledged; unsealed ledger |
| 02 | Inventory candidate | Valid |
| 03 | Metadata candidate | Ineligible: stale admission proof, despite sealed trace |
| 04 | Metadata baseline | Valid |
| 05 | Diagram candidate | Valid |
| 06 | Diagram baseline | Ineligible: full navigation restarted recorder sequencing |
| 07 | Portrait baseline | Valid |
| 08 | Portrait candidate | Ineligible: full navigation restarted recorder sequencing |

Attempt 01's close request arrived about 59.5 seconds after completion; context
disposal is a hypothesis, not an observed cause. A controller watcher subsequently
requested closure within 0–2 ms of completion. Attempt 03's controller helper
error delayed admission evidence beyond the freshness gate; it was not backdated.
Full page navigation in attempts 06 and 08 restarted stream sequencing and caused
rejected events. That observer limitation remains unresolved; frozen observers
were not changed midway through the study.

The candidate inventory author demonstrably used a summary followed by a scoped
query. Both metadata authors used one atomic transaction, so batching alone
cannot explain that time difference. The candidate diagram skipped room-state
reads. Single pairs cannot establish causality or general speed superiority.

The pre-author execution amendment required an empty native recent-room check
and used calibrated isolation plus fresh native host availability. No mandatory
room read was added. Author viewports were uncontrolled. Independent captures
used a 1400×1000 CSS-pixel viewport, DPR 1, padding 32, and exact document revision.
Controller capture was corrected to ignore only volatile participant presence
and stateRevision while preserving document equality and raw differences, and
to respect each frozen build's registered read schema. Failed capture checks
were retained; capture did not change author documents or collector receipts.

Synthetic recorder calibration passed its amended Chromium screen at 13.900 ms
median and 18.090 ms p95 callback overhead. The earlier failed VM measurement
remains documented; synthetic overhead was not subtracted from author times.

## Validation and evidence

Final experiment verification: 53 tests across nine files passed, with TypeScript
and targeted ESLint passing. Earlier product verification included 343 focused
checks and a production build. These checks do not substitute for live evidence.

[Native measurement results](../data/exp-0036-native-results.json) preserve
per-attempt validity, counts, and evidence hashes; ineligible comparative byte
fields are null. Raw sessions, controller states, signed receipts, all four
review results and validations, and exact final PNGs remain in private research
evidence. No credentials or raw author transcripts are included here.

See the [preparation report](./exp-0036-preparation.md),
[study protocol](../protocols/exp-0036-speed-quality.md),
[frozen packet](../protocols/exp-0036-frozen-packet-v1.md), and
[execution amendment](../protocols/exp-0036-execution-amendment-v1.md).
