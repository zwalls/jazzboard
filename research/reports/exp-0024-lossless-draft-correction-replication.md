# EXP-0024 lossless draft-correction replication

- Date: 2026-09-03
- Status: complete; quality passed, targeted correction and speed gains did not
- Product candidate: `5770faa`
- Benchmark: unchanged `dev-architecture-create-observability`
- Author: fresh projectless `gpt-5.6-terra`, reasoning `medium`
- Reviewers: two separate fresh projectless `gpt-5.6-sol`, reasoning `high`

## Result

The unchanged authoring task passed every factual and blinded visual gate. The
authoritative audit matched all six components and all five correctly directed,
typed relationships. Both independent reviewers returned an overall pass with
zero blocking geometry violations. The final deterministic geometry report had
one non-blocking connector-label/edge warning, no connector crossings, no
congested ports, and 40 canvas units of minimum member spacing.

The new top-level `canonicalDraftCorrectionJson` survived generic transport on
every finding-bearing draft receipt. It ranged from 7,828 bytes on draft
revision 1 to 4,160 bytes on revision 5. The author also skipped the deeper
architecture capability read used by EXP-0023.

Those mechanism signals did not become a speed improvement. The author still
used four preview-only correction patches, exactly the same count as EXP-0023,
and the trace contains no explicit parse or reference to the canonical scalar.
Total wall time was 250,680 ms, 32,860 ms (15.1%) slower than EXP-0023. Host
execution actually fell by 1,263 ms (3.1%), while model and coordination time
increased by 34,123 ms. One replicate cannot attribute that increase to the
product change, ordinary model variance, or the later capture recovery.

The author also ignored the lossless pixel contract's `{fullPage:false}` request
and captured the inspection region as a guessed clip. That first image was
blank, so the author correctly used the prescribed one-retry reframe recovery
and completed visual inspection on the second capture. The quality result is
valid, but this replicate does not reproduce EXP-0023's one-capture behavior.

## Decision

Keep the correction scalar as an unproven candidate because it is lossless,
does not choose a layout for the agent, and caused no factual or visual
regression. Do not claim a correction-round or speed benefit.

The next experiment should target the much larger response surface around the
scalar. Even with `responseDetail:"concise"`, the five draft responses delivered
about 130 KB of repeated preview, relationship, and reasoning structures in
addition to the joined scalar. The next candidate should make concise mode
genuinely compact: retain the complete scalar and minimal status/identity fields
while omitting duplicated verbose structures. This tests whether reducing model
input and evidence reconstruction time improves wall time without weakening the
agent's reasoning or quality.

The complete sanitized record is
`research/data/exp-0024-lossless-draft-correction-replication-v1.json`. Room
credentials, raw sessions, semantic state, and pixels remain private and
gitignored.
