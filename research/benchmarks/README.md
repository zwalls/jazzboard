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
