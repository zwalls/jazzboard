# EXP-0001A Codex task orchestration v1

Status: implementation protocol. This document describes the Codex-native task
transport; it is not authority to release the sealed A/A experiment.

## Invariants

- Every author, primary reviewer, adjudicator, and pairwise visual judge is a
  newly created projectless Codex task. Forks, shared history, project context,
  repository access, prepared coordinates, private APIs, and evaluator context
  are forbidden.
- Authors use `gpt-5.6-sol` at `max`. Primary reviewers, adjudicators, and
  pairwise judges use `gpt-5.6-sol` at `high`.
- A verified passing disposable Codex/WebMCP spike is mandatory.
- Every release re-runs the committed `codex login status` preflight. Only an
  unambiguous ChatGPT-authenticated receipt no more than five minutes old can
  release `create_thread`. There is no injectable production preflight seam.
- At most one task is active. A usage-limit interruption stops the coordinator
  before the next brief is released; a begun attempt is never silently removed
  or replaced.

## Role-visible inputs

Author tasks see only a neutral canvas-task title, the frozen public brief, the
exact private Jazzboard invite, and fixed browser/WebMCP operating instructions.
The room ID, assignment, attempt, condition, schedule index, and evaluator
context remain in the restricted coordinator binding.

Primary reviewers and adjudicators see only the public requirement, frozen
rubric, sanitized semantic state or canonical author-failure packet,
revision-matched PNG evidence when available, and one hash-addressed loopback
evidence-manifest URL. The coordinator privately binds an adjudication to the
two conflicting immutable primary records, but neither primary decision,
result digest, evidence reference, nor rationale is included in the
adjudicator task. Pairwise judges see only the public requirement, frozen
rubric, and randomized `canvas-1`/`canvas-2` final PNGs. When either source artifact is
incomplete, the pairwise task instead receives the canonical blinded
unavailable packet; it still occupies its frozen task denominator and no image
is fabricated.

Review evidence is served from an exact `http://127.0.0.1:PORT` origin. Before
task preparation, the coordinator probes the manifest and every content-
addressed image, verifies size and SHA-256, and proves that POST, PUT, DELETE,
and directory listing are rejected. The retained probe receipt binds the
envelope, origin, manifest, files, and request evidence. Arbitrary or additional
URLs are rejected.

## Provisioning-to-author boundary

The canonical author adapter consumes the frozen attempt plan, its independently
retained room-provisioning receipt, and the provisioning handoff. It verifies:

- assignment, attempt, schedule index, plan, and attempt-plan bindings;
- a unique private room/invite/access binding and authoritative provisioning
  evidence;
- the public packet digest and an independent re-render of the public brief;
- coordinator presence expiry and the author release timestamp.

The release path checks wall-clock time again. A future-dated handoff cannot be
used to release a task early.

## Task lifecycle

1. `prepared`: seal the role envelope, private coordinator binding, neutral
   prompt/title/directory, spike receipt, current auth receipt, and exact
   `create_thread` command.
2. `release-invoked`: immediately recheck ChatGPT auth, durably journal a unique
   opaque transport commitment, then record that the prompt may have been
   released.
3. `ready`: bind the returned fresh task/thread and host IDs.
4. `creation-uncertain`: if the create response is lost, retain the attempt as
   begun and reconcile by exact unique title through `list_threads`. Never retry
   `create_thread`; zero or multiple matches remain uncertain.
5. `running`: issue cursor-bound `wait_threads` commands. Timeouts retain and
   advance the cursor.
6. `awaiting-terminal-read`: after completion, attention, usage-limit, or
   failure, issue one task-bound `read_thread` command.
7. `terminal`: retain the read result, policy receipt, terminal artifact or
   failure evidence, and terminal classification.

The coordinator emits only the next legal action for this state machine. It
does not release a second task while one is running, uncertain, or awaiting a
terminal read.

## One-action command and durable ingest

The committed batch command has four mutually exclusive modes:

- the default dry-run verifies the active runtime and state without dispatch;
- `--execute` retains an atomic outbox receipt and prepares exactly one
  authorized coordinator action;
- `--ack-dispatch sha256:<action-digest>` durably records that the outer
  coordinator received the handoff before it may invoke the action once; and
- `--ingest-result /absolute/result.json --dispatch-action sha256:<action-digest>`
  consumes the unmodified result for the exact acknowledged external action.

Local scientific transitions and the loopback artifact-packet sidecar may be
performed by the CLI. Codex-app and Jazzboard WebMCP actions are never claimed
as invoked by the CLI: they are returned with an exact expected-ingest binding
for the outer coordinator. The outer result, prior and next state digests, and
dispatch receipt are retained in the append-only private authority journal
before the next checkpoint can be signed. Before acknowledgement, replay may
redeliver the handoff but the command must not be invoked. After
acknowledgement, replay never reissues a mutating action: it requires the raw
result or exact reconciliation. This distinguishes a crash before acknowledged
handoff from result loss after a possible invocation.

Every review packet is origin-free while sealed. Immediately before its task is
released, the coordinator materializes the exact retained evidence into a
single-task loopback sidecar, probes the manifest and every file, binds the
fresh origin to the task envelope, and tears the sidecar down after terminal
read. A volatile localhost origin is never part of the frozen scientific
artifact identity.

## Retained-trace policy

Task-visible restrictions are not trusted as proof. Every terminal outcome is
checked against a complete retained task trace.

The only permitted non-browser bootstrap is one read of the installed Browser
skill. Active receipts bind its logical skill ID, version, and digest, plus a
private digest of the host-resolved path; no host path is placed in a prompt or
runtime bundle.

Author traces must prove no repository or project reads, no filesystem writes,
no private-API or direct-HTTP access, and browser/WebMCP access only to the exact
Jazzboard origin, private room ID, invite digest, and access binding supplied for
that attempt. Reusing inherited browser context or touching a private recent room
is a policy violation. Reviewer traces must prove no Jazzboard navigation or WebMCP
calls and browser access only to the envelope's loopback evidence origin. Any
extra origin or private-room access is a policy violation. A truncated trace is
non-evaluable, never inferred as clean.

## Terminal-result reconciliation

Task output is strict JSON; narrative, missing, extra, or malformed fields are
not accepted. Primary/adjudication output must cover the exact rubric criteria
and exact image-slot set. Pairwise output must reference both opaque final-image
slots and the frozen rubric exactly once.

An author's JSON cannot establish success. The coordinator joins it to:

- the retained task identity and complete policy-passing trace;
- a final authoritative `read_room_state` result for the bound private room;
- exact room revision and object count;
- the exact observed WebMCP tool-name set;
- sanitized semantic-state and final PNG digests.

Any mismatch is terminal non-acceptance. Counts or tool calls absent from a
retained trace are `unobservable`; they are never inferred from truncated
`read_thread` text.

## Usage limits and accounting

A pre-creation authoritative usage rejection remains genuinely unstarted. A
limit encountered after release remains a begun attempt or review task and is
never retried. The global scheduler pauses every role without releasing another
brief. While paused, it may release only a neutral, fresh, projectless
subscription-availability probe containing no benchmark content. The complete
probe result is retained, counted separately from all experimental
denominators, and fixed-key signed; only that authoritative observation plus a
fresh ChatGPT-auth preflight can resume the next genuinely unstarted work item.
Task count, role settings, wall time, observable WebMCP calls/failures,
revision/inspection counts, observable subscription usage or credits, and
interruptions are retained. Counts, exact tokens, and resolved snapshots remain
`unobservable` unless the retained task evidence supplies them directly.
