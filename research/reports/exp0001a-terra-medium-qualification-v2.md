# EXP-0001A Terra/medium compatibility qualification v2

- Status: **signed pass; eligible for a separately frozen successor runtime**
- Completed: 2026-09-02T00:23:13.000Z
- Partition: public development only
- Author policy: `gpt-5.6-terra` at `medium`
- Reviewer policy: `gpt-5.6-sol` at `high`
- Product commit: `4eb6d9862cd1e805906a338d524529b6b7019639`
- Production deployment: `dpl_CePet5gs1u52rMvQUGye92qByJAQ`
- Production binding: `sha256:26d644dabf67b8f9d63011fdcd6d1af0c09069e67cb6977f3ac97eaa36f15688`

## Decision

All three fixed author attempts satisfied the compatibility boundary. Each was
performed by a fresh projectless Codex task through ChatGPT subscription
authentication, discovered and used Jazzboard's browser-exposed WebMCP
surface, produced an independently attributed authoritative mutation,
completed a visual inspection, and returned a terminal result. Exact-revision
PNG and sanitized semantic evidence were retained for every task.

Two fresh blinded Sol/high reviewers independently evaluated each retained
artifact. All six primary reviews accepted the artifact and all frozen
criteria, so no adjudication task was released. These quality decisions are
development evidence only; they do not estimate a product improvement or a
population success rate.

| Fixed task | Final room revision | Author wall time | Primary reviews |
| --- | ---: | ---: | --- |
| `dev-architecture-create-checkout` | 4 | 227,071 ms | 2 accepted |
| `dev-architecture-edit-uncertainty` | 9 | 192,918 ms | 2 accepted |
| `dev-drawing-create-wayfinding-icon` | 3 | 149,060 ms | 2 accepted |

The three author attempts consumed 569,049 ms of observed wall time in total.
There were no usage-limit interruptions. Exact tokens, resolved model
snapshots, individual WebMCP call counts, and subscription usage were not
observable and were recorded as the literal value `unobservable`, never
estimated.

## Signed evidence

- Qualification result:
  `sha256:63a01fe11795813558a418d23509ecd25e0b2e94bed83a83123b51dca902a9ea`
- Terminal evidence attestation:
  `sha256:d2a0d7fd32ffaaf337ecac2ccec5a0fc73399ed1747ea28d489c333493eb3c73`
- Retained evidence inventory root:
  `sha256:a9b0a34711f10d9de6823799490ba48dc2c48ab3de81fd66ac3bc30b6a3d8652`
- Retained evidence files: 381
- Signed result envelope:
  `sha256:3f35af150413bef4a1112f007ebd25dccb038c10ac5885a454f195e2bfcb94ee`
- Authority-signed payload:
  `sha256:8986f467152ee727e628682a4a1de8ad199ac84a9bf93896f12dd6a2958c7519`

The ignored private evidence root retains the exact state, task bridge
requests/results, raw create/list/wait/read observations, room-controller
receipts, authoritative semantic states, revision-matched PNGs, blinded review
envelopes, sidecar read receipts, and the final signed result. Public reporting
does not expose room invites, room codes, guest sessions, or author prompts.

## Fail-closed incidents

The final successful run followed six preserved stopped qualification roots
created while hardening the transport. They remain failures or invalid setup
evidence and were never deleted, substituted, or relabeled.

After all attempts and reviews were terminal, the first result-sealing call
also failed closed. The capture authorization for each task was already
present, hash-bound, and retained inside the exact controller request, while
the terminal attestor required the same semantic object as a first-class
evidence binding. The failed seal incident was retained. The three existing
authorization objects were materialized without changing their content, the
evidence graph replay reported zero missing artifacts, and a second seal
produced the signed result above. The attestor regression is covered by a
focused test so future runs recognize the inline authoritative evidence
directly.

## Consequence

This pass selects Terra/medium as a compatible ecological author population.
It does **not** itself release the 48-attempt A/A. A new, signed successor
runtime must bind this result, the current baseline-v3 production identity,
the unchanged randomized 48-assignment schedule, the subscription-native task
transport, and the full reviewer/adjudicator/pairwise lifecycle before the
first experimental brief can be released.
