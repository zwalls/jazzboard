# Results

Check in aggregate reports and claim manifests here. Preserve every attempted
run in the underlying run registry, including failures and timeouts; never
select only favorable videos.

Reports must separate authoring quality, self-correction, efficiency,
presentation UX, and reliability. State both absolute and relative changes,
include uncertainty intervals, and list every guardrail. Human preference
results are reported as blinded win rates or percentage-point changes—not as an
unsupported percentage increase in beauty or intelligence.

Per-run transcripts, screenshots, and videos belong under `results/runs/` or an
external artifact store and are ignored by Git. Publish their hashes in the
aggregate report.

`exp0001a-terra-medium-qualification-v1.json` retains the digest-bound outcome
of the three-task Terra/medium author qualification. Its companion narrative
report is `../reports/exp0001a-terra-medium-qualification-v1.md`. The gate
failed, the seeded edit task is explicitly retained as invalid setup, and the
48-attempt A/A remains blocked.
