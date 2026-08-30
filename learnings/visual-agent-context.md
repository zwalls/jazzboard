# Context engineering for visual agents

Research snapshot: 2026-08-30

This document focuses on systems that let agents create or edit diagrams and visual art. The important distinction is between a system that can emit valid drawing data and one that can reason about, inspect, and safely improve the rendered result.

## The four-view model

An effective canvas agent needs complementary views at different resolutions.

### Semantic view

Stable IDs, object kinds, labels/content, explicit node classification, groups or compositions, relationships, creator/editor attribution, and revisions. This is how an agent retrieves and edits by meaning rather than pixel guessing.

### Geometry view

Bounds, rotation, z-order, connector endpoints/routes, containment, crossings, occlusion, text overflow, and spatial neighborhoods. This supports exact repair and conflict-safe mutation.

### Pixel view

A current rendered image of the relevant scope. This reveals weak hierarchy, crowding, illegible labels, visual ambiguity, unintended style, and whether a drawing resembles its subject.

### Temporal view

Recent deltas, active draft state, accepted/rejected decisions, and current revisions. This tells the agent what changed and prevents stale reasoning from overwriting newer human work.

The harness should choose a resolution:

- **overview:** compact composition summaries and peripheral clusters;
- **working set:** relevant objects, relations, geometry, and one rendered region;
- **focus:** complete details for explicitly edited objects and the immediate neighborhood.

## Systems inspected

