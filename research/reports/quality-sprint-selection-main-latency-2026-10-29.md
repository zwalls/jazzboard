# Selection latency against upstream main — 2026-10-29

This patch ports only the semantic selection optimization from sprint commit
`2b6a7ca` onto verified upstream main `3ec7c77`. Its production changes are
confined to `src/lib/canvas/semantic-selection-session.ts`. The earlier
SemanticCanvas document-key change and the user's preexisting SVG changes are
not part of this selection patch.

The topmost-hit API previously computed every overlapping hit, expanded each
selection by scanning the entire scene, and sorted every result. The updated
code walks the scene's existing paint order backwards and stops at the first
actual hit when only the topmost result is requested. All-hit queries preserve
that order without a separate sort and share immutable group selection arrays
within one query. Sparse selection expansion sorts only selected members;
dense expansion retains the linear scene walk. No group cache survives a query.

## Fresh measurements

The same-process harness loads the baseline selection source from `3ec7c77`
and the updated implementation against identical, already-built scenes. It
checks complete result equality for every queried point before measuring.
Measurements use Node v22.22.0 on macOS arm64, 10 warmup calls, and 21 alternating
baseline/current samples. Synthetic fixtures cover sparse grids, overlaps,
groups of 20 rectangular nodes, and pointer misses.

| Workload | Main median (ms) | Updated median (ms) |
| --- | ---: | ---: |
| 1,000 sparse objects, topmost | 0.0418 | 0.0038 |
| 5,000 sparse objects, topmost | 0.1869 | 0.0145 |
| 5,000 sparse objects, all hits | 0.1619 | 0.0261 |
| 5,000 sparse grouped objects, topmost | 0.2054 | 0.0158 |
| 1,000 overlapping objects, topmost | 11.2930 | 0.0004 |
| 1,000 overlapping objects, all hits | 11.2627 | 0.5218 |
| 1,000 overlapping grouped objects, all hits | 15.8027 | 0.9318 |
| 5,000 objects, pointer misses board | 0.0689 | 0.0238 |

These are local geometry CPU timings. They exclude scene construction, DOM
rendering, network latency, and native WebMCP calls. The overlapping-topmost
case deliberately favors early exit; its sub-microsecond result is not a
general browser latency claim. Raw samples, p95 values, and equality results
are in
[`quality-sprint-selection-main-latency-2026-10-29.json`](../data/quality-sprint-selection-main-latency-2026-10-29.json).

Reproduce from the repository root with any locally available baseline ref:

```sh
node research/benchmarks/selection-latency.mjs --baseline-ref 3ec7c77 --output /tmp/jazzboard-selection-main-latency.json
```

Omit `--baseline-ref` to measure only the current implementation.

## Verification

- 110 tests passed across semantic-selection-session, semantic-scene, and
  SemanticCanvas suites on the integration checkout.
- Targeted ESLint and `git diff --check` passed.
- All eight benchmark workloads produced results deeply equal to main.
- Added regressions cover locked-image fallthrough, geometric misses, paint
  order versus distance, current group membership, frozen results, sparse and
  dense selection ordering, and invalid empty-scene queries. Existing tests
  retain equal-z semantic-ID tie coverage.

The parent sprint coordinates full application and browser checks.
