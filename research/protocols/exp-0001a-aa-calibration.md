# EXP-0001A — A/A measurement calibration

- Protocol version: 4
- Status: preregistered; disposable Codex/WebMCP spike passed; full execution
  remains blocked pending the frozen Codex-native coordinator and validation
- Product commit behind both labels: `48a52e0837144ea0db8a09e43217397226759f83`
- Baseline receipt: `research/data/baseline-freeze-v1.json`
- Partition: `development` only
- Labels: opaque `A0` and `A1`; both resolve to the identical product and
  harness configuration

## Purpose and non-hypothesis

Version 2 replaced the pre-execution short commit reference with the exact
receipt-bound production identity. Version 3 separates A/A reliability from
public-gold rater validity and prospectively binds failure taxonomy v2's
binary-disagreement-only adjudication rule. Version 4 replaces the unexecuted
API-key transport with fresh projectless Codex tasks authenticated through
ChatGPT and is governed by `exp-0001a-codex-native-transport-v1.md`. No A/A
task brief was delivered under versions 1 through 3. EXP-0001A tests the experiment machinery, not a harness
change. Its purpose is to expose label leakage, order effects, environment
drift, missing artifacts, unreliable scoring, broken pairing, or analysis
errors before EXP-0001. Because
`A0` and `A1` run the same frozen commit and configuration, any apparent label
effect is diagnostic noise or measurement bias, not product improvement.

Failure to detect a difference does not prove equivalence, absence of bias, or
adequate power. This protocol has no superiority hypothesis and cannot satisfy
a ship gate.

## Frozen prerequisites

Before the first task brief is delivered, hash and freeze the development task
manifest, model snapshot and reasoning settings, system instructions, budgets,
browser and WebMCP host versions, deployment, scorer and judge instructions,
artifact schemas, randomization schedule, and analysis script. Verify that the
resolved commit and treatment-relevant configuration hashes for `A0` and `A1`
are identical. Freeze the exact bytes and digest of
`failure-taxonomy-v2.md`; version 1 remains historical and is not rewritten.
A mismatch is a protocol failure, not an alternative treatment.

No validation, `sealed-test-A`, or `replication-B` prompt, source, rubric,
answer, manifest content, or artifact may be opened, sampled, inspected, or
scored during EXP-0001A.

## Design

Use the 12 EXP-0001 development task instances with two paired replicate blocks
per task: 24 `A0`/`A1` pairs and 48 total fresh sessions. Each pair shares only
the task instance, source packet, replicate/time block, model settings, host,
viewport, and budgets. It never shares a room, context, or authoring history.

Randomize label order within every pair, balance the 24 order assignments as
closely as possible by task family and replicate, and interleave execution in
time. Treat labels as opaque throughout capture and scoring. If inference is
not deterministically seeded, pairing does not imply identical model output.

## Author and evaluator separation

Authors receive only the high-level brief, authorized room entry point, public
task sources, and browser-exposed WebMCP capabilities. They receive no
repository access, terminal, private room API, `page.evaluate` mutation,
prepared coordinates, operation fixture, answer key, treatment meaning, or
evaluator feedback.

Two treatment-blinded evaluators score final artifacts independently before
any pairwise preference judgment. Randomize left-right display and allow ties.
A third blinded evaluator adjudicates binary-success disagreement. Preserve
all original scores, judge IDs, presentation order, and adjudication records.
Authors may not act as evaluators for their own sessions.

## Outcomes and analysis

Report the four paired binary-success cells, the absolute `A1 - A0` success-rate
difference, exact raw denominators, task-level results, label win/tie/loss
preference, reviewer agreement, adjudication rate, artifact completeness, and
paired wall-time, task, WebMCP-call, failure, revision, and inspection summaries.
Report tokens, resolved model snapshots, subscription usage, or ChatGPT credits
only when exposed; otherwise record `unobservable`. Any interval or
randomization test is descriptive calibration evidence only.

Do not pool repeat sessions or judge ratings as independent task samples. Do
not tune thresholds after inspecting outcomes.

## All-attempt policy

