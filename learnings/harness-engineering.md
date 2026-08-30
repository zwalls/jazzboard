# Harness and context engineering

Research snapshot: 2026-08-30

This document synthesizes current first-party guidance and public code from OpenAI, Anthropic, and Cursor. Vendor-reported benchmark numbers are directional, not independent proof. Jazzboard recommendations are marked as inferences.

## What context engineering is

Context engineering is the design of the complete model-visible state at each inference: instructions, user intent, tool definitions, selected artifacts, recent results, images, summaries, and errors. Prompt writing is one part of it. The harness also decides what stays external, what is retrieved, how tools report results, when state is compacted, and what evidence proves completion.

The three vendors converge on a shared model:

- a small, stable, high-signal prefix;
- just-in-time discovery of task-relevant detail;
- authoritative artifacts and raw history outside the context window;
- concise, well-separated tools and results;
- independent verification;
- evaluation of the complete model-plus-harness system.

## Evidence-backed findings

### 1. More context is not automatically better

OpenAI's current [GPT-5.6 harness guidance](https://developers.openai.com/api/docs/guides/latest-model) recommends lean prompts, non-overlapping tools, and examples tied to a measured failure or product requirement. It reports directional internal coding-agent results in which a leaner harness improved scores while materially reducing tokens and cost.

