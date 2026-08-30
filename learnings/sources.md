# Source ledger

Research snapshot and access date: 2026-08-30

Primary vendor documentation, public repositories, and research papers were preferred. Product benchmarks reported by vendors or project authors are recorded as reported figures, not independently validated results. Cursor's proprietary harness source is not public; claims about it rely on Cursor's official engineering posts and documentation, while public protocol repositories provide supporting implementation evidence.

## OpenAI

- [GPT-5.6 prompting and harness guidance](https://developers.openai.com/api/docs/guides/latest-model) — current official guidance on lean prompts, tool relevance, reasoning continuity, autonomy, and programmatic tool calling.
- [Harness engineering](https://openai.com/index/harness-engineering/) — official engineering account of agent-legible systems, short map-style guidance, enforceable invariants, feedback loops, and documentation gardening.
- [The next evolution of the Agents SDK](https://openai.com/index/the-next-evolution-of-the-agents-sdk/) — official direction on memory, sandboxes, MCP, skills, filesystem tooling, and manifests.
- [Tool search](https://developers.openai.com/api/docs/guides/tools-tool-search), [prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching), [compaction](https://developers.openai.com/api/docs/guides/compaction), [agent evals](https://developers.openai.com/api/docs/guides/agent-evals), and [evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices) — official API behavior and recommendations.
- [`openai/codex` at `88f7765`](https://github.com/openai/codex/tree/88f776588f5e73467e7659c268f8358a9a2378b6) — inspected `AGENTS.md`, skill catalog/model, tool definitions, permission instructions, and compaction prompt templates.
- [`openai/openai-agents-python` at `89c02c8`](https://github.com/openai/openai-agents-python/tree/89c02c828ee8510fe9a84ee6675608193aa13b02) — inspected context, running, sessions, tools, guardrails, tracing, `tool.py`, and run configuration.
- [`openai/openai-agents-js` at `8e862b3`](https://github.com/openai/openai-agents-js/tree/8e862b3380a577df1315bef17f351c1b58c2938b) — public SDK snapshot for cross-checking current concepts.
- [`openai/openai-cookbook` at `86af94f`](https://github.com/openai/openai-cookbook/tree/86af94f494ee4680f883252d65fa256132d77c27) — inspected the reliable-agent memory/compaction notebook.
- [`openai/plugins` at `1e28582`](https://github.com/openai/plugins/tree/1e285826e604f66f7208f7ac4dba0fe8341d1f57) — current first-party plugin/skill source; the older `openai/skills` repository is deprecated in favor of this repository.

## Anthropic

- [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) — context budgeting, prompt altitude, just-in-time retrieval, compaction, structured notes, and subagent distillation.
- [Writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents) and [Advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use) — workflow-oriented tool design, concise results, deferred discovery, and programmatic calls.
- [Equipping agents with skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills) — progressive disclosure and skill structure.
- [Agent loop and compaction](https://code.claude.com/docs/en/agent-sdk/agent-loop), [memory](https://code.claude.com/docs/en/memory), [best practices](https://code.claude.com/docs/en/best-practices), and [context-window behavior](https://code.claude.com/docs/en/context-window) — current Claude Code/Agent SDK behavior.
- [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) and [`claude-quickstarts/autonomous-coding` at `2502341`](https://github.com/anthropics/claude-quickstarts/tree/25023412396a0bd082d50b4b4f39a864d35a3a73/autonomous-coding) — inspected initializer/coding prompts, `agent.py`, and `client.py`.
- [Harness design for long-running apps](https://www.anthropic.com/engineering/harness-design-long-running-apps) — planner/generator/evaluator separation and cost tradeoff for visual applications.
- [Managed agents](https://www.anthropic.com/engineering/managed-agents) — durable event history and separation of brain, harness, sandbox, and session.
- [Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) and [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) — delegation economics and outcome-based evaluation.
- [`anthropics/skills` skill creator at `b0cbd3d`](https://github.com/anthropics/skills/blob/b0cbd3df1533b396d281a6886d5132f623393a9c/skills/skill-creator/SKILL.md) — inspected metadata/body/resource progressive disclosure.
- [`claude-agent-sdk-python/types.py`](https://github.com/anthropics/claude-agent-sdk-python/blob/0f005fa5a23aa8872b6e1cad91d89cc99800c3b0/src/claude_agent_sdk/types.py) — inspected prompt presets, task budgets, agent definitions, and hooks.
- [Anthropic frontend-design skill](https://github.com/anthropics/claude-code/blob/423563cfe38c90fdf3b428cff0ee7f51cfec3ca7/plugins/frontend-design/skills/frontend-design/SKILL.md) — inspected visual brief, tokens, signature, screenshot, and critique guidance.

## Cursor

- [Dynamic context discovery](https://cursor.com/blog/dynamic-context-discovery) — artifact-backed large outputs, searchable history, deferred skills/MCP definitions, and reported token effects.
- [Continually improving our agent harness](https://cursor.com/blog/continually-improving-agent-harness) — model-specific harnessing, removal of stale guardrails, tool reliability, offline and online evaluation.
- [Cloud agent lessons](https://cursor.com/blog/cloud-agent-lessons) — environment fidelity, durable execution, append-only events, and self-healing observability.
- [Semantic search](https://cursor.com/blog/semsearch) and [secure codebase indexing](https://cursor.com/blog/secure-codebase-indexing) — hybrid retrieval and incremental indexed context.
- Cursor [rules](https://cursor.com/docs/rules), [prompting](https://cursor.com/docs/agent/prompting), [subagents](https://cursor.com/docs/subagents), and [hooks](https://cursor.com/docs/hooks) — current public usage and extension guidance.
- [`cursor/cursor` at `654b1b4`](https://github.com/cursor/cursor/tree/654b1b4775ca67aef473bd31a14c8c04a1abde2d) — inspected and found only public project material, not the proprietary harness.
- [`cursor/sdk-bridge`](https://github.com/cursor/sdk-bridge) — inspected protocol/service definitions for durable create/resume, idempotency, event offsets, artifacts, usage, and cancellation.
- [`cursor/plugins`](https://github.com/cursor/plugins) — inspected a public skill example emphasizing evidence before memory and references over inlining.
- [`cursor/agent-trace`](https://github.com/cursor/agent-trace) — inspected reference storage/hook code for file- and line-level agent attribution.

## Visual and diagram systems

- [tldraw Agent Starter Kit](https://github.com/tldraw/tldraw/tree/main/templates/agent) — inspected action schemas, prompt parts, focused/simplified/peripheral shape representations, screenshot extraction, lint manager, review action, and prompt rules.
- Official [jgraph/drawio-mcp](https://github.com/jgraph/drawio-mcp) at inspected commit [`be57d3d`](https://github.com/jgraph/drawio-mcp/commit/be57d3d4cb73261ea2c82d14871792f14f5bc555) — inspected MCP server tools, XML normalizer, skill, and shared XML reference.
- [drawmode](https://github.com/teamchong/drawmode) at inspected commit [`0aee6b5`](https://github.com/teamchong/drawmode/commit/0aee6b5454f393a0e5da473c7c3ffbaf31d1fa1d) — inspected MCP registration, embedded SDK types, executor, layout, and validation.
- [Agentic Mermaid](https://github.com/adewale/agentic-mermaid) — inspected typed mutation/verification design and its regression/evaluation approach. Project changelog improvements are author-reported tune-set results, not a private holdout.
- [Nereid](https://github.com/bnomei/nereid) — inspected canonical source, graph queries, stable IDs, diffs, and identity reconciliation.
- [DiagramAgent](https://github.com/outbackops/DiagramAgent) at inspected commit [`bd8b888`](https://github.com/outbackops/DiagramAgent/commit/bd8b888e5095d975bce8be3ba1209295ddff226f) — inspected generation, typed visual assessment, loop orchestration, and stopping behavior.
- [DoodleAgent](https://github.com/YIFANK/DoodleAgent) — inspected the image-plus-recent-strokes loop and drawing validation in `free_drawing_agent.py`.
- [Doop](https://github.com/kgoedecke/doop) — inspected guide discovery, screenshot feedback, design memory, and post-mutation inspection nudges.
- [Excalidraw Mermaid converter](https://github.com/excalidraw/mermaid-to-excalidraw) — inspected bounds, arrow binding, grouping, text fitting, and test approach.

## Visual self-correction research

- [VASCAR](https://arxiv.org/abs/2412.04237) — rendered feedback, automatic metrics, and retrieved examples for layout correction.
- [Feynman](https://arxiv.org/abs/2603.12597) — staged semantic planning, declarative visual programs, rendering, and optimization.
- [Iterative Visual Token Tuning](https://arxiv.org/abs/2606.13156) — evidence that naïve visual iteration can degrade spatial grounding without a better-trained correction loop.
- [RefineSVG](https://arxiv.org/abs/2607.27699), [Render-in-the-Loop](https://arxiv.org/abs/2604.20730), and [Seeing Is Improving](https://arxiv.org/abs/2603.22187) — recent visual refinement systems; promising but not settled production evidence.

## Local Jazzboard evidence inspected

- `PRODUCT-SPEC.md` — product decisions, WebMCP surface, semantic Diagram model, role/privacy rules, inspection contract, and acceptance checklist.
- `README.md` — current documented tool counts and workflows.
- `src/lib/webmcp/registration.ts` and `registration.test.ts` — eager role-specific registration and descriptor budgets.
- `src/lib/webmcp/capability-tools.ts` — versioned renderer-neutral capability contract and canonical examples.
- `src/lib/webmcp/semantic-tools.ts` — semantic reads, transactions, layouts, diagrams, and response shapes.
- `src/lib/webmcp/preview-tools.ts`, `preview-contract.ts`, and `in-room-preview-transport.ts` — revision-consistent inspection, geometry evidence, framing, and host screenshot handoff.
- `src/lib/agent-readiness/content.ts` — generated agent-readable routes, guides, reference, skill, and lifecycle instructions.
- `e2e/deployed-webmcp.e2e.ts` — deployed participant/spectator tool coverage and semantic workflow expectations.

No private vendor source code was accessed. No claims in these notes depend on reverse engineering a closed system.
