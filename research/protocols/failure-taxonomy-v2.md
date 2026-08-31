# Failure taxonomy v2

- Status: immutable classification contract once cited by a frozen experiment
- Supersedes for new work: `failure-taxonomy-v1.md`
- Applies to: development, validation, calibration, and later preregistered
  experiments that explicitly cite version 2
- Unit: one attempt, beginning when its task brief is durably delivered
- Sealed-data rule: this taxonomy contains no sealed content and may not be
  revised after seeing sealed outcomes

## Why version 2 exists

Version 1 required adjudication for disagreements in binary success, primary
class, criticality, or incident status. EXP-0001A instead preregistered one
third review only when the two primaries disagree on binary acceptance. This
version resolves that contradiction without rewriting version-1 history.

Version 2 preserves every version-1 primary class, precedence rule, binary
mapping, and mechanism tag. Its only classification-policy change is:

- binary-acceptance disagreement receives one independent adjudication;
- class-only, mechanism-only, criticality-only, and incident-status-only
  disagreements remain visible diagnostics and do not trigger an additional
  review; and
- when binary acceptance agrees but primary classes differ, the locked class
  is the earliest supported class in the frozen precedence order. Both primary
  ratings remain immutable, `classAgreement` is false, and the record states
  `resolution: frozen_precedence_without_adjudication`.

This avoids outcome-selective extra judging while retaining disagreement as
measurement evidence. Version-1 records remain version 1 and are never
silently recoded.

## Classification contract

Every begun attempt receives exactly one terminal primary class and zero or
more mechanism tags. The primary class determines binary task success and is
used for denominator reconciliation. Tags explain contributing or recovered
mechanisms without double-counting attempts or replacing the primary outcome.

`NOT_STARTED` is a scheduling state only when no task brief was delivered; it
is not an attempt or primary class. `IN_PROGRESS` is transient and must be
resolved before a report locks. Future taxonomy versions must publish an
explicit crosswalk rather than overwrite historical classifications.

## Mutually exclusive primary classes

Apply the first decisive supported class in this order. A class is decisive
only when its condition caused failure, invalidated the attempt, or made the
required outcome unscoreable. A recovered noncritical issue is a mechanism tag
only.

| Order | Primary class | Decisive condition | Binary success |
| ---: | --- | --- | --- |
| 0 | `SUCCESS` | Frozen task rubric passes and no critical guardrail fails | `true` |
| 1 | `FAIL_PROTOCOL_VIOLATION` | Assignment, clean-room, preregistration, or all-attempt rules are violated | `false` |
| 2 | `FAIL_PRIVACY_INTEGRITY` | Unauthorized access, secret exposure, destructive state corruption, or human-work loss occurs | `false` |
| 3 | `FAIL_EVALUATOR_SCORER` | Required evidence or a trustworthy score is unavailable because evaluation failed | `false` |
| 4 | `FAIL_INFRASTRUCTURE` | A verified external service, browser, host, network, capacity, or capture incident prevents completion | `false` |
| 5 | `FAIL_WEBMCP_TOOLING` | A valid, authorized tool workflow is unavailable or malfunctions and prevents completion | `false` |
| 6 | `FAIL_TRANSACTION_REVISION_LEASE` | Transaction, revision, lease, identity, binding, or commit behavior prevents a valid result | `false` |
| 7 | `FAIL_TEMPORAL_PRESENTATION` | A required progressive-draft or atomic-handoff contract fails | `false` |
| 8 | `FAIL_AUTHOR_NONCOMPLETION` | The author refuses, abandons, exhausts budget, misuses available capabilities, or claims completion without a scorable result | `false` |
| 9 | `FAIL_SEMANTIC` | The final artifact or edit misses a frozen entity, label, relationship, direction, grouping, source, or preservation requirement | `false` |
| 10 | `FAIL_GEOMETRY_VISUAL` | Semantics pass, but frozen rendered-quality, readability, geometry, recognizability, or composition criteria fail | `false` |
| 11 | `FAIL_INSPECTION_CORRECTION` | Artifact criteria otherwise pass, but a required inspection, issue-focused correction, verification, or bounded-stop criterion fails | `false` |

Precedence is a reproducibility rule, not a severity score. Every observed
mechanism remains available through evidence-grounded tags.

## Mechanism-tag vocabulary

Each tag requires a trace, receipt, revision, render, score, incident, or
protocol evidence reference. Use all supported tags, including on `SUCCESS`
when a noncritical issue was safely recovered. Do not infer cause from outcome
appearance alone.

### Author behavior

