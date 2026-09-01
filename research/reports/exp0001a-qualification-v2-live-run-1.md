# EXP-0001A qualification v2 — live run 1

Date: 2026-08-31 (America/Los_Angeles)  
Disposition: signed incomplete; A/A release blocked  
Private evidence: retained under the dated `exp0001a-qualification-v2-failed-live-*` archive

## What happened

The first production qualification author assignment was released exactly once. A fresh projectless Codex task was observed at the host, but the create result was not durably retained before the original bridge writer stalled. Recovery correctly refused to invoke `create_thread` again. Its exact-title reconciliation then called `list_threads` with `limit: 100`; the live Codex surface rejects values above 50, so the coordinator terminated the assignment as `invalid_setup`.

One read-only reconciliation observation was repeated after its first local writer exited before persistence. This did not create, modify, replace, or rerun a task. The private operator incident records that extra observation.

The terminal run was retained rather than discarded. Its signed result records:

- gate decision: `incomplete`
- A/A execution status: `blocked`
- retained terminal evidence files: 34
- result digest: `sha256:cc51684a85d966e8d98cfa61c881dcc2ad7cbf13bac4e9f7c6c61d350e9c435d`
- terminal attestation digest: `sha256:5e0829e13f6b567cc7bde0f4094d7a421949d55292fec0ff1904c83fd3d0cd60`
- signed-envelope output digest: `sha256:7e439aff88c09764ad48960c31b688d7c13f8e732601a667bc2bd5cbe21aedd4`

## Harness defects found

1. The qualification task runner requested `list_threads(limit: 100)`, above the live maximum of 50.
2. Terminal result sealing passed a complete evidence attestation into a strict schema that accepted only its six binding fields.
3. The incomplete-result schema used an all-keys-required enum record even though incomplete tasks intentionally have no diagnostic-quality decision.
4. Terminal evidence uniqueness treated byte-identical operator exports of an authoritative bridge request as an ambiguous chain. Identical copies are not ambiguity; the state-bound digest remains authoritative.

## Scientific handling

- The released author assignment remains consumed and is not replaced inside this run.
- No author or reviewer outcome from this run contributes to product-effect estimates.
- The run is classified as harness `invalid_setup`, not model failure.
- A new qualification run may begin only after the defects above have regression coverage and the full release gate passes on a clean commit.
- The frozen 48-attempt A/A experiment remains blocked until a distinct qualification run passes.
