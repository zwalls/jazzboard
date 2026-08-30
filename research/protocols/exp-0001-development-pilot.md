# EXP-0001 — Harness development pilot

- Protocol version: 2
- Status: design frozen; execution not authorized until the candidate commit,
  task-manifest hash, scorer version, and randomization manifest are appended
  in a new protocol version before the first task brief is delivered
- Baseline commit: `48a52e0837144ea0db8a09e43217397226759f83`
- Baseline receipt: `research/data/baseline-freeze-v1.json`
- Candidate branch: `feature/agent-evaluation-science`
- Partition: `development` only

## Objective

Test whether the paired evaluation machinery is feasible and estimate the
quantities needed to power a later validation or sealed experiment. This pilot
is exploratory. It does not test a confirmatory superiority hypothesis and
cannot support a product-wide or model-wide improvement claim.

Version 2 replaces the pre-execution short commit reference with the exact
receipt-bound production identity; no task brief had been delivered under
version 1. The candidate commit is intentionally not inferred from the moving branch
head. No pilot run is authorized until a successor protocol freezes its exact
commit and confirms that the baseline and candidate environments can be
reconstructed.

## Estimand

The pilot estimates the paired absolute task-success difference:

`P(success | candidate harness) - P(success | baseline harness)`.

Success means blinded acceptance without human correction under the frozen
task rubric, with every critical integrity criterion satisfied. The unit is a
fresh agent session. A baseline/candidate pair shares a task instance and
replicate/time block but never a room, context, or authoring history.

## Sample and strata

Use 12 development task instances and two paired replicates per task:

- 12 tasks × 2 replicate blocks = 24 paired comparisons.
- Each pair contains one baseline and one candidate session.
- Total planned sample = 48 agent sessions, 24 per condition.

The development manifest should cover both architecture and freeform work and
include creation, editing, dense geometry, retrieval, and collaboration or
stale-state stressors. Record family, complexity, required capabilities, task
source hash, and rubric hash. The pilot may be imbalanced across these strata;
all estimates must therefore disclose the observed task mix.

Task instances must be selected and hashed before outcomes are observed. No
sealed-test or replication task, prompt, source, answer, or rubric may be
opened, sampled, inspected, or scored for EXP-0001.

## Frozen conditions

Before execution, record and hold constant across treatment within every pair:

- Exact model snapshot, reasoning effort, sampling settings, and system
  instructions outside the treatment.
- Browser, WebMCP host, viewport (`1280 × 720`), deployment, and evaluator
  versions.
- Task brief, authorized source packet, initial room state, and user role.
- Token, wall-clock, tool-call, round-trip, and correction budgets.
- Capture cadence, artifact schema, and scorer/judge instructions.

The authoring agent receives only the high-level brief, authorized room entry
point, public task sources, and browser-exposed WebMCP capabilities. Repository
access, terminals, private room APIs, `page.evaluate` mutation, prepared
coordinates, operation fixtures, answer keys, and evaluator assistance are
forbidden.

## Pairing and randomization

Create a randomization manifest before starting any run. Within each task and
replicate block, randomly assign condition order as baseline-then-candidate or
candidate-then-baseline. Balance the 24 order assignments as closely as
possible across task family and replicate index. Interleave conditions in time;
do not finish all baseline runs before candidate runs.

Each session starts with a fresh private room and fresh agent context. Pairing
controls task content and execution period. Unless the inference API exposes a
verified deterministic seed, it does not control the model's exact stochastic
trajectory and must not be described as doing so.

## Outcomes

### Primary pilot outcome

- Blinded binary task success without human correction.

### Secondary outcomes

- Semantic requirement completion and relationship correctness.
- First-pass acceptance and final rendered-quality rubric points.
- Blinded pairwise visual win, tie, and loss.
- Geometry defects, text readability, and preservation of intentional overlap.
- Per-round correction lift: improved, held, or degraded.
- Tool-selection errors, schema errors, failed calls, conflicts, ambiguous
  transactions, and timeouts.
- Tool calls, round trips, descriptor bytes, context bytes, tokens, and cost.
- Time to first useful draft, total latency, and correction latency.

Two treatment-blinded reviewers independently score each final artifact. They
score artifacts individually before making pairwise comparisons. Disagreement
on binary success is adjudicated by a third blinded reviewer; all original
ratings and judge IDs remain in the data. Randomize baseline/candidate left-right
placement for preference judgments and permit ties.

### Hard guardrails

