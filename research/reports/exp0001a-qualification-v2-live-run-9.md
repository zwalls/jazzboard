# EXP-0001A qualification v2 — live run 9

Date: 2026-08-31 (America/Los_Angeles)  
Disposition: retained compatibility failure and incomplete qualification; A/A release remains blocked  
Private evidence: retained under `.research-private/exp0001a-qualification-v2/`

## Launch conditions

Run 9 started from clean commit `55441e0` after the complete 19-file / 149-test release gate, typecheck, scoped lint, and production build passed. The final portable Browser-skill bootstrap was frozen before release. The first production room was provisioned successfully, and one fresh projectless `gpt-5.6-terra` / `medium` author task was created exactly once through the ChatGPT-authenticated Codex transport.

## Task 1 result

The author successfully completed the frozen skill bootstrap, reached the Browser/WebMCP execution path, and attempted the shared-board workflow. The author then returned a terminal failure after approximately 4.5 minutes because browser security policy denied the mutation: the authorization arrived through delegated task content rather than a direct user instruction in that task.

This is a real transport/model compatibility result. The task is consumed and will not be rerun, replaced, or rescored. It is not evidence that Terra cannot reason about the benchmark artifact; the author never received authority to complete the mutation.

## Task 2 provisioning result

The first controller launch was denied by the local sandbox before a browser could start. The failed incident was retained. A single outside-sandbox retry was permitted because the first attempt performed no external room mutation.

The outside-sandbox controller then failed closed while canonicalizing a WebMCP result because `data.positions` contained a non-JSON value. No trustworthy room receipt was produced. Because the controller may already have crossed the room-creation boundary, provisioning was not retried or replaced.

## Scientific conclusion

- The three-task Terra/medium qualification did not complete.
- No author artifact was captured or sent to reviewers.
- No product-quality score or improvement percentage may be inferred from this run.
- The 48-attempt randomized A/A execution remains blocked.
- The delegated-task mutation authorization boundary must be resolved through an explicitly user-authorized experimental transport; it must not be bypassed by prompt wording.
- The `data.positions` non-JSON serialization defect must be corrected and regression-tested before another production qualification.

Run 9 is the final attempt under the current delegated Codex-task transport. Further execution requires a methodological decision rather than another prompt or validator adjustment.
