# Failure taxonomy v1

- Status: immutable classification contract
- Applies to: development, validation, calibration, and later preregistered
  experiments that cite version 1
- Unit: one attempt, beginning when its task brief is delivered
- Sealed-data rule: this taxonomy contains no sealed content and may not be
  revised after seeing sealed outcomes

## Classification contract

Every begun attempt receives exactly one terminal primary class and zero or
more mechanism tags. The primary class determines binary task success and is
used for denominator reconciliation. Tags explain contributing or recovered
mechanisms without double-counting attempts or replacing the primary outcome.

`NOT_STARTED` is a scheduling state used only when no task brief was delivered;
it is not an attempt or a primary class. `IN_PROGRESS` is transient and must be
resolved before a report is final.

Class identifiers, meanings, and precedence are immutable within version 1.
Future versions must preserve the original value and publish an explicit
crosswalk rather than rewriting historical records.

## Mutually exclusive primary classes

Apply the first decisive class in the precedence order below. A class is
decisive only when its condition caused task failure, invalidated the attempt,
or made the required outcome unscoreable. A recovered issue that does not
prevent success is a mechanism tag only.

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

Precedence is a reproducibility rule, not a severity score. For example, a
semantically incomplete architecture diagram that also has connector crossings
is `FAIL_SEMANTIC` with semantic and visual tags. A task that would otherwise
pass but skips a required pixel verification is `FAIL_INSPECTION_CORRECTION`.
All observed mechanisms remain available through tags.

## Multi-label mechanism tags

Tags require an evidence reference to a trace event, receipt, revision, render,
score, incident, or protocol record. Use all supported tags, including on a
`SUCCESS` attempt when the issue was safely recovered. Do not infer root cause
from outcome appearance alone.

### Author behavior

- `AUTHOR_REFUSAL` — declined an authorized task.
- `AUTHOR_ABANDONED` — stopped before a terminal result with budget remaining.
- `AUTHOR_BUDGET_EXHAUSTED` — reached a frozen time, token, call, or correction
  budget.
- `AUTHOR_WRONG_TOOL` — selected an available but unsuitable capability.
- `AUTHOR_INVALID_INPUT` — sent malformed or schema-invalid arguments.
- `AUTHOR_IGNORED_RECEIPT` — disregarded an actionable success, warning, or
  conflict receipt.
- `AUTHOR_UNSAFE_RETRY` — retried without reconciling an uncertain mutation.
- `AUTHOR_FALSE_COMPLETION` — claimed completion without required evidence.

### WebMCP and tooling

- `TOOL_REGISTRY_MISSING` — an authorized required tool was not discoverable.
- `TOOL_SCHEMA_MISMATCH` — advertised schema and accepted schema differed.
- `TOOL_VALID_CALL_ERROR` — a valid authorized invocation failed unexpectedly.
- `TOOL_INCORRECT_RECEIPT` — receipt misstated status, IDs, revisions, or next
  safe action.
- `TOOL_PIXEL_UNAVAILABLE` — promised pixel evidence could not be delivered.
- `TOOL_HOST_INCOMPATIBLE` — the frozen host did not support the advertised
  contract.

### Transaction, revision, lease, identity, and binding

- `TX_EXPECTED_STALE_REJECTION` — a correct revision fence rejected stale work.
- `TX_AMBIGUOUS_COMMIT` — author could not establish whether mutation applied.
- `TX_ATOMICITY_BREACH` — part of an all-or-nothing mutation became
  authoritative.
- `TX_EXPECTED_LEASE_CONFLICT` — a correct lease prevented unsafe contention.
- `TX_LEASE_BUG` — lease state or enforcement contradicted the contract.
- `TX_REVISION_NONMONOTONIC` — authoritative revision history regressed or
  forked unexpectedly.
- `TX_IDENTITY_BINDING_CORRUPT` — stable IDs, membership, endpoints, or bindings
  were lost or incorrect.
- `TX_UNRELATED_STATE_CHANGED` — a mutation altered state outside authorized
  scope.

### Semantic outcome

- `SEM_REQUIRED_ENTITY_MISSING`
- `SEM_LABEL_OR_ROLE_WRONG`
- `SEM_RELATIONSHIP_MISSING`
- `SEM_DIRECTION_OR_ENDPOINT_WRONG`
- `SEM_GROUP_OR_BOUNDARY_WRONG`
- `SEM_REQUIRED_SOURCE_OR_UNCERTAINTY_MISSING`
- `SEM_EXISTING_INTENT_NOT_PRESERVED`

Each semantic tag must identify the frozen rubric item and involved stable IDs
when available.

### Geometry and visual outcome

