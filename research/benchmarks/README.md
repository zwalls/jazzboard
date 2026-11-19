# Benchmarks

Version benchmark metadata and schemas here. Keep three distinct splits:

- `development` for normal iteration and failure analysis;
- `validation` for choosing among already-defined candidates;
- `sealed-test` for milestone claims only.

The sealed prompts, source repositories, answer keys, and judge rubrics must be
stored where implementation and authoring agents cannot read them. Checked-in
metadata may include task IDs, strata, hashes, licenses, and aggregate counts,
but never enough information to reconstruct hidden answers.

Architecture tasks should cover creation, diagnosis, and editing at multiple
complexities. Drawing tasks should cover icons, characters, scenes, expressive
art, and constrained compositions. Collaboration and latency stressors belong
in both domains.

To compare marquee selection against an earlier revision of the selection
engine, run this from the candidate checkout with its locked dependencies:

```sh
node research/benchmarks/marquee-latency.mjs <baseline-sha> /tmp/marquee-times.json
```

The pinned baseline and candidate selection modules run in one Node process
against the same synthetic scenes and gesture inputs. Use a baseline whose
selection module has compatible dependencies. Each gesture includes setup,
18 pointer updates, and finish. Scene construction is outside the timer.
The harness compares complete snapshots and emits raw samples, median, and p95.