Anthropic describes context as a finite attention budget and recommends the smallest set of high-signal tokens that makes the desired behavior likely in [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents). Cursor describes moving from large static context and guardrails toward a small static environment summary plus dynamic retrieval in [Continually improving our agent harness](https://cursor.com/blog/continually-improving-agent-harness).

**Jazzboard inference:** do not append every new drawing lesson to one permanent prompt. Keep role, authority, coordinate conventions, user intent, and success criteria stable; retrieve the relevant diagram, scene, style, or inspection playbook when needed.

### 2. Use a map, not an encyclopedia

OpenAI's [Harness engineering](https://openai.com/index/harness-engineering/) describes a short agent guide as a map into structured, versioned documentation rather than a giant manual. OpenAI Skills expose metadata before the full skill body; Codex implements the same catalog-first pattern in its [skills catalog prompt](https://github.com/openai/codex/blob/88f776588f5e73467e7659c268f8358a9a2378b6/codex-rs/ext/skills/src/catalog_prompt.rs).

Anthropic's [Agent Skills guidance](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills) uses three layers: small always-visible metadata, the selected skill body, and referenced resources loaded on demand. Its public [skill-creator instructions](https://github.com/anthropics/skills/blob/b0cbd3df1533b396d281a6886d5132f623393a9c/skills/skill-creator/SKILL.md) formalize that structure.

Cursor's [Dynamic context discovery](https://cursor.com/blog/dynamic-context-discovery) stores long tool outputs and summarized-away history as searchable artifacts. Skill metadata stays available while bodies and MCP details are fetched when relevant.

**Jazzboard inference:** always expose a compact scene index and capability map. Retrieve object bodies, local neighborhoods, path points, image metadata, detailed schemas, and history by stable reference.

### 3. Separate context planes

The OpenAI Agents SDK distinguishes application-local context from model-visible context in its [context guide](https://github.com/openai/openai-agents-python/blob/89c02c828ee8510fe9a84ee6675608193aa13b02/docs/context.md). Runtime handles, auth, caches, and transaction machinery do not need to become prompt tokens merely because the application needs them.

A useful Jazzboard decomposition is:

1. **Stable contract:** authority, interaction rules, coordinate system, and compact capability index.
2. **Task contract:** current intent, constraints, acceptance criteria, and active phase.
3. **Working set:** relevant semantic objects, local geometry, rendered crop, and recent deltas.
4. **Runtime state:** auth, leases, caches, binary images, raw events, and idempotency metadata kept outside the model.

### 4. Tool schemas consume attention

OpenAI recommends strict schemas, stable definitions and ordering, clear error behavior, and small semantic namespaces in its [tool-search guide](https://developers.openai.com/api/docs/guides/tools-tool-search) and Agents SDK [tools guide](https://github.com/openai/openai-agents-python/blob/89c02c828ee8510fe9a84ee6675608193aa13b02/docs/tools.md). It also makes clear that hiding a tool is not an authorization boundary.

Anthropic's [Writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents) recommends a few workflow-oriented tools with distinct purposes, semantic identifiers, bounded output modes, filtering, and actionable errors. Its [Advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use) reports large context and accuracy improvements from loading only relevant tool definitions in a very large tool library.

Cursor reports a 46.9% total-token reduction on runs using MCP after replacing eager descriptions with searchable, dynamically loaded definitions in [Dynamic context discovery](https://cursor.com/blog/dynamic-context-discovery). That result is vendor-reported and high-variance, but the direction is relevant.

**Jazzboard inference:** evaluate a small stable capability index with deferred task bundles. Preserve server-side role and guest-session authorization regardless of discovery. Tool discovery is a context optimization, never a permission mechanism.

### 5. Tool results should be receipts, not transcripts

Good mutation output answers:

- Did the operation apply?
- What stable IDs and revisions changed?
- What geometry was resolved?
- What warnings or invariant failures remain?
- What evidence should be inspected next?
- Where can full detail be retrieved if needed?

Large raw outputs should live behind stable artifact references, with filters, pagination, ranges, or a `concise`/`detailed` mode. Cursor notes that repeated tool failures pollute later context; errors should identify whether the cause is invalid input, stale state, authorization, conflict, capacity, or environment failure and give a safe correction path.

### 6. Keep computation near the tools; keep judgment in the agent loop

OpenAI's [programmatic tool-calling guidance](https://developers.openai.com/api/docs/guides/latest-model) recommends code-mediated calls for bounded aggregation, filtering, ranking, deduplication, and validation. Direct model turns remain appropriate when each result changes judgment, approval matters, or native artifacts and citations must stay visible.

**Jazzboard inference:** geometry checks, graph traversal, collision detection, revision validation, and bounded batch operations belong in code. Meaning, composition, and aesthetic decisions remain agent judgments informed by those facts.

### 7. Artifacts outlive conversation context

OpenAI distinguishes compaction, reusable memory, and the reviewed artifact in its [reliable-agent memory and compaction notebook](https://github.com/openai/openai-cookbook/blob/86af94f494ee4680f883252d65fa256132d77c27/examples/agents_sdk/building_reliable_agents_memory_compaction.ipynb). Codex's [compaction prompt](https://github.com/openai/codex/blob/88f776588f5e73467e7659c268f8358a9a2378b6/codex-rs/prompts/templates/compact/prompt.md) preserves progress, decisions, constraints, references, and next steps rather than merely paraphrasing chat.

Anthropic's [Agent SDK loop documentation](https://code.claude.com/docs/en/agent-sdk/agent-loop) treats compaction as a boundary in a growing tool history. Its [managed-agent architecture](https://www.anthropic.com/engineering/managed-agents) separates the model, harness, sandbox, and session while retaining append-only events for rehydration.

Cursor's [cloud-agent lessons](https://cursor.com/blog/cloud-agent-lessons) similarly separate agent-loop, machine, and conversation state and use replayable event streams.

**Jazzboard inference:** the versioned board is authoritative. Keep a compact scene manifest, append-only transaction log, visual brief, accepted decisions, and unresolved defects as durable artifacts. Compaction may reference them; it must not replace them.

### 8. Long-running work needs resumable state and independent proof

Anthropic's [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) uses an initializer, structured feature state, incremental agents, progress artifacts, commits, and browser testing. The accompanying [autonomous-coding code](https://github.com/anthropics/claude-quickstarts/tree/25023412396a0bd082d50b4b4f39a864d35a3a73/autonomous-coding) creates fresh contexts while preserving project state.

Its later [visual application harness](https://www.anthropic.com/engineering/harness-design-long-running-apps) separates planner, generator, and skeptical evaluator. Anthropic reports substantially better results but more than twenty times the cost in its example, so independent evaluation should be gated by task value.

OpenAI's [agent evaluation guidance](https://developers.openai.com/api/docs/guides/agent-evals) separates trace behavior from outcome grading. Cursor combines offline evaluation with online signals such as code retention, user response, latency, tool counts, and token/cache behavior.

**Jazzboard inference:** visual completion needs both deterministic invariant checks and an independent rendered-output judgment. The creating agent's self-report alone is weak evidence.

### 9. Harnesses must evolve with models

Cursor explicitly reports removing older guardrails as models improved. Anthropic reports that a newer model no longer needed context-reset machinery required by an older one. OpenAI recommends matching tool shape to model behavior and keeping prompts lean.

Maintain per-model evals and periodically ablate:

- duplicated instructions;
- forced planning stages;
- tool restrictions;
- context resets;
- deterministic helpers that may now suppress better model judgment.

Do not preserve scaffolding solely because it once helped.

## Durable anti-patterns

- Dumping the whole board, full tool catalog, and full history into every turn.
- Using tool descriptions as authorization.
- Overlapping tools whose choice is semantically ambiguous.
- Returning huge mutation payloads with no compact receipt.
- Blindly retrying a mutation after an uncertain commit or conflict.
- Treating compaction or chat memory as authoritative canvas state.
- Asking the same model to create and certify its work without independent evidence.
- Turning every learned failure into another permanent prose rule.
- Assuming multi-agent work helps a tightly shared live-canvas mutation; coordination can cost more than it saves.
- Measuring only whether a schema call succeeded rather than whether the visual artifact is useful.

## Suggested harness metrics

- Task success and human acceptance without correction.
- Semantic/topological fidelity.
- Visual preference and readability.
- Tool-selection and schema-error rates.
- Failed, retried, or ambiguous transactions.
- Context and tool-definition tokens.
- Cache hit/cached-token behavior where available.
- Tool calls, round trips, latency, and time to first useful draft.
- Retention of human edits after agent work.
- Improvement or degradation after each correction round.

## Live Jazzboard measurement lesson — EXP-0000

The first clean-room production smoke made context amplification measurable.
One simple diagram attempt reached 184,024 cumulative input tokens across ten
stateless Responses turns even though its largest single turn was 41,327 input
tokens. This is cumulative billing/accounting, not a claim that the model's
one-million-token context window was exhausted. The author had already staged
and committed the artifact; the frozen cumulative budget blocked the requested
closing inspection.

The current OpenAI GPT-5.6 guidance says that manual stateless history must
preserve every prior output item and, with `store: false`, replay encrypted
reasoning items. It also warns that long sessions amplify repeated prompts and
tool content, recommends intentional compaction, and explicitly says to track
`cached_tokens` and `cache_write_tokens` because cache writes and hits have
different prices. See [Model guidance](https://developers.openai.com/api/docs/guides/latest-model)
and the [Responses create reference](https://developers.openai.com/api/reference/cli/resources/responses/methods/create).

**Measurement implications:**

- Do not confuse cumulative provider input with live context-window size.
- Preserve stateless reasoning continuity unless compaction is a frozen,
  separately evaluated treatment.
- Retain uncached, cached, cache-write, output, and reasoning-token details;
  total-input-only accounting cannot reconstruct billed cost.
- Set budgets from observed complete-attempt distributions, not a visually
  small task or a single-turn intuition.
- Treat verbose capability receipts and repeated draft-state reads as measured
  context contributors; optimize them only through a preregistered harness
  candidate, not by silently changing the evaluator.
- Gate a fixed-sample experiment on exact final-state and exact-revision pixel
  capture. A plausible semantic artifact is not a substitute for missing
  visual evidence.

See [Jazzboard context engineering](./jazzboard-context-engineering.md) for the proposed application of these findings.
