# Canvas history data-loss fixes

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
