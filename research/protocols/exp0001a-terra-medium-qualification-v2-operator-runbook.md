# EXP-0001A Terra/medium qualification v2 operator runbook

Status: sealed implementation; **do not release a task until every preflight in
this runbook is green**.

This is the only supported production path for the prospective Terra/medium
compatibility qualification. It does not call a provider API, read
`OPENAI_API_KEY`, estimate tokens, or authorize dollar spend. Every model
invocation is a fresh projectless Codex task backed by ChatGPT sign-in.

## Frozen authority and product binding

- plan: `research/data/exp0001a-model-role-qualification-plan-v2.json`
- plan signature:
  `research/data/exp0001a-model-role-qualification-plan-signature-v2.json`
- current launch binding:
  `research/data/exp0001a-model-role-qualification-launch-binding-v3.json`
- launch-binding signature:
  `research/data/exp0001a-model-role-qualification-launch-binding-signature-v3.json`
- immutable predecessor launch binding:
  `research/data/exp0001a-model-role-qualification-launch-binding-v2.json`
- predecessor launch-binding signature:
  `research/data/exp0001a-model-role-qualification-launch-binding-signature-v2.json`
- benchmark: `research/benchmarks/development-v2.json`
- rubrics: `research/benchmarks/development-evaluator-rubrics-v2.json`
- fixtures: `research/benchmarks/development-fixture-specs-v2.json`
- baseline: `research/data/baseline-freeze-v3.json`
- baseline signature:
  `research/data/baseline-freeze-v3-authority-signature.json`
- product commit: `4eb6d9862cd1e805906a338d524529b6b7019639`
- product tree: `100447743f672f103d9cbe7c8c3d6d48e2bca4eb`
- deployment: `dpl_CePet5gs1u52rMvQUGye92qByJAQ`
- build: `bld_nuf9lecj0`
- production alias: `https://www.jazzboard.xyz`

The historical plan names the pre-hotfix successor. Its bytes must not change.
The signed v3 launch binding supersedes only the production identity, retains
`predecessorPlanBytesMutated: false`, and cryptographically names the exact
signed v2 launch binding. Initialization and terminal signing independently
replay plan → v2 binding → v3 binding; never delete or rewrite either v2 file.

## Private boundary and prerequisites

All requests, coordinator state, room receipts, browser storage, prompts, raw
Codex-app results, author evidence, reviewer envelopes, and the unredacted
result must be strict descendants of:

```text
.research-private/exp0001a-qualification-v3/
```

Directories are mode `0700`; JSON and evidence files are singly linked,
non-symlinked mode `0600` files. Requests use absolute normalized paths. Never
print, paste into a public log, or commit an invite, room ID/code, prompt,
participant/session identity, raw task result, or evidence URL.

Provision and capture are allowed only from one clean committed checkout. The
room-controller wrapper hashes its built bundle, wrapper source, package lock,
git commit, and git tree, and refuses a dirty or untracked worktree. The
coordinator locks the first retained harness provenance and requires exact
equality thereafter.

Before releasing author 1, verify that the experiment authority private key is
the canonical singly linked, non-symlinked mode-`0600` regular file at
`.research-private/exp0001a-authority-private.pem`. The signer independently
matches it to the checked-in authority public key and fails closed on any path,
mode, link-count, or key mismatch. Never print or copy its bytes into a request,
log, result, or tracked file.

Before launch, run the complete qualification tests, typecheck, and lint shown
under **Release gate**. Then initialize one private state. The mode-`0600`
initialization request has this shape (replace every `/ABS/...` path with the
actual retained path):

