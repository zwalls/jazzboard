# EXP-0011 authoring-loop speed validation

- Date: 2026-09-02
- Status: complete; frozen quality gate passed, single-run speed signal requires replication
- Product candidate: `3f9a66c82d5b9aaa8eaf7b1966a9be02b543307a`
- Author: fresh projectless `gpt-5.6-terra`, reasoning `medium`
- Reviewer: separate fresh projectless `gpt-5.6-sol`, reasoning `high`

## Result

The independent reviewer passed every frozen semantic and visual criterion with
zero blocking geometry violations. The final artifact contains the required
trust boundary, all four entities, three correctly directed relationships,
coherent first-class Diagram membership, and a readable visual distinction
between synchronous and asynchronous flow.

The author completed in 152,494 ms with nine WebMCP calls. This is 118,123 ms
(43.6%) faster than EXP-0010 and 19,447 ms (11.3%) faster than the previous
best passing checkout run, EXP-0005. These are descriptive deltas for one fresh
attempt, not a population claim. The candidate must replicate before we
attribute the gain to the product changes.

## Mechanism evidence

The accepted candidate removed the contract-recovery failures seen in
EXP-0010. The author did not need a transaction alias or draft-Diagram recovery
call, and reached a clean deterministic candidate in three accepted draft
transactions rather than seven transaction attempts and four accepted draft
revisions. Draft fail/warning counts progressed from 5/1 to 3/2 to 0/0.

The two remaining failures were outside the canvas contract:

- the isolated author tried one obsolete browser-skill path;
- one capability call used a stale WebMCP snapshot captured before room tool
  registration and succeeded after refreshing the snapshot.

The final browser capture is compact and readable. The trust boundary is clear,
the external browser is visually outside it, all internal services are inside,
and connector labels remain legible without crossing unrelated nodes.

## Timing attribution

- Total wall time: 152,494 ms
- Accounted wall time: 152,000 ms
- Host execution: 32,280 ms (21.2%)
- Model and coordination: 119,720 ms
- Capability discovery: 50,893 ms
- Initial authoring: 65,010 ms
- Draft finish: 9,419 ms
- Inspection: 23,184 ms

Exact model reasoning time, tokens, and per-task subscription usage remain
unobservable.

## Reviewer output transport note

The reviewer twice emitted otherwise identical JSON with two raw boolean values
omitted. A format-only follow-up encoded the same two values as strings. It was
given no additional evidence and did not change the substantive verdict. This
transport defect is recorded rather than silently repaired or interpreted.

## Decision

Do not change the product from this single positive run. Repeat the frozen
author task against the same commit with a fresh room and fresh isolated author,
then run the same blinded quality gate. If the gain replicates, the next
optimization target is the still model-dominated capability-discovery and
first-pass authoring time, not the host execution path.

The full sanitized record is
`research/data/exp-0011-authoring-loop-speed-validation-v1.json`. Private room
credentials, raw sessions, semantic packets, and pixels remain outside Git.
