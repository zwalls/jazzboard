# Agent authoring evaluation

This corpus measures whether Jazzboard helps an agent produce and improve a useful visual artifact, not merely whether tool calls validate. It evaluates semantic correctness and rendered appearance separately, then records the cost of reaching the accepted result.

See [`methodology.md`](./methodology.md) for the evidence levels and the closed-loop acceptance boundary. A fixed operation fixture can prove transport and rendering, but it is never accepted as evidence that an agent reasoned, authored, inspected, or self-corrected through Jazzboard.

## Rules

- Use a newly created private room for every trial.
- Discover the browser-exposed WebMCP tools and retrieve the task-relevant capability bundle; do not call private HTTP routes directly.
- Give the authoring agent only the scenario brief and public evidence linked by that brief. Do not give it coordinates, object operations, or a completed visual plan.
- Preserve the agent's exact operations, receipts, inspections, and final room revision as run artifacts.
- Inspect the actual pixels after each coherent authoring pass. Geometry findings are evidence, not permission to redesign deliberate overlap or asymmetry.
- Permit at most three issue-focused correction passes. Stop early when acceptance criteria pass, and stop on two consecutive passes without measurable progress.
- Score from a clean, agent-free viewport at 1280 x 720. Keep screenshots and videos out of git; commit only manifests, hashes, and written evaluations.
- A failed or uncertain mutation is never blindly retried. Refresh authoritative state and reconcile first.

## Shared measures

| Dimension | Measure |
| --- | --- |
| Semantic fidelity | Required entities or parts, labels, relationships, direction, grouping, and hierarchy are present and correct. |
| Document integrity | Stable IDs, bindings, revisions, leases, atomicity, attribution, and preservation of unrelated state remain correct. |
| Geometry | No accidental clipping, off-canvas content, text overflow, unreadable crossings, or unintended object occlusion. |
| Appearance | Independent pairwise preference and rubric score from the exact final render. |
| Correction lift | Each visual-inspection round improves, preserves, or degrades the last accepted render. |
| Efficiency | Tool calls, failed calls, mutation receipt bytes, context bytes, round trips, latency, and time to first useful draft. |

## Required artifact manifest

Each run records the git commit, scenario ID, room ID and code (redacted before publication), starting and final room revisions, tool inventory, capability schema version and bundle, exact image/video filenames, byte sizes, SHA-256 hashes, codec metadata, scorecard, and reviewer notes. The room itself remains the semantic source of truth; the manifest is evaluation evidence, not a replay log.

## Current comparison

The pre-change checkpoint is recorded in `baseline-manifest.json`. The current goal must produce:

1. an improved Mona Lisa trial from the same high-level brief;
2. a before/after image with unchanged capture dimensions;
3. a complex, evidence-based Netflix reference architecture trial;
4. one playable H.264/yuv420p MP4 for each authoring session;
5. a post-change manifest that distinguishes agent decisions from deterministic transport and rendering choreography.