```json
{
  "operation": "initialize",
  "statePath": "/ABS/.research-private/exp0001a-qualification-v3/state.json",
  "at": "2026-08-31T20:00:00.000Z",
  "planPath": "/ABS/research/data/exp0001a-model-role-qualification-plan-v2.json",
  "planSignaturePath": "/ABS/research/data/exp0001a-model-role-qualification-plan-signature-v2.json",
  "productionBindingPath": "/ABS/research/data/exp0001a-model-role-qualification-launch-binding-v3.json",
  "productionBindingSignaturePath": "/ABS/research/data/exp0001a-model-role-qualification-launch-binding-signature-v3.json",
  "predecessorProductionBindingPath": "/ABS/research/data/exp0001a-model-role-qualification-launch-binding-v2.json",
  "predecessorProductionBindingSignaturePath": "/ABS/research/data/exp0001a-model-role-qualification-launch-binding-signature-v2.json",
  "baselineReceiptPath": "/ABS/research/data/baseline-freeze-v3.json",
  "baselineSignaturePath": "/ABS/research/data/baseline-freeze-v3-authority-signature.json",
  "baselineArtifacts": {
    "inventoryPath": "/ABS/research/data/baseline-webmcp-inventory-v3.json",
    "evidencePath": "/ABS/research/data/baseline-production-evidence-v3.json",
    "captureScriptPath": "/ABS/research/scripts/capture-baseline-v3.mjs",
    "privateInventoryPath": "/ABS/.research-private/BASELINE/baseline-webmcp-inventory-private-v2.json",
    "semanticArtifactPath": "/ABS/.research-private/BASELINE/baseline-semantic-artifact-redacted-v2.json",
    "semanticHandlerPath": "/ABS/.research-private/BASELINE/baseline-semantic-handler-redacted-v2.json",
    "authoritativeStatePath": "/ABS/.research-private/BASELINE/baseline-authoritative-state-redacted-v2.json",
    "captureHistoryPath": "/ABS/.research-private/BASELINE/exp0001a-baseline-v2-capture-history-run5.json",
    "exactRevisionPngPath": "/ABS/.research-private/BASELINE/baseline-exact-revision-v2.png",
    "progressiveDraftStagePath": "/ABS/.research-private/BASELINE/baseline-progressive-draft-stage-call-result-v3.json",
    "progressiveDraftFinishPath": "/ABS/.research-private/BASELINE/baseline-progressive-draft-finish-call-result-v3.json",
    "predecessorReceiptPath": "/ABS/research/data/baseline-freeze-v2.json",
    "predecessorAuthoritySignaturePath": "/ABS/research/data/baseline-freeze-v2-authority-signature.json",
    "transportSpikePath": "/ABS/research/data/exp0001a-browser-attached-transport-spike-public-v1.json",
    "authorityPublicKeyPath": "/ABS/research/data/exp0001a-execution-authority-public.pem"
  },
  "benchmarkPath": "/ABS/research/benchmarks/development-v2.json",
  "rubricsPath": "/ABS/research/benchmarks/development-evaluator-rubrics-v2.json",
  "fixtureSpecsPath": "/ABS/research/benchmarks/development-fixture-specs-v2.json"
}
```

Run every coordinator request with:

```sh
node research/scripts/run-exp0001a-model-role-qualification-v2.mjs \
  --request /ABS/.research-private/exp0001a-qualification-v3/REQUEST.json
```

Initialization runs the cryptographic baseline-v3 execution-ready verifier,
verifies the plan, predecessor-v2, current-v3, and baseline Ed25519 authority
chains and timestamp ordering, parses the exact
signed benchmark/rubric/fixture execution bundle, and binds the baseline
participant WebMCP contract. Failure is terminal; there is no operator override.

## Fixed author order

Run exactly these three tasks, once each, in order:

1. `dev-architecture-create-checkout`
2. `dev-architecture-edit-uncertainty`
3. `dev-drawing-create-wayfinding-icon`

Do not rerun, replace, reorder, fork, or share history. For each genuinely
unstarted task, complete the following sequence.

### 1. Provision a private room with the controller

Create the task's parent directory first with mode `0700`. The `provision`
output directory itself must remain absent so the controller can create it
exclusively. For example:

```sh
mkdir -m 700 /ABS/.research-private/exp0001a-qualification-v3/TASK
```

Create a mode-`0600` room-controller request:

```json
{
  "operation": "provision_room",
  "taskId": "dev-architecture-create-checkout",
  "outputDirectory": "/ABS/.research-private/exp0001a-qualification-v3/TASK/provision",
  "at": "2026-08-31T20:01:00.000Z"
}
```

The output directory must not exist. Run exactly once:

```sh
node research/scripts/run-exp0001a-model-role-qualification-v2-room-controller.mjs \
  --request /ABS/.research-private/exp0001a-qualification-v3/TASK/provision-request.json
```

The controller creates a fresh production room, verifies the exact landing and
participant tool contracts, applies the frozen fixture when required, verifies
blank/fixture authoritative state, and retains these private files:

