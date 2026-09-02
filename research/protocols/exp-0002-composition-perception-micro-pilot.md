# EXP-0002 — Composition-perception micro-pilot

- Status: **frozen before author release**
- Frozen at: `2026-09-02T04:31:47Z`
- Scope: public development evidence only
- Purpose: test the mechanism introduced by Jazzboard commit `3d44902`

## Research question

Does exact whole-board composition guidance help an ordinary Codex author use
Jazzboard's visual-inspection loop and avoid framing, scale, and integration
failures without losing semantic correctness or deliberate overlap?

This is a small exploratory mechanism test. It cannot support a percentage
product-lift claim, a population success-rate claim, or a sealed-test decision.
The earlier EXP-0001A attempts remain calibration/pilot evidence and are not
pooled into this treatment comparison.

## Frozen product arms

| Opaque arm | Git commit | Vercel deployment | Product difference |
| --- | --- | --- | --- |
| `A0` | `eb69c38` | `jazzboard-frc793mdy-zwalls-projects.vercel.app` | actionable recovery before composition-aware inspection |
| `A1` | `3d44902` | `jazzboard-emq92fz7q-zwalls-projects.vercel.app` | exact whole-room composition inspection and follow-up guidance |

Authors receive only an opaque private-room invite on an opaque experiment
origin. They do not receive the arm label, commit, deployment identity,
comparison hypothesis, paired result, repository, fixture coordinates, or
evaluator context.

## Frozen benchmark inputs

- Benchmark: `research/benchmarks/development-v2.json`
  - SHA-256 `9326d2e0d8cd06fdaabfe9345b0eb85e0634fbcc9ece285124553c2a0a649227`
- Fixtures: `research/benchmarks/development-fixture-specs-v2.json`
  - SHA-256 `cb6942984d5fc6b566cccc62d90d0d29567fba387677ee87f06f973a15307575`
- Rubrics: `research/benchmarks/development-evaluator-rubrics-v2.json`
  - SHA-256 `15bde60f5e593164a2b8d7ec924cf3d722c049e18db07b0ded5586f9b00f8919`

The two development tasks were not used to design the candidate patch:

1. `dev-architecture-stress-dense-routing`
2. `dev-drawing-edit-crop-repair`

Each task receives one fresh `A0` author and one fresh `A1` author. The four
attempts are released in the preregistered interleaved order `A1-dense`,
`A0-crop`, `A0-dense`, `A1-crop`. Rooms are private, fresh, semantically
matched within a pair, and start at room revision 2.

## Author policy

- Fresh projectless Codex task for every attempt
- Model `gpt-5.6-terra`, reasoning `medium`
- ChatGPT subscription authentication; no API-key transport or dollar ledger
- Browser/WebMCP access to only the supplied private Jazzboard invite
- No Jazzboard repository, prepared coordinates, shared history, forks,
  evaluator prompt, author transcript from another attempt, or condition label
- Fixed browser viewport target: 1280 × 720
- Hard author wall-time limit: 15 minutes
- A usage-limit interruption is retained and never silently replaced

Authors are told to discover the live WebMCP surface, satisfy only the public
task packet, inspect the final result visually, correct identified defects, and
return a short terminal result. They are not told which tool calls constitute
the experimental mechanism.

## Primary mechanism outcomes

For each attempt, retain independent evidence for whether:

1. a mutation receipt exposed `recommendedInspection`;
2. the candidate receipt exposed `recommendedCompositionInspection` when the
   room had surrounding content;
3. the author followed the exact recommended scope and overview;
4. the author captured and inspected the returned `screenshotClip` rather than
   treating framing metadata as pixel inspection; and
5. the inspection caused a targeted correction before completion.

Missing evidence is `unobservable`; it is never inferred from the author's
claim of completion.

## Product outcomes and guardrails

Primary product outcome is the frozen per-task rubric result. Corroborating
outcomes are blinded pairwise visual preference, exact final semantic state,
revision-matched clean pixels, framing/crop failure, relative scale, connector
readability, preservation of intentional overlap, unrelated-state integrity,
wall time, WebMCP calls/failures, revisions, inspections, and corrections.

Pairwise reviewers must receive identically framed evidence. Missing,
mismatched, UI-contaminated, or falsely typed image evidence yields
`indeterminate`, not a preference. Reviewer disagreement is preserved.

## Stopping and interpretation

All four begun attempts are retained. No attempt may be retried, substituted,
or removed because of author failure, usage limits, transport failure, or poor
quality. Reviewers and pairwise judges use fresh isolated `gpt-5.6-sol` tasks
at `high` reasoning and receive only the public requirement, frozen rubric,
sanitized final state, and matched final pixels.

If both candidate attempts demonstrate the intended inspection mechanism
without a new guardrail regression, run a second fixed replicate before
widening the comparison. If the mechanism is not used, the next product work
must improve discoverability/actionability rather than claiming a visual gain.

