# EXP-0004 — Draft correction transport micro-pilot

- Status: **candidate implementation; author not released**
- Date: 2026-09-02
- Branch: `research/speed-quality-replication`
- Author profile: fresh projectless `gpt-5.6-terra`, reasoning `medium`
- Reviewer profile: separate fresh projectless `gpt-5.6-sol`, reasoning `high`
- Development task: `dev-architecture-stress-dense-routing`

## Question

Can a stable-reference partial connector correction reduce author correction
churn and total time without choosing composition for the agent or weakening
semantic, geometry, progressive-presentation, atomicity, or pixel-inspection
requirements?

This is a bounded mechanism test, not a randomized multi-task effect estimate.
It cannot support a general percentage-improvement claim.

## Frozen diagnosis

The retained current-production author completed in 335,809 ms. Exact session
timeline attribution assigns 238,758 ms (71.1%) to the lead-in and execution of
ten pre-finish draft-authoring calls. The author knew which connector required
repair, but tried three unsupported partial-update operation shapes and then
used repeated complete draft replacements. Host execution was not the dominant
cost: 260,867 of 336,000 accounted milliseconds were between-call model and
coordination time.

The sanitized phase record, raw-session hashes, clocks, and limitations are
frozen in `research/data/exp-0004-speed-phase-diagnostic-v1.json`. No raw author
prompt, tool payload, or private room credential is copied into the repository.

## Candidate mechanism

The candidate adds one operation inside the existing
`apply_canvas_transaction` tool:

- `update_draft_connector` is valid only with an owned existing draft, its exact
  `draftId` and `expectedDraftRevision`, and `updateMode: patch`.
- It targets one connector by its lifetime-stable `tempRef` and accepts only the
  connector fields the agent elects to change: endpoints, routing, label,
  direction, color, z-index, and semantic identity.
- Jazzboard reconstructs that one complete unpublished connector, preserves all
  unaffected draft candidates, performs the existing compare-and-swap write,
  and returns a newly validated receipt.
- A finding-bearing receipt returns `recommendedDraftCorrection` with exact
  draft identity/revision and affected stable references. It provides mechanics,
  never a proposed route, position, style, or quality verdict.

The candidate does not add a registered tool, change transaction limits, choose
layout/routing, mutate authoritative state before finish, weaken validation,
alter progressive presentation, or skip exact pixel inspection.

## Release and evidence rules

Before author release:

1. commit the candidate and record its immutable hash;
2. pass typecheck, lint, complete WebMCP Vitest, production build, and focused
   browser regression;
3. deploy through the public production origin and verify the exact alias;
4. independently fetch the live quickstart and registered transaction schema to
   prove that `update_draft_connector` is exposed;
5. create a fresh private room and fresh projectless author task.

The author receives only the public task packet and exact private room URL. It
gets no repository, private API, prepared coordinates, prior transcript,
condition label, or evaluator context. Every begun attempt is retained.

## Development acceptance

The mechanism passes its development gate only if:

- the final authoritative artifact has exactly the required nine nodes, nine
  labeled directed relationships, and one complete first-class Diagram;
- progressive construction and one atomic finish remain observable;
- the agent performs exact rendered-pixel inspection;
- the frozen semantic rubric and a separate blinded visual reviewer pass;
- no unsupported draft-correction operation or unchanged rejected retry occurs;
- if a connector correction is needed, the author can use
  `update_draft_connector` without resending unaffected candidates;
- all host calls, failures, WebMCP calls, draft revisions, inspection rounds,
  correction rounds, and wall-clock phases are retained.

Wall time and call count are reported exactly. A faster or slower single run is
diagnostic only. If the mechanism behaves correctly, the next stage is a small
randomized interleaved replication across multiple architecture and drawing
tasks, with time-to-blinded-acceptance as the primary speed outcome and quality
non-inferiority as a hard gate.