| System | Strongest pattern | Limitation to avoid |
|---|---|---|
| [tldraw Agent Starter Kit](https://github.com/tldraw/tldraw/tree/main/templates/agent) | Combines screenshot, focused shapes, simplified in-view shapes, peripheral clusters, recent actions, lints, and an explicit review turn. Prompt modes control which “eyes” and “hands” are active. | Cropped images and peripheral summaries can omit important identity or topology; many low-level actions consume turns. |
| Official [draw.io MCP](https://github.com/jgraph/drawio-mcp) | Uses just-in-time search across a very large shape catalog and a shared XML reference as the source of truth; normalizes malformed XML. | Valid XML can still be visually poor, and full XML is verbose and brittle. |
| [drawmode](https://github.com/teamchong/drawmode) | Offers a compact programmatic Excalidraw SDK, semantic boxes/connections, Graphviz layout, and structural validation. | It has no built-in pixel critic; whole-program regeneration can erase human intent without identity reconciliation. |
| [Agentic Mermaid](https://github.com/adewale/agentic-mermaid) | Typed family-specific intermediate representation, atomic mutations, precise operation-index errors, deterministic verification, and a strong regression/eval corpus. | Structural validity does not prove intended semantics or visual quality. |
| [Nereid](https://github.com/bnomei/nereid) | Stable metadata IDs, graph queries, diffs, selections, and identity reconciliation around canonical Mermaid source. | Some edits fall back to source replacement and there is no pixel-quality loop. |
| [DiagramAgent](https://github.com/outbackops/DiagramAgent) | Renders, runs a typed visual assessment, refines, retains the best score, and stops on stagnation. | A single judge score can be noisy or gamed; full-source rewrites may disturb good regions. |
| [DoodleAgent](https://github.com/YIFANK/DoodleAgent) | Sends the current image plus bounded recent stroke history, validates drawing vocabulary, and clamps coordinates. | Minimal semantic identity and structure make precise later editing difficult. |
| [Doop](https://github.com/kgoedecke/doop) | Compact MCP initialization, a just-in-time guide, actual PNG screenshots, design-memory exemplars, and post-mutation nudges to inspect work. | Its HTML-oriented creation model is not a direct substitute for a shared semantic canvas. |

### Particularly useful tldraw code

- [Prompt-part definitions](https://github.com/tldraw/tldraw/blob/main/templates/agent/shared/schema/PromptPartDefinitions.ts)
- [Focused shape representation](https://github.com/tldraw/tldraw/blob/main/templates/agent/shared/format/FocusedShape.ts)
- [Screenshot extraction](https://github.com/tldraw/tldraw/blob/main/templates/agent/client/parts/ScreenshotPartUtil.ts)
- [Peripheral clustering](https://github.com/tldraw/tldraw/blob/main/templates/agent/client/parts/PeripheralShapesPartUtil.ts)
- [Lint manager](https://github.com/tldraw/tldraw/blob/main/templates/agent/client/agent/managers/AgentLintManager.ts)
- [Review action](https://github.com/tldraw/tldraw/blob/main/templates/agent/client/actions/ReviewActionUtil.ts)

The reusable idea is not tldraw's exact prompt. It is multi-resolution perception plus an explicit transition from authoring to fresh visual review.

## The right action hierarchy

The agent should have three levels of control.

1. **Semantic intent operations** describe a coherent outcome: compose a diagram, add a labeled relationship, create a layered illustration, or revise one composition.
2. **Atomic batch operations** create/update/connect/group many objects under one revision fence with temporary references and all-or-nothing conflict behavior.
3. **Primitives** provide exact shape, path, point, z-order, style, and connector control for unusual or artistic work.

Architecture helpers must not become universal drawing rules. Center-to-center edges, automatic layout, obstacle routing, and minimum spacing can be good defaults for a conventional flow diagram and wrong for a character, collage, annotation, stacked card, or intentional overlap. The harness should expose evidence and optional operations; the agent chooses them according to intent.

## A grounded correction loop

Recommended loop:

1. Write a compact visual contract: purpose, audience, required entities/parts, relationships, hierarchy, aesthetic direction, viewport/readability target, and acceptance criteria.
2. Retrieve the relevant scene scope at the appropriate resolution.
3. Create or patch one coherent layer in an atomic transaction.
4. Return a canonical receipt with stable IDs, revisions, resolved bounds, warnings, and lint deltas.
5. Run deterministic checks for hard issues such as invalid bindings, clipping, text overflow, unexpected overlaps, off-canvas bounds, and stale revisions.
6. Render the exact current revision and give the vision-capable agent the actual pixels for the affected scope.
7. Diagnose specific issues by object ID and patch only the affected region.
8. Re-render, compare with the previous accepted state, and stop when criteria pass or progress stagnates.

Deterministic validation should run before another expensive model turn, but it should report facts rather than silently redesigning the composition.

## Self-correction is not automatically beneficial

Recent research supports render-in-the-loop workflows, but the evidence is early and conditional.

- [VASCAR](https://arxiv.org/abs/2412.04237) combines rendered output, automatic metrics, and relevant examples rather than asking for generic reflection.
- [Feynman](https://arxiv.org/abs/2603.12597) separates domain ideas, a code plan, a declarative visual program, and iterative rendering/optimization.
- [Iterative Visual Token Tuning](https://arxiv.org/abs/2606.13156) reports that naïve visual iteration severely degraded a spatial-grounding baseline before task-specific training stabilized the loop.
- [RefineSVG](https://arxiv.org/abs/2607.27699), [Render-in-the-Loop](https://arxiv.org/abs/2604.20730), and [Seeing Is Improving](https://arxiv.org/abs/2603.22187) are promising 2026 work, but too recent to treat as settled product practice.

The safe product conclusion is narrower: provide issue-focused evidence, stable identity, a revision fence, a rubric, bounded retries, and a stop/rollback policy. Do not assume “look again” will improve a result.

## What good visual feedback contains

- The actual rendered crop or image content, not only coordinates describing where a screenshot could be taken.
- Exact board and object revisions.
- The scope's semantic summary and stable IDs.
- Deterministic findings with geometry and involved IDs.
- Coverage information explaining what was outside the crop.
- A delta from the prior accepted render or mutation.
- The requested intent and acceptance rubric.

For very large canvases, send an overview first, then focused crops and local neighborhoods. Do not repeatedly send the entire board to diagnose one label.

## Generalize beyond architecture

A universal whiteboard needs a first-class semantic composition, not only a diagram whose meaning is inferred from nearby shapes. A composition can represent an architecture diagram, character, storyboard, visual explanation, collage, or annotation set while preserving:

- stable composition ID, title, purpose, and optional category;
- member objects, relationships, groups, and layers;
- bounds, tags, attribution, and revision;
- named parts and semantic roles;
- optional layout or style constraints;
- accepted visual brief and unresolved defects.

Architecture-specific node classifications and relationship semantics can remain available within this general container. Freeform paths and intentional overlaps remain authoritative rather than being “corrected” by a diagram layout engine.

## Evaluation design

Evaluate structure and appearance separately, then combine them into task success.

- **Semantic fidelity:** requested entities/parts, labels, relationship direction, grouping, and hierarchy.
- **Document integrity:** valid IDs and bindings, atomicity, undo, revisions, leases, and human-edit preservation.
- **Geometry:** clipping, unexpected overlap, crossings, margins, alignment, containment, and off-canvas objects.
- **Text:** overflow, density, contrast, and rendered readability.
- **Appearance:** human or independent-model pairwise preference using the exact render.
- **Correction lift:** whether each inspection round improves, holds, or degrades the accepted result.
- **Efficiency:** tool calls, round trips, tokens, latency, failed operations, and time to first useful draft.

The benchmark must include conventional architecture, dense multi-directional systems, freeform illustration, intentional overlap, mixed images and annotations, partial edits, and adversarial stale-state conflicts. Use multiple stochastic trials and held-out tasks; a single attractive demo is not evidence of a robust harness.
