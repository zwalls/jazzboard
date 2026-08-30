# Scalable Agent Composition Sessions

Status: Proposed
Area: WebMCP, semantic canvas, agent drafts, renderer performance
Primary use cases: large architecture diagrams, detailed vector illustrations, agent-authored visual compositions

## Summary

Jazzboard should support compositions that exceed one WebMCP transaction without giving up progressive construction, semantic identity, visual inspection, revision safety, or a single atomic publication moment.

Today, an agent can build a large board through multiple committed transactions. The limiting behavior is narrower: one atomic transaction or progressive draft can contain at most 200 operations, and a progressive draft has a 192 KiB retained-record budget. This is sufficient for ordinary diagrams and moderately detailed drawings, but a dense system map or high-detail illustration can exceed it.

Add a server-backed, chunked composition session. An agent assembles a private or room-visible candidate through bounded chunks, inspects the cumulative result, and publishes the complete candidate through one authoritative capacity- and revision-checked operation. The chunks remain transport details; the finished Diagram and canvas objects retain normal Jazzboard semantic IDs and behavior.

## Current Boundaries

| Surface | Current bound | Consequence |
| --- | ---: | --- |
| One semantic transaction | 200 total operations and 1 MiB JSON | Objects, connectors, Diagram creation, and optional layout share the operation budget. |
| Progressive agent draft | 200 create-only operations, 256 KiB request, 192 KiB retained record | Complex vector geometry or long labels may hit the byte budget before the operation count. |
| Draft choreography | 48 animated targets and 7 seconds of queued work per revision | The complete candidate remains visible, but not every large-stage object receives an individual construction animation. |
| One first-class Diagram | 500 member objects and 500 connectors | A Diagram may reference at most 1,000 canvas objects. |
| One room | 5,000 objects, 500 Diagrams, and 250,000 aggregate drawing/path points | These are capacity safety ceilings, not renderer performance guarantees. |
| Durable room document | 3 MiB product budget; 8 MiB unconditional Redis write guard | A valid composition must fit the normal authoritative room budget at publication. |
| Exact inspection or PNG scope | 1,000 objects | This matches the largest valid Diagram scope. |
| Uploaded raster asset | 10 MiB per Blob asset; 100 assets or 128 MiB per room | Image bytes remain outside the semantic room document, while each image object still consumes one object slot. |

Examples:

- 100 nodes, 99 connectors, and one Diagram use exactly 200 operations and fit one atomic transaction.
- 100 nodes, 100 connectors, and one Diagram use 201 operations and must currently be split.
- A 46-object vector portrait fits comfortably in one progressive draft.
- A 300-object illustration is possible today through multiple commits, but it cannot have one all-or-nothing final publication event.

## Goals

- Allow an agent to assemble up to one maximum-sized Diagram through bounded uploads.
- Preserve a single deliberate publication moment for the complete composition.
- Retain stable temporary references across chunks so later connectors can target earlier candidate nodes.
- Preserve semantic node classifications, Diagram metadata, connector relationships, attribution, and exact revisions.
- Keep the server authoritative and retain all-or-nothing conflict and capacity behavior.
- Let humans and agents observe genuine progressive work without representing unpublished candidates as authoritative room state.
- Give agents semantic and pixel inspection loops over the cumulative candidate before publication.
- Keep agent judgment in control of composition, routing, overlap, style, and intent; infrastructure must not impose architecture-specific layout decisions.

## Proposed Model

Introduce a bounded `CanvasCompositionSession` sidecar with:

- Stable composition ID and owner participant ID.
- Baseline room and document revision.
- Status: `assembling`, `ready`, `publishing`, `published`, `discarded`, or `expired`.
- Ordered chunk metadata and a cumulative content digest.
- Stable temporary-reference map across every chunk.
- Candidate canvas objects and first-class Diagram metadata.
- Aggregate operation, object, connector, point, and byte accounting.
- Creation, update, expiry, and publication timestamps.
- Optional intent, summary, and tags for human-readable activity.

Each appended chunk remains within the existing bounded request envelope. The server validates the chunk, resolves temporary references against the cumulative candidate, and atomically replaces the composition session revision. It does not mutate `RoomState`, advance `roomRevision`, enter normal object queries, or appear in exports and history.

Publication assembles the validated candidate server-side and applies it through the normal semantic engine. Before writing, the server must:

1. Verify session ownership and guest authorization.
2. Verify the exact composition revision and baseline room revision.
3. Revalidate every object, Diagram, relationship, and stable reference.
4. Confirm no object ID collides with current authoritative state.
5. Evaluate normal room capacity and the unconditional Redis write guard.
6. Apply the complete composition in one authoritative room revision or apply nothing.
7. Record bounded attribution and activity without embedding the complete private request.

The initial release should remain create-only. Updating or deleting authoritative objects would require leases held across a potentially long composition session and creates misleading shared authority. Those edits should continue through the existing revision- and lease-checked mutation surface.

## Proposed WebMCP Surface

Names are provisional, but the semantic responsibilities should be explicit:

- `begin_canvas_composition` — create a bounded composition at the exact current room revision.
- `append_canvas_composition_chunk` — add or replace one exact chunk using the current composition revision.
- `read_canvas_composition` — return cumulative semantic evidence, counts, bounds, temporary references, and revision.
- `query_canvas_composition` — find candidate objects by content, type, relationship, group, Diagram, or region without loading the complete candidate.
- `inspect_canvas_composition` — frame an exact cumulative candidate and return a clean screenshot clip for real pixel inspection.
- `publish_canvas_composition` — atomically publish one exact, visually inspected composition revision.
- `discard_canvas_composition` — explicitly remove an unfinished candidate.

