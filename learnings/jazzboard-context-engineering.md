# Jazzboard context-engineering direction

Research snapshot: 2026-08-30

This is an evidence-backed audit and experiment backlog, not an approved product specification. It preserves Jazzboard's current product decisions: a universal canvas, direct live agent editing, server-authoritative guest sessions and roles, stable semantic identity, active-object leases, atomic revision checks, and human creative control.

## Current strengths

The current implementation already has unusually strong foundations for an agent-native visual system.

- A participant room exposes 54 role-authorized tools and a spectator 18, verified in `e2e/deployed-webmcp.e2e.ts`.
- `get_canvas_capabilities` provides a versioned, renderer-neutral contract covering coordinates, rotation, z-order, colors, primitives, transactions, and inspection.
- `query_objects` and `read_neighborhood` provide bounded semantic retrieval rather than requiring a full room result.
- Diagram records are first-class semantic containers with stable IDs, title, description, category, membership, bounds, tags, revisions, and attribution.
- Objects preserve explicit classifications and connector endpoint relationships rather than inferring meaning from style.
- `apply_canvas_transaction` supports up to 200 atomic operations, temporary references, inferred or exact Diagram membership, revisions, leases, attribution, and all-or-nothing failure.
- Progressive create-only drafts preserve eventual stable IDs and let humans watch an agent build before one authoritative commit.
- Automatic layout is opt-in; exact coordinates and intentional overlap remain available for art and unconventional composition.
- `inspect_canvas_scope` combines a revision-consistent semantic scene, deterministic geometry evidence, framing, and a screenshot clip while truthfully reporting that pixel inspection has not yet occurred.
- The server remains authoritative for authorization, participant/spectator permissions, policies, revisions, leases, proposals, capacity, and attribution.

These should be evolved, not discarded.

## Current gaps and risks

### 1. The eager tool surface is large

Fifty-four participant tools fit the current descriptor budget, but a valid schema budget is not the same as a good attention budget. Tool choice can become ambiguous, and static descriptions consume context before the model knows the task.

The current `get_canvas_capabilities` is a good map, but all role tools are still registered eagerly. Research from all three vendors supports testing progressive disclosure.

### 2. Guidance is comprehensive but mostly static

`src/lib/agent-readiness/content.ts` is a substantial source of generated guidance across `llms.txt`, agent guides, WebMCP references, `AGENTS.md`, and a downloadable skill. It accurately documents many workflows, but additional prose will eventually lower signal.

The next improvement should be task-scoped context packets and retrievable playbooks, not a longer universal guide.

### 3. Pixel access depends on the host

`inspect_canvas_scope` returns a truthful `visualInspectionStatus: not_performed` and an exact `screenshotClip`. The browser host must capture the clean window and crop it. The WebMCP JSON result itself does not contain pixels.

That is honest and workable, but it means visual self-correction depends on host behavior. A host that discovers tools but never performs the capture cannot visually judge the board. Jazzboard should either return an actual image content/resource when the evolving protocol and host permit it, or advertise and test the capture contract explicitly.

### 4. Bounded model results still begin from a full room read

`query_objects` and `read_neighborhood` filter to bounded model output, which protects LLM context. Internally, the current client transport reads the full authorized room before filtering. This is not a privacy leak to the model, but it is a scaling and latency opportunity for large boards.

### 5. Mutation receipts may become too large

Transactions return rich changed-object and Diagram state. That is useful at today's scale, but large compositions can flood context. Default receipts should become compact while retaining an explicit detailed read path.

### 6. Diagram semantics do not fully cover freeform art

The custom Diagram category and group IDs help, but a drawing such as a face, storyboard, or scene benefits from named parts, layers, intent, style constraints, and a durable visual brief. Those are not the same as an architecture graph.

### 7. Current tests emphasize correctness more than agent outcome quality

The suite strongly covers schemas, authorization, atomicity, revisions, visual geometry, and deployed tool exposure. It needs a held-out harness evaluation corpus that measures whether agents create useful, readable architecture and expressive art, whether visual review helps, and how much context and latency each workflow costs.

## North-star interaction contract

For every meaningful authoring step, the agent should receive:

1. **Intent:** what the user wants, why, and what must remain unchanged.
2. **Success criteria:** semantic, visual, and interaction-specific acceptance conditions.
3. **Scope:** the relevant composition, local neighborhood, and peripheral summary.
4. **Authority:** role, allowed operations, review/live policy, and exact revisions.
5. **Evidence:** semantic state, geometry findings, actual pixels when visual judgment is required, and recent deltas.
6. **Actions:** a small task-relevant tool set with strict schemas and a primitive escape hatch.
7. **Receipt:** changed IDs/revisions, warnings, and the next useful inspection target.

The canvas and its append-only history remain authoritative. The context packet is a disposable projection for one decision.

## Prioritized experiments

### P0 — Establish a harness evaluation baseline

Before changing discovery or prompts, create a repeatable evaluation corpus and capture current performance.

Task families:

