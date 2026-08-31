# EXP-0001A ecological-author policy amendment v2

- Status: preregistered; no v2 qualification brief released
- Author population: `gpt-5.6-terra` at `medium` reasoning
- Partition: public development only
- Prior qualification: retained failure, never replaced or relabeled
- A/A execution: blocked until this compatibility gate and a successor
  production freeze both pass

## Decision being frozen

Terra/medium remains the primary ecological author population for EXP-0001A.
This decision is made after disclosing the complete version-1 qualification
result and is based on the intended population—balanced everyday Codex
users—not on selecting the strongest model that produced the prettiest
development artifact.

The version-1 qualification remains a failed quality gate. Its architecture
creation was rejected for ambiguous directionality, its architecture-edit
fixture was invalid before author release, and its drawing task passed. None of
those attempts may be deleted, rerun, or reclassified. In particular, this
amendment does not claim that Terra passed version 1.

## Why the next gate measures compatibility

Artifact quality is the outcome the A/A and later A/B experiments are designed
to measure. Requiring perfect development-task quality before admitting an
author model would select on the outcome, bias the experiment toward a ceiling
population, and make Jazzboard less representative of ordinary use.

The new gate therefore asks only whether Terra/medium can execute the author
role under the real clean-room transport and leave complete, independently
evaluable evidence. Blinded task-quality reviews are still retained, but they
do not determine compatibility. A rejected artifact remains a real product
observation and is never repaired by the coordinator.

## Prospective task set

The following previously unattempted Terra/medium tasks are fixed in this
order before any author brief is released:

1. `dev-architecture-create-checkout` — blank-room architecture creation.
2. `dev-architecture-edit-uncertainty` — bounded editing of a validated seed.
3. `dev-drawing-create-wayfinding-icon` — blank-room native-vector drawing.

These tasks cover architecture creation, architecture editing, and drawing
creation. They use only the public development benchmark. No validation,
sealed-test, replication, answer-key, or private repository material may be
opened.

## Required pre-author gates

Before each brief is delivered, the coordinator must prove all of the
following:

- current Codex authentication is ChatGPT subscription sign-in, not API-key
  authentication;
- the task is a brand-new projectless Codex task requesting exactly
  `gpt-5.6-terra` and `medium` reasoning;
- the room is new, private, and authorized only through its exact invite;
- a blank room is authoritative and empty, or a fixture has been rendered and
  passes its own frozen semantic and visible-baseline preflight;
- the active production alias resolves to the successor frozen deployment;
- exact-revision PNG and semantic-state evidence paths have passed a disposable
  preflight; and
- no author brief for the assignment has previously been released.

A failure before brief delivery is retained as `not_started`. It may be fixed
only before releasing that same genuinely unstarted assignment.

## Compatibility criteria

Each of the three attempts must satisfy every compatibility criterion:

- fresh projectless task with no fork or shared history;
- no Jazzboard repository, other repository, terminal, private API, prepared
  coordinates, answer material, or evaluator context;
- browser-exposed WebMCP is discovered and used;
- at least one authoritative canvas mutation succeeds;
- at least one visual inspection is completed;
- a closing authoritative room read is bound to the final room revision;
- a revision-matched PNG and sanitized semantic state are retained and hashed;
- the task returns a terminal result; and
- no privacy, authorization, provenance, or evidence-integrity guardrail
  fails.

The gate passes only when all three attempts are valid and compatible. A model
refusal, timeout, malformed terminal result, boundary violation, missing final
evidence, or non-setup failure fails the gate. An invalid seed or other
coordinator defect makes the assignment incomplete and blocks release of the
next task until a versioned repair is frozen. There are no retries,
replacements, best-of-N selection, or silent exclusions.

## Quality evidence

Two fresh Sol/high reviewers independently score every evaluable artifact
using only the public requirement, frozen rubric, sanitized semantic state,
and revision-matched PNG. A separate fresh adjudicator is used only for binary
primary disagreement. Quality decisions are reported task by task but do not
change the compatibility decision.

This separation is deliberate:

- compatibility answers whether the selected everyday model can participate
  in the experiment without breaking the measurement boundary;
- blinded task success remains an experimental outcome; and
- neither result supports a percentage-improvement claim.

## Consequences

- **Pass:** create and sign a new EXP-0001A production/runtime freeze with
  Terra/medium as the homogeneous primary author population. The old unsigned
  Sol/max freeze remains historical and cannot release a brief.
- **Fail or incomplete:** keep the 48-attempt A/A blocked, retain every begun
  attempt, and diagnose without changing this gate or selecting favorable
  replacements.

The machine-verifiable companion is
`research/data/exp0001a-model-role-qualification-plan-v2.json`.