Tool schemas and annotations must remain truthful:

- Begin, append, publish, and discard are mutations.
- Read, query, and inspect are read-only with respect to authoritative room state.
- Framing is not visual inspection; the consuming agent must capture and examine the returned pixels.
- A spectator may observe a room-visible candidate but cannot create, append, publish, or discard it.
- No tool may enumerate rooms or compositions outside the current authorized room.

## Progressive Construction

Composition size and animation size should remain separate concepts.

- A chunk can contribute more objects than the choreography queue animates.
- Agents should normally add 30–48 new visual targets per visible stage so every object can receive an intentional construction pass.
- Previously completed candidate objects must not replay when a later chunk is appended.
- Connectors should appear only after their endpoints exist in the cumulative candidate.
- The bot should travel through authored work areas and trace the actual geometry, as it does for current progressive drafts.
- Reduced-motion, hidden-page, and slow-device behavior should collapse safely to a static cumulative preview.

## Renderer and Analysis Prerequisites

The 5,000-object room capacity is not currently a smoothness guarantee. The live semantic canvas traverses and renders the complete SVG scene, and conventional Diagram analysis performs pairwise geometry checks. Large-composition support must therefore include measured performance work rather than only raising server limits.

Before marketing 500–1,000-object Diagrams as a polished workflow:

- Add viewport-aware SVG culling while retaining connectors whose routes cross the visible region.
- Keep semantic state complete even when visual objects are culled.
- Move expensive route and visual-quality analysis off the interaction-critical path, preferably to a worker.
- Add incremental analysis keyed by object and connector revision so unchanged geometry is not recomputed.
- Preserve exact full-scope inspection and export, even when the interactive renderer is culled.
- Benchmark pan, zoom, selection, multiplayer presence, inspection, PNG export, and WebMCP reads at representative 100-, 300-, 500-, and 1,000-object Diagram sizes.

## Agent Guidance

`get_canvas_capabilities` should expose both hard constraints and recommended working sizes:

- Maximum operations and bytes per chunk.
- Maximum cumulative composition objects, connectors, points, and bytes.
- Maximum individually animated targets per revision.
- Maximum Diagram membership and exact inspection scope.
- Recommended 30–48-target progressive stages.
- Guidance to split large systems into multiple first-class Diagrams when that improves human comprehension.

The guidance must not impose deterministic architecture behavior. A conventional system map may benefit from hierarchical decomposition, while a character drawing may intentionally contain hundreds of overlapping shapes. The agent receives evidence and constraints, then decides according to the requested intent.

## Failure and Recovery

- A stale session revision rejects the append without changing the candidate.
- A changed room baseline rejects publication without partially applying content.
- Capacity failure leaves the candidate readable so the agent can simplify it.
- Unknown publication outcomes use idempotency and authoritative readback; they are never blindly retried.
- Expiry must not delete a session that is actively publishing or awaiting a review decision.
- Review mode should turn the exact complete composition into one review proposal without copying an unbounded request into activity history.
- Discard and expiry should remove only the composition sidecar and never touch authoritative objects.

## Non-Goals

- Raising or bypassing the existing room, Redis, or asset safety ceilings.
- Durable offline editing or client-side mutation replay.
- Cross-room composition discovery or a global template directory.
- Long-lived leases for edits or deletions of authoritative objects.
- Architecture-specific automatic placement that overrides an agent's authored geometry.
- Treating deterministic layout analysis as proof of visual quality.

## Delivery Plan

### Phase 1: Measurement and contracts

- Add deterministic large-scene fixtures and performance measurements.
- Publish current hard and recommended limits through `get_canvas_capabilities`.
- Define composition session schemas, state transitions, retention, authorization, and byte accounting.

### Phase 2: Chunked create-only sessions

- Implement Redis-backed composition sessions with bounded chunks and stable temporary references.
- Add begin, append, read, query, publish, and discard operations.
- Preserve exact room-revision and idempotency behavior.

### Phase 3: Visual construction and inspection

- Project cumulative candidates as non-authoritative room-visible work.
- Reuse current bot choreography without replaying completed objects.
- Add exact cumulative candidate inspection and pixel-capture validation.

### Phase 4: Large-scene performance

- Add viewport culling and incremental/worker-based analysis.
- Validate representative architecture and illustration workloads in multiplayer browsers and on mobile.

## Acceptance Criteria

- An agent constructs a composition with more than 200 objects through multiple bounded chunks.
- Temporary references connect objects created in different chunks without ID guessing.
- Humans and spectators see genuine progressive candidate growth while authoritative room state remains unchanged.
- The agent can semantically query and visually inspect the exact cumulative candidate.
- One exact publication creates the complete Diagram and all contained objects in one room revision.
- A baseline conflict, malformed reference, authorization failure, or capacity failure creates nothing.
- Review mode preserves one exact candidate and human-only approval authority.
- A 500-object architecture Diagram and a comparably complex freeform illustration remain responsive during pan, zoom, presence, and inspection on supported desktop hardware.
- Mobile remains usable and may apply more aggressive culling or reduced-motion presentation without losing semantic access.
- Automated coverage verifies limits, chunk ordering, idempotency, conflict rollback, privacy boundaries, exact inspection, multiplayer visibility, and production-shaped Redis writes.
