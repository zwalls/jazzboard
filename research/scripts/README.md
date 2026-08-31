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

## Active Codex-native transport

EXP-0001A model work is performed only by fresh projectless Codex tasks backed
by ChatGPT sign-in. Run the authentication preflight before preparing work and
again immediately before invoking task creation:

```sh
node research/scripts/codex-auth-preflight.mjs
```

The active deterministic runtime is built from
`src/lib/research/exp0001a-runtime-composition.ts`:

```sh
node research/scripts/build-exp0001a-runtime.mjs --check
```

The transport emits exact, receipt-bound commands for task creation, waiting,
terminal reads, and uncertain-create reconciliation. The outer Codex
coordinator invokes the corresponding Codex app tools and feeds their retained
results back into the state machine. Authors, primary reviewers, adjudicators,
and pairwise judges always receive distinct fresh task IDs and neutral
projectless workspaces.

The production-shaped coordinator command is deliberately a one-action state
machine. Dry-run is the default:

```sh
node research/scripts/exp0001a-batch-command.mjs \
  --config /absolute/path/to/codex-runtime-config.json
```

After the frozen runtime, fixed authority, fresh ChatGPT authentication,
append-only coordinator state, and signed checkpoint all verify, `--execute`
retains an outbox receipt and returns exactly one action:

```sh
node research/scripts/exp0001a-batch-command.mjs --execute \
  --config /absolute/path/to/codex-runtime-config.json
```

The command performs only deterministic local transitions and the local
artifact-packet sidecar itself. For a returned Codex-app or Jazzboard WebMCP
action, it reports `externalToolInvokedByCli: false`; an outer coordinator must
first acknowledge receipt of that prepared handoff:

```sh
node research/scripts/exp0001a-batch-command.mjs \
  --ack-dispatch sha256:<action-digest> \
  --config /absolute/path/to/codex-runtime-config.json
```

Only after the durable acknowledgement may the retained action be invoked
exactly once. Its unmodified result is then advanced through the committed
ingest binding with the same action identity:

```sh
node research/scripts/exp0001a-batch-command.mjs \
  --ingest-result /absolute/path/to/raw-tool-result.json \
  --dispatch-action sha256:<action-digest> \
  --config /absolute/path/to/codex-runtime-config.json
```

Ingest requires the matching durable outbox receipt, appends the full result to
the private authority journal, and atomically advances provisioning,
coordinator, scheduler, and accounting state. Before acknowledgement an
unchanged signed checkpoint may safely redeliver the non-invocable handoff.
After acknowledgement it never re-emits a mutating action and returns an exact
reconciliation instruction if the raw result was lost. After every local
transition or ingest, a new signed checkpoint is required before the next
action.

Usage-limit recovery follows the same boundary. While paused, the only legal
action is a neutral projectless subscription-availability probe with no
experiment brief. Its full result is retained separately, fixed-key signed,
and counted as `subscription_probe`; only a valid signed observation resumes
the next genuinely unstarted work item. Reviewer evidence is served one task at
a time by the GET/HEAD-only loopback packet sidecar, whose start, probe, and stop
receipts are part of the coordinator chain.

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
