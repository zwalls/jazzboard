# Research scripts

Scripts in this directory must be deterministic, non-interactive, and safe to
run from a clean checkout. Each executable should document its inputs, outputs,
seed handling, and artifact schema.

Keep authoring and evaluation processes separate. Author runners may expose
only public browser WebMCP capabilities. Evaluator scripts may record traces,
screenshots, semantic state, and timing, but must never send hints or mutations
to the authoring session.

Prefer machine-readable JSON or JSONL outputs with schema versions. Emit hashes
for prompts, traces, room-state snapshots, media, and scorer configuration.

## Blinded evaluator runner

`blinded-evaluator-runner.mjs` performs one independent, treatment-blinded
review per process invocation. It never opens a browser or repository tool for
the reviewer model. The only model-visible evidence is the task's committed
evaluator rubric, a privacy-projected spectator final-state snapshot, and the
single exact-revision spectator PNG. The Responses API request uses
`store: false`, an empty tool list, and a strict JSON Schema response format.

Before the API request, the runner fails closed unless all of the following
verify:

- the raw `attempt-bundle.json` bytes match an external SHA-256 commitment;
- the artifact index names the exact directory inventory, with no missing,
  extra, unsafe, or symbolic-link entries, and every byte count/hash/root
  reproduces;
- the author evidence seal covers the exact retained author evidence and
  matches both the bundle and an external commitment;
- the sealed author brief exactly reproduces the public packet for the named
  frozen development task, whose public criteria exactly match the task rubric;
- the frozen task rubric matches its external commitment; and
- spectator state, inspection receipt, PNG digest, and filename all name the
  same final room revision.

Run it with a JSON config (never put an API key in this file):

```sh
OPENAI_API_KEY=... node research/scripts/blinded-evaluator-runner.mjs \
  --config /absolute/path/to/evaluator-config.json
```

The config is strict and accepts exactly these fields:

```json
{
  "attemptDirectory": "/absolute/path/to/research/results/runs/attempt-id",
  "expectedAttemptBundleSha256": "64 lowercase hex characters",
  "expectedArtifactRoot": "64 lowercase hex characters",
  "expectedAuthorEvidenceRoot": "64 lowercase hex characters",
  "taskId": "dev-architecture-create-checkout",
  "expectedRubricSha256": "sha256: followed by 64 lowercase hex characters",
  "reviewerId": "opaque-reviewer-01",
  "reviewerRole": "primary",
  "model": "frozen-model-snapshot",
  "reasoningEffort": "low",
  "inputTokenBudget": 100000,
  "outputTokenBudget": 12000,
  "pricing": {
    "currency": "USD",
    "inputUsdPerMillionTokens": 0,
    "cachedInputUsdPerMillionTokens": 0,
    "outputUsdPerMillionTokens": 0,
    "source": "frozen-protocol-price-table-v1"
  }
}
```

`outputDirectory` is the only optional path override, and it must remain outside
the sealed attempt directory. The API hosts are fixed to the official OpenAI
Responses endpoints so credentials cannot be redirected. Assignment labels,
pair/order metadata, extra reviewers, API keys, and scorer hints are not
accepted. Input tokens are counted before scoring;
the one scorer request is capped to the remaining (here, total) output budget,
and reported provider usage is checked again afterward. Provider failures,
invalid structured output, budget exhaustion, and evidence-integrity failures
produce an immutable failed/non-accepted record when the config is valid.

By default, review records are written outside the sealed attempt directory at
`research/results/runs/_reviews/<opaque-artifact>/<role>-<reviewer>.json`.
Existing records are never overwritten. The record includes prompt, safe
configuration, evaluator-input, provider-output, evidence, and record hashes;
usage and frozen price inputs; lock time; criterion decisions; separate
semantic, visual, correction, presentation, and efficiency observations; and
the frozen primary failure class. It always records
`treatmentLabelKnownAtLock: false` and
`pairedArtifactSeenBeforeLock: false`.

The caller must obtain the bundle/artifact/author-seal commitments from the
trusted all-attempt registry, not from the attempt directory itself. The caller
also remains responsible for assigning distinct opaque identities to the two
primary invocations and any later adjudicator. This CLI deliberately cannot
inspect previous reviews to enforce cross-invocation identity uniqueness,
because doing so would expose another reviewer's result before lock. Since
author traces are excluded from the reviewer view, correction, temporal, and
efficiency observations that cannot be established from state and pixels must
be recorded as `not_observable`; a future frozen evaluator-view compiler may
add separately committed, non-identifying facts if the protocol authorizes
them.
