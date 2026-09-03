# EXP-0025 compact draft-receipt replication

- Date: 2026-09-03
- Status: complete; large speed signal with all quality gates passed, replication required
- Product candidate: `8ed1618`
- Benchmark: unchanged `dev-architecture-create-observability`
- Author: fresh projectless `gpt-5.6-terra`, reasoning `medium`
- Reviewers: two separate fresh projectless `gpt-5.6-sol`, reasoning `high`

## Result

The compact receipt produced the first large aligned speed signal in this line of
experiments. Across the complete draft loop, response payload fell from 129,888
bytes in EXP-0024 to 31,717 bytes, a 75.6% reduction. The author needed two
correction patches instead of four. Total wall time fell from 250,682 ms to
161,551 ms, a 35.6% reduction. Host execution fell 14.2%, while accounted model
and coordination time fell 39.8%.

The author did not load a deeper architecture capability bundle. The compact
receipt omitted duplicated preview objects, diagrams, structured findings, and
the structured recommended-correction block. It retained draft identity,
temporary references, exact relationship review, validation counts, and the
complete `canonicalDraftCorrectionJson`. That scalar was the only detailed
finding surface in concise mode. The author used its named object and connector
references to resolve four initial findings in two patches, so behavioral use of
the lossless correction transport is directly observed even though no explicit
JavaScript `JSON.parse` call appeared in the trace.

Quality remained intact. The authoritative audit matched all six required
components and all five correctly directed relationships. The final deterministic
geometry report passed with complete coverage, zero findings, zero crossings,
zero congested ports, and 33 canvas units of minimum member spacing. Both
independent blinded pixel reviewers returned an overall pass with zero blocking
geometry violations, no unsupported assertions, and no reversed relationships.

The author again used a clip for the first pixel capture even though the returned
contract preferred a clean full viewport. That capture was blank; the author used
the bounded one-retry recovery and completed pixel inspection successfully. This
known inspection friction did not improve and should remain a separate candidate.

## Interpretation

The payload, correction-count, host-time, model/coordination-time, and total-time
movements all point in the same direction, while every quality gate passed. This
is promising evidence that concise response design can make Jazzboard materially
faster without precomputing layout or reducing agent control.

It is still one post-change run. Model variance and the different initial layout
can contribute to the observed wall-time difference, so this record does not
claim a 35.6% average improvement or causal effect. The next step is an unchanged
fresh-room replication on the same frozen benchmark. If that remains positive,
the candidate should then be exercised on a different large architecture task to
test generalization before promotion.

The complete sanitized record is
`research/data/exp-0025-compact-draft-receipt-replication-v1.json`. Room
credentials, raw sessions, semantic state, and pixels remain private and
gitignored.
