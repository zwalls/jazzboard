# EXP-0006 paint-order occlusion validation

- Date: 2026-09-02
- Status: complete; mechanism validated, one isolated artifact passed
- Product candidate: `80a9a1afdc94baa95d5bc844ebfca7cc15afd4c2`
- Author: fresh projectless `gpt-5.6-terra`, reasoning `medium`
- Reviewer: separate fresh projectless `gpt-5.6-sol`, reasoning `high`

## Why this follow-up exists

EXP-0005 found that the candidate architecture tasks passed two of two while
the preceding surface passed zero of two, but it also exposed a blind spot. A
foreground Checkout API node covered part of a labeled trust-boundary shape,
yet diagram-only geometry inspection reported no defect because the boundary
was a visual contributor outside the Diagram's declared membership.

The product change adds paint-order-aware `textOcclusionRisks` to focused and
working-set inspection. The signal binds the estimated text source and the
later-painted opaque rectangle to exact object IDs and revisions. It supplies
evidence and corrective options; it does not move, resize, or lay out objects
on the agent's behalf.

## Live mechanism check

Using the actual browser-exposed WebMCP tools, the validation created the
failure pattern from EXP-0005: a labeled trust boundary underneath a Checkout
API node. Inspection returned one `likely` risk with:

- the label object's exact revision;
- the occluding object's exact revision;
- estimated label and overlap bounds;
- the method `shared_text_layout_bounds_and_exact_rectangle_paint_order`;
- a stable same-scope finding key; and
- guidance to inspect pixels and choose whether to move, resize, or separate
  the text.

After an agent-chosen exact-revision move, the same scope returned no
`textOcclusionRisks`. Re-inspection reported that the prior same-scope key was
not observed. Jazzboard deliberately does not label that result “resolved”:
absence of one deterministic signal is not proof that all visual defects are
gone.

## Isolated author result

A fresh projectless Terra task received only the public checkout-diagram brief,
a private room URL, and browser/WebMCP access. It had no Jazzboard repository,
private API, prepared coordinates, author history, or evaluator context.

The author completed the artifact in 200,800 ms. Its final authoritative state
contained eight objects, one revision-1 Diagram, all four required Diagram
members, and exactly three connectors. The trust boundary remained a separate
visual contributor, reproducing the membership condition that defeated the old
inspection surface. Final inspection reported:

- `geometryQualityStatus: pass`;
- no text occlusion risks;
- no text findings; and
- no outstanding finding keys.

The first exact clipped capture was blank despite visible semantic targets.
The author followed the bounded one-retry protocol, reframed once, and obtained
a valid clean full-viewport capture containing the exact inspection region.

## Blinded review

A separate fresh Sol reviewer received only the public requirement and frozen
rubric, sanitized semantic state, and final clean PNG. It received no author
transcript, condition label, room credential, repository, or paired result.

The reviewer passed checkout facts, trust-boundary semantics, and readability,
with no material defects. The clean PNG SHA-256 is
`8e8d70a63328d387f11b93e5e182d4d9b0dbc54fad913fd74f9f470f5dfa7950`.

## Decision

The intended detect-correct-verify mechanism is validated, and one fresh
autonomous artifact passed blinded review. This is a prospective n=1 mechanism
check, not a population estimate. It does not justify a percentage improvement
claim or settle the high-variance speed result from EXP-0005.

The next speed work should preserve this quality surface while measuring where
author time is spent: discovery, draft construction, validation, correction,
and host execution. That attribution can tell us whether the next intervention
belongs in schemas, result compactness, operation batching, or agent guidance.

The complete sanitized record is
`research/data/exp-0006-paint-order-occlusion-validation-v1.json`. Private room
credentials, raw sessions, semantic packets, and pixels remain outside Git.