- Clean-room authorization and privacy boundary.
- Stable IDs, bindings, revisions, leases, atomicity, attribution, and
  preservation of unrelated or human-authored state.
- Progressive presentation and atomic authoritative handoff where required.
- No blind retry after an uncertain mutation.
- Exact final-revision render and truthful pixel-inspection status.

Any critical guardrail failure makes task success false and is reported
separately; it cannot be canceled by a high visual score.

## All-attempt and missing-data policy

An attempt begins when the task brief is delivered to the agent. Every attempt
thereafter counts in its assigned condition, including refusal, timeout,
malformed call, no-op, abandoned session, agent crash, and author-visible tool
failure. An unfavorable attempt is never deleted or silently replaced.

An incident before brief delivery is “not started,” not an attempt. If a
verified evaluator or platform incident after delivery destroys outcome
evidence, retain the attempted run, label the incident, and score task success
as false in the primary all-attempt summary. A supplemental rerun may diagnose
the incident only if both its link to the original and its non-primary status
are explicit. Report complete-case sensitivity results separately if useful.

## Analysis

Because EXP-0001 is small and exploratory, emphasize raw paired outcomes and
uncertainty rather than significance:

- Report baseline and candidate successes over 24 attempts each.
- Report the paired absolute difference and all four paired outcome cells:
  both pass, baseline only, candidate only, and both fail.
- Report results by task family and task, without inferential subgroup claims.
- Estimate between-task variance, within-task correlation, and paired
  discordance for later simulation.
- Report visual win/tie/loss counts and original reviewer agreement.
- Report medians, interquartile ranges, and paired ratios for skewed latency,
  token, and cost measures.
- Use a task-cluster bootstrap interval only as a descriptive diagnostic; with
  12 task clusters it is not a confirmatory confidence statement.

Do not pool reviewer ratings or the two repetitions as if they were independent
task instances. Do not create an unregistered composite score.

## Provisional power handoff

Use pilot estimates to simulate the sample size for the next immutable
protocol. As initial planning anchors, a paired binary endpoint at 80% power and
two-sided 5% alpha requires approximately 115 pairs to detect a 15-point lift
when 35% of pairs are discordant, 230 pairs to detect a 10-point lift when 30%
are discordant, or 300 pairs to detect an 8-point lift when 25% are discordant.

The simulation must incorporate task clustering and prefer additional unique
tasks over extra within-task repetitions. The provisional sealed design is 60
tasks × 4 paired repetitions, but EXP-0001 cannot finalize or initiate it.

## Stopping rule

The planned pilot sample is fixed at 48 attempted sessions. There is no
efficacy, futility, significance, or favorable-result stopping. Do not extend
the sample because the observed result is close to a threshold.

Pause execution only for a privacy or security breach, invalid scorer or
measurement system, corrupted treatment assignment, or broad infrastructure
incident. Preserve all completed and active attempt records. Before resuming or
restarting, publish a versioned amendment describing the incident, affected
runs, and unchanged or revised analysis treatment without inspecting sealed
data.

## Pilot decision rule

EXP-0001 advances to validation design only if:

- Every planned artifact and hash can be captured reproducibly.
- Treatment assignment and reviewer blinding remain intact.
- Task success and guardrails are scoreable for at least 11 of 12 tasks.
- Failure classifications and resource metrics are sufficiently complete to
  support power simulation.
- No unresolved privacy, authorization, or critical integrity defect makes
  further autonomous testing unsafe.

This is a measurement-readiness gate, not a superiority or ship gate.

## Permitted reporting language

Allowed: “In the 24-pair development pilot, candidate success was X/24 versus
Y/24 for baseline, an exploratory paired difference of Z percentage points;
the pilot was designed for feasibility and power estimation.”

If reporting a rate change, lead with percentage points and show both
denominators. A relative percentage may follow only for a preregistered
ratio-scale metric with a meaningful nonzero baseline. Ordinal rubric changes
are points, and visual preference is a win/tie/loss rate.

Prohibited for this pilot: “statistically significant,” “proven,” “X% better,”
“X% more beautiful,” “production improvement,” or any general claim beyond the
tested development tasks, model, host, and budgets.

## Required run record

For every attempt, record condition and order, task and replicate IDs, exact
commits and environment versions, model settings, budgets, start and stop
times, attempt status, ordered tool categories, failures, room and revision
hashes, semantic state, scorecard, reviewer records, media and trace hashes,
resource measures, exclusion or incident labels, and links to supplemental
runs. Every report must reconcile exactly to the all-attempt registry.