- `AUTHOR_REFUSAL`
- `AUTHOR_ABANDONED`
- `AUTHOR_BUDGET_EXHAUSTED`
- `AUTHOR_WRONG_TOOL`
- `AUTHOR_INVALID_INPUT`
- `AUTHOR_IGNORED_RECEIPT`
- `AUTHOR_UNSAFE_RETRY`
- `AUTHOR_FALSE_COMPLETION`

### WebMCP and tooling

- `TOOL_REGISTRY_MISSING`
- `TOOL_SCHEMA_MISMATCH`
- `TOOL_VALID_CALL_ERROR`
- `TOOL_INCORRECT_RECEIPT`
- `TOOL_PIXEL_UNAVAILABLE`
- `TOOL_HOST_INCOMPATIBLE`

### Transaction, revision, lease, identity, and binding

- `TX_EXPECTED_STALE_REJECTION`
- `TX_AMBIGUOUS_COMMIT`
- `TX_ATOMICITY_BREACH`
- `TX_EXPECTED_LEASE_CONFLICT`
- `TX_LEASE_BUG`
- `TX_REVISION_NONMONOTONIC`
- `TX_IDENTITY_BINDING_CORRUPT`
- `TX_UNRELATED_STATE_CHANGED`

### Semantic outcome

- `SEM_REQUIRED_ENTITY_MISSING`
- `SEM_LABEL_OR_ROLE_WRONG`
- `SEM_RELATIONSHIP_MISSING`
- `SEM_DIRECTION_OR_ENDPOINT_WRONG`
- `SEM_GROUP_OR_BOUNDARY_WRONG`
- `SEM_REQUIRED_SOURCE_OR_UNCERTAINTY_MISSING`
- `SEM_EXISTING_INTENT_NOT_PRESERVED`

### Geometry and visual outcome

- `VIS_CLIPPED_OR_OFF_CANVAS`
- `VIS_TEXT_OVERFLOW_OR_UNREADABLE`
- `VIS_UNINTENDED_OCCLUSION`
- `VIS_CONNECTOR_CROSSING_OR_ROUTE`
- `VIS_ALIGNMENT_SPACING_OR_CONTAINMENT`
- `VIS_WEAK_HIERARCHY_OR_CONTRAST`
- `VIS_RECOGNIZABILITY_OR_COMPOSITION`
- `VIS_INTENTIONAL_GEOMETRY_MISCATEGORIZED`

### Inspection and correction

- `INSPECT_REQUIRED_SCOPE_OMITTED`
- `INSPECT_PIXELS_NOT_RECEIVED`
- `INSPECT_WRONG_OR_STALE_REVISION`
- `INSPECT_FINDING_NOT_GROUNDED`
- `CORRECTION_NOT_ISSUE_FOCUSED`
- `CORRECTION_REGRESSED_ACCEPTED_STATE`
- `CORRECTION_NOT_REINSPECTED`
- `CORRECTION_STAGNATION_LIMIT_BREACHED`

### Temporal presentation

- `TEMP_DRAFT_LIFECYCLE_MISSING`
- `TEMP_REVEAL_NOT_PROGRESSIVE`
- `TEMP_COMMIT_BEFORE_PRESENTATION_COMPLETE`
- `TEMP_DRAFT_AUTHORITATIVE_OVERLAP`
- `TEMP_HANDOFF_NOT_ATOMIC`
- `TEMP_FINAL_REVISION_NOT_PRESENTED`
- `TEMP_ACTIVE_PRESENTATION_ALTERED_IN_EVIDENCE`

### Evaluator and scorer

- `EVAL_CAPTURE_MISSING_OR_CORRUPT`
- `EVAL_WRONG_REVISION_SCORED`
- `EVAL_SCORER_NONDETERMINISTIC`
- `EVAL_RUBRIC_AMBIGUOUS`
- `EVAL_JUDGE_DISAGREEMENT`
- `EVAL_BLINDING_BREACH`
- `EVAL_ARTIFACT_HASH_MISMATCH`
- `EVAL_DENOMINATOR_MISMATCH`

### Infrastructure

- `INFRA_BROWSER_OR_HOST_CRASH`
- `INFRA_NETWORK_OR_SERVICE_OUTAGE`
- `INFRA_CAPACITY_OR_QUOTA`
- `INFRA_MODEL_SERVICE_INTERRUPTION`
- `INFRA_CAPTURE_PIPELINE_FAILURE`
- `INFRA_CLOCK_OR_TELEMETRY_FAILURE`

### Privacy and integrity

