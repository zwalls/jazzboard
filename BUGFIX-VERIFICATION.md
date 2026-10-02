# Verified product-failure fixes

Base: remote main `6276b7dafa1aa80aaa71f2dc0b4bf8a272a470a3`. Vercel production metadata also identified this commit before the fixes. Work was isolated from the canonical checkout and the separate OpenAI plugin branch.

## Reproduced findings

1. **High severity: Undo overwrites a collaborator's saved work.** In two actual Chrome contexts, participant A moved a shape, participant B saved a new label at object revision 3, and A invoked Undo. The previous implementation restored the old whole-object snapshot, adopted revision 3 as its concurrency base, and persisted the original label at revision 4. The browser regression failed before the fix and screenshots showed the overwritten label. The same history mechanism applies to Redo, create/delete, multi-object edits, and diagram metadata.
2. **High severity: diagram history restoration can overwrite a change made during lease acquisition.** A persistence regression injected a diagram title change from revision 2 to revision 3 during object lease acquisition. Before the fix, the driver generated a diagram update restoring the old title with `expectedRevision: 3`. After the fix, it rejects the entire save, preserves the collaborator's title, and releases the lease.

History now checks every affected object's and diagram's source/target semantics before emitting edits. Source identity includes `createdAt`; already-restored targets remain safe no-ops. A conflict preserves both current work and the history stack and reports an actionable error. Acknowledged history-owned recreations rebase only their own incarnation in retained history, keeping repeated Undo/Redo valid. Diagram restoration separately captures revision and identity before persistence and retains those fences across lease acquisition.

The policy is deliberately conservative: any conflicting change to an affected object or diagram rejects the complete history step. It does not attempt to merge individual fields or silently skip a conflicting history entry.

## Verification

- Product unit/integration suite: `npm test -- --exclude '**/research/**'` — **1,639 passed, 12 skipped**, across 162 passing files and one skipped file.
- Final focused history, persistence, and edit-controller suite — **63 passed**.
- Eight focused real-browser regressions passed: collaborator conflict via keyboard and menu; repeated deletion/recreation Undo/Redo with text cancellation and reload; rejected history save and successful retry; delayed lease cancellation; atomic conflict rollback; fresh-incarnation deletion Undo; failed-deletion recovery; and saving pending keyboard work on navigation.
- Repeated recreation was checked again after the final incarnation-rebasing optimization — passed.
- Five additional browser scenarios passed: room navigation layout, unauthenticated room protection, create/join/recents, sharing/export separation, and spectator authorization/explicit upgrade.
- Final production build and TypeScript check passed. Changed-file ESLint passed. Full-project lint exited successfully with existing research warnings.
- Browser checks used synthetic participants and an isolated local server with production Redis, Blob, and Vercel credentials disabled.

Local reproduction commands:

```sh
REDIS_URL='' JAZZBOARD_PRIVATE_READ_WRITE_TOKEN='' BLOB_READ_WRITE_TOKEN='' VERCEL='' \
  SESSION_SECRET='jazzboard-synthetic-critical-bug-test-secret' \
  npm run dev -- --port 4288 --hostname 127.0.0.1

PLAYWRIGHT_BASE_URL=http://127.0.0.1:4288 npm run test:e2e -- \
  e2e/canvas-history-conflicts.e2e.ts e2e/canvas-sync-edgecases.e2e.ts \
  --grep 'history|recreates a deleted|keeps a failed deletion|cancels a delayed lease|rolls back every member|flushes a pending keyboard'
```

## Existing full-check limitation

`npm run check` cannot be reported green. Its research suite encounters research/provenance/runtime failures, and the broad run was interrupted after those failures appeared. The frozen spectator allowlist test was rerun in an unchanged `6276b7d` checkout and fails there too: the frozen research allowlist lacks `start_guided_walkthrough`, `get_guided_walkthrough_status`, `navigate_guided_walkthrough`, `stop_guided_walkthrough`, and `control_local_viewport`. These changes do not alter that registry or the research authority contracts. Product tests, focused browser regressions, type checking, lint, and production compilation were verified separately; no research/security gate was changed or bypassed.

