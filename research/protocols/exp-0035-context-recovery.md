# EXP-0035 — Existing-board context recovery

- Status: prepared; no author attempts released
- Study class: paired public-development mechanism pilot
- Branch: `codex/webmcp-context-recovery`; no merge or deployment authorized
- Author: fresh projectless `gpt-5.6-terra`, reasoning `medium`
- Budget: 15 minutes per attempt; eight attempts in four matched pairs

## Question and scope

Does the candidate help an autonomous author inventory an existing board and
perform an exact, nonvisual metadata edit with less reading and no loss of
correctness? This pilot measures room/object retrieval and metadata preservation.
It does not establish visual quality, draft recovery, Diagram pagination, or a
population-level improvement. Passing unit tests is not an agent outcome.

## Frozen product conditions

- A0: `f7762da4ea7d1603671a35b4912143c4bff83f34`, localhost port 3101.
- A1: `55ed2446fa0b8b91c9602d50881ebc38a61d3514`, localhost port 3102.

Both are independent git archives with identical copied dependencies, Node
runtime, normal Next development bundler, and browser transport. Neither archive
contains this experiment's evaluator source. Warm the room routes before author
release. Record runtime versions and artifact hashes in the run manifest before
the first attempt. Do not alter either product archive during the experiment.

## Tasks and fixed order

The generator and authoritative grader are
`research/scripts/exp0035-context-fixture.mjs`. Authors receive only its public
brief, their exact authorized room entry, and the common isolation instructions.
The provisioning operations, expected answers, seed, and grader are controller
data and never enter an author prompt.

1. Inventory, seed `20260904-inventory-1`: A0, then A1.
2. Repair, seed `20260904-repair-1`: A1, then A0.
3. Inventory, seed `20260904-inventory-2`: A1, then A0.
4. Repair, seed `20260904-repair-2`: A0, then A1.

This is a fixed order-balanced schedule, not a claim of random assignment.
Inventory has 360 mixed objects and six Diagrams; report kind counts, Diagram
count, and exact sorted semantic names of open questions owned by Mira. It must
not mutate the document. Repair has 240 mixed objects, including 12 qualifying
questions; defer only those questions with the specified resolution, preserving
all other content. Duplicate visible labels make semantic identity meaningful.
Each paired attempt starts from the same generated fixture in a fresh room.

## Isolation and attempt accounting

Use a new projectless task for every attempt, with no forked history. Authors may
use the assigned room's native browser WebMCP tools, its public guidance, and
browser pixels. They may not use repository files, terminal, private HTTP APIs,
page evaluation, other rooms, other transcripts, or evaluator context. Ordinary
application guidance may differ between product conditions: that is part of the
treatment. Do not coach tool arguments or prepare the author's edits.

Record every released attempt, including failures, timeouts, interruptions, and
transport failures. Never replace an attempt or restart its brief. A setup
failure before any author receives a brief is recorded separately. Usage limits
pause release of unstarted assignments; they do not erase begun assignments.

## Authoritative grading

Retain independent before/after room snapshots. Check fixture cardinality before
release and exact structured terminal answers after completion. Inventory must
leave objects and Diagrams unchanged. Repair must preserve object identity sets,
all protected objects, and every target field except the requested lifecycle
changes and their required authoritative bookkeeping. A controller grader,
not author self-report or a model judge, determines semantic success. No visual
reviewer is needed because no visible change is requested or permitted.

## Measurements and decision

Primary outcome is semantic pass/fail. For accepted attempts, report wall time
from task start to task completion using retained session events. Also report
host calls, observable WebMCP calls/errors, and exact UTF-8 bytes of visible
textual read responses when the trace exposes them. Do not equate textual host
output with network payload bytes or token usage. Missing, elided, or truncated
evidence is `unobservable`; do not substitute author telemetry. Static code-call
counts must be labeled as such when loops prevent runtime counts.

Report all attempts and each matched difference. Do not assign artificial
completion times to failures. Evidence supports further replication only if all
four candidate attempts pass, candidate correctness is no worse than baseline,
candidate summary/scoped reading is observed, and both accepted wall time and
observable read-response bytes improve in at least three of four pairs. If any
required measurement is unavailable, this decision is inconclusive. Four pairs
cannot establish a general statistical or percentage improvement; even four
favorable signs have one-sided sign-test p=0.0625.

## Pre-release setup log

No author has received a brief. Initial dependency symlinks were incompatible
with Turbopack's root boundary. A webpack preflight failed on a client-side
`node:crypto` import. Both were discarded before release; both frozen archives
now use copied dependencies and the normal Turbopack development command.
Native baseline room creation and room-tool discovery passed; native candidate
room creation and summary reads also passed. Both generated fixtures and the
grader passed four tests through the real transaction validator and engine.
Author-task
creation remains pending explicit user authorization required by the app tool.
