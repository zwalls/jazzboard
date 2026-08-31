# EXP-0001A Terra/medium author qualification v1

Completed: 2026-08-31T15:16:42.000Z

Plan digest:
`sha256:7ef8289fe13fe928f18b922dd84bfe1b9bae8a9b15e47027c308ce3933c8935d`

Result digest:
`sha256:e4cc8465d3c9847c7705bddc1a4719dcc265976e6f43f6b74d752f7529f97d84`

## Outcome

Terra at medium reasoning does **not** pass the frozen operational gate for
becoming the sole author population in EXP-0001A. The 48-attempt A/A remains
blocked and its v2 Sol/max authority remains unmodified and unsigned for brief
release.

| Task | Validity | Primary reviews | Gate status | Main finding |
| --- | --- | --- | --- | --- |
| Observability architecture creation | Valid, non-prospective | reject / reject | Failed | Four required directed relationships had visually ambiguous arrowheads; planes and viewport passed |
| Primary-path architecture edit | Invalid setup, prospective | reject / reject | Incomplete | The frozen seed already rendered the p95 note and Audit Sink as truncated before author release |
| Layered portrait drawing | Valid, prospective | accept / accept | Passed | All content, native-vector style, focal hierarchy, and overlap criteria passed |

The gate decision is `fail`: one valid failure is sufficient under the
all-three-must-pass stopping rule. The drawing task passed; the edit task is
retained but incomplete rather than charged to the model.

No percentage-improvement or population-performance claim is permitted. One
of the two valid scored tasks passed, but this three-task qualification is an
operational gate, task one was observed before its full freeze, and the sample
is not an inferential benchmark.

## Role policy evaluated

- Candidate ecological author: `gpt-5.6-terra`, `medium` reasoning.
- Independent primary reviewers: `gpt-5.6-sol`, `high` reasoning.
- Platform-default Sol/medium and lower-bound Luna/xhigh authors were not mixed
  into this gate or its denominator.
- Resolved model snapshots, exact tokens, and subscription usage were not
  exposed and are recorded as `unobservable`, never estimated.

## Author evidence

### Architecture creation

- Task: `dev-architecture-create-observability`
- Author task: `01a05822-e23e-73a3-b2e2-df1fd52a7799`
- Wall time: 250,709 ms
- Final authoritative room revision: 4
- Final state: 17 objects, 1 Diagram
- Visual inspections: 3
- Correction rounds: 2
- Semantic state:
  `sha256:314b085729c0979492be46891259a89da274647a2fa0eb5e47f14b18cd63190d`
- Final PNG:
  `sha256:1ae067395d416a185a9d8553b4fb74279c0479b32a77cb8c83221dfa5fb2ebb0`
- Reviewers: `01a0582d-1aeb-78a3-8218-21a986fe16fe` and
  `01a0582d-1033-7fc3-b1d1-d188d90562b1`
- Decision: both rejected only the directed-relationship criterion; both
  accepted plane separation and fixed-viewport readability.

### Architecture edit

- Task: `dev-architecture-edit-primary-path`
- Author task: `01a05857-f208-7ee3-8594-2a68461a3f92`
- Wall time: 107,801 ms
- WebMCP: 9 calls, 0 failures
- Final authoritative room revision: 3
- Final state: 8 objects, 1 Diagram
- Visual inspections: 2
- Correction rounds: 1
- Semantic state:
  `sha256:f746af98c1e129590f0cb04437dbb2e961690c7aad2855d4256d8af7a55401da`
- Final PNG:
  `sha256:5775899e8de9940982d264f0e4b4bbbea888583802f79f05664deccf7be9284e`
- Reviewers: `01a05861-29d5-7513-b684-fa5b528e2f00` and
  `01a05861-3735-7833-8911-52aea43d6ec7`
- Author behavior: correctly preserved all entities, all relationships, and
  the human note; changed only the bad Gateway-to-Catalog label/connector.
- Review decision: both rejected visible preservation because the final pixels
  ellipsized `p95 latency: 180 ms` and `Audit Sink`.
- Validity decision: invalid setup. The coordinator's pre-author transaction
  receipt already reported `TEXT_CONTENT_LIKELY_TRUNCATED` for the p95 note and
  `SHAPE_LABEL_LIKELY_TRUNCATED` for Audit Sink. Their object revisions remained
  1 after the author finished, proving the author did not create the defects.
  The public WebMCP transaction also applied its node-type palette rather than
  the fixture's specified white/black style and could not encode the fixture's
  text fill/stroke exactly. Releasing a non-exact, already-failing baseline was
  a harness error.

One reviewer twice omitted boolean values from otherwise unchanged JSON. The
same reviewer context re-emitted its existing decision after two
format-repair turns. No evidence was reopened, no reviewer was replaced, and
the substantive judgment never changed.

### Drawing creation

- Task: `dev-drawing-create-layered-portrait`
- Author task: `01a05858-0165-70f2-b872-0fb4e6b0bee6`
- Wall time: 171,429 ms
- WebMCP: 12 calls, 1 harmless unavailable-tool probe with no canvas effect
- Final authoritative room revision: 2
- Final state: 18 native vector paths, 0 Diagrams
- Visual inspections: 2
- Correction rounds: 0
- Semantic state:
  `sha256:77f40e09ad464539a3f1116755a699c9f7d700cdf3fcca503a362e57965885c8`
- Final PNG:
  `sha256:1cbe4be7dd80b511e6f26ad6d7793f85a8b8d198a18c4bdc2a0f8e8bb9b687c3`
- Reviewers: `01a05861-4e59-7411-b8f3-cab33b358160` and
  `01a05861-4262-7290-ac43-18bc74f4681e`
- Decision: both accepted all content, style, and layering criteria with high
  confidence. Both found the face clearly focal and the hair-over-face,
  collar-over-torso, and hand-over-jacket relationships intact.

## Retained setup incidents

Before the valid observability attempt, task
`01a0581e-8d3b-7753-bec0-a1f064b69ffb` received no exact room URL because of a
coordinator prompt-construction error. The task created no valid artifact,
never became a model attempt, and is retained without scoring against Terra.

During evidence collection, production `export_canvas_artifact` returned HTML
where JSON was expected. This did not affect either author or canvas. The
coordinator instead used authoritative `read_room_state`, applied the frozen
redaction projection, hashed the result, and paired it with the exact-revision
PNG. The product/harness export failure should be diagnosed separately before
a larger run.

## Scientific interpretation

This gate separates two conclusions that would otherwise be easy to blur:

1. Terra/medium demonstrated strong, efficient native-vector drawing on this
   task and made a narrowly bounded architecture edit without topology damage.
2. Terra/medium is not yet qualified as the sole primary author population,
   because the valid architecture-creation artifact failed required visual
   directionality under two independent reviews.

The edit result cannot support a model conclusion. It instead exposed a missing
runner invariant: a seeded fixture must pass its own baseline visual contract
before an author brief can be released. Semantic equality alone is not enough
when a preservation criterion will later be judged in pixels.

## Next decision

Do not generate or sign a v3 48-run freeze yet. First:

1. Add a seed preflight that renders every fixture and blocks release when the
   baseline already violates a criterion or guardrail.
2. Repair/version the primary-path fixture for the current renderer.
3. Decide prospectively whether to run a new Terra/medium qualification after
   that harness fix or instead qualify Sol/medium as the primary author policy.
4. Preserve this failed gate unchanged; do not reuse its artifacts as new
   attempts or select a best-of-N replacement.

Machine-readable evidence is in
`research/results/exp0001a-terra-medium-qualification-v1.json`.
