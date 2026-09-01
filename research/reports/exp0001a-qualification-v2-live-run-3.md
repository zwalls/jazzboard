# EXP-0001A qualification v2 — live run 3

Date: 2026-08-31 (America/Los_Angeles)  
Disposition: retained harness-invalid run; A/A release remains blocked  
Private evidence: retained under the dated `exp0001a-qualification-v2-aborted-live-*` archive

## What happened

Run 3 started from clean commit `31546c4`. Production room provisioning passed. A fresh projectless Terra/medium author was created exactly once, the direct-ready task identity was retained, and two bounded `wait_threads` observations were retained until the author task completed.

The subsequent `read_thread` request used `maxOutputCharsPerItem: 1,000,000`. The live Codex surface rejects values above 20,000, so the exact invalid-argument result was retained and the author transport ended as `failed` before terminal output or authoritative board evidence could be derived.

The coordinator advanced to the next task after a `failed` author, so this run was not terminal and could not truthfully produce a signed qualification result. It was archived intact rather than forcing a terminal state or misclassifying the transport defect as model failure.

## Root cause and correction

The canonical Codex transport already freezes the live maximum at 20,000 characters per item. The qualification-specific runner had independently widened it to 1,000,000 without a live contract test. The qualification runner now uses the same 20,000-character limit, with a regression assertion on the exact `read_thread` arguments.

## Scientific handling

- The completed author task remains consumed and is not reused or rescored.
- No visual, semantic, or model-quality conclusion is drawn from this run.
- The run is classified as harness invalidity, despite the coordinator’s pre-fix `failed` receipt label.
- The private state, exact bridge requests, raw returned results, and operator diagnostic are retained.
- A new run may begin only after the corrected read limit passes the full clean-commit release gate.