- `VIS_CLIPPED_OR_OFF_CANVAS`
- `VIS_TEXT_OVERFLOW_OR_UNREADABLE`
- `VIS_UNINTENDED_OCCLUSION`
- `VIS_CONNECTOR_CROSSING_OR_ROUTE`
- `VIS_ALIGNMENT_SPACING_OR_CONTAINMENT`
- `VIS_WEAK_HIERARCHY_OR_CONTRAST`
- `VIS_RECOGNIZABILITY_OR_COMPOSITION`
- `VIS_INTENTIONAL_GEOMETRY_MISCATEGORIZED`

The final tag is used when a lint, scorer, or correction incorrectly treats
deliberate overlap, asymmetry, routing, or layering as a defect.

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

Classify an external incident only when contemporaneous logs or independent
reproduction show that a valid, authorized action or required environment was
unavailable independently of the author's choice. Mere failure after a tool
call is insufficient.

- A malformed argument, wrong tool, ignored conflict receipt, or failure to
  reconcile an expected stale-revision rejection is author behavior. Use
  `FAIL_AUTHOR_NONCOMPLETION` when decisive, plus the relevant author and
  transaction or tool tags.
- A valid call rejected because the tool implementation contradicts its frozen
  schema is `FAIL_WEBMCP_TOOLING` when decisive.
- A correct stale-revision or lease rejection is not a product failure. Tag the
  expected rejection; classify by what ultimately prevented success.
- A proven atomicity, revision, lease, identity, or binding defect is
  `FAIL_TRANSACTION_REVISION_LEASE` when decisive.
- A broad verified outage is `FAIL_INFRASTRUCTURE`; a tool-specific defect
  during an otherwise healthy service is `FAIL_WEBMCP_TOOLING`.
- Model refusal, poor judgment, or ordinary budget exhaustion is author
  behavior. A verified model-service interruption is infrastructure.

When responsibility remains uncertain at report lock, apply the earliest
supported primary class from the precedence table, add all evidence-supported
tags, set `causalConfidence: uncertain`, and disclose the ambiguity. Do not use
an “unknown” primary class to remove the attempt from analysis.

## Classification timing and blind review

1. At attempt end, the recorder assigns a provisional class from artifacts
   without viewing its paired counterpart or aggregate condition results.
2. Two treatment-blinded reviewers independently score the frozen task rubric,
   guardrails, primary class, and mechanism tags using only hashed evidence.
3. Any disagreement in success, primary class, criticality, or incident status
   goes to a third blinded adjudicator. Preserve both original decisions.
4. Lock classification before treatment labels are decoded or condition-level
   results are calculated. Record classifier IDs, timestamps, taxonomy version,
   evidence references, and adjudication rationale.
5. Later factual corrections append a signed amendment containing old value,
   new value, new evidence, author, time, and whether any published estimate
   changes. Never overwrite the locked record.

Reviewer disagreement itself receives `EVAL_JUDGE_DISAGREEMENT`; it does not
make an otherwise scoreable attempt an evaluator failure after adjudication.

## No favorable recoding

A class or tag may not change because it harms a treatment estimate, crosses a
threshold, creates imbalance, or complicates a claim. Infrastructure,
evaluator, and protocol labels require affirmative evidence; they are not
fallbacks for poor artifacts. Rubric reinterpretation, new exclusions, and
causal relabeling after condition unblinding are exploratory amendments and do
not alter the preregistered primary analysis.

All failures after brief delivery remain in the assigned condition. A
complete-case sensitivity analysis may accompany, but never replace, the
all-attempt result.

## Supplemental reruns

A rerun receives a new immutable attempt ID and `analysisRole: diagnostic`,
links to the original attempt and incident, and records the same classification
fields. It may test reproducibility or help assign a cause. It never replaces
the original attempt, changes its denominator, inherits its randomization slot,
or enters the primary estimate unless a future protocol independently samples
it. Report original and supplemental outcomes together.

## Hard-guardrail mapping

Every failure class has `binarySuccess: false`. The following mappings also
trigger hard-guardrail reporting and cannot be averaged away by appearance or
semantic scores:

| Primary class or tag | Hard guardrail | Required action |
| --- | --- | --- |
| `FAIL_PROTOCOL_VIOLATION` or any `PROTO_*` tag | Preregistration and clean-room validity | Stop or quarantine per protocol; preserve attempt |
| `FAIL_PRIVACY_INTEGRITY` or any `PRIV_*` tag | Authorization and privacy | Stop immediately and follow incident policy |
| Any `INTEGRITY_*` tag | State, human-work, and attribution integrity | Stop if ongoing harm is possible; audit affected state |
| `TX_ATOMICITY_BREACH`, `TX_REVISION_NONMONOTONIC`, `TX_IDENTITY_BINDING_CORRUPT`, or `TX_UNRELATED_STATE_CHANGED` | Atomicity, identity, revision, and scope | Treat as critical integrity failure |
| `FAIL_TEMPORAL_PRESENTATION` or `TEMP_COMMIT_BEFORE_PRESENTATION_COMPLETE`, `TEMP_DRAFT_AUTHORITATIVE_OVERLAP`, or `TEMP_HANDOFF_NOT_ATOMIC` | Progressive presentation and atomic handoff | Fail temporal contract and retain temporal evidence |
| `AUTHOR_UNSAFE_RETRY` | No blind retry after uncertain mutation | Fail the applicable safety guardrail |
| `EVAL_BLINDING_BREACH`, `EVAL_SCORER_NONDETERMINISTIC`, `EVAL_ARTIFACT_HASH_MISMATCH`, or `EVAL_DENOMINATOR_MISMATCH` | Trustworthy independent evaluation | Invalidate measurement until disposition |

