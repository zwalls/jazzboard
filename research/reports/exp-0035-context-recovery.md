# EXP-0035 — Existing-board context recovery

**The eight-attempt study did not demonstrate an improvement.** Both fully
accepted matched edit pairs were slower on the candidate. The preregistered
advancement rule was not met. No attempts were replaced or excluded.

All work remains on `codex/webmcp-context-recovery`. The frozen baseline was
`f7762da4ea7d1603671a35b4912143c4bff83f34`; the candidate was
`55ed2446fa0b8b91c9602d50881ebc38a61d3514`. Both ran locally from independent
archives with copied dependencies. Nothing was merged or deployed.

## Results

Each author was a fresh projectless `gpt-5.6-terra` task with medium reasoning.
The fixture, scorer, task packet, schedule, and starting rooms were frozen before
release. An independent controller graded authoritative before/after state and
the exact final JSON answer.

| Attempt | Condition | Task | Frozen grade | Accepted time | Host calls / failed |
| --- | --- | --- | --- | --- | --- |
| 01 | Baseline | Inventory 1 | Pass | 49.377 s | 5 / 1 |
| 02 | Candidate | Inventory 1 | Fail: Mac locked | — | 1 / 1 |
| 03 | Candidate | Edit 1 | Pass | 81.471 s | 5 / 0 |
| 04 | Baseline | Edit 1 | Pass | 55.637 s | 7 / 0 |
| 05 | Candidate | Inventory 2 | Pass | 71.002 s | 6 / 0 |
| 06 | Baseline | Inventory 2 | Fail: extra zero-count keys | — | 5 / 1 |
| 07 | Baseline | Edit 2 | Pass | 65.706 s | 10 / 3 |
| 08 | Candidate | Edit 2 | Pass | 75.823 s | 12 / 2 |

Both conditions passed 3/4 under the frozen exact grader. The candidate's failed
attempt never reached the app: it reported the locked Mac after 8.216 seconds.
The remaining assignments paused until the user instructed continuation. That
host failure is not evidence of an application correctness regression.

Baseline attempt 06 returned the correct counts and names but added zero-valued
`connector`, `image`, and `draw` keys. Its 52.993-second task duration is not an
accepted completion time. The failure is exact-output formatting, not a false
inventory. Every completed edit changed exactly the 12 intended questions and
preserved protected content; all inventory attempts preserved the document.

The two fully accepted matched pairs favor baseline by **25.834 seconds** and
**10.117 seconds**. Neither inventory pair supplies two accepted times.
Descriptive accepted-time medians are 55.637 seconds for baseline and 75.823
seconds for candidate; their task mix differs, so they are not a causal estimate.

## What the traces show

Candidate attempt 05 used the new room summary after first requesting a full
room read that was truncated. Its summary response was complete and 2,304 UTF-8
bytes. This demonstrates that the new recovery path was usable, but not that
authors reliably chose it first or became faster.

In edit pair 1, the candidate issued 12 serial `update_object` calls inside one
host call; baseline batched 12 operations in one transaction. Both builds
exposed both workflows. This observed choice helps explain the time difference
but cannot establish that the candidate caused it. The candidate's scoped query
used fields available in both conditions. Candidate attempt 08 used the new
exact-ID query around a batched transaction. No attempt exercised continuation
pagination, and this study did not test draft recovery.

Host-call failures and native WebMCP failures are distinct. For example,
baseline attempt 07 received a native `INVALID_TOOL_INPUT` response after
including the read-only `resolvedAt` field, then corrected its batch. That native
error appeared inside a completed host call and is not in the table's failed
host-call count. No state changed on the rejected request.

## Measurement and isolation limits

Complete read-response byte comparisons are unavailable. Some outputs were
truncated; others combined several reads or mutations in one host call or
printed an author-reduced result. The parser's partial textual totals therefore
cannot be compared as complete response totals. Native metadata supplies
individual observed entries and complete per-entry output strings, but lacks
a completeness/capping signal. No exact runtime-call total, hidden bytes, or
token count is inferred.

The fresh tasks had no prior conversation history, but inherited global
instructions and a task-creation envelope. The claim is identical
experiment-specific packets, not that those packets were their entire context.
Same-origin browser storage also exposed recent-room links from earlier
attempts and preflights. No author opened another room or used shell, repository,
direct HTTP, page evaluation, or another author's transcript. Nevertheless,
the visible room references are a material isolation limitation; these were
not clean browser sessions.

Four matched pairs are a small development pilot, with only two fully accepted
pairs here. Even without these limitations it would not establish a general
statistical or percentage improvement.

## Decision and next experiment

The frozen advancement rule required four candidate passes and lower accepted
wall time plus complete read bytes in at least three pairs. It was not met.
Retain the feature as experimental; do not market these results as improved
agent performance.

The next candidate should test clearer summary-first discovery and batched
metadata-edit guidance. Those are hypotheses suggested by the traces, not
validated fixes. Before another study, isolate browser storage, confirm unlocked
host access before each release, capture complete native tool telemetry, and
preregister whether extra zero-count keys are allowed. Do not retroactively
relax this study's grader or replace its blocked attempt.

## Evidence and validation

Public results and evidence hashes are in
`research/data/exp-0035-context-recovery-v1.json`. Raw traces, release receipts,
authenticated controller evidence, and before/after snapshots are retained in
the ignored local directory `.research-private/exp0035-context-recovery` and
the working directory `/private/tmp/exp0035`. Cookies and room access details
are not included in public results.

The parser was adapted to actual retained message shapes and error-result text;
the frozen product builds, public packet, fixtures, and correctness scorer were
not changed after release. Every grade records the final parser and input
hashes. Focused tests validate the experiment machinery; they are not evidence
of improved author outcomes.

Final validation: 18 focused tests passed, changed parser lint passed, and
`git diff --check` passed. Evidence copies were checked against their recorded
hashes. Main remained at the baseline commit.
