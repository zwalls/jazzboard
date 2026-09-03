# EXP-0026 compact draft-receipt unchanged replication

- Date: 2026-09-03
- Status: complete; directionally replicated with all quality gates passed
- Product candidate: `8ed1618` (unchanged from EXP-0025)
- Benchmark: unchanged `dev-architecture-create-observability`
- Author: fresh projectless `gpt-5.6-terra`, reasoning `medium`
- Reviewers: two separate fresh projectless `gpt-5.6-sol`, reasoning `high`

## Result

The unchanged replication preserved the positive direction but exposed material
run-to-run variance. Total draft-response payload was 54,126 bytes, 58.3% below
EXP-0024's 129,888 bytes. The author used three correction patches instead of
four. Total wall time was 236,449 ms, 5.7% below EXP-0024's 250,682 ms.

The run also carried extra setup friction not present in EXP-0025: one failed
read of a nonexistent browser-skill path and one redundant full tool-list read.
Despite that, all WebMCP business calls succeeded, the author skipped the deeper
architecture capability bundle, and the completed artifact passed every quality
gate.

The authoritative audit matched all six required components and all five
correctly directed relationships. The final deterministic geometry audit had one
non-blocking title/subtitle spacing warning, zero connector crossings, and zero
congested ports. Both blinded pixel reviewers independently passed facts, planes,
viewport readability, diagram membership, and unsupported-assertion checks with
zero blocking geometry violations.

## Two-run interpretation

EXP-0025 and EXP-0026 both pass quality and improve every targeted direction
relative to the single immediately preceding EXP-0024 run. Their post-change wall
times span 161,551-236,449 ms and average 199,000 ms, descriptively 20.6% below
EXP-0024. Their draft payloads average 42,921.5 bytes, descriptively 67.0% below
EXP-0024, and correction patches average 2.5 instead of four.

The large wall-time range is a warning against reporting the 20.6% figure as an
average causal effect. What is replicated is the direction: both runs reduced
payload, correction count, and wall time without losing factual or visual
quality. That is enough to advance the unchanged candidate to a different large
architecture benchmark, not enough to claim a population-level percentage.

The complete sanitized record is
`research/data/exp-0026-compact-draft-receipt-replication-v1.json`. Room
credentials, raw sessions, semantic state, and pixels remain private and
gitignored.
