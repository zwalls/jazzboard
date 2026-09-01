# EXP-0001A qualification v2 — live run 7

Date: 2026-08-31 (America/Los_Angeles)  
Disposition: retained harness-invalid run; A/A release remains blocked  
Private evidence: retained under the dated `exp0001a-qualification-v2-aborted-live-*` archive

## What happened

Run 7 started from clean commit `d732f8f` after the complete 19-file / 146-test gate, typecheck, scoped lint, and production build passed. Production provisioning and one-time fresh Terra/medium author creation passed. The author reached terminal state and the exact 20,000-character read request was retained.

The host normalized the newly lengthened unique-prefix title differently from the shorter prior title: it retained the first 59 characters and an ellipsis. More importantly, the retained `create_thread` delegation witness projected the exact 6.5K-character prompt into ordered segments separated by ellipses, even though the containing function-call output reported `truncated:false`. The primary exact create request and release journal still retain and hash the complete prompt; only the secondary readback witness was projected.

The fail-closed validator required one fixed 47-character title transform and a complete XML-text encoding of the readback prompt. It therefore sealed the author as failed before capture or review.

## Root cause and correction

The Codex host's user-facing title and delegated-input witnesses are display-normalized rather than stable byte-for-byte echoes. Their normalization depends on content length and retained-page pressure.

Future task titles are shortened below the observed host threshold while keeping the unique action suffix at the beginning. The secondary delegation witness accepts either the complete XML-text encoding or an ordered ellipsis projection whose literal segments match the exact released prompt from beginning to end and retain a substantial minimum amount of evidence. The exact create request, invocation authorization, release journal, raw create result, action digest, and projectless identity remain primary authority. Unknown entities, changed retained bytes, reordered segments, suffix loss, prefix loss, or overly sparse projections fail closed.

## Scientific handling

- The created author task is consumed and will not be rerun, replaced, or rescored.
- No artifact or model-quality conclusion is drawn from this run.
- The run remains private and retained; no capture or reviewer was released.
- The correction changes only secondary host-witness validation and title recoverability, not task content or artifact guidance.
