# EXP-0001A qualification v2 — live run 4

Date: 2026-08-31 (America/Los_Angeles)  
Disposition: retained harness-invalid run; A/A release remains blocked  
Private evidence: retained under the dated `exp0001a-qualification-v2-aborted-live-*` archive

## What happened

Run 4 started from clean commit `643c617`. Production room provisioning passed. A fresh projectless Terra/medium author was created exactly once, the direct-ready task identity was retained, and bounded `wait_threads` observations continued until the author task completed. The corrected live `read_thread` maximum of 20,000 characters was accepted and the full retained task page was untruncated.

The author reported that the requested artifact was complete. The isolation attestation nevertheless rejected the attempt because the task made two platform bootstrap commands: an initial failed read of an obsolete browser-skill cache path and a subsequent successful read of the authoritative browser skill. The successful read also used a harmlessly wider `sed` range than the validator's exact command literal. No repository or private API was accessed, but the frozen validator requires exactly one successful bootstrap command matching one exact spelling, so the author receipt correctly sealed as `failed` under the current contract.

The coordinator advanced after the failed receipt. No authoritative artifact capture or blinded review was released. The run was archived intact rather than reusing the created task or treating the transport mismatch as model-quality evidence.

## Root cause and correction

The author prompt named the browser/WebMCP capability but did not tell the isolated task to use the exact skill path already supplied by its available-skills catalog. The task first guessed an obsolete cache location, then recovered. The bootstrap contract was also coupled to a single `sed` upper-bound spelling rather than to the substantive property that the authoritative skill file was read completely.

The correction makes the permitted platform bootstrap explicit in the isolated prompt, prohibits path probing, and validates one successful read of the exact authoritative browser skill while accepting an upper bound that still covers the complete file. Repository access, arbitrary filesystem access, extra commands, private APIs, forks, shared history, prepared coordinates, and evaluator context remain forbidden.

## Scientific handling

- The created author task is consumed and will not be rerun, replaced, or rescored.
- No artifact-quality, model-quality, or Jazzboard-capability conclusion is drawn from this run.
- The failure is classified as harness invalidity, despite the coordinator's fail-closed author receipt.
- The private state, exact bridge requests, raw returned results, and terminal receipt are retained.
- The three-task qualification restarts only after the corrected bootstrap contract passes the full clean-commit release gate.
