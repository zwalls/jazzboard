# EXP-0013 large-architecture scaling measurement

- Date: 2026-09-02
- Status: complete; frozen large-task quality gate passed
- Product candidate: `3f9a66c82d5b9aaa8eaf7b1966a9be02b543307a`
- Benchmark: `dev-architecture-create-observability`
- Author: fresh projectless `gpt-5.6-terra`, reasoning `medium`
- Reviewer: separate fresh projectless `gpt-5.6-sol`, reasoning `high`

## Result

The independent reviewer passed every frozen semantic and visual criterion with
zero blocking geometry violations. The final 18-object Diagram contains all six
required components, all five directed relationships, three visibly distinct
planes, coherent membership, and no unsupported provider, protocol, ownership,
hidden, or duplicate claims.

The author completed in 182,384 ms with ten WebMCP calls. This task has twice as
many semantic objects as the simple checkout benchmark, but took only 32,692 ms
(21.8%) longer than the 149,692 ms EXP-0011/0012 mean. The author constructed
the complete composition in one transaction. Transaction length did not emerge
as the scaling bottleneck in this run.

## Where the additional time went

- Total wall time: 182,384 ms
- Host execution: 37,939 ms (20.8%)
- Model and coordination: 144,061 ms
- Capability discovery: 40,274 ms
- Initial one-transaction authoring: 43,435 ms
- Draft finish: 12,508 ms
- Inspection and reframe: 38,442 ms
- Authoritative reads: 27,751 ms
- Two pixel-evidenced text corrections: 17,162 ms

The larger artifact was actually faster to construct than the small checkout
pair. Its extra time came after publication: visual inspection, one blank-crop
recovery, authoritative reads, and two direct corrections to clipped text.
Exact model reasoning time, tokens, and subscription usage remain unobservable.

## High-value signal divergence

Jazzboard's intent-unaware geometry detector reported 25 failures on the draft
and 25 findings on the final Diagram. The blinded reviewer found zero blocking
geometry violations. The discrepancy is explainable: production, telemetry
platform, and responder are explicit semantic plane containers. Their member
nodes and relationship paths are supposed to lie inside or cross those
background regions, but the detector currently reports that valid containment
as member overlap, connector intrusion, and connector-label collision.

The author handled this correctly. It preserved the requested plane structure,
then used pixels—not the noisy container findings—to identify and fix two real
clipped text labels. A less capable agent could waste correction loops or
destroy the intended composition trying to satisfy the false positives.

## Decision

Do not optimize transaction size from this evidence. Make deterministic
geometry evidence aware of explicitly semantic container backgrounds. Suppress
only containment-derived overlap and intrusion findings while preserving title
occlusion, sibling-object collisions, ambiguous endpoints, route crossings,
label clipping, and all other genuine findings. Then rerun the unchanged large
task to measure whether cleaner context reduces correction risk and time.

The full sanitized record is
`research/data/exp-0013-large-architecture-scaling-v1.json`. Private room
credentials, raw sessions, semantic packets, and pixels remain outside Git.