An attempt begins when its task brief is delivered. From that point, refusals,
timeouts, malformed calls, no-ops, abandoned sessions, crashes, and tool
failures remain in the assigned label and primary denominator. No unfavorable
attempt may be deleted or silently replaced.

An incident before brief delivery is `not_started`. If a verified platform or
evaluator incident after delivery destroys evidence, retain the attempt and
score binary success false in the all-attempt summary. A linked supplemental
rerun may diagnose the incident but never replaces the original primary record.
The report must reconcile exactly to all 48 planned sessions.

## Preregistered falsification and diagnostic thresholds

The calibration is **falsified and must stop** if any of these occurs:

- `A0` and `A1` resolve to different product, prompt, tool, budget, model,
  scorer, host, or treatment-relevant configuration hashes.
- An author receives forbidden information, an evaluator learns label meaning
  before locking scores, sealed data is accessed, or randomization is altered
  after outcome inspection.
- The all-attempt registry cannot reconcile assignments, artifacts, and
  published denominators exactly.
- Recomputing a deterministic score from the same hashed inputs changes its
  value, or a critical privacy, authorization, or integrity failure makes
  continued autonomous testing unsafe.

If none of those occurs, the following thresholds trigger investigation and a
documented disposition before EXP-0001 may begin:

- Absolute paired success-rate difference exceeds 15 percentage points, or a
  two-sided paired randomization test gives `p < 0.10`.
- Among non-tied blinded comparisons, either opaque label wins less than 35% or
  more than 65%, or label preference gives a two-sided permutation `p < 0.10`.
- Binary-success reviewer agreement is below 80%, Cohen's kappa is below 0.60
  when estimable, or more than 20% of artifacts require adjudication.
- Fewer than 95% of required non-outcome artifact fields are captured, any
  required hash fails verification, or any attempted session is absent.
- The median paired `A1/A0` ratio for wall time, WebMCP calls, revisions, or
  inspections falls outside `[0.80, 1.25]`, or a material label-by-order or
  usage-reset-window pattern appears. An unobservable measure is excluded with
  its coverage reported; it is never imputed.

These are bias alarms, not equivalence margins. Crossing a diagnostic threshold
does not automatically identify a cause; not crossing one does not certify an
unbiased or accurate scorer. Investigate by task, order, time block, judge,
failure class, and environment while preserving the original data. Any changed
machinery requires a new version and a fresh A/A calibration.

## Stopping and decision rule

Complete the fixed 48-attempt sample without efficacy, futility, significance,
or favorable-result stopping. Pause only for a falsification event, security or
privacy breach, invalid measurement system, corrupted assignment, or broad
infrastructure incident. Preserve every begun attempt and publish an amendment
before resumption.

EXP-0001 may start only after all hard falsification checks pass, every
diagnostic trigger has a documented disposition, the report and run registry
reconcile, the product/configuration identity of both labels is verified, and
the separately frozen public rendered-gold rater-validation gate in
`public-gold-rater-validation-v1.md` passes. A/A agreement cannot substitute
for sensitivity, specificity, false-accept, and false-reject evidence against
independently established public gold labels.

## Permitted claims

Allowed: “On 24 paired development blocks using identical commit `48a52e0`
behind both opaque labels, the calibration observed X/24 versus Y/24 successes,
an A/A difference of Z percentage points; scorer agreement was K and artifact
capture was C. These results are instrumentation diagnostics, not an estimate
of harness improvement.” State every triggered threshold and protocol incident.

Not allowed: either label is better, worse, equivalent, unbiased, accurate,
validated for production, or evidence of a harness improvement;
“statistically significant” as a product claim; “X% better”; a ship
recommendation; or generalization beyond this development calibration. A null
result is not proof that the measurement system is correct. A null A/A result
is reliability evidence only; it is not rater-validity evidence.

## Required execution identifiers

Before execution, a successor immutable version must record the exact task and
randomization manifest hashes, model and host versions, scorer version and
configuration hash, artifact-schema versions, analysis-script hash, and the
verified identical configuration hashes for `A0` and `A1`.
