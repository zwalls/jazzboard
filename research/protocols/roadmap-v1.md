# Harness evaluation research roadmap v1

- Status: active research design
- Baseline product commit: `48a52e0837144ea0db8a09e43217397226759f83`
- Baseline freeze receipt: `research/data/baseline-freeze-v1.json`
- Initial development protocol: `exp-0001-development-pilot.md`
- Active measurement-calibration protocol: `exp-0001a-aa-calibration.md`
- Operational continuation record: `exp-0001a-execution-readiness.md`
- Active transport amendment: `exp-0001a-codex-native-transport-v1.md`
- Public rater-validity gate: `public-gold-rater-validation-v1.md`
- Active failure contract: `failure-taxonomy-v2.md` once the prebrief is frozen

## Purpose

This roadmap defines how Jazzboard will measure whether a candidate agent
harness improves useful visual-authoring outcomes over the product at commit
`48a52e0837144ea0db8a09e43217397226759f83`. Historical demonstrations remain valuable contract and provenance
evidence, but a fixed-operation baseline, one attractive artifact, or one
successful closed-loop session is not a population-level harness comparison.

The object of evaluation is the complete model-and-harness system. A model,
host, task distribution, or budget change is a separate treatment and must not
be attributed to the harness.

## Primary estimand

The primary estimand is the paired absolute difference in task-success
probability:

`P(success | candidate harness) - P(success | baseline harness)`.

A task succeeds only when a blinded evaluator accepts the final artifact
without human correction under the task's frozen semantic and rendered-quality
rubric and no critical integrity guardrail fails. The experimental unit is one
fresh agent session on one task instance. Repeated sessions and multiple judge
ratings are not independent task samples.

## Evaluation boundary

Every evaluated author receives only the task brief, authorized room entry
point, public task sources, and browser-exposed WebMCP capabilities available to
a real Jazzboard user. It receives no repository access, terminal, private room
API, `page.evaluate` mutation, prepared coordinates, operation fixture,
benchmark answer, or evaluator assistance.

Each attempt uses a fresh private room and fresh projectless Codex task backed
by ChatGPT sign-in. Baseline and candidate sessions use the same frozen
requested model, reasoning setting, task instance, source packet, browser and
host versions, viewport, and time, call, and correction budgets. Resolved model
snapshots, tokens, subscription usage, and ChatGPT credits are recorded only
when exposed and are otherwise `unobservable`. The conditions are
interleaved, and their order is randomized within task-and-replicate blocks.
If an API does not provide deterministic sampling, replicate index and time
block are pairing controls; they must not be described as identical randomness.

## Benchmark partitions

- `development` supports instrumentation work, failure analysis, and prompt or
  harness iteration.
- `validation` selects among candidates and supports preregistered ablations.
- `sealed-test-A` supports one locked milestone comparison.
- `replication-B` supports independent confirmation after test A.

The sealed prompts, sources, answer keys, and judge rubrics remain inaccessible
to authoring and implementation agents. Opening either sealed partition turns
it into consumed test evidence; it may not subsequently be used for tuning.

**No sealed test partition may be opened, sampled, scored, inspected, or used
to choose a candidate during the development pilot or validation phases.**

## Phased program

The active program inserts two validity gates before the previously described
development A/B pilot. This ordering is authoritative for the current research
branch:

1. complete provider-free execution readiness and hard-block API transport;
2. pass one fresh projectless Codex/WebMCP disposable spike through ChatGPT
   sign-in;
3. run EXP-0001A A/A through isolated Codex tasks while preserving usage-limit
   pauses and chronological A0/A1 balance;
4. validate the frozen rater on a separately preregistered public gold corpus;
5. publish both gate reports and resolve every alarm; and only then
6. freeze and run a candidate-versus-baseline development A/B experiment.

A/A agreement is reliability evidence, not reviewer-accuracy evidence. Public
gold validity is rater-accuracy evidence, not product-lift evidence. Neither
gate may be skipped or pooled into an apparent improvement estimate.

### Phase 0 — Measurement readiness

Freeze the baseline, artifact schemas, trace validation, scorer behavior,
reviewer blinding, hash manifests, environment capture, and all-attempt run
registry. Verify that transport fixtures and contract tests are labeled
separately from autonomous authoring trials.

### Phase 0A — A/A operational calibration

Run EXP-0001A with the exact same receipt-bound baseline behind both opaque
labels. Its fixed schedule is 12 public development tasks, two task-level
replicates, 24 pairs, 48 author attempts, and two primaries per retained
attempt. It tests clean-room execution, denominator completeness, treatment
neutrality, reviewer repeatability, provenance, recovery, accounting, and
cluster-aware analysis. It cannot support a product-improvement or reviewer-
accuracy claim.

### Phase 0B — Public gold rater validation

Run the exact production-shaped blinded evaluator on independently labeled
public rendered artifacts spanning architecture and drawing. Report
sensitivity, specificity, false accepts, false rejects, criterion behavior,
domain differences, evidence coverage, and source-exemplar-clustered
uncertainty. A/A may not substitute for this gate. The corpus, thresholds,
randomization, task settings, and subscription-accounting policy must freeze
before the first evaluated response.

### Phase 1 — Development A/B pilot

Only after phases 0A and 0B pass, freeze a new version of experiment `exp-0001`:
12 development tasks, two paired replicates per task, 24 baseline/candidate
pairs and 48 total agent sessions. Use it to measure feasibility, characterize
failure modes, estimate paired discordance and task-level variance, and
simulate later sample sizes. It is exploratory, not confirmatory, and cannot
authorize a general improvement claim.