```text
room-receipt.json
provision-controller-receipt.json
authorized-storage-state.json
create-room-call-result.json
blank-read-room-state-call-result.json
fixture-transaction-call-result.json       # uncertainty task only
pre-author-read-room-state-call-result.json
```

It brackets mutations with the bound deployment identity. The room receipt
keeps the room ID and invite code private. Only its exact
`https://www.jazzboard.xyz/#join=XXXXXX` invite is later released to the author.
Manual room creation, a manually sealed room receipt, a copied storage state,
or substitute WebMCP outputs are forbidden.

Retain the controller output with coordinator operation `retain_room`:

```json
{
  "operation": "retain_room",
  "statePath": "/ABS/.research-private/exp0001a-qualification-v3/state.json",
  "at": "2026-08-31T20:02:00.000Z",
  "receiptPath": "/ABS/.../TASK/provision/room-receipt.json",
  "provisionControllerReceiptPath": "/ABS/.../TASK/provision/provision-controller-receipt.json",
  "createRoomCallResultPath": "/ABS/.../TASK/provision/create-room-call-result.json",
  "blankReadRoomStateCallResultPath": "/ABS/.../TASK/provision/blank-read-room-state-call-result.json",
  "preAuthorReadRoomStateCallResultPath": "/ABS/.../TASK/provision/pre-author-read-room-state-call-result.json",
  "authorizedStorageStatePath": "/ABS/.../TASK/provision/authorized-storage-state.json"
}
```

Omit `fixtureTransactionCallResultPath` only for the two blank tasks.
`retain_room` verifies every raw call digest, storage digest, fixture digest,
deployment observation, tool contract, room/revision/count, and controller
provenance before it advances.

### 2. Prepare and execute the author action

Run this `prepare_author` request with the three exact public inputs used at
initialization:

```json
{
  "operation": "prepare_author",
  "statePath": "/ABS/.research-private/exp0001a-qualification-v3/state.json",
  "at": "2026-08-31T20:02:30.000Z",
  "benchmarkPath": "/ABS/research/benchmarks/development-v2.json",
  "rubricsPath": "/ABS/research/benchmarks/development-evaluator-rubrics-v2.json",
  "fixtureSpecsPath": "/ABS/research/benchmarks/development-fixture-specs-v2.json"
}
```

The production CLI runs
the committed `runCodexAuthPreflight()` at this boundary; no auth-receipt input
exists. Anything other than current ChatGPT sign-in fails closed.
The request `at` records submission time only. After the preflight returns, the
CLI records its own clock as the authoritative action `preparedAt`; an operator
cannot guess or backdate the post-authentication timestamp.

The resulting pending action is exactly one fresh `gpt-5.6-terra` / `medium`
projectless task with a unique title. It contains only the public task packet,
the private `#join` invite, and browser/WebMCP instructions. It contains no
room ID and no standalone room code outside the private invite, repository,
prepared coordinates, evaluator context, source task, or fork.

Execute it through the retained file-bridge protocol, not by manually creating
a Codex task:

1. In a dedicated process, run a mode-`0600` task-runner request:

   ```json
   {
     "operation": "run_pending_action",
     "statePath": "/ABS/.research-private/exp0001a-qualification-v3/state.json",
     "bridgeRoot": "/ABS/.research-private/exp0001a-qualification-v3/TASK/author-bridge"
   }
   ```

   ```sh
   node research/scripts/run-exp0001a-model-role-qualification-v2-task-runner.mjs \
     --request /ABS/.research-private/exp0001a-qualification-v3/TASK/run-author.json
   ```

   The runner first retains the immutable release journal and CAS-updates state,
   then waits for exact Codex-app results. Before that journal/state transition,
   the production CLI securely creates the fresh bridge path component by
   component, verifies that every component is a non-symlink mode-`0700`
   directory beneath the private root, and uses its resolved path. This is the
   dispatch acknowledgement; there is no separate `ack_dispatch` operation.

2. Poll the bridge with a `status` request. Public status includes only
   sequence, tool name, request digest, arguments digest, and time. It never
   includes the prompt or invite.
