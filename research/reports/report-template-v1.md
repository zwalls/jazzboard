# Experiment report template v1

Delete instructional placeholders only after every section is complete. Use
`not applicable` with a reason instead of silently omitting a section.

## Report identity

- Experiment and protocol version:
- Report version and status (`draft`, `final`, or `superseded`):
- Protocol, amendment, and analysis-script hashes:
- Baseline and candidate commits:
- Benchmark partition and manifest hash:
- Model, reasoning, host, browser, and deployment versions:
- Scorer version and configuration hash:
- Execution window and report author:

## Decision and permitted claim

- Preregistered decision reached:
- One-sentence claim permitted by the protocol:
- Important scope limitation:
- Ship, continue, investigate, or stop recommendation:

Do not introduce claim language or a decision threshold absent from the frozen
protocol.

## Protocol adherence

| Check | Result | Evidence or hash |
| --- | --- | --- |
| Exact treatments reconstructed |  |  |
| Task manifest frozen before runs |  |  |
| Randomization frozen before runs |  |  |
| Author/evaluator separation preserved |  |  |
| Reviewer blinding preserved |  |  |
| Sealed-data boundary preserved |  |  |
| Analysis matches preregistration |  |  |

List every amendment, deviation, unplanned analysis, and date discovered.
Separate confirmatory results from exploratory or sensitivity analyses.

## Run accounting

| Accounting item | Baseline or A0 | Candidate or A1 | Total |
| --- | ---: | ---: | ---: |
| Planned sessions |  |  |  |
| Not started before brief delivery |  |  |  |
| Attempts begun |  |  |  |
| Completed normally |  |  |  |
| Refusals or no-ops |  |  |  |
| Timeouts or crashes |  |  |  |
| Tool or platform failures |  |  |  |
| Outcome evidence unavailable |  |  |  |
| Primary all-attempt denominator |  |  |  |
| Supplemental reruns, excluded from primary |  |  |  |

Explain why planned sessions, not-started records, attempts, primary
denominators, and supplemental runs reconcile exactly. Link every nonstandard
status to its immutable run ID and incident record.

## Primary outcome

- Estimand:
- Analysis population:
- Point estimate, absolute difference, and 95% interval:
- Prespecified test or randomization result:
- Practical threshold and decision:

| Paired binary outcome | Count |
| --- | ---: |
| Both succeed |  |
| Baseline or A0 only succeeds |  |
| Candidate or A1 only succeeds |  |
| Both fail |  |

Report raw numerators and denominators before percentages. State whether task
clustering, repetitions, task-family weights, and missing outcomes were handled
exactly as preregistered.

## Guardrails

| Guardrail | Margin or required value | Baseline | Candidate | Interval | Result |
| --- | --- | ---: | ---: | --- | --- |
| Privacy and authorization |  |  |  |  |  |
| Document integrity |  |  |  |  |  |
| Temporal presentation |  |  |  |  |  |
| Reliability |  |  |  |  |  |
| p95 latency |  |  |  |  |  |
| Cost |  |  |  |  |  |

Describe every critical failure individually. Zero observed failures must be
accompanied by an upper confidence bound, not described as a zero failure rate.

## Secondary and mechanism outcomes

Report semantic fidelity, rendered quality, first-pass acceptance, correction
lift, blinded win/tie/loss preference, tool and schema errors, ambiguous
transactions, calls, round trips, context and descriptor bytes, tokens, time to
first useful draft, total latency, and cost as required by the protocol.

For each outcome state the unit, numerator and denominator, summary statistic,
interval, multiplicity status, and whether it was confirmatory, exploratory, or
a sensitivity analysis. Report ordinal scales in points and skewed resource
measures with medians or preregistered paired ratios.

## Results by task and stratum

| Task or stratum | Attempts per condition | Baseline or A0 | Candidate or A1 | Difference | Notes |
| --- | ---: | ---: | ---: | ---: | --- |
|  |  |  |  |  |  |

Show both equal-family and preregistered deployment-weighted results when
required. Do not promote a post-hoc subgroup observation to a headline claim.

## Calibration diagnostics

For A/A studies, report configuration identity, label-order balance, success
difference, paired randomization result, opaque-label preference, reviewer
agreement and adjudication, artifact completeness, deterministic scorer replay,
resource ratios, and every falsification or diagnostic threshold. For A/B
studies, reference the prerequisite calibration report and disposition.

## Missingness, incidents, and sensitivity analyses

List each affected immutable run ID, assigned condition, when the task brief was
delivered, failure classification, primary treatment, supplemental rerun link,
and whether the handling was preregistered. Show complete-case or alternative
analyses only as labeled sensitivities; they never replace the all-attempt
result.

## Artifact and provenance ledger

| Artifact | Schema version | Durable location | Bytes | SHA-256 | Verification |
| --- | --- | --- | ---: | --- | --- |
| All-attempt registry |  |  |  |  |  |
| Task manifest |  |  |  |  |  |
| Randomization manifest |  |  |  |  |  |
| Protocol and amendments |  |  |  |  |  |
| Scorer configuration |  |  |  |  |  |
| Analysis output |  |  |  |  |  |
| Trace index |  |  |  |  |  |
| Render and media index |  |  |  |  |  |

Room secrets, guest sessions, private source content, and personally
identifying data must not appear in the published report.

## Reproduction record

- Clean-checkout command or script:
- Required inputs and durable locations:
- Seed and randomization handling:
- Generated outputs and expected hashes:
- Independent verifier, date, and result:

## Claim audit

- Exact public wording:
- Absolute effect and interval stated before any relative effect:
- Tested model, host, task distribution, and budgets stated:
- Guardrail results and material limitations stated:
- Prohibited causal, equivalence, beauty, intelligence, or generalization
  language absent:

## Sign-off

- Research owner:
- Independent evaluator:
- Engineering owner:
- Approval date:
- Supersedes or is superseded by:
