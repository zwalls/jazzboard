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

## Speed-with-quality trace analysis

`analyze-codex-author-speed.mjs` turns one retained `read_thread` JSON export
into a prompt-free timing summary. It separates host execution from residual
model-and-coordination wall time, counts browser-exposed WebMCP calls, and
classifies room entry, discovery, initial authoring, draft finish, inspection,
correction, and final reads. It does not estimate hidden reasoning time,
tokens, authoritative completion, or presentation completion.

```sh
node research/scripts/analyze-codex-author-speed.mjs \
  --input /absolute/path/to/read-thread.json
```

The EXP-0003 protocol defines how this diagnostic is combined with separate
room activity and live presentation evidence.

## Terra/medium role qualification v2

The prospective three-task compatibility qualification is operated through
`seal-exp0001a-model-role-qualification-v2.mjs`,
`sign-exp0001a-model-role-qualification-v2.mjs`, and
`run-exp0001a-model-role-qualification-v2.mjs`. Its exact gates, private file
boundary, one-action dispatch protocol, blinded-review requirements, and
commands are documented in
`research/protocols/exp0001a-terra-medium-qualification-v2-operator-runbook.md`.

The coordinator does not call Codex tools itself. The room controller provisions
and captures authoritative browser/WebMCP evidence; the task runner journals a
private exact action before invocation and exchanges exact Codex-app
`CallToolResult` values through a mode-`0600` file bridge; the review-sidecar
runner serves one digest-bound opaque loopback PNG read. The coordinator derives
receipts from those retained raw values rather than accepting operator-authored
task receipts. Do not use the historical v1 qualification or the active
48-attempt batch command to run this prerequisite.

## Frozen successor transport (execution blocked)

EXP-0001A model work is performed only by fresh projectless Codex tasks backed
by ChatGPT sign-in. Run the authentication preflight before preparing work and
again immediately before invoking task creation:

```sh
node research/scripts/codex-auth-preflight.mjs
```

The prospective deterministic successor runtime is built from
`src/lib/research/exp0001a-runtime-composition.ts`:

```sh
node research/scripts/build-exp0001a-runtime.mjs --check
```

Its dry-run validation remains available for historical evidence:

```sh
node research/scripts/exp0001a-batch-command.mjs \
  --config /absolute/path/to/codex-runtime-config.json
```

Every mutation mode (`--execute`, acknowledgement, ingest, resume, or sidecar
mutation) is hard-disabled at the CLI entry point with
`EXP0001A_LEGACY_MUTATION_PATH_DISABLED_REQUIRES_SIGNED_QUALIFICATION_V2_AND_SUCCESSOR_V3`.
Do not import the retained historical implementation as a release workaround.
The 48-attempt A/A experiment remains blocked until the v2 three-task
qualification produces a signed pass and a separately reviewed successor-v3
runner is frozen. Authors, reviewers, adjudicators, and pairwise judges in that
future runner will still require distinct fresh projectless task IDs.

No active EXP-0001A command reads an API key, contacts a provider endpoint, or
accepts a price/spend authorization. Do not add those fields to a v2 config.

## Retired blinded evaluator runner

`blinded-evaluator-runner.mjs` retains the provider-free evidence validation
and immutable-record code from the original transport. Its live scoring entry
point is now hard-blocked: reviewers will run as fresh, projectless Codex tasks
after the Codex/WebMCP spike passes. It never opens a browser or repository
tool for the reviewer model. The only future model-visible evidence is the
task's committed evaluator rubric, a privacy-projected spectator final-state
snapshot, and the single exact-revision spectator PNG.

Before any future reviewer task may be released, the retained evidence must
still fail closed unless all of the following verify:

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

Verify the host is using ChatGPT subscription authentication before any
Codex-native experiment work:

```sh
node research/scripts/codex-auth-preflight.mjs
```

This command invokes only `codex login status`, accepts only the exact ChatGPT
authentication result, retains no raw command output, and rejects API-key,
unknown, failed, contradictory, or oversized results. The current
`blinded-evaluator-runner.mjs` live entry point always returns
`CODEX_NATIVE_TRANSPORT_REQUIRED`; it cannot release a direct provider call.

## Disposable Codex/WebMCP spike sealer

`seal-codex-webmcp-spike.mjs` reconciles a private spike request with ten
exact-byte evidence artifacts, independently seals and verifies the result,
writes a secret-free public projection, and writes an A/A allow gate last only
for a verified pass. Private outputs must remain below `.research-private`.
The CLI emits only status and digests; it never prints a room code, room ID,
invite, authorized room URL, or private path.

Those version-1 outputs are retained historical evidence, not current release
authority. The active freeze accepts only the non-revoked version-2 recovery
schema and a fixed-key `spike_gate` signature produced by
`sign-exp0001a-codex-spike-recovery-gate.mjs` after its authoritative recovery
checks pass. A version-1 gate, unsigned recovery draft, or self-hash cannot open
the batch command.

The retained legacy script is evidence-validation code only. Its live model
entry point is hard-blocked with `CODEX_NATIVE_TRANSPORT_REQUIRED`; it is not a
supported EXP-0001A config surface. Do not construct new provider-shaped
configs for it. The Codex-native evaluator envelope instead contains only the
public requirement, frozen rubric, sanitized semantic state, and
revision-matched PNG evidence.

By default, review records are written outside the sealed attempt directory at
`research/results/runs/_reviews/<opaque-artifact>/<role>-<reviewer>.json`.
Existing records are never overwritten. The historical record includes prompt,
safe configuration, evaluator input/output, evidence and record hashes, lock
time, criterion decisions, separate
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
