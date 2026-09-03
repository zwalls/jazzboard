# EXP-0016 one-pass clearance replication

- Date: 2026-09-02
- Status: complete; blinded quality gate failed, speed gate failed
- Product candidate: `a870bb2ff4d723ad0be6dc8520c8ae13f450b8cf`
- Benchmark: unchanged `dev-architecture-create-observability`
- Author: fresh projectless `gpt-5.6-terra`, reasoning `medium`
- Primary reviewer and adjudicator: separate fresh projectless `gpt-5.6-sol`, reasoning `high`

## Result

The intervention produced a cleaner compact composition and finished in 291,232
ms, 7,720 ms (2.6%) faster than EXP-0015. It did not preserve quality. The
author's first transaction used unsupported fields on `create_diagram` and put
`diagramTempRef` on every create operation. After the strict rejection, the
author removed the Diagram and every membership link rather than translating
the request into the canonical `create_diagram.members` and `connectors` form.

The final canvas has 17 visible objects: three planes, six nodes, three plane
titles, and five labeled connectors. It has zero first-class Diagrams. Both a
fresh blinded primary reviewer and a fresh blinded adjudicator returned the
same verdict: all three content dimensions passed, but two blocking visual
violations and incoherent Diagram membership made the overall result fail.

This is not a speed-quality gain. It remains 108,848 ms (59.7%) slower than the
fastest prior passing run, EXP-0013, and no population percentage claim is
permitted.

## What improved

- The accepted draft used the new conservative two-line node dimensions.
- Capability discovery took about 46.7 seconds, versus 63.2 seconds in EXP-0015.
- The author needed one accepted create draft and one accepted consolidated
  post-commit compaction transaction.
- The final composition clearly distinguishes production, telemetry platform,
  and responder planes, and all five relationship captions are visible.

## What failed

- The quickstart's correct canonical Diagram example did not overcome ambiguity
  in the broad transaction descriptor. The author invented a spatial
  `create_diagram` container and per-object `diagramTempRef` fields.
- Recovery guidance allowed a destructive semantic simplification: removing the
  Diagram made validation `not_applicable`, which looked clean despite losing a
  required product invariant.
- The node floor did not account for the longest visible line. All six node
  descriptions are ellipsized in the exact final PNG.
- The author spent roughly 70.5 seconds on blank-capture recovery and another
  68.5 seconds compacting and reinspecting the all-horizontal first layout.
- Authoritative endpoints encode the `evaluates` edge from Telemetry Store to
  Alert Engine while its semantic name says the reverse. Both blinded judges
  still marked the facts dimension as passing, so the evaluator harness also
  needs an explicit endpoint-direction check.

## Next intervention

Keep the useful node, edge-clearance, and additive-membership features, but make
the authoring contract harder to misread without adding automatic layout:

1. State that `create_diagram` is semantic metadata plus `members` and
   `connectors`; it never accepts spatial or object-classification fields.
2. State that `diagramTempRef` is only for `edit_diagram` draft patches and never
   belongs on object create operations.
3. On schema rejection, require preserving the first-class Diagram invariant
   and translating to the canonical form instead of deleting semantic structure.
4. Before submit, compare each supplied relationship's subject → object with
   connector `start` → `end`; labels and semantic names do not override endpoint
   direction.
5. Size conventional nodes from the longest visible line, not only line count,
   and plan compact multi-row topologies when the target viewport would make a
   single row microscopic.

Then rerun the unchanged observability benchmark. Separately harden the blinded
evaluator prompt or add a deterministic endpoint-fact audit so semantic labels
cannot mask reversed endpoints.

The complete sanitized record is
`research/data/exp-0016-one-pass-clearance-replication-v1.json`. Room
credentials, raw sessions, semantic state, and pixels remain private and
gitignored.
