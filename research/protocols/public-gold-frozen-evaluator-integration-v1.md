# Public-gold integration with the frozen evaluator v1

Status: provider-free integration handoff. This document does not authorize a
provider call and does not define a parallel evaluator or classification path.

## Exact production path

Live public-gold work must use the frozen production sequence without a second
resolver:

1. Build and verify the production `BlindedReviewPlan`. The public-gold plan
   commits each artifact's ordered, distinct `primaryReviewerIds` pair and the
   independently eligible adjudicator selected by that same plan. Reviewer
   qualification commitments must prove the measurement-primary,
   standard-primary, and adjudicator capabilities.
2. Run or recover both primary `ReviewerWorkItem`s through
   `Exp0001aEvaluatorReviewRuntime.run/recover/load`, retaining the resulting
   `LockedEvaluatorRecord`s even when a call fails.
3. Pass the complete primary set to `lockPrimaryReviews`, then call
   `prepareAdjudicationWork`. Its output is authoritative: only a binary
   acceptance disagreement opens adjudication. A class-only disagreement does
   not.
4. Run and retain every prepared adjudication call, call
   `lockAdjudicationReviews`, and finish with
   `finalizeArtifactClassifications`.
5. Treat the resulting `ClassificationBook` fields—`reviewAccepted`, ordered
   `primaryFailureClasses`, `primaryClassAgreement`, `primaryFailureClass`,
   `resolution`, `primaryRecordSha256s`, and
   `adjudicationRecordSha256`—as the sole production resolution.

The public-gold analysis has one case per artifact, even though its retained
call ledger has two primary records and, only on binary disagreement, one
adjudication record. It reports individual reviewer roles separately but
compares the final production-resolved acceptance with gold.

## Strict adapter contract

`PublicGoldReviewRecord` is a canonical analysis projection of one retained
`LockedEvaluatorRecord` plus frozen corpus/plan bindings. It is not another
provider response. A future adapter must accept an already verified
`BlindedReviewPlan`, its durable evaluator journal, one
`LockedEvaluatorRecord`, the public corpus/plan commitments, and the relevant
`ClassificationBook`/ledger commitments. It must produce exactly one terminal
record and may never invoke a provider.

The new schema makes the contract enforceable:

| Public-gold commitment | Frozen source and verification |
| --- | --- |
| `lockedEvaluatorRecordDigest` | `sha256:` normalization of the exact `LockedEvaluatorRecord.recordSha256`; a locked record may project once only |
| `lockedEvaluatorProjection` | Exact locked `status`, production reviewer role, acceptance, primary class, and structured result; failed projections retain `FAIL_EVALUATOR_SCORER` |
| `reviewerRole` / `evaluatorIdentityId` | Ordered measurement/standard primary assignment or independent adjudicator assignment from the verified plan |
| `primaryLockedEvaluatorRecordDigests` | On every adjudicator terminal (including failure), the ordered primary record roots from the production adjudication assignment; always `null` on primaries |
| `begunAt` | Durable evaluator `prepared` journal event, never a caller-supplied clock value |
| `finishedAt` | Locked evaluator record time |
| `requestDigest` | Frozen request hash, or a typed no-release request-intent commitment from the durable journal |
| `responseDigest` | Frozen output hash, or `null` when no response was retained |
| artifact/render/semantic/rubric/taxonomy digests | Exact comparison between manifest evidence and the locked work item/record; mismatches remain non-evaluable and are never replaced with expected bytes |
| corpus/plan digests | Verified canonical self-digests from the signed launch inputs |
| provider identity evidence | `verified` only when observed model/tier, response-ID commitment, release state, and locked record root reconcile; the evidence digest commits that receipt |
| provenance evidence | `verified` only when locked artifact evidence matches every manifest commitment; the evidence digest commits that binding receipt and locked record root |
| `recordDigest` | Canonical self-digest of the complete public terminal projection, excluding only `recordDigest` itself |

A public terminal is `completed` only when its result exactly matches a scored
locked projection and every required criterion/evidence field is evaluable. A
production failure becomes `failed`. A scored or failed lock whose public-gold
binding cannot be evaluated becomes `non_evaluable`; its locked projection is
still retained for audit, but it receives no correctness credit. None of these
states may be retried or replaced to improve a measured rate.

The schema and analysis intentionally separate two facts:

- the production resolver fields are reproduced from the locked projections;
- `analysisAccepted` is `null` whenever any required public-gold projection is
  non-evaluable, even if the production `reviewAccepted` field is boolean.

This prevents missing evidence from becoming a correct rejection while still
proving what the deployed resolver would have decided.

## Blinding boundary

The adapter passes only the validated `BlindedPublicGoldPacket` through the
frozen request builder. The internal `artifactId -> caseId` map, source cluster,
gold labels, corruption provenance, parent/variant links, expected outcome, and
related artifact identities remain outside model input. One reviewer context
may not contain siblings from the same source-exemplar cluster.

## Integration tests required before live execution

- Project real synthetic `LockedEvaluatorRecord`s for the ordered primary pair
  through the adapter and prove byte-for-byte schema equality.
- Prove primary reviewer reuse, a missing primary, an unassigned reviewer, and
  duplicate locked-record projection are rejected.
- Prove class-only disagreement receives frozen precedence and no adjudication;
  prove binary disagreement cannot classify without exactly one independently
  assigned adjudication, including a retained failed adjudication.
- Compare every adapter-produced resolution field with
  `finalizeArtifactClassifications` for agreement, class disagreement, primary
  scorer failure, and binary adjudication.
- Crash before release, after release, and after record commit; prove
  `run/recover/load` produces one retained terminal and never a second call.
- Mutate each locked evidence digest, provider identity field, manifest digest,
  plan digest, ordered primary root, and public self-digest; prove validation
  fails while the begun call remains observable.
- Inspect the serialized provider request and prove that gold labels,
  corruption names, parent/source-cluster links, and sibling identities are
  absent.
- Prove analysis reads only terminal projections derived from retained locked
  records and cannot accept hand-authored live records.

Until this adapter and its frozen runtime/source/dependency receipts are added
to the signed bundle, the checked-in provider-free fixture demonstrates only
schema, resolver, retention, and analysis executability. Live rater validity
remains pending.
