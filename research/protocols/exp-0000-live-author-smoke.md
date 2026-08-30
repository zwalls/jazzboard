# EXP-0000 — Clean-room live author smoke

- Protocol version: 1
- Status: preregistered; no task brief delivered yet
- Purpose: infrastructure and cost calibration only
- Partition: development
- Task: `dev-architecture-create-checkout`
- Task commitment: `sha256:d666c417b583d3dba6ee2a92e8f8c97198b7983277da11aa2c501e3f2dd5e7b0`
- Product commit: `48a52e0837144ea0db8a09e43217397226759f83`
- Deployment: `dpl_2m1qqwE4xXuTX1huy4nwoEqy5fmD`
- Baseline receipt: `research/data/baseline-freeze-v1.json`
- Live contract receipt: `research/data/baseline-live-contract-v1.json`
- Frozen runner config: `research/data/exp-0000-run-config-v1.json`
- Runner-config file digest:
  `sha256:6cb2004e123f67e2885f2057fb5f4a0c027ba2f5982fed3587afa79df1099790`
- Runner script digest:
  `sha256:03ab941fcf2663ed713b19258ae5e81f0dd581098fd5b3dff88a8b2c59584f04`
- Sealed data permitted: none

## Question and permitted conclusion

This single attempt asks whether the frozen clean-room runner can carry one
public development creation task through room provisioning, a raw model/tool
loop, revision-bound pixel delivery, immutable author-evidence sealing, and a
fresh spectator capture while retaining complete usage and failure evidence.
It cannot estimate task success probability, scorer accuracy, A/A bias, or
harness improvement. A visually good result remains anecdotal.

## Frozen author condition

- One fresh private room and one fresh browser/model context.
- Model: `gpt-5.6-sol`.
- Reasoning effort: `max` (the highest Responses API effort exposed for this
  model; Codex UI effort names are not substituted).
- Sampling temperature and seed: provider defaults; neither is supplied.
- Browser: Playwright Chromium `151.0.7922.34`, viewport `1280 × 720`, device
  scale factor `1`, locale `en-US`, timezone `UTC`.
- Public execution origin: `https://www.jazzboard.xyz/`, only after an
  authenticated Vercel preflight confirms deployment
  `dpl_2m1qqwE4xXuTX1huy4nwoEqy5fmD` immediately before execution.
- Participant contract:
  `d64cf3d25b9e275003438597b3b01c35419063d71613082d45aaf2f97c388b8e`.
- Spectator contract:
  `1760c6b1ec8cc4d8814b3de6a8f4516b3f4c215da69069c50072f23128541be2`.
- Raw Responses API with `store: false`, encrypted reasoning replay, no
  parallel tool calls, no terminal, repository, filesystem, DOM automation,
  evaluator feedback, or raw network tool.

The author receives only the compiler's public task packet and these explicit
live WebMCP capabilities:

- `get_canvas_capabilities`
- `read_room_state`
- `query_objects`
- `read_neighborhood`
- `find_diagrams`
- `read_diagram`
- `analyze_diagram_layout`
- `apply_canvas_transaction`
- `layout_objects`
- `read_canvas_drafts`
- `finish_canvas_draft`
- `inspect_canvas_scope`
- `render_canvas_preview`

The live descriptions and JSON schemas—not repository documentation—define
their exact behavior. The task starts only when the public brief is delivered.

## Frozen budgets

| Resource | Limit |
| --- | ---: |
| Wall time | 600,000 ms |
| Author tool calls | 40 |
| Per-tool timeout | 30,000 ms |
| Cumulative billed input tokens | 80,000 |
| Cumulative output tokens | 12,000 |
| Output tokens per response | 4,000 |
| Maximum nominal model cost at current frozen rates | $0.56 |

The cost ceiling uses $4 per million input tokens and $20 per million output
tokens, as published on the [official GPT-5.6 Sol model page](https://developers.openai.com/api/docs/models/gpt-5.6-sol)
on 2026-08-30. Actual provider usage and returned model identity are retained. A
response may cross the cumulative input ceiling because the provider reports
input usage only after completion; no subsequent request or tool call may run
after the crossing. Output is hard-capped before each request.

## Pass/fail diagnostics

The smoke passes its infrastructure objective only if:

1. alias preflight and both exact live contract hashes pass;
2. no browser request escapes the allowlisted Jazzboard origin;
3. the author uses only namespaced allowlisted WebMCP calls;
4. every completed response and tool receipt is retained with usage;
5. any inspect/render pixels are bound to an exact room revision;
6. author evidence is sealed before the author context closes;
7. a new spectator context exposes exactly the frozen 18-tool non-mutation
   surface and captures final semantic state plus a clean final render;
8. room, session, participant, preview, cookie, and API credentials are absent
   from persisted evidence; and
9. the artifact index and evidence hashes recompute exactly.

Task acceptance is scored separately and reported only as exploratory smoke
evidence. Any missing final state or render is an evidence failure and cannot
be converted into success from the author's prose.

## Attempt retention and retry policy

The planned attempt ID is `smoke-exp0000-checkout-solmax-v1`. Once its brief is
delivered, timeout, refusal, no-op, malformed call, provider failure, product
failure, or runner failure remains the smoke outcome. A supplemental diagnostic
may use a new linked attempt ID, but never replaces or deletes the original.
Failures before brief delivery are retained as `not_started` infrastructure
incidents and do not become author attempts.

## Stopping and next decision

Stop immediately for credential leakage, authorization failure, contract
drift, non-WebMCP mutation, or evidence corruption. Otherwise run exactly one
attempt, publish its actual cost and failure classification, then freeze any
necessary measurement change before EXP-0001A. Do not tune Jazzboard or the
benchmark from this one artifact and do not access a validation or sealed
partition.
