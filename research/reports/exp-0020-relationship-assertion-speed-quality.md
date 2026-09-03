# EXP-0020 relationship-assertion speed-quality replication

- Date: 2026-09-03
- Status: complete; factual and visual gates passed, strong single-run speed recovery
- Product candidate: `25a01293f920341169b4517f843ad53e2dafe113`
- Benchmark: unchanged `dev-architecture-create-observability`
- Author: fresh projectless `gpt-5.6-terra`, reasoning `medium`
- Reviewers: two separate fresh projectless `gpt-5.6-sol`, reasoning `high`

## Result

This is the first observability replication in this sequence to pass both the
exact authoritative fact audit and both independent visual reviews. All six
required components, three planes, and five directed labeled relationships are
present in one coherent first-class Diagram. The relationship that EXP-0019
reversed is stored correctly as `Alert Engine → Telemetry Store`.

The accepted initial draft carried five caller-authored
`relationshipAssertions`. Jazzboard compared them with the compiled connector
endpoints, directions, and labels before any authoritative mutation and
returned `relationshipAssertionReview.status=pass`. Jazzboard inferred no task
facts, selected no route, and repaired no endpoint.

Author wall time was 201,038 ms: 150,560 ms (42.8%) faster than EXP-0019 and
18,654 ms (10.2%) slower than the fastest prior passing run, EXP-0013. The
author committed once, inspected once, and made no post-commit edits. Both
blinded reviewers independently returned an overall pass with zero blocking
geometry violations.

This is strong development evidence, not a population-level 42.8% claim. One
unchanged replication cannot establish a general effect or latency
non-inferiority.

## What improved

- Exact authoritative matching passed 6/6 entities and 5/5 directed
  relationships with no blocking finding.
- Both independent reviewers passed facts, plane distinction, fixed-viewport
  readability, Diagram coherence, and unsupported-assertion checks.
- The valid draft proved all five caller-authored facts against its compiled
  connectors before publication.
- Total wall time fell from 351,598 ms to 201,038 ms.
- There were no post-commit corrections and only one final inspection.

## Remaining friction

The author still made two schema-invalid transaction attempts. The quickstart
tool contained the correct canonical skeleton, but the generic browser result
printer collapsed nested entries to `[Object]`. The author guessed `type`
instead of `op`, guessed the relationship-assertion field names, then guessed
an unsupported connector endpoint shape. It needed two deeper architecture
reads before serializing the canonical example losslessly.

This is a harness problem we can fix without narrowing author freedom: the
fast-path response should expose the same canonical transaction as a
copy-ready JSON string in addition to its structured object. That changes no
canvas schema, layout behavior, routing, authorization, or mutation semantics;
it only prevents generic object rendering from hiding the exact contract.

## Next intervention

Add a bounded `canonicalDraftJson` string to the architecture quickstart, with
the exact `op`, endpoint, Diagram-membership, and `relationshipAssertions`
spellings already present in the structured skeleton. Tell authors to adapt
that lossless template rather than reconstructing collapsed nested values.
Then run the unchanged observability task again. The target is to remove both
schema failures and the two recovery reads while preserving the factual and
visual passes.

The complete sanitized record is
`research/data/exp-0020-relationship-assertion-speed-quality-v1.json`. Room
credentials, raw sessions, semantic state, and pixels remain private and
gitignored.
