# EXP-0001A execution-readiness runbook

- Status: Codex-native coordinator rebuild complete and validated; the immutable
  prebrief signature is intentionally absent, so **no A/A author brief is
  authorized or released**
- Partition: public development only
- Product under both opaque labels: commit `48a52e0837144ea0db8a09e43217397226759f83`
- Fixed schedule: 24 pairs / 48 author attempts / 96 primary reviews
- Active transport: fresh projectless Codex tasks authenticated through ChatGPT
- Mandatory gate: one passing disposable Codex/WebMCP spike
- Prohibited transport: `OPENAI_API_KEY` and direct OpenAI Responses API calls

This file is the operational companion to
`exp-0001a-aa-calibration.md`. It records the implementation edges that must
remain closed even if the active coding context is compacted. It does not
authorize execution, alter the frozen schedule, or expose a sealed partition.
`exp-0001a-codex-native-transport-v1.md` supersedes every API-key, provider-
response, pricing, dollar-spend, and spend-authorization provision below.
Historical source and tests may be inspected while rebuilding, but they cannot
release a task or contact a provider.

## Authoritative chain

The execution chain is, in order:

1. The exact pre-brief freeze commits the product, public development tasks,
   schedule, requested model/reasoning, browser, tools,
   scorer/evaluator policy, and every execution-critical source path and byte
   digest.
2. A committed-code receipt proves those bytes are ordinary Git blobs at one
   exact commit and tree and equal the current checkout bytes.
3. An authenticated Vercel alias preflight proves the public execution URL
   resolves to the frozen deployment and build.
4. A contract-only clean-room run captured after the freeze and committed-code
   checkpoint proves the participant and spectator WebMCP contracts still
   equal their frozen hashes. It must not call an author model.
5. A credential-safe `codex login status` preflight proves ChatGPT—not API-key—
   authentication.
6. A disposable projectless Codex task proves the public browser/WebMCP path
   end to end and is reconciled against authoritative room evidence.
7. An exclusive release lock and durable no-brief receipt prove that zero A/A
   task briefs have been released.
8. The execution gate recomputes every digest and emits a short-lived receipt
   signed by the precommitted execution authority. The coordinator verifies
   that signature and reruns the live ChatGPT-authentication check under the
   release lock immediately before every task creation.

No test fixture, caller declaration, mutable working-tree path, or historical
contract receipt may substitute for any element in this chain.

## Required implementation closures

Checked items below mean the fail-closed implementation and its synthetic
verification are present. They do not mean that any A/A author or reviewer task
has run. The all-attempt registry and final completion signature remain
unchecked until the frozen experiment is separately authorized and completed.

- [x] Every legacy direct-model entry point fails closed before configuration,
  credential, browser, or network work. The active deterministic runtime cannot
  import a retired provider runner or spend ledger.
- [x] `codex login status` is executed without reading credential files. Only
  the exact ChatGPT-authenticated result passes; API-key, unknown, contradictory,
  failed, timed-out, or oversized output is a hard stop.
- [x] One disposable fresh projectless Codex task passed the private-room
  browser/WebMCP spike and returned terminal output reconciled with authoritative
  Jazzboard semantic state, revision history, participant attribution, and
  activity evidence. This v2 eligibility spike deliberately makes no final-PNG
  claim; per-attempt image evidence uses the separate byte-bearing path below.
- [x] The retained v2 spike release gate is bound to the exact independently
  retained raw task, ordered browser/WebMCP trace, and authoritative room
  recovery through fixed SHA-256 commitments and a fixed Ed25519 authority;
  the revoked v1 gate and caller-mintable self-hashes are rejected.
- [x] The v2 prebrief freeze binds the exact deterministic runtime bundle,
  transitive input inventory, 48-entry schedule, role settings, task/rubric/
  taxonomy bytes, reviewer rosters and assignments, adjudication rule, and
  randomized 24-item pairwise work order.
- [x] The deterministic runtime rejects local dynamic imports, unexpected
  externals, retired provider/spend modules, host/private/cache paths, and any
  uncommitted byte drift.
- [x] The active coordinator journals each state transition before the related
  external action and exposes one exact machine-actionable next step at a time.
  It never embeds a task brief in logs intended for publication.
- [x] Scheduler, provisioning reservation, room receipt, author handoff,
  transport plan, Codex task lifecycle, accounting record, and final artifact
  share the same exact assignment, attempt, schedule, and room commitments.
