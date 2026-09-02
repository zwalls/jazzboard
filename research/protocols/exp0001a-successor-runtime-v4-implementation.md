# EXP-0001A full-run successor runtime v4 implementation record

- Status: active implementation; **no A/A brief authorized or released**
- Predecessor qualification: signed pass, result
  `sha256:63a01fe11795813558a418d23509ecd25e0b2e94bed83a83123b51dca902a9ea`
- Required production binding:
  `sha256:26d644dabf67b8f9d63011fdcd6d1af0c09069e67cb6977f3ac97eaa36f15688`
- Required baseline-v3 receipt:
  `sha256:6b0bfb2e944366f39102409c1d4a1e67cbf505b9f66587e299e6f11642ef661b`
- Frozen denominator: 12 public-development tasks, 24 pairs, 48 authors,
  96 primary reviews, disagreement-only adjudication, 24 pairwise judgments

## Objective

Replace the disabled predecessor execution shell with one signed,
subscription-native successor that can complete the frozen 48-attempt A/A
without API billing, repository-visible authors, manual result fabrication,
silent retries, denominator loss, or treatment leakage.

The predecessor prebrief bytes, the single-assignment successor-v3 prototype,
the signed qualification, and every stopped qualification root remain
historical evidence. They are not mutated or reinterpreted.

## Implementation sequence

1. **Full-run launch authority**
   - Verify the exact signed qualification pass through its fixed Ed25519
     authority.
   - Verify the binding-v3 → baseline-v3 → deployment/contract chain.
   - Bind Terra/medium authors, Sol/high evaluators, and the unchanged
     development-v2 randomized schedule.
   - Persist sequential release state before every external action and enforce
     an all-48 ceiling with no repeated assignment release.

2. **Codex task supervisor**
   - Generalize the qualified mode-`0600` create/list/wait/read bridge to every
     experimental role and opaque work-item ID.
   - Run fresh ChatGPT-authentication preflight immediately before create.
   - Retain exact raw app results, reconcile ambiguous create by neutral title,
     and never issue create twice.
   - Preserve actionable `inProgress`/`waitingOnApproval` states without
     approving, messaging, or falsely terminalizing them.

3. **Room and author evidence controller**
   - Execute the existing development-v2 provisioning plan through the frozen
     browser/WebMCP contract.
   - Preserve blank/fixture preflight, exact private-invite authorization,
     independent final room read, attribution, exact-revision semantic state,
     inspection evidence, and PNG bytes for every assignment.
   - Generalize receipt identity from three qualification task IDs to opaque
     assignment/attempt IDs without relaxing path, mode, symlink, or deployment
     checks.

4. **Blinded evaluator packets**
   - Reuse the full primary/adjudication/pairwise scientific work orders.
   - Require successful reviewer output to echo the exact supplied
     `evidenceRoot` or `pairRoot`.
   - Keep author transcript, condition, pair order, prior decisions, repository,
     room secrets, and private adjudication roots out of evaluator inputs.
   - Prove at least one post-release GET for every exact packet URL; readiness
     probes do not count as reviewer consumption.

5. **Durable batch coordinator and CLI**
   - Retain one exact machine action at a time and ingest only its committed raw
     result.
   - Keep the legacy mutation command disabled.
   - Drive the frozen author denominator first, then 96 primaries, conditional
     adjudications, locked classifications, 24 pairwise judgments, cluster-aware
     analysis, and detached completion signature.
   - Pause globally on usage limits, preserve every begun task, and resume at
     the first genuinely unstarted assignment while maintaining schedule-prefix
     balance.

6. **Freeze and release gates**
   - Pass provider-free synthetic full-lifecycle, crash/restart, ambiguous
     create, trace-policy, blinding, and evidence-tamper tests.
   - Run three disposable evaluator transport spikes: primary, adjudication,
     and pairwise including identical bytes at distinct URLs.
   - Commit and deterministically bundle the exact successor source.
   - Independently review scientific integrity and security boundaries.
   - Produce a new qualification-aware no-A/A-release attestation and detached
     successor signature. Only that signed artifact may release assignment 1.

## Definition of done

The experiment is ready only when all of the following are true:

- the successor verifies the actual signed qualification and current production
  chain;
- a fresh private run can traverse a provider-free synthetic 48/96/conditional/
  24 lifecycle with exact counts and unique task identities;
- every external action is journaled before invocation and crash-safe;
- auth, privacy, trace, attribution, revision, PNG, blinding, and usage-limit
  adversarial tests pass;
- the committed deterministic runtime reproduces byte-for-byte;
- independent review is complete; and
- the zero-A/A-release successor freeze is signed.

Until then, “qualification passed” must not be described as “the 48-attempt
experiment is ready.”
