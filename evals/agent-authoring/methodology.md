# Agent-authoring evidence methodology

Jazzboard separates transport/rendering evidence from evidence that an agent can genuinely author through the product.

## Evidence levels

1. **Contract tests** validate schemas, authorization, revision checks, leases, and deterministic geometry helpers.
2. **Transport and renderer trials** may replay a fixed operation fixture to exercise WebMCP registration, draft choreography, commit behavior, export, and rendering. These trials must be labeled deterministic and are not evidence of agent reasoning or self-correction.
3. **Closed-loop agent-authoring trials** are the acceptance bar for agent experience claims.

## Closed-loop acceptance requirements

- Start a fresh agent without a prepared canvas plan, coordinates, operation fixture, or prior room state.
- Give the agent only the high-level creative or diagramming brief and exact authorized Jazzboard entry point.
- Require the agent to discover and call the browser-exposed WebMCP tools itself.
- Forbid repository-derived plans, direct room APIs, page-evaluate mutations, replay harnesses, and UI automation for canvas edits.
- Record from an independent spectator session whose tool inventory contains no mutation tools.
- Require multiple meaningful authoring stages followed by semantic and live-pixel inspection.
- Require the agent to distinguish intentional geometry from genuine defects and make targeted corrections through WebMCP.
- Preserve the ordered tool categories, inspection/correction round counts, authoritative final room/Diagram revisions, semantic completeness, and immutable media hashes.
- Use a final Diagram metadata marker only after the agent has completed correction and reinspection so passive capture cannot stop early. The marker is evidence coordination, not a substitute for inspecting the work.

Any precomputed operation plan, even when written by an agent, is classified as a deterministic transport/rendering trial. It must not be presented as closed-loop authoring evidence.
