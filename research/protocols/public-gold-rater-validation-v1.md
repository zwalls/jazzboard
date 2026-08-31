# Public gold-artifact rater validation v1

- Status: preregistration draft; Codex subscription-task execution not authorized
- Partition: public development only
- Sealed prompts, sources, answers, or artifacts: forbidden
- Purpose: test reviewer validity before any Jazzboard A/B claim

## Why this gate exists

A/A calibration measures treatment neutrality, repeatability, and operational
reliability. Two reviewers can be consistently wrong. Agreement, kappa, and an
A/A null result therefore cannot establish semantic or visual scoring accuracy.

This gate evaluates the same frozen blinded-review pipeline against public
artifacts with independently established labels. It must pass before any A/B
experiment is interpreted as product improvement. Its outcomes may improve the
harness, but cannot be used to tune thresholds and then validate those same
thresholds without a new held-out public gold version.

## Corpus design

Create a versioned public corpus spanning both Jazzboard domains:

- architecture diagrams with realistic entities, boundaries, directions,
  connector labels, sources, and uncertainty;
- drawings with recognizable composition, deliberate overlap, layering,
  asymmetry, and non-architectural geometry;
- accepted exemplars that satisfy the frozen rubric; and
- rejected variants produced by one documented corruption at a time, plus a
  smaller set of realistic multi-defect artifacts.

Each source exemplar yields treatment-neutral variants from frozen corruption
operators. At minimum cover:

| Family | Required corruptions |
| --- | --- |
| Semantic | missing entity, wrong label/role, missing relationship, reversed direction, wrong grouping, missing source/uncertainty |
| Visual | clipped content, unreadable/overflowing text, unintended occlusion, connector intrusion/crossing, weak spacing/hierarchy |
| Integrity | stale revision, pixel/state mismatch, missing evidence, changed stable ID or endpoint binding |
| Correction | no issue-focused change, regression of accepted content, no reinspection, repeated ineffective correction |
| Drawing-specific | lost recognizability, broken composition, accidental rather than deliberate overlap, missing defining feature |
| Architecture-specific | boundary violation, mislabeled edge, route through a service, semantically correct but visually unusable layout |

Do not create labels by asking the evaluated reviewer model. Corpus authors and
gold labelers must be separated from the frozen evaluation calls.

## Gold-label procedure

1. Two independent qualified raters label each artifact using the frozen task
   rubric, semantic state, and exact rendered pixels.
2. They record binary acceptance, criterion decisions, primary class,
   mechanism tags, criticality, incident status, and evidence references.
3. Any binary or criterion disagreement receives a third qualified gold
   adjudicator. Gold creation may adjudicate more broadly than the production
   reviewer pipeline because this stage establishes the reference label rather
   than estimates production-review cost.
4. Lock the raw independent labels, adjudication, artifact bytes, semantic
   state, rubric, and digests before any evaluated model output is generated.
5. Publish the public corpus manifest and corruption provenance. Remove secrets,
   personal data, treatment labels, and production-room credentials.

Synthetic corruption provenance establishes what changed, not automatically
whether the artifact became unacceptable. Human gold raters must still apply
the rubric, especially for drawings and intentional geometry.

## Blinded model evaluation

Run the exact production-shaped evaluator request builder, schemas, budgets,
model identity checks, retention, crash recovery, and classification resolver.
Each artifact receives the ordered pair of independently assigned production
primaries (measurement-capable, then standard). Only a binary acceptance
disagreement may open a third call, assigned to an independent
adjudication-capable reviewer. A class-only disagreement never opens
adjudication; it resolves by the production taxonomy's frozen precedence. The
analysis must retain both primary locks and any required adjudication lock, then
use the production `ClassificationBook` projection as the resolved decision.
The evaluator receives no gold label, corruption name, parent/variant link,
expected decision, condition label, or aggregate result. Randomize order and
ensure related variants cannot appear together in one context.

Integrity-targeted cases must receive a frozen integrity evidence view that
contains the exact stable IDs, revisions, endpoint bindings, and relevant
before/after commitments needed by their rubric. Aggregate roots and pixels
alone are not sufficient to detect an intentionally corrupted identity or
binding. This view is source-bound and treatment-neutral and remains hidden
from artifact authors.