- [x] Each assignment reserves one neutral opaque private-room nonce before
  `create_room`. An uncertain result reconciles only through the current
  browser session's private recent-room evidence; it never retries blindly or
  enumerates rooms belonging to other sessions.
- [x] Room provisioning fields are derived from retained exact WebMCP results.
  Invite-to-room authorization is proven by the corresponding join/read result,
  room IDs are unique across the batch, and coordinator presence has genuinely
  expired before author task creation.
- [x] Blank rooms remain byte-identical to the authoritative blank baseline;
  seeded rooms contain exactly the single frozen atomic seed transaction. Any
  extra revision, object, connector, presence, or mutation blocks release.
- [x] The author-visible task brief is independently rendered from the exact
  frozen public packet. Caller-supplied or resealed changes cannot reach a task.
- [x] Every author, primary reviewer, adjudicator, and pairwise judge is created
  as a distinct neutral-title projectless Codex task with no fork, shared
  history, repository, private API, prepared geometry, or evaluator leakage.
- [x] A fresh non-injectable ChatGPT authentication preflight runs immediately
  before every task-creation invocation. A retained receipt alone cannot
  authorize release.
- [x] Ambiguous task creation is recovered through its unique opaque neutral
  title and the app task list. Zero or multiple matches remain unresolved and
  the prompt is never re-released.
- [x] Author trace policy permits only the platform Browser-skill bootstrap,
  the exact Jazzboard origin, and browser-exposed WebMCP calls. Reviewer trace
  policy permits only its one hash-addressed read-only loopback evidence packet
  and rejects access to Jazzboard/recent rooms, repository, filesystem, private
  HTTP, other tasks, or shared browser state.
- [x] Exactly two fresh independent primary tasks review each retained attempt.
  They receive only the public requirement, frozen rubric, sanitized semantic
  state, and revision-matched PNGs; no transcript, label, paired artifact,
  repository, room secret, or prior decision is visible.
- [x] Only binary primary-acceptance disagreement launches one distinct fresh
  adjudicator over the same blinded evidence. It does not receive the primary
  decisions. Other disagreements remain diagnostics.
- [x] Pairwise visual review starts only after individual decisions lock, uses
  the frozen randomized left/right work order, permits ties, and cannot repair
  semantic, integrity, trace, or evidence failure.
- [x] Every successful author result is independently reconciled to its final
  authoritative room read, complete trace, semantic state, object inventory,
  tool calls, and exactly one final-revision PNG before acceptance.
- [x] Task accounting records fresh Codex task/thread IDs, requested model and
  reasoning, wall time, WebMCP calls/failures, revisions, inspections,
  observable subscription/credit usage, and usage-limit interruptions. Tokens,
  resolved model snapshots, and credits are literal `unobservable` when not
  exposed; no value is estimated.
- [x] A usage-limit interruption pauses before the next brief, preserves the
  affected begun task and every prior attempt, and resumes only after an
  authoritative no-brief availability/reset observation. The next assignment
  is the first genuinely unstarted frozen assignment; A0/A1 prefix imbalance
  never exceeds one across usage windows.
- [ ] The immutable registry reconciles all 48 author attempts, 96 primary
  reviews, the exact binary-disagreement adjudication count, and 24 pairwise
  judgments with unique task IDs and no silent exclusions or replacements.
- [ ] Completion requires a detached Ed25519 authority signature over the
  frozen runtime/gate, full scheduler and accounting roots, all task/trace/
  evidence/review roots, analysis root, and exact role denominators. A
  caller-created digest cannot mark the run complete.
- [x] Outcome, semantic, visual, correction, presentation, efficiency, and
  usage metrics preserve missing observations as missing/`unobservable`. No
  missing field silently becomes a pass, zero, or ordinary author failure.
- [x] Primary A/A inference uses the preregistered 12-cluster sign-flip design;
  naive pair-level tests remain descriptive. Sealed-sample planning propagates
  pilot uncertainty and uses the preregistered cluster-aware power rule.

These A/A closures establish reliability and neutrality only. Before any A/B
harness claim, the separately frozen public rendered-gold gate in
`public-gold-rater-validation-v1.md` must establish domain-specific reviewer
sensitivity and specificity with false-accept/false-reject uncertainty.

## Fixed execution order

1. Verify the gate and lock.
2. Execute the 48 author assignments in frozen manifest order. A temporary
   `not_started` incident may retry only the same still-unbegun assignment. A
   begun attempt is never replaced.
3. Reconcile and seal the complete author denominator before generating any
   reviewer assignment.
