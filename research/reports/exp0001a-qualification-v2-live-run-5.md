# EXP-0001A qualification v2 — live run 5

Date: 2026-08-31 (America/Los_Angeles)  
Disposition: retained harness-invalid run; A/A release remains blocked  
Private evidence: retained under the dated `exp0001a-qualification-v2-aborted-live-*` archive

## What happened

Run 5 started from clean commit `ca39ba9`. All 19 release-gate test files (143 tests), typecheck, scoped lint, and production build passed. Production room provisioning passed. A fresh projectless Terra/medium author was created exactly once and completed after two bounded waits. The exact 20,000-character task read was retained without truncation.

The Run 4 bootstrap defect was corrected: the author made exactly one successful read of the authoritative browser skill, with no guessed path, extra command, repository access, or private API access. The author then used the browser skill's required and documented runtime workflow: it read the selected browser's documentation, waited for navigation readiness, discovered WebMCP descriptions, and refreshed the room-scoped tool handle after navigation. The author reported the artifact complete.

The frozen trace validator rejected those documented read-only browser operations and concatenated every Node-REPL invocation into one artificial JavaScript lexical scope. The latter makes a legal handle refresh look like a duplicate declaration even though the live execution surface accepts it as separate invocations. The author also named the refreshed participant tool handle `roomTools`, while the mutation-proof analyzer recognizes only the literal identifier `tools`. These are harness/live-surface compatibility defects; no authoritative capture or blinded review was released.

## Root cause and correction

The isolation policy encoded one narrower, synthetic browser bootstrap rather than the actual browser skill contract. It treated required documentation and ordinary readiness/discovery calls as forbidden, modeled separate invocations as one source file, and coupled semantic WebMCP provenance to a variable name.

The correction validates each invocation in its real lexical boundary while carrying forward only declared bindings for `no-undef` protection; permits the required browser-documentation call and bounded read-only navigation/discovery methods; and keeps all existing bans on repositories, private APIs, arbitrary network access, dangerous JavaScript capabilities, extra browser surfaces, history, and open-tab enumeration. The author transport also freezes one changing handle named `tools` for participant WebMCP calls so mutation-proof markers remain unambiguous without supplying artifact content or coordinates.

## Scientific handling

- The created author task is consumed and will not be rerun, replaced, or rescored.
- No artifact-quality, model-quality, or Jazzboard-capability conclusion is drawn from this run.
- The private state, exact bridge requests, raw returned results, and terminal receipt are retained.
- The correction changes only transport/isolation semantics required by the live browser contract; it does not expose repository context, evaluator context, prepared geometry, or answers.
- The three-task qualification restarts only after the corrected trace contract passes the full clean-commit release gate.
