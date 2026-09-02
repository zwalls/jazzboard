# EXP-0005 — Small interleaved speed-with-quality replication

- Status: **frozen before author release**
- Frozen at: 2026-09-02T20:44:00Z
- Branch: `research/speed-quality-replication-v2`
- Study class: paired randomized development replication
- Author profile: fresh projectless `gpt-5.6-terra`, reasoning `medium`
- Reviewer profile: separate fresh projectless `gpt-5.6-sol`, reasoning `high`
- Author wall-time limit: 15 minutes

## Question

Does the current Jazzboard WebMCP surface reduce time to a semantically exact,
blind-review-accepted artifact relative to the immediately preceding production
surface, without reducing perceptual quality, progressive presentation,
authoritative atomicity, or final pixel inspection?

This small development replication tests transport direction across multiple
tasks. It is not powered for a population-level percentage claim or sealed-test
product decision.

## Frozen conditions

- `A0` build: `https://jazzboard-iqwpad8gn-zwalls-projects.vercel.app`
  - author origin: `https://exp0005-previous.jazzboard.xyz`
  - deployment `dpl_B2QMi4VXcv8cA1hnMoUXUNrVC9xP`
  - preceding production surface
- `A1` build: `https://jazzboard-qjjv1qq8q-zwalls-projects.vercel.app`
  - author origin: `https://exp0005-current.jazzboard.xyz`
  - deployment `dpl_BKMmpJ4t3Yiy9axtDXkFtLGSR2Uy`
  - main commit `6af0784815de4961597f1f1a638c5cef34b9d6b4`
  - includes `update_draft_connector` and exact
    `recommendedDraftCorrection` receipts

The condition changes information and draft-correction transport only. Neither
condition may receive prepared coordinates, evaluator context, repository
access, private APIs, deterministic composition assistance, or animation-paced
authoring instructions.

## Frozen public tasks

The exact public packets and rubrics come from:

- `research/benchmarks/development-v2.json`
  - SHA-256 `9326d2e0d8cd06fdaabfe9345b0eb85e0634fbcc9ece285124553c2a0a649227`
- `research/benchmarks/development-evaluator-rubrics-v2.json`
  - SHA-256 `15bde60f5e593164a2b8d7ec924cf3d722c049e18db07b0ded5586f9b00f8919`

Tasks:

1. `dev-architecture-create-observability`
2. `dev-drawing-create-wayfinding-icon`
3. `dev-drawing-create-layered-portrait`
4. `dev-architecture-create-checkout`

Architecture tasks exercise connector correction. Drawing tasks are a
non-target control for discovery, draft delivery, inspection, and perceptual
quality regressions.

## Randomization

Seed: `20260902`.

Algorithm: xorshift32 task shuffle followed by one xorshift32 draw for condition
order within each adjacent task pair. The frozen sequence is:

1. observability `A0`
2. observability `A1`
3. wayfinding `A0`
4. wayfinding `A1`
5. portrait `A0`
6. portrait `A1`
7. checkout `A1`
8. checkout `A0`

No begun attempt may be removed, replaced, restarted, or silently rerun. A
usage-limit interruption pauses release before the next genuinely unstarted
assignment.

## Isolation

Every author attempt receives a fresh private room and a brand-new projectless
Codex task containing only:

- its exact public task brief and packet;
- its exact private room URL on the assigned immutable origin;
- permission to use page-scoped browser WebMCP and exact browser pixels.

Every blinded reviewer receives a separate fresh projectless task containing
only:

- the public requirement and frozen task rubric;
- sanitized final semantic state;
- exact final clean-canvas pixels.

Reviewers receive no author transcript, condition, deployment, pair identity,
repository, room credential, prior verdict, or implementation context.

## Outcomes

Primary outcome per attempt: author wall time when and only when the artifact
passes every frozen semantic and blinded visual criterion. A failed or timed-out
attempt remains in the dataset and is not assigned an artificial completion
time in the descriptive table.

Secondary outcomes:

- author host-call and WebMCP-call counts;
- failed calls and failure taxonomy;
- capability, authoring, finish, inspection, correction, and terminal phases;
- draft transaction, patch, replacement, and unsupported-operation counts;
- inspection rounds and authoritative room revision;
- exact entity/object, relationship/connector, and Diagram counts;
- reviewer wall time and criterion verdicts;
- model and reasoning settings, task counts, wall time, observable subscription
  usage, and usage-limit interruptions.

Exact tokens and resolved model snapshots remain `unobservable` unless the
Codex task surface reports them directly; they are never estimated.

## Analysis and decision rule

Report all eight attempts, four within-task differences, condition medians,
failure counts, and quality verdicts. Do not pool a rejected artifact with
accepted completion times. Do not interpret ordinal rubric judgments as
percentages.

The mechanism warrants broader replication when:

- both architecture `A1` artifacts pass every hard gate;
- neither drawing `A1` artifact introduces a material quality or completion
  regression;
- no `A1` author attempts an unsupported correction form;
- architecture pair differences and correction-call evidence are directionally
  consistent with lower transport churn.

Any broader speed percentage remains forbidden after this eight-attempt study.

## Pre-release transport amendment

Before attempt 1 received a brief, direct navigation to the immutable `A0`
deployment hostname encountered Vercel deployment protection. No author task or
room was created. The two exact frozen builds were therefore assigned the
public, condition-neutral author origins listed above. Aliasing does not rebuild
or alter either deployment. Both origins must pass health and live WebMCP
discovery checks before release.