### Phase 2 — Validation and ablation

On validation tasks only, compare the baseline, the complete candidate, and
preregistered leave-one-component-out variants. Candidate components may
include task-scoped scene context, concise receipts, progressive tool
disclosure, actual pixel delivery, and issue-focused correction. Each ablation
must name the failure it addresses and a mechanism metric. Freeze one candidate
before any sealed-test access.

### Phase 3 — Sealed confirmation

Compare the frozen candidate with the exact receipt-bound baseline on
`sealed-test-A`. The provisional
headline design is 60 unique task instances with four paired replicates: 240
pairs, 240 sessions per condition, and 480 sessions total. The final task count
and replication count must be fixed by a new immutable protocol after pilot
power simulation. Add unique tasks before extra within-task repetitions when
budget permits.

### Phase 4 — Replication and rollout

Repeat the locked comparison on `replication-B`, preferably across another
supported model or host profile without combining the estimands. If offline
criteria pass, use a bounded product canary to verify operational reliability,
latency, and cost before broad rollout.

## Outcomes

### Primary outcome

- Blinded task success without human correction, evaluated independently of
  treatment label.

### Secondary outcomes

- Semantic completeness and relationship correctness.
- First-pass acceptance and final rendered-quality rubric scores.
- Blinded visual win, tie, and loss rates.
- Geometry, text readability, and local-repair correctness.
- Correction lift after each inspection round.
- Tool-selection, schema-error, timeout, and ambiguous-transaction rates.
- Tool calls, round trips, descriptor bytes, context bytes, tokens, and cost.
- Time to first useful draft, total latency, and correction latency.

Ordinal rubric scores are reported as points, not percentages. Visual
preference is reported as a blinded win/tie/loss rate and does not substitute
for semantic correctness.

### Hard guardrails

- Authorization, privacy, and clean-room boundaries.
- Stable identity, bindings, revision checks, leases, atomicity, attribution,
  and preservation of unrelated or human-authored state.
- Progressive presentation, closing inspection, and atomic authoritative
  handoff where the product contract requires them.
- No blind retry after an uncertain mutation outcome.
- Preregistered reliability, p95 latency, and cost ceilings.

Critical boundary or document-integrity failures are reported individually and
cannot be averaged away by a composite score.

## Analysis principles

The primary report gives the absolute paired pass-rate difference and a 95%
confidence interval. Confirmatory analysis resamples whole task clusters while
retaining their repetitions; paired randomization inference or McNemar analysis
is a sensitivity check. Task-family weights, multiplicity handling, preference
models, skew-aware latency and cost summaries, and non-inferiority margins must
be fixed in the applicable confirmatory protocol.

Headline estimates must be shown both with equal task-family weighting and any
separately preregistered deployment weighting. Subgroup results remain
secondary unless explicitly powered and preregistered.

## Provisional power plan

Final power will be simulated from pilot-observed baseline success, paired
discordance, between-task variance, and within-task correlation. Approximate
nominal requirements for a paired binary endpoint at 80% power and two-sided
5% alpha are:

| Absolute lift | Assumed discordant-pair rate | Approximate pairs |
| --- | ---: | ---: |
| 15 percentage points | 35% | 115 |
| 10 percentage points | 30% | 230 |
| 8 percentage points | 25% | 300 |

These figures precede task clustering, unusable evaluation artifacts, and any
multiplicity adjustment. Repetitions within one task do not replace task
diversity.

## Attempt and stopping policy

The all-attempt registry begins when the task brief is delivered to the agent.
From that point, failures, refusals, timeouts, malformed calls, no-op sessions,
and abandoned sessions count in the assigned condition. They may not be
silently excluded or replaced. Evaluator or infrastructure incidents are
classified under rules frozen in the experiment protocol; the original record
and any supplemental rerun both remain visible.

Confirmatory experiments use a fixed sample with no significance peeking,
efficacy stopping, or unregistered extension. A run may pause only for a
privacy or security breach, invalid measurement system, or broad infrastructure
incident. Resumption, restart, or protocol amendment must be documented before
additional outcomes are inspected.

## Provisional ship criteria

A confirmatory protocol should require all of the following:

- Primary point estimate at least 10 percentage points and its two-sided 95%
  confidence interval excludes zero.
- No critical privacy, integrity, or temporal-contract failure is observed;
  the upper confidence bound is still reported when zero are observed.
- Visual preference is non-inferior under a frozen margin.
- Reliability degradation stays within a frozen margin, provisionally five
  percentage points.
- Upper confidence bounds for candidate-to-baseline latency and cost ratios
  remain below frozen ceilings, provisionally 1.15 and 1.10.
- No severe regression is concentrated in an important task family.
- Replication is directionally consistent before broad rollout.

## Permitted claim language

Pass-rate changes lead with percentage points: “success increased from 50% to
60%, a gain of 10 percentage points (20% relative), 95% CI …”. Relative change
may follow only for a preregistered ratio-scale measure with a meaningful,
nonzero baseline. “Percent better,” “percent more beautiful,” and percentages
derived from ordinal scores are prohibited.

Pilot reports may state observed counts, paired differences, and uncertainty
while explicitly labeling them exploratory. Only a locked sealed comparison
may support a general harness-improvement claim, and only within the tested
model, host, task distribution, and budgets.
