# EXP-0003 — Speed-with-quality micro-pilot

- Status: **baseline diagnostic frozen before author release**
- Frozen at: `2026-09-02T06:01:00Z`
- Scope: public development evidence only
- Active implementation branch: `feature/agent-speed-quality`
- Current production baseline commit: `e30fea80f56b41123242a653945295419ba2dd99`
- Current production deployment: `dpl_GJbEkXWrRxbCuvRoseXaPhB7D9uz`

## Research question

Can Jazzboard reduce the elapsed time required for an agent to create a
semantically complete, visually acceptable architecture diagram without
reducing semantic accuracy, visual quality, progressive construction,
authoritative atomicity, or final pixel inspection?

This is an exploratory mechanism pilot. It may identify bottlenecks and support
a bounded development decision, but it cannot support a population-level
percentage-improvement claim or a sealed-test decision.

## Comparisons

The pilot separates a non-causal speed reference from the causal product
comparison:

1. `M0` — a fresh projectless Codex task writes Mermaid syntax for the frozen
   public architecture brief. This measures declarative authoring time only.
2. `J0` — a fresh projectless Codex task completes the same brief in a fresh
   private room through the current production WebMCP surface.
3. `J1` — after the `J0` trace identifies a concrete bottleneck, a fresh
   projectless Codex task completes the same brief through one frozen candidate
   deployment.

`M0` is a reference, not a treatment arm: Mermaid does not provide Jazzboard's
multiplayer presence, semantic object identity, direct editing, revision
checks, leases, progressive construction, or pixel-inspection contract. Only
the matched `J0` versus `J1` comparison can be attributed to a Jazzboard
change.

## Frozen task and evidence

- Task: `dev-architecture-stress-dense-routing`
- Benchmark: `research/benchmarks/development-v2.json`
  - SHA-256 `9326d2e0d8cd06fdaabfe9345b0eb85e0634fbcc9ece285124553c2a0a649227`
- Fixtures: `research/benchmarks/development-fixture-specs-v2.json`
  - SHA-256 `cb6942984d5fc6b566cccc62d90d0d29567fba387677ee87f06f973a15307575`
- Rubric: `research/benchmarks/development-evaluator-rubrics-v2.json`
  - SHA-256 `15bde60f5e593164a2b8d7ec924cf3d722c049e18db07b0ded5586f9b00f8919`

Historical EXP-0002 attempts are diagnostic priors only. The two retained
architecture attempts took `342,911 ms` and `396,916 ms`; they are not pooled
with new outcomes because they used earlier product deployments.

## Author isolation

- Fresh projectless Codex task for every attempt
- Model `gpt-5.6-terra`, reasoning `medium`
- ChatGPT subscription authentication; no API-key transport
- No Jazzboard repository, private API, prepared coordinates, evaluator
  context, paired result, fork, or shared task history
- `J0` and `J1` receive only the public task packet and one exact private room
  invite, then use browser-exposed WebMCP
- `M0` receives only the public task packet and a request for one Mermaid
  artifact
- Fixed author wall-time limit: 15 minutes
- Every begun attempt is retained, including failures and usage interruptions

## Timing model

The harness records three distinct clocks when observable:

1. **Author task wall time** — Codex turn start through terminal completion.
2. **Authoritative completion** — task start through the room activity that
   records the final accepted semantic mutation.
3. **Visible presentation completion** — task start through completion of the
   latest progressive draft presentation.

Missing clocks are `unobservable`; they are never estimated. The Codex task
trace additionally records:

- host/browser call count, duration, and failure count;
- browser-exposed WebMCP tool names invoked;
- room-entry and capability-discovery calls;
- initial draft mutations and replacements;
- `finish_canvas_draft` calls and outcomes;
- inspections, pixel captures, direct correction mutations, and final reads;
- residual wall time not spent inside recorded tool execution, labeled
  `model_and_coordination`, not inferred as pure model reasoning;
- room revisions, object/connector/Diagram counts, and activity timestamps.

Tokens, resolved model snapshots, presentation timestamps, or subscription
usage are recorded only when exposed; otherwise they remain `unobservable`.

## Quality and integrity gates

The candidate is eligible to merge only when all of the following hold:

- Every required entity and directed relationship appears exactly once.
- Stable semantic identities, first-class Diagram metadata, connector
  bindings, revision checks, attribution, and unrelated fixture state remain
  correct.
- The final exact-revision artifact passes the frozen semantic rubric.
- Blinded visual review finds no material regression in label readability,
  routing clarity, framing, or overall usefulness.
- Progressive construction remains visible, while its animation does not pace
  or delay the agent's semantic authoring.
