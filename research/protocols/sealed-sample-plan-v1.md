# Sealed-sample planning protocol v1

Status: planning specification only. This document contains no sealed prompts,
answer keys, scores, or empirical pilot estimates. Every numeric input below is
a hypothetical sensitivity assumption used to expose how sample requirements
change.

## Primary endpoint and unit

The primary binary endpoint is preregistered accepted-artifact success. One
paired observation runs baseline and candidate on the same task assignment and
run condition, then records whether each artifact passes the same frozen gate.
The four possible pair outcomes are both fail, baseline-only pass,
candidate-only pass, and both pass.

The unique task is the sampling cluster. Repeated runs on the same task can
measure stochastic reliability, but they do not create the same information as
new tasks. Statistical planning therefore reports unique tasks and total paired
runs separately.

## Paired-binary parameterization

Let `p0` be baseline acceptance, `delta` the candidate-minus-baseline lift, and
`d` the total discordance probability. The paired 2x2 probabilities are:

- candidate-only pass: `(d + delta) / 2`;
- baseline-only pass: `(d - delta) / 2`;
- both pass: `p0 - (d - delta) / 2`;
- both fail: `1 - p0 - (d + delta) / 2`.

Inputs are rejected unless all four cells are nonnegative, `d >= |delta|`, and
both marginal rates lie in `[0, 1]`. Once lift and discordance are fixed,
McNemar power does not depend on baseline rate; the baseline rate remains in
the plan because it determines whether the assumed paired table is feasible.

## Nominal independent-pair calculation

`findNominalPairRequirement` uses a two-sided, equal-tailed exact McNemar/sign
test at alpha 0.05. For each possible number of discordant pairs it obtains the
exact binomial rejection region under probability 0.5, evaluates that region
under candidate-win probability `(d + delta) / (2d)`, and averages over the
binomial distribution of the discordant count. It scans pair counts in order,
so the returned requirement is the first discrete count reaching target power.

This result is explicitly labeled `independent_pairs_no_task_clustering`. It is
a nominal lower-level requirement, not the execution sample size when a task is
repeated.

## Task clustering and design effect

For `r` equal replicates per task and intratask correlation `rho` of the signed
paired difference, the planning design effect is:

`DE = 1 + (r - 1) * rho`.

The cluster-adjusted pair requirement is `ceil(nominal pairs * DE)`. Unique
tasks are `ceil(adjusted pairs / r)`, and total pairs are rounded up to complete
task clusters. The plan always prints these values beside, not in place of, the
nominal calculation.

The Monte Carlo sensitivity check uses a deterministic seeded common-shock
mixture. Each task draws a shared paired outcome; each replicate uses that
outcome with probability `sqrt(rho)` and otherwise draws independently. This
preserves the requested marginal 2x2 table and gives signed paired differences
the requested intratask correlation. Each simulated dataset is tested from the
task-level mean differences with a two-sided cluster-level normal statistic.
At least 30 unique tasks are required. Monte Carlo estimates include Wilson 95%
simulation intervals; they are numerical uncertainty intervals, not confidence
intervals for any observed Jazzboard effect.

## Hypothetical sensitivity scenarios

All rows target 80% power at two-sided alpha 0.05. The seeds control only the
planning simulation and must be retained exactly when regenerating this table.

| Scenario | Baseline | Lift | Discordance | Nominal independent pairs | Replicates/task | ICC | Design effect | Cluster-adjusted unique tasks | Rounded pairs | Monte Carlo power (95% MC interval) | Seed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| larger-lift sensitivity | 0.55 | 0.15 | 0.30 | 112 | 2 | 0.10 | 1.10 | 62 | 124 | 0.852 (0.845–0.859) | 2026083101 |
| central sensitivity | 0.55 | 0.12 | 0.30 | 172 | 2 | 0.25 | 1.25 | 108 | 216 | 0.843 (0.835–0.850) | 2026083102 |
| smaller-lift sensitivity | 0.55 | 0.08 | 0.35 | 448 | 3 | 0.40 | 1.80 | 269 | 807 | 0.822 (0.814–0.829) | 2026083103 |

These rows are not estimates of likely Jazzboard performance. Before any
sealed run, the chosen effect, discordance, and ICC assumptions must be frozen
from an external rationale or a separately authorized public-development
pilot. Sealed results may never be used to revise this table or choose a more
favorable row.

