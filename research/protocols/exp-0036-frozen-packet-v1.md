# EXP-0036 frozen packet supplement v1

Status: prepared, not authorized for author or reviewer release.

This supplement freezes the runnable packet for the study described in
`exp-0036-speed-quality.md`. The baseline is commit
`f7762da4ea7d1603671a35b4912143c4bff83f34`; the candidate is commit
`5a67b21505b50c643bf282774f0e7bf4698edf05`. The public author packet is
`research/data/exp-0036-author-packets-v1.json`; controller answers, build
assignments, and neutral-label mappings exist only in
`research/data/exp-0036-grader-manifest-v1.json`.

Those two commits freeze the product source archives. Later repository HEADs
that add only research harnesses, type declarations, packet files, or reports
do not redefine either product arm; A1 remains exactly `5a67b21505b50c643bf282774f0e7bf4698edf05`.

The fixed attempt order is:

1. `attempt01`: existing-board inventory, baseline A0.
2. `attempt02`: existing-board inventory, candidate A1.
3. `attempt03`: existing-board metadata edit, candidate A1.
4. `attempt04`: existing-board metadata edit, baseline A0.
5. `attempt05`: checkout architecture creation, candidate A1.
6. `attempt06`: checkout architecture creation, baseline A0.
7. `attempt07`: layered portrait creation, baseline A0.
8. `attempt08`: layered portrait creation, candidate A1.

Every attempt requires a fresh projectless task, unique `*.localhost` origin,
fresh signed guest identity, empty pre-join recent-room result, exact frozen
build identity, and complete terminal native telemetry. Codex task creation
starts its first turn immediately, so infrastructure readiness precedes task
creation and task/session admission is validated after creation. Neither phase
is itself authorization to create an author task.

The inventory seeds are `20260904-exp0036-inventory-2` and
`20260904-exp0036-repair-2`. Inventory answers must state every present kind's
exact count. Supported absent kinds may be omitted or included with exact count
zero. Unknown kinds and nonzero absent kinds fail. Exact Diagram count, sorted
target names, and the unchanged authoritative document remain strict. Metadata
editing retains strict target lifecycle, revision, and protected-state checks.

The checkout and portrait tasks use their complete public records from
`development-v2.json` and their complete controller rubrics from
`development-evaluator-rubrics-v2.json`. Each creation pair receives two
independent blinded Sol/high reviews under
`exp-0036-blinded-pair-review-v1.md`. The two reviewers see reversed attempt
order with distinct neutral labels. Review packets exclude author transcripts,
arm identity, timing, room credentials, peer verdicts, and private mappings.
Reviewers must grade every hard criterion for each artifact and then record a
supported preference or tie in the frozen JSON format.

No author or reviewer task may be created from these files until the controller
has completed the release prerequisites and the user authorizes task creation.
