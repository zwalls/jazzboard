# EXP-0017 semantic-recovery replication

- Date: 2026-09-02
- Status: complete; visual and speed gates passed, factual quality gate failed
- Product candidate: `113d9cd5071c6a5abfdf205d2b17a6cf9cd6b058`
- Benchmark: unchanged `dev-architecture-create-observability`
- Author: fresh projectless `gpt-5.6-terra`, reasoning `medium`
- Primary reviewer and adjudicator: separate fresh projectless `gpt-5.6-sol`, reasoning `high`

## Result

The intervention fixed the exact structural and visual failure observed in
EXP-0016. The author used the canonical transaction schema on its first draft,
kept one first-class Diagram with all 13 members and five connectors, made one
targeted draft patch, and committed once. No Jazzboard WebMCP call returned a
business failure, and there was no post-commit mutation.

Wall time fell to 188,763 ms: 102,469 ms (35.2%) faster than EXP-0016 and only
6,379 ms (3.5%) slower than the fastest prior passing run, EXP-0013. Both
blinded judges found the three planes clear, the fixed-viewport composition
readable, Diagram membership coherent, and zero blocking geometry defects.

The overall result still fails. The `reads` edge is Telemetry Store → Query UI
instead of Query UI → Telemetry Store, and the `evaluates` edge is Telemetry
Store → Alert Engine instead of Alert Engine → Telemetry Store. The author gave
both connectors prose semantic names that describe the correct facts but
created start/end references in the opposite order. Both independent judges
identified the same two reversals.

This is strong mechanism evidence and a meaningful speed/visual improvement,
but not yet a speed-quality win. No population percentage claim is permitted.

## What improved

- Canonical `create_diagram` guidance prevented the semantic-deletion recovery
  seen in EXP-0016.
- The complete Diagram was present in the initial draft and remained coherent
  through finish.
- One exact draft patch cleared deterministic geometry findings; no direct
  correction loop followed the commit.
- Every component and relationship label is visible at a useful scale in the
  independently captured image.
- Host execution fell 8,296 ms and model/coordination time fell 93,936 ms
  relative to EXP-0016.

## What still failed

- Static direction wording in the quickstart did not make the author compare
  its actual connector references against the supplied facts.
- The wrong direction was already visible in the author's own tempRef names:
  `store_to_query` and `store_to_alert` contradicted the prose semantic names.
- The concise draft receipt exposes object IDs and semantic names in separate
  structures, but not one scan-friendly table joining connector tempRef,
  start/end tempRefs, endpoint semantic names, label, and connector semantic
  name.
- Pixel review alone did not reveal the semantic mistake to the author because
  the rendered arrowheads matched the incorrectly authored endpoint state.

## Next intervention

Add a bounded `relationshipReview` block to draft and direct transaction
receipts. For each connector it should present the connector tempRef/ID,
semantic name and label, actual start tempRef/name, actual end tempRef/name,
and direction together. The quickstart should require the author to reconcile
this returned table with the task facts before finishing.

This must remain evidence for agent reasoning. Jazzboard should not infer verbs
from prose, silently reverse endpoints, or choose a layout on the agent's
behalf. The unchanged observability benchmark should then be replicated again.

The complete sanitized record is
`research/data/exp-0017-semantic-recovery-replication-v1.json`. Room
credentials, raw sessions, semantic state, and pixels remain private and
gitignored.