In the EXP-0001A analysis report these legacy hypothetical Monte Carlo rows are
retained only as `non_recommendation_diagnostics_only`. Their older
cluster-mean normal test cannot be selected as the design test. The only
sample-size recommendation is the uncertainty-aware observed-A/A search below,
which consistently uses the task-cluster sign-flip planning approximation.

## Replicate-allocation sensitivity

The following table holds the central hypothetical effect and discordance
fixed. It shows why repeated runs cannot be counted as independent unique
tasks.

| Allocation | Nominal independent pairs | Replicates/task | ICC | Design effect | Unique tasks | Rounded pairs | Monte Carlo power (95% MC interval) | Seed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| breadth first | 172 | 1 | 0.25 | 1.00 | 172 | 172 | 0.828 (0.821–0.836) | 2026083110 |
| two replicates | 172 | 2 | 0.25 | 1.25 | 108 | 216 | 0.841 (0.834–0.848) | 2026083111 |
| three replicates | 172 | 3 | 0.25 | 1.50 | 86 | 258 | 0.843 (0.835–0.850) | 2026083112 |

The one-replicate row still contains a baseline/candidate pair; “one
replicate” does not mean one unpaired run.

## Recommendation rules

1. Reject any plan that does not reach the preregistered target power.
2. Among feasible allocations, prefer more unique tasks before marginally
   higher repeated-run power. `rankTaskAllocations` implements this order.
3. Give every selected task one baseline/candidate pair before assigning a
   second pair to any task. Add repeated pairs only after the unique-task floor
   is met or when a separately preregistered reliability estimand requires
   them.
4. If exactly equal replication is required operationally, use the
   cluster-adjusted task count, never the nominal pair count divided by
   replicates.
5. Use at least 30 unique tasks overall and preserve planned task-stratum
   quotas. More tasks are required if a stratum-level claim needs independent
   power.
6. Freeze task count, repetitions, exclusions, alpha, effect, discordance, ICC,
   simulation count, and seed before sealed access. Do not stop when a desired
   significance result appears.
7. If resources cannot support the chosen plan, change the claim or return to
   public development planning. Do not inspect a subset of sealed outcomes to
   negotiate the sample size.

## Public-development A/A calibration update

When the exact 48-attempt, 24-pair, 12-task development A/A denominator is
available, the report may add an exploratory planning calibration without
touching sealed-test data. It reports Wilson 95% intervals for pooled success
and paired discordance, plus a deterministic 10,000-draw task-cluster bootstrap
interval for within-task dependence. Non-estimable dependence uses the
predeclared `0.40` fallback; planning otherwise takes at least the upper
bootstrap bound and `0.40`. Planning discordance takes at least its upper
Wilson bound, the fixed lift, and `0.30`.

The old nominal-pairs-times-design-effect result remains visible as a
`diagnostic_only_not_recommended_sample_size` calculation. The recommendation
instead searches every unique-task count from that diagnostic starting point
through 600, in increments of one, using 1,000 simulations and fixed
candidate-specific seeds. Its decision statistic is the complete-task
sign-flip sum with the preregistered large-task normal randomization
approximation. The retained pointwise Wilson Monte Carlo interval is
descriptive. Selection uses a simultaneous one-sided 95% Hoeffding lower bound
with Bonferroni allocation over the complete fixed candidate universe of 571
counts (30 through 600). Therefore an isolated noisy pointwise crossing cannot
be selected. If no simultaneous lower bound reaches 0.80, the plan reports
`maximum_exhausted` and recommends no sample size.

Under the central hypothetical assumptions, the breadth-first planning
recommendation is 172 unique tasks with one paired replicate per task. If two
replicates per task are mandatory, the distinct cluster-adjusted alternative is
108 unique tasks and 216 total pairs. Neither number is an empirical claim;
the smaller-lift sensitivity demonstrates that a materially larger plan may be
required.

## Reproduction contract

The checked-in implementation is `src/lib/research/sample-planning.ts`.
Regeneration must record the product commit, module schema, scenario inputs,
simulation count, seeds, and generated table. Any implementation or assumption
change creates a new protocol version rather than silently rewriting this one.
