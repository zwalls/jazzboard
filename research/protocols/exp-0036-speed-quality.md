# EXP-0036 — Speed with diagram and illustration quality

Status: candidate, packet, and measurement preparation complete; author release
awaits explicit authorization for the new tasks and per-attempt fresh preflight.
No live author attempts have started. EXP-0035 remains unchanged.

## Product question

Does task-aware scoped discovery and atomic batching improve existing-board work
without sacrificing technical-diagram correctness, illustration quality, or
accepted completion speed? More tools and smaller individual responses are not
success criteria by themselves.

The candidate keeps full reads compatible, preserves revision checks and draft
delivery, and preserves final exact-revision pixel inspection. It changes tool
discovery/guidance, not the agent's artistic geometry or the correctness grader.
Broad inventory/orientation uses a summary first; an already-known narrow scope
goes directly to a scoped query. An extra orientation read is not mandatory.
All changes stay on `codex/webmcp-context-recovery`; no merge or deployment.

## Proposed paired study

Eight fresh projectless Terra/medium authors, one baseline/candidate pair per
task, sequential and order-balanced. Freeze both exact commits, dependencies,
observer patch, task packets, grader/reviewer instructions, seed, schedule,
viewport, and acceptance thresholds before releasing any author.

1. Existing-board inventory from EXP-0035, new seed: baseline then candidate.
2. Existing-board metadata edit from EXP-0035, new seed: candidate then baseline.
3. `dev-architecture-create-checkout` from `development-v2.json`: candidate then baseline.
4. `dev-drawing-create-layered-portrait` from `development-v2.json`: baseline then candidate.

Creation tasks retain their complete public packets and existing evaluation
criteria. They are controls for regression and part of the product's long-term
quality target. This pilot cannot establish best-in-class or unprecedented
speed. Broader claims require larger independent replication across diagram
complexity, illustration styles, and collaboration stressors.

## Release prerequisites

- Independent author task with no inherited transcript or evaluator context.
  Record unavoidable platform/global instructions rather than claiming the
  task packet is the whole context.
- A fresh storage origin **and** signed guest session for every attempt.
  A different port alone is insufficient for host-scoped cookies. Verify that
  no prior recent-room reference is visible before release.
- Verified browser availability and unlocked host immediately before release.
  If access fails after release, retain that attempt; never silently replace it.
- Complete passive native execution ledger: sequence/epoch, actual input/output
  byte counts, success/structured failure/throw, pending-call accounting, and an
  explicit sealed-complete flag. Loops count actual invocations. Missing,
  truncated, unsealed, or restarted capture cannot produce a valid byte total.
- Observer calibration on both builds: identical descriptors/results, no
  additional authorization, no author coaching, and bounded measured overhead.
- Authoritative initial state and exact build identity verified before release.

The existing host JSONL remains the source of author wall time and host-call
evidence. Its partial output is not a substitute for complete native telemetry.
The passive recorder is controller infrastructure; authors cannot query it.
An adapter or validation unit test alone does not prove live capture works.
The synthetic adapter/collector calibration uses a 267,642-byte JSON result,
three warmups, and ten measured calls. The declared screen is at most 20 ms
median and 50 ms p95 added callback latency, preserved result identity, and a
complete sealed collector receipt. Report acknowledgement latency separately.
The initial Node/VM method failed this screen (approximately 169.941 ms median).
Before any author run, calibration was amended to execute the generated module
in Chromium 151 rather than a fresh Node VM context; that measured 13.900 ms
median and 18.090 ms p95. Node/ESM also measured 10.456 ms median. Preserve the
method change and all outcomes; do not present the VM result as passing or
claim a universal overhead bound. These are synthetic callback measurements,
not native WebMCP or author latency. Live native smoke passed separately on
both frozen builds. Never subtract synthetic estimates from author times.

## Quality gates

Inventory: exact counts and named targets, no document mutation. The v1 packet
allows supported absent kinds to be omitted or included with exact zero counts;
unknown kinds fail. EXP-0035's frozen formatting rule and outcomes are unchanged.

Metadata edit: exact target lifecycle updates, authoritative revision advances,
all unrelated objects and visual properties preserved. Grade from independent
before/after state, not the author's completion claim.

Technical creation: exact supplied entities and directed relationships, no
invented facts, correct trust boundary, readable labels and routes, coherent
Diagram membership, and final pixel inspection. Use the existing authoritative
architecture audit in conjunction with independent blinded visual review.

Illustration: recognizable requested parts, cohesive palette/treatment,
deliberate layering, focal hierarchy, and no unintended essential-part loss.
Require independent final pixels and two blinded Sol/high reviewers per
creation pair (four reviewer tasks total). Each separately grades both neutral
artifact labels against the frozen rubric and records a quality preference or
tie. Randomize display order before review. Reviewers get the public task,
frozen rubric, sanitized final states, and pixels; no author transcript,
condition label, timing, room credential, or peer verdict. Preserve artistic
freedom and intentional overlap.

## Analysis to freeze before release

Correctness and visual acceptance are prerequisites for efficiency comparisons.
Report every attempt, failure category, every paired time difference, complete
native read/output totals, actual failed calls, observer overhead, and mechanism
uptake. Failed artifacts receive no artificial accepted completion time.

The prospective advancement rule is deliberately conjunctive:

- All four candidate artifacts pass every applicable hard gate, including both
  independent reviews for each creation artifact.
- Both matched existing-board pairs have accepted results in both arms, with
  candidate completion time and complete native read bytes no higher than
  baseline, and at least one strict time improvement.
- Both creation pairs have accepted results in both arms, neither reviewer
  prefers baseline quality, and neither candidate takes more than 110% of its
  baseline's accepted completion time. This 10% pilot tolerance is a declared
  screening margin, not statistical evidence of non-inferiority.
- Candidate median accepted time across all four tasks is below baseline.
- Capture is complete and observer calibration passes for both arms. Missing
  measurements or disputed visual gates make advancement inconclusive.

Report every difference, including any slowdown inside the screening margin.
A small mixed-task pilot can reject a poor candidate or motivate replication;
it cannot prove population-level speed non-inferiority. Do not convert reviewer
ordinal scores into quality percentages.

## Current boundary

This document is a preparation record, not an author outcome. Exact packets,
commits, seeds, and reviewer contracts are in `exp-0036-frozen-packet-v1.md`.
Live storage isolation and complete browser-only native capture were verified
in controller smoke checks; the evidence and calibration amendment are in
`../reports/exp-0036-preparation.md`. Each real attempt still requires fresh
infrastructure/session admission and its own complete terminal receipt. The
next step requires explicit authorization for eight new author tasks and four
new blinded reviewer tasks. None has been created.
