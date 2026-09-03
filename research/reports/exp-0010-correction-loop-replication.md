# EXP-0010 correction-loop replication

- Date: 2026-09-02
- Status: complete; frozen quality gate passed, speed gate failed
- Product candidate: `b4a4c73ed9a27cf6b17d95dd69f492289f02c3ae`
- Author: fresh projectless `gpt-5.6-terra`, reasoning `medium`
- Reviewer: separate fresh projectless `gpt-5.6-sol`, reasoning `high`

## Result

The independent reviewer passed every frozen semantic and visual criterion with
zero blocking geometry violations. The final artifact contains all four
required entities, three correctly directed relationships, coherent first-class
Diagram membership, and a readable trust-boundary composition.

The run took 270,617 ms and 15 WebMCP calls. It is 1,579 ms slower than EXP-0009
and 98,676 ms slower than the accepted EXP-0005 checkout candidate. This is a
quality-preserving replication, not a speed improvement, and it supports no
population or percentage claim.

## What the trace exposed

Only 18.8% of wall time was host execution. The remaining 219,972 ms occurred
between calls. The author spent 148,141 ms in initial authoring while advancing
the candidate through four accepted draft revisions. Deterministic feedback
did useful work: fail counts fell from 5 to 2 to 1 to 0, and the blinded final
review passed. The opportunity is to reach that first clean candidate with less
schema recovery and better first-pass planning evidence.

Four avoidable business failures appeared:

- The first capability call used a tool snapshot taken while the room was still
  connecting.
- The initial transaction used the familiar standalone name
  `draw_connection` and the intuitive Diagram fields `memberObjectRefs` and
  `connectorRefs`; the transaction requires `connect`, `members`, and
  `connectors`.
- While adding a dedicated boundary-label object, the author tried to update the
  draft Diagram through `edit_diagram` with `diagramTempRef`.
- It then retried with the authoritative Diagram ID, but current progressive
  drafts reject existing-Diagram edits. The author had to publish and repair
  membership in a separate authoritative call.

The prior solid-only connector guidance worked: the author did not retry an
unsupported dash field. The new connector-path-versus-container-title detector
also prevented the specific visual regression seen in EXP-0009.

## Timing attribution

- Total wall time: 270,617 ms
- Accounted wall time: 271,000 ms
- Host execution: 51,028 ms (18.8%)
- Model and coordination: 219,972 ms
- Capability discovery: 55,778 ms
- Initial authoring: 148,141 ms
- Draft finish: 10,837 ms
- Inspection: 36,604 ms

Exact model reasoning time, tokens, and per-task subscription usage remain
unobservable.

## Next intervention

Preserve the validation and visual-inspection gates. Remove needless recovery
by accepting common standalone naming aliases within transactions and allowing
the owner to patch a draft Diagram's metadata and membership through its stable
temporary reference. Add compact first-pass planning evidence for node label
fit, connector corridors, and boundary titles. These changes reduce contract
translation and correction calls while leaving all composition and routing
decisions with the agent.

The full sanitized record is
`research/data/exp-0010-correction-loop-replication-v1.json`. Private room
credentials, raw sessions, semantic packets, and pixels remain outside Git.