A recovered noncritical tag may coexist with `SUCCESS`. A critical tag cannot:
if blind review confirms a critical tag, primary class must be the applicable
failure class under precedence and binary success is false.

## Classification examples

| Scenario | Primary class | Mechanism tags | Rationale |
| --- | --- | --- | --- |
| Architecture diagram omits the playback-license responsibility but is visually clean | `FAIL_SEMANTIC` | `SEM_REQUIRED_ENTITY_MISSING` | A frozen semantic requirement is absent |
| Architecture nodes and directions are correct, but labels overflow and unrelated connectors cross nodes | `FAIL_GEOMETRY_VISUAL` | `VIS_TEXT_OVERFLOW_OR_UNREADABLE`, `VIS_CONNECTOR_CROSSING_OR_ROUTE` | Semantics pass; rendered readability fails |
| Author sends a stale revision, receives a correct conflict receipt, blindly retries, and times out | `FAIL_AUTHOR_NONCOMPLETION` | `TX_EXPECTED_STALE_REJECTION`, `AUTHOR_IGNORED_RECEIPT`, `AUTHOR_UNSAFE_RETRY`, `AUTHOR_BUDGET_EXHAUSTED` | The platform behaved correctly; author recovery failed |
| A valid architecture transaction partially commits before returning an error | `FAIL_TRANSACTION_REVISION_LEASE` | `TX_ATOMICITY_BREACH` | Critical transaction integrity is broken |
| Progressive architecture preview commits while objects remain hidden | `FAIL_TEMPORAL_PRESENTATION` | `TEMP_COMMIT_BEFORE_PRESENTATION_COMPLETE`, `TEMP_FINAL_REVISION_NOT_PRESENTED` | Required temporal contract fails |
| Portrait contains face and clothing but omits both required folded hands | `FAIL_SEMANTIC` | `SEM_REQUIRED_ENTITY_MISSING` | Recognizable pixels do not satisfy named-part requirements |
| Drawing contains all named parts, but the face is clipped and focal hierarchy is unreadable | `FAIL_GEOMETRY_VISUAL` | `VIS_CLIPPED_OR_OFF_CANVAS`, `VIS_WEAK_HIERARCHY_OR_CONTRAST` | Required visual criteria fail after semantic pass |
| Drawing passes final artifact criteria, but the agent claims pixel review without receiving a render | `FAIL_INSPECTION_CORRECTION` | `INSPECT_PIXELS_NOT_RECEIVED`, `AUTHOR_FALSE_COMPLETION` | Required inspection evidence is absent |
| A drawing correction turns a previously accepted hand into an obvious occlusion and is not reinspected | `FAIL_GEOMETRY_VISUAL` | `CORRECTION_REGRESSED_ACCEPTED_STATE`, `CORRECTION_NOT_REINSPECTED`, `VIS_UNINTENDED_OCCLUSION` | Final visual outcome fails; correction tags preserve mechanism |
| Independent capture crashes after brief delivery and no final revision can be scored | `FAIL_INFRASTRUCTURE` | `INFRA_CAPTURE_PIPELINE_FAILURE`, `EVAL_CAPTURE_MISSING_OR_CORRUPT` | Verified external incident makes outcome unscoreable |
| Evaluator opens a sealed answer while judging a development drawing | `FAIL_PROTOCOL_VIOLATION` | `PROTO_SEALED_DATA_ACCESSED`, `EVAL_BLINDING_BREACH` | Protocol validity takes precedence and sealed content stays undisclosed |

Examples illustrate classification logic only. They contain no benchmark
answers, task manifests, sealed prompts, or sealed rubrics.

## Required record fields

Each begun attempt records `attemptId`, `taxonomyVersion`, `primaryClass`,
`binarySuccess`, `mechanismTags`, `causalConfidence`, `evidenceRefs`,
`provisionalClassifier`, `blindReviewers`, `adjudicator`, classification and
lock timestamps, incident links, supplemental-run links, and append-only
amendments. Reports must reconcile primary-class counts exactly to the
all-attempt denominator.
