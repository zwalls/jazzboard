# EXP-0001A qualification v2 — live run 9

Date: 2026-08-31 (America/Los_Angeles)  
Disposition: invalid delegated transport and incomplete qualification; A/A release remains blocked
Private evidence: retained under `.research-private/exp0001a-qualification-v2/`

## Launch conditions

Run 9 started from clean commit `55441e0` after the complete 19-file / 149-test release gate, typecheck, scoped lint, and production build passed. The final portable Browser-skill bootstrap was frozen before release. The first production room was provisioned successfully, and one fresh projectless `gpt-5.6-terra` / `medium` author task was created exactly once through the ChatGPT-authenticated Codex transport.

## Task 1 result

The author successfully completed the frozen skill bootstrap, reached the Browser/WebMCP execution path, and attempted the shared-board workflow. The author then returned a terminal failure after approximately 4.5 minutes because browser security policy denied the mutation: the assignment had been wrapped as delegated task content by the app-task transport rather than presented as the author's direct task.

This is an invalid experimental transport result, not a Jazzboard authorization requirement and not evidence that Terra cannot reason about the benchmark artifact. Jazzboard must not introduce a confirmation gate. Possession of the exact private invite plus an authorized participant guest session is the product authorization boundary; spectators remain read-only. The task is consumed and will not be rerun, replaced, or rescored.

## Task 2 provisioning result

The first controller launch was denied by the local sandbox before a browser could start. The failed incident was retained. A single outside-sandbox retry was permitted because the first attempt performed no external room mutation.

The outside-sandbox controller then failed closed while canonicalizing a WebMCP result because `data.positions` contained a non-JSON value. No trustworthy room receipt was produced. Because the controller may already have crossed the room-creation boundary, provisioning was not retried or replaced.

## Scientific conclusion

- The three-task Terra/medium qualification did not complete.
- No author artifact was captured or sent to reviewers.
- No product-quality score or improvement percentage may be inferred from this run.
- The 48-attempt randomized A/A execution remains blocked.
- The experiment must use a fresh browser-attached author session in which the frozen benchmark brief is the direct task. It must not add per-action or per-task confirmation prompts to Jazzboard.
- The `data.positions` non-JSON serialization defect must be corrected and regression-tested before another production qualification.

Run 9 is the final attempt under the delegated app-task transport. Further execution requires a direct-origin, browser-attached Codex transport rather than another prompt or validator adjustment.

## Erratum and direct-CLI follow-up

The original operator conclusion incorrectly proposed direct user confirmation in each author task. That would violate Jazzboard's agent-first product requirement and is withdrawn.

A disposable `codex exec` follow-up used the signed-in ChatGPT account, a fresh empty workspace, `gpt-5.6-terra` / `medium`, automatic review, and the same private brief. It received the brief as a direct user turn and produced no approval request, confirming that delegated wrapping caused the earlier denial. The run terminated autonomously in approximately 26 seconds because standalone Codex CLI was not attached to an in-app browser connection. It therefore could not reach browser-exposed WebMCP and is retained only as transport evidence, not an author-quality attempt.