No additional critical finding is claimed by this focused pass. These are verified high-impact product data-loss failures, not claims of a general security audit or an authentication bypass.

## Follow-up: blocked browser storage

**Material availability failure:** browser policy can throw `SecurityError` when accessing the `window.localStorage` getter itself. The old default-argument access occurred outside the existing read/write exception handlers. In an actual Chrome page with a synthetic policy denial, creating a room returned a successful API response but left the person on the homepage, and none of the five landing WebMCP tools registered. Exact-code entry was also vulnerable to the same storage access.

The shared storage accessor now catches getter failures and returns unavailable storage. Authorized room creation/joining and agent tool registration proceed; optional local room history reports that it was not stored. No authorization rule, cookie setting, or server persistence behavior changed.

The unit and browser regressions failed before the fix. Verification after the fix:

- Storage and landing-tool unit tests: **25 passed**.
- Product unit/integration suite: **1,641 passed, 12 skipped**, across 162 passing files and one skipped file.
- Two actual Chrome regressions against the local production build passed: create, signed-session membership, reload, tool discovery, empty local history, invalid-code error recovery, and exact-code join with denied storage.
- Six additional Chrome scenarios against the local development server passed: landing registration before hydration, discovery before hydration, skill/crawler/sitemap delivery, live agent Follow/Spotlight, shared semantic edits and object conflicts, and spectator authorization/explicit upgrade.
- Production build, TypeScript check, and changed-file ESLint passed.

Production browser authorization was checked through same-origin browser fetch. Existing collaboration tests use Playwright API request helpers; those helpers do not send production Secure cookies over local HTTP, so their additional coverage runs against the isolated development server. An initial local-production run of those helper-based tests returned `AUTH_REQUIRED`; the cookie security policy was preserved. Sandbox-only attempts to launch Chrome also failed before browser startup; successful browser runs used the approved local Chrome/loopback execution environment.

This bounded follow-up does not claim another critical vulnerability. Its separate commit keeps the concrete storage availability fix reviewable alongside the earlier data-loss fix.

## Pass 3: committed-save recovery and live-lease reacquisition

Two additional material product failures reproduced:

1. **Protected ghost after a superseded committed create.** An actual Chrome tab created a rectangle while its successful response was held. A second authorized tab deleted that persisted object. The first tab then received an accurate committed-mutation receipt and repeatedly refreshed newer durable room state, but retained its optimistic object and pending transaction. It waited for an object that would never reappear. Before-fix browser evidence shows the server deletion succeeded while the first tab still rendered the rectangle after 12 seconds; deterministic driver tests show unsettled recovery for both create/update. Existing-object updates have an independent lease-renewal fallback, so an indefinite browser update stall is not claimed.
2. **Reacquired live lease reports an obsolete object revision.** After saving revision 2 while retaining a human lease acquired at revision 1, another operation by that same participant verified revision 2 but received the original token with `objectRevision: 1`. The client correctly rejected this inconsistent response and the board action failed. Both an engine regression and the actual browser acquisition assertion failed before the fix.

The persistence driver now treats a missing affected object as incompatible once the receipt's committed room revision is visible, and performs normal authoritative recovery. Missing objects in older snapshots still wait for visibility. It never recreates the deleted object or resends its committed mutation. Lease reacquisition now refreshes `objectRevision` from the already revision-checked object while preserving the same token, actor, and acquisition time.

Focused driver/controller tests passed (48). Eleven actual Chrome scenarios passed: confirmed create/update supersession with a subsequent save and reload; delayed replay with a newer local generation; same-participant live-lease delete and reload; image upload failure/cancel/retry/reload; completed-but-delayed upload cancellation followed by a new upload and reload; duplicate and group identity (three); and disjoint/older-save recovery (two). Production compilation, TypeScript, and changed-file lint passed. Detailed coverage and negative results are in `BUG-COVERAGE.md`.

An initial broad product run concurrent with compilation passed 1,644 tests but timed out one unchanged 5-second bounded semantic-read test. The final run after compilation passed **1,645 tests, with 12 skipped**, across 162 passing files and one skipped file, using four workers. No test timeout, assertion, or research/security gate was relaxed.

## Pass 4: artifact persistence and cancellation