3. For each `awaiting_raw_result`, export the exact request to a new private
   mode-`0600` path with `export_exact_request`. In the trusted desktop
   orchestration context, read that file and call its exact Codex-app tool and
   arguments once. For `create_thread`, export first runs a fresh committed
   ChatGPT-auth preflight and retains a five-minute invocation authorization
   bound to the exact request, action, and release journal. Invoke the tool and
   ingest its result within that authorization window. The expected sequence
   is create, title reconciliation via list, one or more waits, and one or more
   terminal reads.
4. Return the exact `CallToolResult` through stdin. For example, the request
   that ingests a create result is:

   ```json
   {
     "operation": "record_raw_create_thread_result",
     "bridgeRoot": "/ABS/.research-private/exp0001a-qualification-v3/TASK/author-bridge",
     "sequence": 1,
     "rawResultSource": "stdin"
   }
   ```

   Keep the CLI stdin open, invoke the exact app tool, write exactly one JSON
   `CallToolResult`, then close stdin. Never print that result or prompt to a
   terminal. The operations for later results are
   `record_raw_list_threads_result`, `record_raw_wait_threads_result`, and
   `record_raw_read_thread_result`. Malformed, multiple, oversized, wrong-tool,
   wrong-sequence, or replayed results fail closed.
   `record_raw_create_thread_result` performs a second fresh ChatGPT-auth
   preflight, binds its exact private receipt to the result, and uses an
   internally observed record time. The request schema rejects an operator-
   supplied timestamp. An expired authorization or a switch to API-key auth
   leaves the raw result unaccepted; never invoke `create_thread` again.
5. Repeat until the runner seals `external-task-receipt.json` under
   `.research-private/exp0001a-qualification-v3/external-actions/<actionId>/`
   and atomically ingests it into coordinator state.

Node cannot directly invoke Codex-app MCP. The exact raw-result bridge is the
intentional production boundary: the trusted desktop host invokes the app tool;
the coordinator derives all receipts from retained raw results. Callers never
self-author a task receipt.

After any runner crash, do **not** run `run_pending_action` again. Run
`recover_pending_action` with the same state and bridge paths. Recovery has one
narrow create exception: when the exact action-bound dispatch lock exists but
there is no release journal, no dispatch-state transition, and no create
observation, retained evidence proves the assignment is genuinely unstarted.
After a fresh auth preflight, recovery materializes that original journal and
may invoke the exact `create_thread` request once. If a journal, dispatch
transition, or create observation exists, recovery never invokes create; it
reconciles by the unique title through `list_threads`, fails on zero after
bounded observation or more than one match, and resumes wait/read.

Recovery locks are action-bound. A live owner blocks concurrent recovery; an
abandoned recovery lock is archived only after its recorded process is proven
dead. A prior dispatch lock is retired only when coordinator state plus the
exact retained external receipt prove that prior action terminal. Locks are
never deleted merely because they are old.

The runner retains all `wait-NNN.json` and `read-NNN.json` observations with
exact action digest, task/host IDs, arguments, raw result, and ordinal. Reads
request `includeOutputs: true`; any truncation fails. It verifies the exact
delegated prompt, projectless isolation, one exact browser-skill bootstrap,
allowed node-repl/browser calls, no repository/private API access, and the
terminal result. A usage-limit refusal before task creation pauses the
qualification and preserves the genuinely unstarted assignment; no task or
reviewer ordinal is consumed.

For an author `usage_limit_interrupted` receipt with `taskCreated:false` and
null task/host IDs, retain the interruption, then run
`resume_after_usage_limit`. That operation itself requires a new trusted auth
preflight. Run `prepare_author` again: it prepares the same fixed task and
author ordinal with a new action digest. A usage-limit interruption after task
creation is consumed and non-resumable; do not replace it.

### 3. Reserve and capture authoritative author evidence once

Only after an author task has a completed/evaluable receipt, run
`prepare_capture`:

```json
{
  "operation": "prepare_capture",
  "statePath": "/ABS/.research-private/exp0001a-qualification-v3/state.json",
  "at": "2026-08-31T20:10:00.000Z",
  "roomReceiptPath": "/ABS/.../TASK/provision/room-receipt.json",
  "provisionControllerReceiptPath": "/ABS/.../TASK/provision/provision-controller-receipt.json",
  "storageStatePath": "/ABS/.../TASK/provision/authorized-storage-state.json",
  "outputDirectory": "/ABS/.research-private/exp0001a-qualification-v3/TASK/capture"
}
```

