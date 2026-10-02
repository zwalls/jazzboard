# Focused product-bug coverage ledger

Work starts from remote main `6276b7d`. Tests use isolated local stores and synthetic participants. Canonical active files and the separate plugin checkout are preserved. This is product QA, not a general security audit.

| Area | Evidence/status | Remaining distinct paths |
| --- | --- | --- |
| Collaborative history | Fixed `1e95ea5`; browser conflict, atomic rollback, reuse identity, repeated recreate, cancel/reload, save retry | Complete for this pass |
| Diagram history race | Fixed `1e95ea5`; deterministic lease-acquisition race | Complete for this pass |
| Entry without browser storage | Fixed `57fd38a`; getter denial, create, signed membership, reload, agent discovery, invalid-code recovery, exact-code join | Complete for this pass |
| Navigation/session/spectator | First two batches: entry, unauthenticated room, role upgrade, sharing/export, discovery, Follow/Spotlight and shared-edit browsers passed | No repeated baseline scan planned |
| Image authoring | Pass 3 source review and actual Chrome: failed upload preserves reviewed candidate; review cancellation and cancellation of a completed-but-delayed upload create no object; a new upload stores exactly one image and survives reload | Covered; two scenarios passed, no new defect reproduced |
| Clipboard/group actions | Pass 3 actual Chrome: duplicate creates fresh IDs; group duplicate gets fresh shared identity; singleton duplicate dissolves group; disjoint failed saves stay independent; older saves cannot steal newer gestures | Covered; five scenarios passed, no new defect reproduced |
| Ambiguous committed saves | Pass 3 fixed: confirmed create followed by another authorized tab's delete left a protected ghost indefinitely. Failed before-fix browser/unit evidence; create/update/replay browsers pass after fix. Pre-commit missing snapshots still wait safely | Covered; no commit replay or resurrection introduced |
| Lease reacquisition | Pass 3 fixed: a saved object's same-actor lease reused its token but reported the old revision; the client rejected the live lease and board action. Deterministic engine and actual Chrome regressions failed before fix and passed after | Covered; exact token/owner retained and revision verified before refresh |
| Lease renewal fallback | Receipt-confirmed update followed by deletion recovered through normal renewal even before the fix. Initial creation has no lease and lacked that fallback | Negative result recorded; no claim of an indefinite update stall in the browser |
| Research contracts | Existing failure reproduced on unchanged `6276b7d`; excluded from product fix scope | Full check remains non-green; no gate changes |

Do not repeat successful suites without a new change or unresolved concern. Record actual findings and negative results here before closing each focused pass.

Pass 3 explored a bounded set of remaining collaboration/persistence/board-action error paths. Eleven actual Chrome scenarios across the rows above passed. No further critical defect was reproduced in those covered paths. The first broad product run, concurrent with compilation, hit one existing 5-second semantic-read test timeout; the final run at four workers after compilation passed **1,645 tests, with 12 skipped**. The timeout limit and test logic are unchanged. Production build, TypeScript and changed-file lint passed.

This closes the selected receipt/lease, image cancellation/retry, and duplicate/group failure-path coverage. Continuing the same scenarios would be redundant; any subsequent pass should select a distinct uncovered subsystem or new reproducible symptom.