- Exact pixel inspection occurs before the author claims visual completion.
- No uncertain mutation is blindly replayed.

The primary speed outcome is total author wall time. Secondary outcomes are
time to first authoritative mutation, time to final authoritative mutation,
tool execution time, residual model-and-coordination time, WebMCP calls,
failed calls, inspection rounds, and correction rounds.

## Candidate-selection rule

The `J0` trace must identify a bounded mechanism supported by retained
evidence. Permitted candidate classes include a more actionable fast-path
contract, fewer redundant descriptors or receipts, draft-time diagnostic
evidence, or removal of an unnecessary blocking presentation wait. The
candidate may improve information or transport, but must not choose the
diagram's composition, silently auto-layout it, weaken validation, skip pixel
inspection, hide progress, or lower the model/reasoning setting.

After the candidate is implemented and frozen, append an amendment naming its
commit, deployment, exact mechanism hypothesis, and fixed `J0`/`J1` release
order before releasing `J1`.

## Candidate amendment — frozen before J1 release

- Frozen at: `2026-09-02T06:42:10Z`
- Candidate source commit: `080cc19c54ceee0a0ce3e074c7d69a8a76c2d8f0`
- Candidate deployment: `dpl_48CbCBWQnkrGegqkV1DGLkC1aUgD`
- Candidate origin: `https://jazzboard-r2li6w9ce-zwalls-projects.vercel.app`
- Release order: completed `M0`, then completed `J0`, then exactly one fresh
  `J1` author task. No candidate change is permitted after `J1` receives its
  brief.

The retained `J0` attempt took `477,603 ms`. Recorded host/tool execution
accounted for `60,023 ms`; the remaining `417,580 ms` is labeled
`model_and_coordination`, not pure reasoning. The trace included three
capability-bundle reads, one failed first transaction caused by unsupported
per-operation metadata placement, and post-commit geometry and pixel repair.
The final semantic graph was complete, but deterministic geometry still
reported nine failures and three warnings.

The frozen candidate changes only information timing:

1. The existing `get_canvas_capabilities` selector now exposes compact
   `quickstart_architecture` and `quickstart_illustration` bundles. The
   quickstart is a self-contained authoring, draft-preflight, finish, and exact
   inspection path; it explicitly tells authors not to preload core or multiple
   deeper bundles. No additional registered tool or descriptor was added.
2. Every progressive draft receipt now overlays its unpublished preview onto
   the current authoritative room and returns bounded, intent-unaware
   `draftValidation` findings before `finish_canvas_draft`. Authors may replace
   the complete cumulative draft to correct unintended findings before atomic
   publication. Deliberate overlap, routing, cropping, spacing, asymmetry, and
   all creative decisions remain under author/user control.
3. The public agent guide, `llms.txt` family, `AGENTS.md`, and downloadable
   Jazzboard skill now direct new work through one quickstart and explain the
   draft preflight. Registered schemas and server validation remain
   authoritative.

The mechanism hypothesis is that one compact initial contract plus pre-commit
geometry evidence will reduce context processing, prevent the observed schema
retry, and move deterministic corrections ahead of presentation and commit.
The candidate does not alter transaction limits, progressive presentation,
draft persistence, atomic commit, routing/layout algorithms, authorization,
leases, revision checks, final pixel inspection, or the frozen author model and
reasoning level.

## Interpretation

Report exact observed durations, call counts, quality decisions, and paired
differences. Do not call an ordinal score a percentage and do not generalize
from this micro-pilot. A later randomized multi-task replication is required
before making a broad speed-with-quality claim.

## Development addendum — candidate reopened before production J1

The deployment named in the original candidate amendment required Vercel
login, so an isolated projectless author could not access it. No production
`J1` brief was released against that deployment. The candidate was therefore
reopened for non-scoring local development qualifications; this does not alter
or discard the retained `J0` baseline.

Four fresh local qualifications were retained rather than selectively hidden.
They reduced author wall time from 427,292 ms to 343,979 ms, 310,733 ms, and
finally 253,862 ms as bounded transport and guidance defects were corrected.
Their final blocking-geometry counts were 8, 8, 3, and 0 respectively. The
fourth qualification preserved all nine required entities and nine required
relationships, retained three non-blocking warnings, performed an exact pixel
capture, and was 46.8% faster than the 477,603 ms production baseline. Full
evidence is retained in
`research/reports/exp-0003-qualification-4.md`.

The next candidate freeze must name a public production-accessible deployment
before releasing exactly one fresh matched production `J1`. Local
qualifications remain mechanism-development evidence only and are not pooled
with the production comparison.