This mints a one-shot authorization but does not launch capture. Next run
`ack_capture_dispatch` with a never-before-created
`controllerRequestOutputPath`. The coordinator first persists the exact
invocation-ordinal-1 release journal, then atomically writes the complete
controller request containing that authorization and journal:

```json
{
  "operation": "ack_capture_dispatch",
  "statePath": "/ABS/.research-private/exp0001a-qualification-v3/state.json",
  "at": "2026-08-31T20:10:01.000Z",
  "controllerRequestOutputPath": "/ABS/.research-private/exp0001a-qualification-v3/TASK/capture-controller-request.json"
}
```

Invoke the room controller exactly once with that generated request. The
controller validates rather than mints the release journal, opens the exact
authorized room, independently calls `read_room_state`,
`inspect_canvas_scope`, and local `export_canvas_png`, and retains:

```sh
node research/scripts/run-exp0001a-model-role-qualification-v2-room-controller.mjs \
  --request /ABS/.research-private/exp0001a-qualification-v3/TASK/capture-controller-request.json
```

```text
capture-release-journal.json
closing-read-room-state-call-result.json
closing-inspect-canvas-scope-call-result.json
closing-export-canvas-png-call-result.json
closing-exact-revision.png
capture-controller-receipt.json             # success only
capture-terminal-receipt.json               # success or failure
```

The first terminal transition is permanent. Run `retain_capture_terminal` with
`terminalReceiptPath`; include `captureControllerReceiptPath` only when outcome
is `succeeded`. A terminal failure is retained and cannot be replaced. If the
controller was or may have been invoked but no trustworthy terminal receipt is
available (including a crash after acknowledgement or a lost generated
request), run `record_capture_indeterminate`. That permanently stops the
qualification. Never delete a capture directory, mint a new output path, or
retry capture.

For a successful capture, run `derive_author_evidence` with:

- all author action-root `wait-NNN.json` paths in ascending ordinal order;
- all author action-root `read-NNN.json` paths in ascending ordinal order;
- the exact provision and capture controller receipts;
- provision `pre-author-read-room-state-call-result.json`;
- capture closing read, inspection, and PNG-export CallToolResults; and
- new private output paths for sanitized semantic JSON and exact-revision PNG.

The complete request is:

```json
{
  "operation": "derive_author_evidence",
  "statePath": "/ABS/.research-private/exp0001a-qualification-v3/state.json",
  "at": "2026-08-31T20:11:00.000Z",
  "waitThreadResultPaths": ["/ABS/.../external-actions/ACTION/wait-001.json"],
  "readThreadResultPaths": ["/ABS/.../external-actions/ACTION/read-001.json"],
  "provisionControllerReceiptPath": "/ABS/.../TASK/provision/provision-controller-receipt.json",
  "captureControllerReceiptPath": "/ABS/.../TASK/capture/capture-controller-receipt.json",
  "preAuthorReadRoomStateCallResultPath": "/ABS/.../TASK/provision/pre-author-read-room-state-call-result.json",
  "closingRoomReadCallResultPath": "/ABS/.../TASK/capture/closing-read-room-state-call-result.json",
  "inspectionCallResultPath": "/ABS/.../TASK/capture/closing-inspect-canvas-scope-call-result.json",
  "pngExportCallResultPath": "/ABS/.../TASK/capture/closing-export-canvas-png-call-result.json",
  "authorEvidenceOutputPath": "/ABS/.../TASK/author-evidence.json",
  "sanitizedSemanticStateOutputPath": "/ABS/.../TASK/sanitized-semantic-state.json",
  "exactRevisionPngOutputPath": "/ABS/.../TASK/exact-revision.png"
}
```

The derivation binds every wait/read observation to the dispatched action and
task/host IDs, recomputes the terminal chain, parses successful join and agent
session identity, and proves all post-fixture object/diagram mutations are
attributable to that agent with no extra participant contamination. Successful
mutation result markers must exactly cover the attributed changed IDs. Its
visual marker binds a successful post-mutation room read, scene-context-v2
inspection, exact production room URL, and screenshot in one completed browser
invocation. The independently captured canonical canvas projection and
exact-revision PNG must agree. Attribution and identity stay private; the
reviewer semantic projection strips them recursively.
`author-evidence.json` is an exclusive mode-`0600` copy of the independently
derived evidence, written before coordinator state advances. It is required by
terminal result attestation; a caller-authored or merely self-hashed evidence
summary is not accepted.

