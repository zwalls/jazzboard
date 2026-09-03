# EXP-0012 authoring-loop speed replication

- Date: 2026-09-02
- Status: complete; same-commit speed signal replicated with frozen quality gate
- Product candidate: `3f9a66c82d5b9aaa8eaf7b1966a9be02b543307a`
- Author: fresh projectless `gpt-5.6-terra`, reasoning `medium`
- Reviewer: separate fresh projectless `gpt-5.6-sol`, reasoning `high`

## Result

The independent reviewer passed all frozen semantic and visual criteria with
zero blocking geometry violations. The final artifact has the required trust
boundary, four entities, three correctly directed and labeled relationships,
coherent first-class Diagram membership, and a readable blue-versus-orange
distinction between synchronous and asynchronous flow.

The author completed in 146,890 ms using seven WebMCP calls. Together,
EXP-0011 and EXP-0012 form a tight passing range of 146,890-152,494 ms with a
mean of 149,692 ms. That pair is descriptively 44.5% faster than the immediately
preceding passing pair, EXP-0009 and EXP-0010, and 12.9% faster than the earlier
best passing checkout run, EXP-0005. This replicates the directional signal; it
is still not a population effect estimate.

## Mechanism evidence

The author again avoided every transaction-contract recovery seen in EXP-0010.
It produced one complete draft and used two precise patches. Draft validation
progressed from 7 failures and 1 warning, to no failures and 1 warning, to no
findings. The final exact clip passed the blinded visual review.

The remaining two host failures occurred during generic browser setup rather
than Jazzboard authoring: one obsolete local skill path and one unsupported
documentation call on the already valid WebMCP capability handle. Neither
changed room state.

## Timing attribution

- Total wall time: 146,890 ms
- Accounted wall time: 147,000 ms
- Host execution: 28,473 ms (19.4%)
- Model and coordination: 118,527 ms
- Capability discovery: 39,108 ms
- Initial authoring: 68,205 ms
- Draft finish: 8,711 ms
- Inspection: 13,120 ms
- Final authoritative read: 12,831 ms

Exact model reasoning time, tokens, and per-task subscription usage remain
unobservable.

## Decision

Freeze the current product candidate as the simple-architecture speed baseline.
Do not keep tuning on the same small checkout task. The next experiment should
use a larger architecture requirement on the unchanged candidate and measure
how authoring, draft correction, presentation, and inspection scale. That gives
us evidence for the next product intervention without overfitting to one graph.

The full sanitized record is
`research/data/exp-0012-authoring-loop-speed-replication-v1.json`. Private room
credentials, raw sessions, semantic packets, and pixels remain outside Git.