Every begun evaluation remains in the denominator. Failed tasks are not
replaced. Codex task identity, requested model/reasoning, wall time,
subscription/credit observations, usage-limit interruptions, request digest,
output digest, and evidence coverage remain observable or explicitly
`unobservable`. Tokens, resolved model snapshots, and credits are never
estimated when the Codex task surface does not expose them.

There are two explicit denominators. Every artifact appears exactly once in the
gold accuracy analysis, while each of its two or three begun reviewer calls
appears in call-retention and reviewer-role diagnostics. A scored frozen record
whose public-gold evidence binding cannot be verified remains available for
auditing the exact production resolution, but its artifact outcome is
non-evaluable for gold accuracy. It cannot earn a correct pass or reject.

## Preregistered endpoints

Report separately for architecture, drawing, and pooled artifacts:

- binary sensitivity on gold rejects;
- binary specificity on gold accepts;
- false-accept and false-reject rates;
- balanced accuracy;
- criterion-level sensitivity and specificity where denominators permit;
- primary-class agreement and confusion matrix;
- mechanism-tag precision/recall as descriptive diagnostics;
- evidence-coverage and non-evaluable rates;
- duplicate-item repeatability on a frozen subset; and
- reviewer-role/order diagnostics without causal claims.

The primary report compares the final production-resolved acceptance to gold.
It additionally reports measurement-primary, standard-primary, and conditional
adjudicator diagnostics separately; those role reports are descriptive and do
not replace the resolved artifact-level endpoint.

Every rate includes exact numerator/denominator and a two-sided 95% Wilson
interval. Cluster-aware uncertainty resamples source exemplars, not individual
corruption siblings. If the number of independent source exemplars is too small
for a defensible interval, report the result as feasibility evidence only.

## Initial graduation criteria

Before Codex task execution, a separate freeze must set corpus size and numeric
thresholds using no evaluated-model outputs. At minimum the gate must require:

- lower confidence bounds for architecture and drawing sensitivity and
  specificity above the preregistered minima;
- zero critical integrity false accepts in the observed corpus;
- no domain with materially worse non-evaluable or false-accept behavior hidden
  by the pooled result;
- complete Codex task/authentication and artifact-provenance verification; and
- no unresolved evidence, denominator, blinding, or execution-integrity alarm.

The exact numeric minima are intentionally not chosen in this draft. Choosing
them after seeing live outputs would be outcome-driven. They must be frozen in
the signed prebrief before any public-gold brief is released to a fresh Codex
task.

## Separation from EXP-0001A

EXP-0001A A/A and this gold validation answer different questions:

| Study | Primary question | Cannot establish |
| --- | --- | --- |
| A/A calibration | Is the pipeline treatment-neutral, complete, stable, and operationally reproducible? | Reviewer correctness or product lift |
| Public gold validation | Does the frozen reviewer identify known good/bad public artifacts with bounded error? | Product lift on future unseen tasks |
| Later sealed A/B | Does a frozen harness change improve outcomes on a preregistered unseen distribution? | Generalization beyond that target population |

Both A/A operational validity and public-gold rater validity are necessary
preconditions for an A/B claim. Neither may expose or consume a sealed test
partition.

## Artifacts required before execution

- public corpus and source-exemplar cluster manifest;
- corruption-operator registry and per-variant provenance;
- independent gold labels and adjudication records;
- frozen reviewer runtime/source/dependency digests;
- exact sample plan, randomization, thresholds, and analysis script;
- frozen Codex task-count plan, role/model/reasoning settings, and
  usage-limit pause/resume policy;
- dry-run evidence showing no gold-label leakage; and
- signed launch and completion attestations using the same clean-room authority
  model as EXP-0001A.

Until those artifacts are complete and a user explicitly authorizes the Codex
subscription-task run, status remains `preregistration draft; Codex
subscription-task execution not authorized`. This protocol has no API-key
transport, provider-token pricing model, or dollar-denominated spend gate.