## Two blinded reviewers, then conditional adjudication

For each `ready_for_review` task, run exactly two fresh `gpt-5.6-sol` / `high`
primary reviewer actions. An adjudicator is prepared only when both completed
primary reviewers return opposite binary `artifactAccepted` decisions.

Each reviewer gets a fresh sidecar output directory. Start the sidecar in its
own process before preparing the review:

```json
{
  "operation": "serve_review_evidence",
  "statePath": "/ABS/.research-private/exp0001a-qualification-v3/state.json",
  "sanitizedSemanticStatePath": "/ABS/.../TASK/sanitized-semantic-state.json",
  "exactRevisionPngPath": "/ABS/.../TASK/exact-revision.png",
  "outputDirectory": "/ABS/.research-private/exp0001a-qualification-v3/TASK/reviewer-1-sidecar",
  "at": "2026-08-31T20:12:00.000Z"
}
```

```sh
node research/scripts/run-exp0001a-model-role-qualification-v2-review-sidecar.mjs \
  --request /ABS/.research-private/exp0001a-qualification-v3/TASK/reviewer-1-sidecar-request.json
```

Wait only for private `ready-receipt.json`; do not probe the URL. The sidecar
binds exact manifest/PNG/semantic bytes, listens only on one opaque loopback
`/evidence/<32-hex>.png` path, rejects query/fragment/wrong path, serves exactly
one successful read, sets no-cache, and seals `read-receipt.json` plus
`completion-receipt.json`. A preflight GET would consume the only read.

While that process is waiting, run coordinator `prepare_review` with its exact
private `review-envelope.json`:

```json
{
  "operation": "prepare_review",
  "statePath": "/ABS/.research-private/exp0001a-qualification-v3/state.json",
  "at": "2026-08-31T20:12:01.000Z",
  "reviewEnvelopePath": "/ABS/.../reviewer-1-sidecar/review-envelope.json"
}
```

Then use the same task-runner/file-bridge loop as
the author, adding:

```json
"reviewEvidenceReadReceiptPath": "/ABS/.../reviewer-1-sidecar/read-receipt.json"
```

to `run_pending_action`. The reviewer receives only the public requirement,
frozen task rubric, strict allowlisted semantic projection, and loopback PNG.
It receives no room/task/author/participant identity, invite, condition,
repository path, paired result, transcript, or other decision. The runner
parses the exact terminal reviewer JSON; malformed/missing/extra criteria are
retained non-evaluable, not replaced. It also requires the exact sidecar read
receipt before completion.

If task creation is refused for usage limits, retain the interruption, allow
the first sidecar to time out and retain its incident, run
`resume_after_usage_limit` only after a new trusted auth preflight can pass,
then start a fresh sidecar for the same genuinely unstarted reviewer ordinal.
If a reviewer task was created, any failure consumes that attempt; do not
replace it.

## Result, signature, and stop conditions

Advance to the next fixed author only after the current task's evidence and
required reviews are terminal. Any setup invalidity, ambiguity, contamination,
capture failure/indeterminacy, or post-creation author usage-limit interruption
stops before the next brief. A proven pre-creation interruption follows only
the explicit same-assignment resume path above. Preserve all begun actions and
raw receipts. Never silently remove or substitute an assignment.

When the coordinator is terminal, run `seal_result` with two new private
mode-`0600` outputs. The coordinator independently replays the terminal state
and retained evidence graph before emitting either file:

```json
{
  "operation": "seal_result",
  "statePath": "/ABS/.research-private/exp0001a-qualification-v3/state.json",
  "at": "2026-08-31T21:00:00.000Z",
  "outputPath": "/ABS/.research-private/exp0001a-qualification-v3/qualification-result-v2.json",
  "attestationOutputPath": "/ABS/.research-private/exp0001a-qualification-v3/qualification-terminal-attestation-v2.json"
}
```

Then sign the exact result only against that terminal state and attestation:

