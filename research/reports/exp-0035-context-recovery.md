# EXP-0035 — Existing-board context recovery

Status: paused after two of eight scheduled attempts. Improvement is not proven.

The protocol, fixture generator, scorer, author packet, and starting rooms were
frozen before the first author task. Each author is a fresh projectless
`gpt-5.6-terra` task with medium reasoning, using native browser WebMCP against
one of two frozen localhost builds. Main and production were not changed.

| Attempt | Condition | Task | Outcome | Accepted completion time |
| --- | --- | --- | --- | --- |
| 01 | Baseline | Inventory 1 | Semantic pass; document preserved | 49.377 s |
| 02 | Candidate | Inventory 1 | Host blocked: Mac locked | — |
| 03–08 | Scheduled | Remaining pairs | Not released; waiting for unlock | — |

Attempt 02 ended with an explicit lock-screen blocker after 8.216 seconds. This
is an observed failed attempt, not a candidate completion time or an application
correctness regression. It remains in the dataset and will not be replaced.
The remaining six attempts are paused until the user restores browser access.

The baseline inventory answer matched every requested count and exact semantic
name. Independent before/after snapshots confirmed no document mutation. Its
trace contains five completed host calls, including one failed host call. Host
metadata reports truncation, so incomplete textual output is not treated as a
complete byte measurement.

No matched efficiency conclusion is possible from the released pair. The
preregistered advancement rule requires all four candidate semantic passes and
complete measurements; it cannot be satisfied by this interrupted run as
currently recorded. Completing the remaining assignments can still reveal
correctness and mechanism behavior, but must not erase the transport failure.

Raw session traces, release receipts, authenticated controller evidence, and
before/after snapshots are retained under `/private/tmp/exp0035`. Public data
records their hashes without cookies or room access details. The private
directory is temporary and must be retained if these local artifacts are needed
after system cleanup.

The experiment infrastructure passed 17 focused tests and scoped lint checks.
These validate the experiment machinery, not an improvement in author outcomes.
