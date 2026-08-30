# Jazzboard learning library

Research snapshot: 2026-08-30

This folder is Jazzboard's durable research memory for agent harness and context engineering. It records evidence, interpretations, and candidate experiments separately so future work can build on what was learned without turning the product prompt into an ever-growing manual.

## Read this first

The central lesson is not “give the model more context.” It is:

> Give the model the smallest high-signal representation that makes the next decision well grounded, keep authoritative state outside the conversation, and make missing detail easy to retrieve.

For a visual canvas, no single representation is enough:

1. **Semantics** answer what an object is, what it means, and how it relates to other objects.
2. **Geometry** answers exactly where it is, how large it is, what it intersects, and how connectors route.
3. **Pixels** answer whether the rendered result is readable, balanced, recognizable, or aesthetically successful.
4. **Deltas and history** answer what just changed, why, and which revision is safe to edit.

An LLM does not continuously “see” a Jazzboard. At each inference it reasons from the representations the harness supplies. Exact coordinates do not communicate visual gestalt; a screenshot does not provide stable object identity; semantic JSON does not reveal an ugly composition; and a full event history can bury the current task in noise. Jazzboard should combine these views at the resolution appropriate to the current step.

## Documents

- [Harness engineering](./harness-engineering.md) — findings from OpenAI, Anthropic, and Cursor documentation and public code.
- [Visual-agent context](./visual-agent-context.md) — patterns from tldraw, draw.io, Excalidraw systems, diagram agents, and recent visual self-correction research.
- [Jazzboard implications](./jazzboard-context-engineering.md) — an audit of the current WebMCP surface and a prioritized, testable direction.
- [Source ledger](./sources.md) — primary sources, inspected code paths, dates, and evidence limitations.

## Working principles

- The versioned canvas is the source of truth. Conversation summaries and agent memory are caches.
- Keep a small stable map always available; fetch bodies, schemas, pixels, and history just in time.
- Let agents decide meaning and aesthetics. Use deterministic code for authority, atomicity, identity, revisions, geometry facts, and hard invariants.
- Prefer a few distinct workflow tools over overlapping endpoint wrappers, while retaining low-level primitives as an escape hatch.
- Return concise mutation receipts with stable IDs, revisions, warnings, and a next inspection target.
- Treat visual inspection as evidence, not ceremony. Framing a region is not the same as seeing its pixels.
- Make correction bounded and issue-focused. Preserve the best accepted state and stop when iterations stagnate.
- Evaluate the model and harness together on held-out architecture and freeform-art tasks.
- Periodically ablate old instructions and scaffolding. A harness that helped an older model can hinder a newer one.

## Recommended agent loop

`orient → retrieve → plan → mutate atomically → validate → render → inspect → patch → verify → finish`

This is a reasoning loop, not a deterministic drawing algorithm. The harness supplies trustworthy evidence and safe actions; the agent still chooses the composition.

## Maintenance rule

Add findings here only when they are one of:

- supported by a linked primary source or inspected source code;
- observed directly in Jazzboard's implementation or evaluations; or
- explicitly labeled as an inference or experiment.

Keep this index short. Put detail in topic files and load it only when the task calls for it.