```sh
node research/scripts/sign-exp0001a-model-role-qualification-v2.mjs \
  --purpose result \
  --input /ABS/.research-private/exp0001a-qualification-v3/qualification-result-v2.json \
  --state /ABS/.research-private/exp0001a-qualification-v3/state.json \
  --attestation /ABS/.research-private/exp0001a-qualification-v3/qualification-terminal-attestation-v2.json \
  --output /ABS/.research-private/exp0001a-qualification-v3/qualification-result-signed-v2.json
```

The signed result records task count, exact requested model/reasoning, wall
time, WebMCP source/result evidence, authoritative revision/inspection,
failures, and usage-limit interruptions. Exact tokens, resolved model snapshot,
subscription usage, and individual WebMCP call counts remain `unobservable`
when the retained Codex surface cannot prove them. Only an independently
attributed authoritative mutation can satisfy compatibility.

Only a signed `pass` makes EXP-0001A eligible for a separately versioned
successor runtime freeze. This runner never releases the 48-attempt A/A batch.

## Release gate

From the clean checkout used for launch:

```sh
npx vitest run \
  src/lib/research/baseline-freeze-v2-authority.test.ts \
  src/lib/research/baseline-freeze-v2.test.ts \
  src/lib/research/baseline-freeze-v3-authority.test.ts \
  src/lib/research/baseline-freeze-v3.test.ts \
  src/lib/research/exp0001a-model-role-qualification-v3-binding.test.ts \
  src/lib/research/exp0001a-model-role-qualification-v2-authority.test.ts \
  src/lib/research/exp0001a-model-role-qualification-v2-signer.test.ts \
  src/lib/research/exp0001a-model-role-qualification-v2-semantic-projection.test.ts \
  src/lib/research/exp0001a-model-role-qualification-v2-png-sidecar.test.ts \
  src/lib/research/exp0001a-model-role-qualification-v2-review-sidecar-runner.test.ts \
  src/lib/research/exp0001a-model-role-qualification-v2-file-bridge.test.ts \
  src/lib/research/exp0001a-model-role-qualification-v2-room-controller-receipts.test.ts \
  src/lib/research/exp0001a-model-role-qualification-v2-room-controller.test.ts \
  src/lib/research/exp0001a-model-role-qualification-v2-task-runner.test.ts \
  src/lib/research/exp0001a-model-role-qualification-v2-author-evidence.test.ts \
  src/lib/research/exp0001a-model-role-qualification-v2-result-attestation.test.ts \
  src/lib/research/exp0001a-model-role-qualification-v2-coordinator.test.ts \
  src/lib/research/exp0001a-model-role-qualification-v2.test.ts \
  src/lib/research/exp0001a-successor-runtime-v3.test.ts \
  research/scripts/capture-baseline-v2.test.ts \
  research/scripts/capture-baseline-v3.test.ts \
  research/scripts/codex-native-transport-block.test.ts

npx tsc --noEmit
npx eslint 'src/lib/research/exp0001a-model-role-qualification-v2*.ts' \
  'src/lib/research/baseline-freeze-v2*.ts' \
  'src/lib/research/baseline-freeze-v3*.ts' \
  src/lib/research/exp0001a-model-role-qualification-v3-binding.ts \
  src/lib/research/exp0001a-model-role-qualification-v3-binding.test.ts \
  'src/lib/research/exp0001a-successor-runtime-v3*.ts' \
  research/scripts/capture-baseline-v2.mjs \
  research/scripts/capture-baseline-v2.test.ts \
  research/scripts/capture-baseline-v3.mjs \
  research/scripts/capture-baseline-v3.test.ts \
  research/scripts/run-exp0001a-model-role-qualification-v2-review-sidecar.mjs \
  research/scripts/run-exp0001a-model-role-qualification-v2-room-controller.mjs \
  research/scripts/run-exp0001a-model-role-qualification-v2-task-runner.mjs \
  research/scripts/run-exp0001a-model-role-qualification-v2.mjs \
  research/scripts/seal-exp0001a-model-role-qualification-v2.mjs \
  research/scripts/sign-baseline-freeze-v2.mjs \
  research/scripts/sign-exp0001a-model-role-qualification-v2.mjs \
  research/scripts/codex-native-transport-block.test.ts \
  research/scripts/exp0001a-batch-command.mjs

npm run build
```

Loopback sidecar and Playwright controller tests require a host that permits a
localhost listener and Chromium. A sandbox networking denial is not a passing
result; rerun that exact suite on the trusted host and retain the test output.