4. Run all 96 primary reviews without exposing the paired artifact, opaque
   label meaning, aggregate outcomes, or another reviewer decision.
5. Generate and run only the preregistered binary-disagreement adjudications.
6. Lock individual classifications, then run pairwise visual preference in its
   separately randomized presentation order.
7. Decode labels once, compile the report once, and retain every input/output
   hash. No outcome-driven rerun, threshold change, or favorable selection is
   permitted.

## Frozen evaluator-measurement design

The first reviewer in each artifact's already-frozen ordered pair is the
measurement reviewer. This choice is a function of the pre-brief review plan,
not of its output. Its single blinded response must include both the ordinary
criterion decision and a schema-bounded assessment of every exact revision
packet supplied to it, plus the final successful-artifact decision. The
assessment is part of that reviewer's immutable record and therefore locks
before classification, pairwise comparison, label decoding, or aggregate
analysis. It does not create an outcome-selected follow-up call.

The coordinator later derives the attempt-metrics assessment envelope directly
from that exact locked primary record, its frozen reviewer identity commitment,
and the verified review-ledger root. There is no optional caller callback and no
post-unblinding assessor. A failed measurement reviewer remains failed evidence;
the affected evaluator-derived endpoints are unobservable and their coverage
denominators must show the loss. File presence and endpoint coverage are
reported separately.

Revision packets may contain only the public task/rubric, a neutral revision
identifier and room revision, sanitized authoritative state when retained, and
the exact revision-bound PNG bytes already committed by the attempt artifact
index. They cannot expose an attempt ID, opaque label, assignment order, pair,
author transcript, raw tool trace, treatment-bearing path, room secret, or
aggregate result. The packet inventory, hashes, ordering, image dimensions, and
fresh reviewer-task command are retained and verified before release.

## Frozen A/A inference and planning design

The primary A/A symmetry statistic is the mean signed A1-minus-A0 outcome. Its
exact two-sided randomization distribution flips the complete two-replicate
outcome vector for each of the 12 task clusters as one unit, enumerating all
`2^12` task-level sign assignments. The visual-preference symmetry statistic
uses the same task-cluster sign-flip rule after encoding A1 win as `+1`, A0 win
as `-1`, and tie as `0`. Ordinary 24-pair McNemar and non-tie sign-test values
remain clearly labeled descriptive sensitivities. The investigation decision
uses the cluster-aware values.

Pilot-based sealed planning must show uncertainty, not only point estimates.
At minimum it reports interval estimates for pooled success, paired
discordance, and within-task dependence; the planning discordance and
dependence use preregistered conservative bounds. For each externally fixed
candidate lift, the deterministic simulation uses the task-cluster sign-flip
statistic and its predeclared large-task normal randomization approximation,
then searches upward in unique tasks. Selection requires a simultaneous
one-sided 95% lower power bound to reach `0.80`; the bound allocates familywise
error across the complete fixed 30-through-600 task candidate universe, so a
noisy earlier pointwise crossing cannot stop the search. The random seed,
simulation count, increment rule, maximum, pointwise interval, simultaneous
bound, and all failed candidate sizes are retained. A one-shot nominal
requirement multiplied by a design effect is diagnostic only and cannot be the
recommended sample size.

## Pause and failure behavior

Pause immediately for contract/deployment drift, registry uncertainty,
identity collision, non-ChatGPT authentication, usage-limit interruption,
privacy or secret leakage, missing or
tampered required evidence, manifest/order drift, or a broad infrastructure
incident. Preserve all bytes and registries. A run can resume only from the
first manifest assignment that provably never reached brief delivery; a begun
attempt stays in the primary denominator.

Any source, model, reasoning setting, rubric, runner, evaluator, or analysis change after
the immutable checkpoint creates a new protocol/freeze version. It may not be
patched into the active A/A run.

## Completion artifacts

- immutable all-attempt and review registries with independent readback;
- per-attempt author and evaluator artifact manifests and hashes;
- A/A configuration-identity proof and exact run accounting;
- paired success cells, descriptive interval and randomization result;
- reviewer agreement, kappa when estimable, adjudication and preference rates;
- semantic, visual, correction, presentation, efficiency, wall-time, Codex-task,
  WebMCP-call/failure, revision, inspection, and observable subscription-usage
  summaries with explicit coverage and literal `unobservable` fields;
- every falsification/diagnostic threshold and disposition;
- deterministic scorer replay and judge-validation report;
- pilot-informed sealed-sample sensitivity plan without opening any sealed
  prompt, source, rubric, answer, or artifact.