- simple and dense architecture diagrams;
- multi-directional systems with labeled connectors;
- edits to an existing human-authored diagram;
- intentional overlap and layered composition;
- freeform character or scene drawing;
- path-heavy illustration;
- mixed images and annotations;
- large-board retrieval and local repair;
- stale revision, busy object, and human-interruption cases.

Record semantic fidelity, visual preference/readability, correction lift, human acceptance, tokens, descriptor bytes, calls, round trips, latency, schema errors, conflicts, and time to first useful draft. Run multiple trials and hold out final tasks.

### P1 — Add a task-scoped scene context packet

Prototype a read/inspection result with `overview`, `working_set`, and `focus` resolutions. It should combine:

- compact composition summaries;
- focused full object records;
- in-view simplified objects;
- peripheral clusters;
- local relationships and connector routes;
- deterministic findings;
- recent deltas since a supplied revision;
- an exact rendered crop or an explicit host-capture artifact.

Do not duplicate tools merely to expose this. First test whether it should evolve `inspect_canvas_scope`, `read_neighborhood`, and capability guidance or become one new workflow tool.

### P1 — Make result receipts concise by default

For large mutations, default to:

- status and exact resulting room revision;
- changed/preserved/deleted IDs and revisions;
- resolved bounds and relationship warnings;
- deterministic validation deltas;
- `visualInspectionStatus`;
- a recommended next scope;
- stable references for detailed objects, transaction data, or render artifacts.

Never hide uncertain commit state. Preserve Jazzboard's no-blind-retry behavior.

### P1 — Prototype progressive tool disclosure

Evaluate, rather than assume, a smaller stable index plus task bundles such as:

- observe and retrieve;
- diagram authoring;
- illustration and paths;
- collaboration and presence;
- review and proposals;
- export and sharing.

Constraints:

- The live registry and server remain the permission authority.
- Spectators must never receive mutations.
- Landing and room lifecycle tools must remain discoverable.
- Dynamic registration must be validated against actual WebMCP hosts after navigation and role changes.
- Compare against the current eager surface on accuracy, discovery latency, descriptor tokens, and tool-selection errors.

If hosts require all schemas upfront or dynamic changes cause unreliable discovery, retain stable registration and use allowed-tool guidance or a capability index instead.

### P1 — Close the pixel-inspection loop

Test the best protocol-compatible route for giving a vision-capable agent the actual scoped pixels:

- image content returned by a tool;
- a short-lived local-only resource readable by the host;
- or a formally advertised full-window-capture and crop handshake.

Maintain current privacy: no hosted snapshots, no image persistence, exact authorized revision, and no claim that pixels were inspected until the agent actually receives them.

### P2 — Introduce a general semantic Composition

Evaluate generalizing Diagram or adding a compatible Composition container with:

- ID, title, purpose, category, tags, bounds, revision, and attribution;
- member objects, relationships, groups, layers, and named parts;
- optional visual brief, style tokens, protected/pinned members, and accepted decisions;
- unresolved defects and inspection state.

Architecture-specific node classes and graph relationships remain first-class. Freeform work must not be forced through architecture layout rules.

### P2 — Add durable, retrievable visual memory

Store only useful task artifacts:

- visual contract and acceptance rubric;
- scene manifest and layer completion state;
- accepted/rejected design decisions;
- exemplar references and style tokens;
- unresolved defects;
- append-only transaction events queryable by cursor, object, composition, or revision.

Do not copy raw conversation into every turn. Keep full results behind references and let agents retrieve slices.

### P2 — Add issue-focused correction policies

After a multi-object or layout-sensitive mutation:

1. run hard invariant checks;
2. inspect only the affected render scope;
3. identify defects by stable object ID;
4. patch locally under exact revisions;
5. compare with the previous accepted state;
6. stop after success or bounded stagnation.

For creative work, lints are evidence. They must not automatically erase intentional overlap, asymmetry, unusual routing, or layering.

### P3 — Tune per model and host

Keep the core semantic protocol stable, but evaluate model/host profiles for:

- amount of planning scaffolding;
- concise versus detailed results;
- maximum atomic batch size;
- number of visual-review rounds;
- tool discovery strategy;
- actual image-delivery support.

Periodically remove a rule or helper and rerun held-out evals. Complexity must earn its place.

## Explicit non-goals

- No global room directory, enumeration, or cross-user search.
- No permission encoded only in prompt text.
- No architecture-only deterministic compositor for every drawing.
- No screenshot-only pixel automation that loses semantic identity.
- No semantic-only sign-off that claims visual quality.
- No unbounded retry or self-critique loop.
- No automatic retry after an ambiguous mutation outcome.
- No replacement of live human edits with an agent's stale plan.

## Decision rule for future improvements

Every proposed instruction, tool, context field, or automated helper should answer four questions:

1. Which observed failure does it address?
2. Why must it be in active context rather than retrieved or enforced in code?
3. How will we measure whether it helps across architecture and art?
4. What existing context or machinery can it replace?

If those questions cannot be answered, the change is likely context debt rather than context engineering.
