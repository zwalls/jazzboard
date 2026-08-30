# EXP-0001A development execution manifest v1

`development-execution-manifest-v1.json` commits the public 12-task development
bundle to the A/A calibration schedule before any author brief is delivered.

- Fixed seed: `20260830`
- Algorithm: `xorshift32-fisher-yates-weave-v1`
- Design: 12 tasks × 2 replicate blocks × 2 opaque labels
- Total: 24 paired blocks and 48 fresh agent sessions
- Labels: `A0` and `A1`; neither discloses a treatment meaning
- Treatment: both labels carry the same canonical frozen-baseline treatment
  digest

Within each family-and-replicate block, three pairs run `A0` first and three run
`A1` first. The complete schedule is globally balanced 12/12 and alternates
architecture and drawing tasks. Each attempt requires a fresh author context
and fresh private room, but the manifest intentionally contains no room,
session, authorization, or other credential.

Every full public task, pair assignment, and the manifest itself has a
canonical SHA-256 commitment. Verification regenerates the schedule from the
checked-in development bundle and rejects count, coverage, order, label,
treatment, hash, sensitive-data, or partition drift. This development manifest
contains no sealed prompt, answer, rubric, identifier, or task selection.

The seed fixes assignment and order; it does not claim to seed or reproduce the
model's stochastic trajectory. Runner, scorer, model, environment, and budget
commitments remain the responsibility of the later immutable execution-freeze
receipt.
