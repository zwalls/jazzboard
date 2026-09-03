# EXP-0019 paired-port congestion replication

- Date: 2026-09-02
- Status: complete; visual gate passed, factual, speed, and evaluator-reliability gates failed
- Product candidate: `cb03b6f912dd61b0ad5be52102d0e31e3b160209`
- Benchmark: unchanged `dev-architecture-create-observability`
- Author: fresh projectless `gpt-5.6-terra`, reasoning `medium`
- Primary reviewer and adjudicator: separate fresh projectless `gpt-5.6-sol`, reasoning `high`

## Result

The paired-port congestion defect from EXP-0018 is gone. The final diagram is
clean and readable, with three distinct planes, six required components, five
visible connector labels, coherent first-class Diagram membership, and no
near-coincident ingress. Both isolated pixel reviewers found zero blocking
geometry violations.

The artifact still fails. The required `Alert Engine → Telemetry Store`
`evaluate` relationship is authoritatively stored as `Telemetry Store → Alert
Engine`. The connector prose describes the requested direction, but its actual
start and end object IDs are reversed. The first draft receipt exposed that
contradiction directly; the author ignored it and later claimed all directions
were correct.

More importantly, both isolated model judges received the sanitized
authoritative state and still returned a factual pass. That is a confirmed
evaluator false-positive, not evidence that the artifact passed. Exact
benchmark facts must therefore be verified deterministically from authoritative
IDs; model reviewers should remain responsible for visual and perceptual
questions.

Wall time was 351,598 ms, 69,003 ms (24.4%) slower than EXP-0018 and 169,214
ms (92.8%) slower than the fastest prior passing run, EXP-0013. The author used
four draft transactions, five inspections, three state reads, and four
post-commit updates. No population percentage claim is permitted.

## What improved

- The exact two-connector ingress collision that failed EXP-0018 did not recur.
- Both pixel judges passed geometry, plane distinction, and fixed-viewport
  readability.
- All required entities and labels are visible, and Diagram membership is
  coherent.
- The product signal remains passive and intent-unaware: Jazzboard did not move
  endpoints, choose ports, or impose a layout.

## What failed

- One of five required directed relationships is reversed in authoritative
  state.
- `relationshipReview` correctly exposed the actual reversal, but the author
  did not reconcile it with the public facts.
- Both independent model judges false-passed the same exact endpoint mismatch.
- The run was the slowest observability replication so far, with a long
  post-commit text-correction loop.

## Next intervention

Add a deterministic semantic audit at the blinded evidence boundary. It should
match public benchmark entities to authoritative semantic objects, then verify
required relationship type and actual connector start/end object IDs. Missing,
duplicate, ambiguous, reversed, or type-mismatched facts must fail the factual
gate and cannot be overridden by a model decision.

This does not make diagramming deterministic and does not constrain how an
agent draws. It makes the experiment's ground-truth checks deterministic.
Model reviewers continue to judge visual composition, readability, perceptual
quality, and other criteria that cannot be settled from semantic IDs alone.

The complete sanitized record is
`research/data/exp-0019-paired-port-congestion-replication-v1.json`. Room
credentials, raw sessions, semantic state, and pixels remain private and
gitignored.