Three material artifact failures reproduced before fixing them:

1. A downloaded semantic JSON file omitted a visible pending edit. Chrome showed the rectangle at x=181 while its save was held; the downloaded file contained the older persisted x=180.
2. Closing Export while its server response was delayed still triggered the download after closing. The before-fix Chrome assertion saw one unexpected download, and the component regression reproduced the same behavior for SVG.
3. Closing Export while reading a valid template still submitted the import after the file read completed. The before-fix browser test verified a new persisted shape appeared after the panel closed, despite the expected cancellation.

Semantic exports now use the canvas persistence drain and authority refresh before requesting an artifact. They capture the live selection at invocation, so a selected optimistic creation is not discarded merely because the older room props lack it. Template import uses the same drain and its returned room revision before submission. Active gestures must finish first; active text is committed through the existing canvas path. PNG keeps its faithful local renderer behavior.

All artifact requests share a cancellation controller. Closing or unmounting aborts it, and continuation guards after file reading, persistence waiting and HTTP completion prevent late submission, download and UI callbacks. This does not promise to roll back an import already committed by the server.

Seven added component regressions passed alongside the existing eleven tests (18 total). Three actual Chrome scenarios passed, including held-save export, export rejection/retry/reload, delayed export cancellation, delayed template-read cancellation, reopening, import rejection/retry with fresh IDs, and reload. Existing spectator sharing/export and participant image PNG-export browser scenarios also passed. The browser checks used the isolated port-4294 server and synthetic data. Two runs timed out during Chrome page-fixture setup before test actions; successful runs verified the actual assertions independently.

Production build, TypeScript and changed-file lint passed. The four-worker product run passed 1,650 tests, with 12 skipped and two existing five-second timeouts in semantic-tools/Mermaid tests. A one-worker recheck of both complete affected files passed all 62 tests unchanged. The broad run is not reported green, and no timeout or test assertion was relaxed.

## Pass 5: simultaneous first-session entry

**Material session availability failure:** two fresh tabs in the same browser could both create boards successfully with no existing guest cookie. Each request independently established a different signed participant identity. Their responses overwrote the one shared guest cookie; one active creator then received `403` for their own newly created room. The before-fix actual Chromium regression verified `[403, 200]` instead of `[200, 200]`, with separate saved memberships. The delayed server-processing fixture preserves each request's actual outgoing cookie headers rather than acquiring another tab's cookie later through Playwright's request helper.

Same-origin POST requests to `/api/rooms` now use a shared exclusive Web Lock. The next tab sends its request only after the preceding entry's response and bounded retry settle, so it reuses the established signed cookie. Create and join share this boundary. Other origins, reads and ordinary board mutations keep their existing behavior. Server authorization, bootstrap identity derivation, idempotency and cookie policy are unchanged.

Five new coordination tests and the existing API/session/room-route tests passed (34 total), including request queuing, identity stability across ambiguous retry, cancellation before dispatch, queue release, scope and denied-getter availability. Actual Chromium verified both rooms authorize the same signed participant and survive reload, and a queued tab closed before dispatch creates no board while its replacement can enter and reload.

The third actual browser scenario passed synthetic entry failure, queued spectator joining, creator retry, correct per-room roles, exact request counts and reload of both rooms. A trial locator matched Next.js's route announcer instead of the visible form notice and was corrected. A subsequent trace showed two reload load-event waits of about 25 seconds exhausted the 60-second scenario budget; the verified test waits for DOM readiness and then applies the unchanged 20-second canvas-visible assertions.

Web Locks coordination is optional where the browser does not expose a lock manager, including policy-denied getter access. Those environments retain existing entry availability but do not gain the cross-tab serialization guarantee. This is a product/session availability fix, not an authentication bypass finding.

Final verification: production build, TypeScript and changed-file lint passed. The complete product unit/integration suite passed **1,657 tests, with 12 skipped**, across 163 passing files and one skipped file, using one worker. Existing assertions and test timeout settings were preserved. Three session browser scenarios passed; together with the preceding artifact batch, this follow-up added eight successful actual-browser scenarios. The unchanged research-suite limitation documented above remains outside this product fix scope.
