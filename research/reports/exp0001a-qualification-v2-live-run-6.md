# EXP-0001A qualification v2 — live run 6

Date: 2026-08-31 (America/Los_Angeles)  
Disposition: retained harness-invalid run; A/A release remains blocked  
Private evidence: retained under the dated `exp0001a-qualification-v2-aborted-live-*` archive

## What happened

Run 6 started from clean commit `01f30ba` after all 19 release-gate files (145 tests), typecheck, scoped lint, and production build passed. Production provisioning passed. One fresh projectless Terra/medium author was created and completed after bounded waits. The author used one authoritative skill read, one selected-browser documentation read, one browser/tab, only the production invite/origin, browser-exposed WebMCP, the frozen session/mutation/visual markers, no repository, and no private API. The corrected per-invocation isolation analyzer independently accepts the retained browser trace.

The full task attestation still rejected the author before capture because two trusted-host presentation transformations were compared as raw strings. Codex normalized the 68-character requested task title to a 47-character visible title ending in an ellipsis. The retained `<codex_delegation>` envelope XML-escaped the two `>` characters in the prompt as `&gt;`. Both transformations are deterministic and reversible for this frozen input, but the validator required the unnormalized requested title and unescaped prompt bytes.

The unique 12-character action suffix was also placed at the end of the requested title, beyond the host's visible truncation boundary. Direct-ready identity remained authoritative, but title-based recovery would be unable to distinguish attempts reliably.

## Root cause and correction

The harness modeled `create_thread` arguments as if the app returned them verbatim, despite the tool contract stating that titles are normalized and the delegation being retained inside an XML-like envelope.

The correction validates the exact known live title normalization, compares the delegation against a one-pass XML text-node encoding of the exact released prompt, and places the unique action suffix at the beginning of the requested title so it survives normalization. List-based setup/recovery uses the same normalized unique title. Unknown entities, double decoding, prompt drift, title drift, duplicate matches, and missing matches continue to fail closed.

## Scientific handling

- The created author task is consumed and will not be rerun, replaced, or rescored.
- No artifact-quality or model-quality conclusion is drawn from this run.
- The private state, requests, returned results, terminal receipt, and independent trace diagnostic are retained.
- The correction is limited to trusted-host representation and recovery identity; it supplies no artifact content, geometry, evaluator context, or repository access.
- Qualification restarts only from a clean commit after the full gate passes.