- `PRIV_UNAUTHORIZED_CAPABILITY_OR_ACCESS`
- `PRIV_SECRET_OR_PERSONAL_DATA_EXPOSED`
- `PRIV_REPOSITORY_OR_ANSWER_ACCESS`
- `INTEGRITY_HUMAN_WORK_OVERWRITTEN`
- `INTEGRITY_STATE_CORRUPTION_OR_DATA_LOSS`
- `INTEGRITY_ATTRIBUTION_WRONG`

### Protocol compliance

- `PROTO_WRONG_COMMIT_OR_CONFIGURATION`
- `PROTO_WRONG_MODEL_HOST_OR_BUDGET`
- `PROTO_RANDOMIZATION_DEVIATION`
- `PROTO_FORBIDDEN_AUTHOR_ASSISTANCE`
- `PROTO_FORBIDDEN_MUTATION_PATH`
- `PROTO_SEALED_DATA_ACCESSED`
- `PROTO_UNREGISTERED_EXCLUSION_OR_REPLACEMENT`
- `PROTO_POST_OUTCOME_THRESHOLD_CHANGE`
- `PROTO_ATTEMPT_OR_ARTIFACT_OMITTED`

## Incident versus author failure

An external incident requires contemporaneous logs or independent reproduction
showing that a valid authorized action or required environment was unavailable
independently of author choice. Malformed input, wrong-tool selection, ignored
receipts, unsafe retries, poor judgment, or ordinary budget exhaustion remain
author behavior. Correct stale-revision and lease rejections are expected
safety behavior; classify by what ultimately prevented success. When cause is
uncertain, apply the earliest supported class, retain all supported tags, and
set `causalConfidence: uncertain`; never remove the attempt from analysis.

## Classification timing and blinded review

1. At attempt end, the recorder assigns a provisional evidence-grounded class
   without viewing a paired artifact or condition aggregates.
2. Two treatment-blinded primaries independently score the rubric, guardrails,
   binary acceptance, primary class, mechanism tags, criticality, and incident
   status using the same frozen evidence packet.
3. Only binary-acceptance disagreement receives one distinct blinded
   adjudicator. The adjudicator resolves binary acceptance and the terminal
   primary class while both original ratings remain immutable.
4. When binary acceptance agrees, no adjudicator is called. If primary classes
   differ, resolve by the frozen precedence table and retain both ratings with
   `classAgreement: false` and
   `resolution: frozen_precedence_without_adjudication`.
5. Mechanism, criticality, incident-status, and class disagreements are
   reported as diagnostics. `EVAL_JUDGE_DISAGREEMENT` marks the disagreement
   without converting a scoreable artifact into evaluator failure.
6. Lock classifications before labels decode or condition aggregates exist.
   Record reviewer commitments, timestamps, taxonomy digest, evidence refs,
   agreement fields, and resolution method.
7. Factual corrections append a signed amendment containing old/new values,
   new evidence, author, time, and publication impact. Never overwrite a lock.

## No favorable recoding, reruns, or exclusions

No class or tag may change because it harms an estimate, crosses a threshold,
creates imbalance, or complicates a claim. Every failure after brief delivery
remains in the assigned condition. Diagnostic reruns receive new immutable IDs
and never replace original attempts or enter the primary estimate. A complete-
case sensitivity may accompany but never replace all-attempt analysis.

## Critical guardrails

Any `PROTO_*`, `PRIV_*`, or `INTEGRITY_*` tag; any atomicity, nonmonotonic
revision, identity-binding, or unrelated-state mutation breach; an unsafe
retry; a temporal atomic-handoff breach; or evaluator blinding, determinism,
artifact-hash, or denominator breach is critical. A confirmed critical tag
cannot coexist with `SUCCESS`; it maps to the earliest applicable failure
class. Recovered noncritical tags may coexist with `SUCCESS`.

## Crosswalk from version 1

| Version-1 field | Version-2 field | Conversion rule |
| --- | --- | --- |
| Primary class | Same identifier | Identity mapping; precedence unchanged |
| Binary success | Same Boolean | Identity mapping |
| Mechanism tag | Same identifier | Identity mapping |
| Binary disagreement | Binary disagreement | Adjudicate in both versions |
| Class-only disagreement | Class-only disagreement | Version 1 adjudicates; version 2 uses frozen precedence without an extra call |
| Criticality-only disagreement | Criticality diagnostic | Version 1 adjudicates; version 2 reports without an extra call |
| Incident-only disagreement | Incident diagnostic | Version 1 adjudicates; version 2 reports without an extra call |

Historical version-1 records retain their original adjudication path. Applying
version 2 prospectively requires freezing this file's exact bytes and digest in
the experiment manifest and reviewer prompt.
