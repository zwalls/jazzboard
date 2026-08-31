# EXP-0001A model-policy qualification amendment v1

Status: frozen public-development qualification; the 48-attempt A/A remains
blocked and unchanged.

Frozen: 2026-08-31T14:51:40.000Z

This amendment evaluates a candidate author-model policy before it can replace
the author setting in the unstarted EXP-0001A A/A calibration. It does not
rewrite the v1/v2 protocols, the v2 prebrief freeze, the existing runtime
bundle, or any historical artifact.

## Why this amendment exists

The v2 freeze selects `gpt-5.6-sol` at `max` for authors. That is a strong
engineering model but it does not represent the everyday balanced experience
we now want as the primary ecological estimand. Current official Codex model
guidance describes Terra as the balanced model for everyday work and the
default Power setting as Sol at medium reasoning. The candidate policy is
therefore:

| Experimental role | Model | Reasoning | Intended interpretation |
| --- | --- | --- | --- |
| Primary ecological author | `gpt-5.6-terra` | `medium` | Balanced everyday-user author population |
| Platform-default validation author | `gpt-5.6-sol` | `medium` | Separate validation against the current Codex default Power setting |
| Lower-bound author | `gpt-5.6-luna` | `xhigh` | Separate robustness diagnostic, never pooled into the primary result |
| Primary reviewer, adjudicator, pairwise judge | `gpt-5.6-sol` | `high` | Independent evidence review |

Source: [Codex model documentation](https://learn.chatgpt.com/docs/models).

The primary 48-attempt A/A will remain one homogeneous Terra/medium author
population if this qualification passes. Sol and Luna author results, if run,
will be separately denominated supplements. They may not be mixed into the
primary 48, its A/A balance, or its headline analysis.

## Disclosure of evidence observed before this freeze

The model and reasoning choice preceded this document, but one valid
Terra/medium architecture-creation artifact and its two blinded reviews were
already observed before the full three-task gate was frozen. That observation
is retained as task one and is explicitly non-prospective. Both reviewers
rejected the artifact because four directed relationships had visually
ambiguous arrowheads, while accepting its planes and fixed-viewport
readability. It is a model failure under the frozen rubric, not a setup
failure, and may not be replaced or rerun.

One earlier Terra/medium task omitted the exact Jazzboard URL due to a
coordinator prompt-construction error. It produced no valid artifact and is
retained as an invalid setup attempt; it is not scored against the model and
may not be relabeled as an author failure.

The remaining editing and drawing tasks, their order, the all-three pass rule,
and their review policy are frozen before either task is released.

## Qualification tasks

The exact public development tasks, in order, are:

1. `dev-architecture-create-observability` — architecture creation under
   density and viewport pressure. Observation timing:
   `observed_before_gate_freeze`.
2. `dev-architecture-edit-primary-path` — bounded repair of a seeded diagram
   while preserving human-authored state. Observation timing:
   `prospective_after_gate_freeze`.
3. `dev-drawing-create-layered-portrait` — original native-vector drawing with
   intentional overlap. Observation timing: `prospective_after_gate_freeze`.

The public bundle is
`research/benchmarks/development-v1.json`, digest
`sha256:067802ba59f921b361442fd27d234063f7c30476b58aeb1801da1202c0a27136`.
No sealed task or answer material is accessed by this qualification.

## Author isolation

Each attempt uses a brand-new projectless Codex task with Terra/medium and no
fork, shared history, Jazzboard repository, private API, prepared coordinates,
rubric, evaluator context, or answer material. The author receives only the
public task brief and packet, an exact private room URL, and the
browser-exposed WebMCP surface. A platform-required read of the Browser skill
is permitted. The author must discover capabilities, inspect the canvas,
author, visually inspect, correct if needed, and finish with an authoritative
room-state read.

Blank tasks begin in a verified empty private room. The edit task is seeded by
the coordinator with exactly `fixture-architecture-primary-path-v1` before the
author brief is released. Seed coordinates are not included in the prompt.

## Evidence and review

Every valid author attempt retains its fresh Codex task identifier, requested
model/reasoning, wall time, WebMCP calls and failures when observable,
inspection count, final authoritative room revision, sanitized semantic-state
digest, revision-matched PNG digest, and terminal outcome. Exact tokens,
resolved model snapshots, or subscription usage are recorded only if exposed;
otherwise the literal value is `unobservable`.

Two new Sol/high projectless reviewers independently evaluate each completed
artifact. Each reviewer sees only the public requirement, frozen rubric,
sanitized semantic state, and revision-matched final PNG. The reviewer cannot
see author identity, model, transcript, room, condition, paired result, or
repository. A separate Sol/high adjudicator is launched only if the two binary
primary decisions disagree. Original reviews remain immutable.

## Gate and stopping rule

All three tasks must pass every frozen criterion. A task passes when both
primary reviewers accept it, or—only after a primary binary disagreement—the
independent adjudicator accepts it. There are no retries, replacement
attempts, best-of-N selection, silent exclusions, or model-assisted repairs.

A usage-limit interruption preserves the begun attempt, pauses release of the
next task, and resumes only at the next genuinely unstarted assignment. It
does not become a replacement opportunity.

Because task one was observed before this document, this gate supports an
operational model-policy decision but no percentage, statistical-improvement,
or general performance claim.

## Consequences

- **Pass:** prepare a new v3 protocol/freeze/runtime chain that makes
  Terra/medium the sole primary-48 author setting, preserves Sol/high review
  roles, and defines any Sol/Luna author supplements separately. The v3 chain
  still requires its own generation, verification, and signing before a brief
  is released.
- **Fail or incomplete:** keep the 48-attempt run blocked. Diagnose the retained
  evidence and predeclare a new qualification or choose another author policy;
  do not mutate or replay this gate.

The machine-verifiable companion plan is
`research/data/exp0001a-model-role-qualification-plan-v1.json`.
