# EXP-0009 container-label signal validation

- Date: 2026-09-02
- Status: complete; frozen quality gate passed, speed gate failed
- Product candidate: `9ac7ce3d48b9e3c5cf8b939970832004e29f5f06`
- Author: fresh projectless `gpt-5.6-terra`, reasoning `medium`
- Reviewer: separate fresh projectless `gpt-5.6-sol`, reasoning `high`

## Result

The independent reviewer passed the supplied facts, trust-boundary placement,
and pixel readability with zero blocking geometry violations. The intervention
therefore repaired the false quality pass seen in EXP-0008.

The run took 269,038 ms, however, and made 16 WebMCP calls. That is 97,097 ms
slower than the preceding accepted checkout candidate from EXP-0005. This is an
accepted artifact, not a speed improvement, and it supports no population or
percentage claim.

## What the trace exposed

The author reached a clean draft in three accepted draft transactions and
published it. Its first exact pixel inspection then found a defect the draft
analyzer had missed: the orange asynchronous connector path split the visible
`Commerce trust boundary` label. The new detector covered a connector label
over a container label, but not the connector path itself.

The author corrected that defect safely, but the repair cost seven additional
WebMCP calls. It rerouted the connector, externalized the boundary caption into
a dedicated text object, removed the centered shape label, and repaired Diagram
membership. The final pixels are readable and the separate blinded reviewer
passed all frozen criteria.

Two contract mismatches added avoidable latency:

- The author tried an unsupported `routing.dash` field before learning that
  connectors are currently solid and should be distinguished by color, label,
  or route.
- During a post-commit correction it used the standalone tool name
  `update_object` as a transaction operation, while the transaction expects the
  shorter `update` discriminator.

A concurrent object edit and Diagram membership edit also produced a revision
conflict because the object edit correctly advanced the containing Diagram
revision before the second call evaluated its stale guard.

## Timing attribution

- Total wall time: 269,038 ms
- Accounted wall time: 269,000 ms
- Host execution: 66,731 ms (24.8%)
- Model and coordination: 202,269 ms
- Initial authoring: 104,657 ms
- Inspection: 35,014 ms
- Post-finish correction transaction: 20,960 ms
- Other post-finish mutations: 57,423 ms

Exact model reasoning time, tokens, and per-task subscription usage remain
unobservable.

## Next intervention

Keep the connector-label signal. Extend the same renderer-equivalent boundary
to connector paths: intentional passage through a semantic container remains
valid, but a path crossing the container's own visible label should be a
blocking, actionable finding.

Also remove two schema-discovery round trips without changing authority:
state the solid-only connector contract in the compact architecture quickstart,
and accept `update_object` as an alias for the transaction's revision-checked
`update` operation. Neither change chooses layout on the agent's behalf.

The full sanitized record is
`research/data/exp-0009-container-label-signal-validation-v1.json`. Private room
credentials, raw sessions, semantic packets, and pixels remain outside Git.
