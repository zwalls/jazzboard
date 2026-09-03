# EXP-0023 lossless pixel-capture replication

- Date: 2026-09-03
- Status: complete; all quality gates passed and the targeted capture retry disappeared
- Product candidate: `90c7585`
- Benchmark: unchanged `dev-architecture-create-observability`
- Author: fresh projectless `gpt-5.6-terra`, reasoning `medium`
- Reviewers: two separate fresh projectless `gpt-5.6-sol`, reasoning `high`

## Result

The unchanged authoring task passed every factual and blinded visual gate. The
final board contains all six required components, three visually distinct
planes, and all five correctly directed relationships. Both independent
reviewers returned an overall pass with zero blocking geometry violations.

The targeted pixel-capture failure did not recur. The lossless top-level
`canonicalPixelCaptureJson` scalar survived the generic result transport at
2,021 bytes. After one semantic inspection, the author's next and only pixel
capture used the prescribed clean request, `{fullPage:false}`. There was no
guessed clip, blank capture, repeated inspection, or capture retry.

Total author wall time was 217,820 ms, 9,855 ms (4.3%) faster than EXP-0022,
despite this run using two more draft transactions. Host execution time fell
by 914 ms (2.2%), and host calls fell from 17 to 15. This is useful mechanism
evidence, not a population-level speed claim: one replicate cannot separate
ordinary run variance from the product effect, and the author also serialized
the complete inspection result before using the clean capture request.

## Additional mechanism evidence

This run also exercised the actionable text-fit bounds introduced before
EXP-0022. The first draft reported `TEXT_CONTENT_LIKELY_TRUNCATED` for the
Telemetry plane heading, with an exact minimum width of 376 at its current
height and an explicit warning that a zero failure count did not resolve it.
The author's first patch widened that heading from 360 to 460, and the warning
disappeared before commit. No post-commit text repair was required.

The author accepted five draft transactions before one atomic finish. The
initial draft exposed several routing and label problems, and the author used
four preview-only correction patches. The final deterministic geometry report
contained six warnings but no failures: one connector crossing, one connector
label/edge collision, and four small-spacing warnings. Both blinded pixel
reviewers judged those findings non-blocking and found the diagram readable.

## Decision

Keep both the lossless pixel-capture contract and actionable text-fit
correction fields. The capture pathway's targeted behavioral mechanism is
validated for this replicate, with no factual or visual regression. Do not
claim an average speed improvement until randomized repetitions establish it.

The dominant remaining avoidable work has moved earlier in the workflow: four
draft correction rounds plus a second capability read. The next investigation
should determine whether draft receipts already contain enough exact local
geometry to consolidate those corrections, and whether generic result
transport hides or fragments that context. Jazzboard should improve the
agent's evidence and decisions, not silently lay out or repair the canvas on
the agent's behalf.

The complete sanitized record is
`research/data/exp-0023-lossless-pixel-capture-replication-v1.json`. Room
credentials, raw sessions, semantic state, and pixels remain private and
gitignored.
