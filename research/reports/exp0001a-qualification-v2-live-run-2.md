# EXP-0001A qualification v2 — live run 2

Date: 2026-08-31 (America/Los_Angeles)  
Disposition: signed incomplete; A/A release blocked  
Private evidence: retained under the dated `exp0001a-qualification-v2-failed-live-*` archive

## What happened

Run 2 started from clean commit `d6d7b26`. Production room provisioning passed and `create_thread` was invoked exactly once for a fresh projectless Terra/medium author. The retained create result contained a ready task and host identity. The immediately following `list_threads(50)` result did not enumerate that task, so the runner discarded the ready identity and stopped as `invalid_setup`.

A post-terminal read-only diagnostic proved that the exact task identity from `create_thread` was valid and directly readable while still absent from `list_threads`. This is a transport-observability mismatch, not model failure and not a Jazzboard artifact result.

The first attempt to persist the read-only list result exceeded a canonical PTY line buffer. The same read-only call was repeated once and retained with chunked, non-canonical, no-echo input. The private operator incident records the extra observation. No task creation or board mutation was repeated.

The signed terminal record contains 32 retained evidence files:

- gate decision: `incomplete`
- result digest: `sha256:6bff6a084ab1146e44ab839d36cef75b03a1960407f95b883171e892dda2dfa5`
- terminal attestation digest: `sha256:d068d06b42d13530af5fb693c28a5bbf4d2f88333f9e434250fe85b72ed16ef9`
- signed-envelope digest: `sha256:1992061eecc46c72c291dbf0ffa065edd0866e298917b955949529cf75f7818a`

## Root cause and correction

`create_thread` has two materially different outcomes:

- Direct ready: returns `threadId` and `hostId`. Those retained values are authoritative and should proceed directly to `wait_threads` and `read_thread`, which validate the same identity.
- Setup pending or create result unavailable during recovery: lacks a ready identity and therefore requires exact-title `list_threads` reconciliation.

The old runner forced both outcomes through `list_threads`. The correction preserves direct-ready identity and reserves list reconciliation for missing/client-setup identity only.

Run 2 also exposed a terminal attestation bug: the coordinator’s temporary runtime file lived inside the evidence root while the inventory was created, then was deleted during wrapper cleanup, making replay impossible. Ephemeral coordinator, task-runner, and room-controller runtimes now live in a private sibling runtime root outside the attested evidence tree.

## Scientific handling

- The released author assignment remains consumed and is not replaced inside run 2.
- The run is classified as harness `invalid_setup`; it contributes no model or product-effect estimate.
- Its signed incomplete result and private evidence are retained.
- A distinct run may start only after direct-ready, client-setup, recovery, and self-excluding terminal-attestation regressions pass on a clean commit.
