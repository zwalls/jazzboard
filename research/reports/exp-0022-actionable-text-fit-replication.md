# EXP-0022 actionable-text-fit replication

- Date: 2026-09-03
- Status: complete; all quality gates passed, causal speed gain not established
- Product candidate: `3d3cfc6`
- Benchmark: unchanged `dev-architecture-create-observability`
- Author: fresh projectless `gpt-5.6-terra`, reasoning `medium`
- Reviewers: two separate fresh projectless `gpt-5.6-sol`, reasoning `high`

## Result

The unchanged authoring task passed every factual, deterministic geometry, and
blinded visual gate. The final board contains all six required components,
three visually distinct planes, all five correctly directed relationships, and
no blocking geometry findings. Both independent reviewers returned an overall
pass.

The prior post-commit text repair did not recur. The author gave its plane
headings sufficient space in the initial candidate, and the final inspection
reported zero findings, warnings, failures, crossings, or congested ports.
This establishes compatibility and no quality regression, but it does not
causally validate the new text-fit bounds: no truncation finding was emitted,
so the author never consumed those fields.

Total author wall time was 227,675 ms, 23,171 ms (11.3%) slower than EXP-0021.
The product call count stayed at eight and there was no post-commit mutation.
Therefore this run is not evidence of a speed improvement.

## What the trace revealed

The dominant new avoidable work occurred during visual inspection. The tool
returned a correct `pixelCaptureProtocol`, but the author's generic result
display collapsed that nested object. The author then guessed a clipped
capture request, received an unusable image, repeated the inspection, and
captured again. The board itself was already correct.

This is the same class of transport problem previously fixed for the
architecture quickstart: semantically complete nested data is not useful when
an ordinary agent result renderer presents it as an opaque object. It can be
fixed without choosing layout or performing correction on the agent's behalf.

## Decision

Keep the actionable text-fit intervention. It is truthful, bounded, and did
not regress quality, but do not claim a causal or population-level speed gain
from this replicate.

The next intervention is to add a bounded top-level lossless JSON field for the
exact clean pixel-capture request returned by `inspect_canvas_scope`. The agent
will still decide whether to inspect and how to respond; Jazzboard will only
ensure that generic tool-result rendering cannot erase the instructions needed
to obtain valid perceptual evidence. Then repeat the identical benchmark.

The complete sanitized record is
`research/data/exp-0022-actionable-text-fit-replication-v1.json`. Room
credentials, raw sessions, semantic state, and pixels remain private and
gitignored.
