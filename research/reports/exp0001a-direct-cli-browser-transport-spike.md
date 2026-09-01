# EXP-0001A direct CLI/browser transport spike

Date: 2026-09-01 (America/Los_Angeles)  
Disposition: direct authorization passed; browser attachment unavailable  
Private evidence: retained under `.research-private/exp0001a-direct-cli-spike-20260901T0420Z/`

## Purpose

Determine whether a fresh ChatGPT-authenticated Codex CLI session can replace the delegated app-task transport while preserving zero-confirmation Jazzboard authoring through the page's actual WebMCP tools.

## Conditions

- fresh empty workspace with no Jazzboard repository context;
- signed-in ChatGPT subscription authentication;
- `gpt-5.6-terra` with `medium` reasoning;
- direct frozen author brief on stdin;
- automatic review with no user approval interaction;
- private prompt, JSONL trace, stderr, and terminal result retained as mode-`0600` evidence.

## Result

The direct Codex session started and completed without an approval request. Exact usage telemetry was observable from the CLI trace. The author loaded the frozen browser bootstrap but could not establish a browser connection, so it could not open the private Jazzboard room or discover page WebMCP tools. The terminal result arrived in approximately 26 seconds.

This demonstrates that direct task origin solves the false delegated-authorization refusal. It also demonstrates that standalone CLI sessions are not a substitute for browser-attached Codex sessions in the current environment.

## Product conclusion

Jazzboard must remain zero-confirmation for authorized participant agents. The experiment must move to a fresh direct-origin Codex session that is attached to the in-app browser; it must not add consent dialogs, proposal gates, or manual confirmations to compensate for an orchestration limitation.
