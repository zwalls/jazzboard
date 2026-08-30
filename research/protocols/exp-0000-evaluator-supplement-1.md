# EXP-0000 Evaluator Supplement 1 — V3 blinded measurement-readiness review

- Supplement version: 1
- Status: preregistered after v3 evidence sealing; evaluator brief not delivered
- Parent protocol: `research/protocols/exp-0000-live-author-smoke.md`
- Author amendment: `research/protocols/exp-0000-amendment-2.md`
- Partition: development only
- Author attempt: `smoke-exp0000-checkout-solmax-v3`
- Frozen evaluator config: `research/data/exp-0000-v3-primary-review-config.json`
- Evaluator-config file SHA-256:
  `sha256:4f004adeaccdd52c0e4f7595a5401e0b00f5e388bbf2b7b70c21ffdc3de31805`
- Evaluator-config canonical JSON SHA-256:
  `sha256:4d4aa23df44837b2a86ef189aecc1e868a1e38c55ee2fffdb2e901a3f93f1806`
- Authorized evaluator runner SHA-256:
  `sha256:1888105ca84a46a69f16a1439b704222201f7d04a7bb9afa3d8c87a462c4c5a6`
- Sealed or validation task data permitted: none

This supplement was written after the v3 author context closed and its attempt
directory became immutable, but before any evaluator prompt or Responses API
request. It does not amend, reinterpret, or expose author behavior. Its sole
purpose is to test whether the repaired blinded evaluator can verify and score
one complete development-only evidence package without seeing treatment,
pairing, author identity, room secrets, traces, or evaluator-only data beyond
the frozen public-task rubric.

## Frozen evidence commitments

- Attempt-bundle file SHA-256:
  `4d688dbfa7f7b1dc6e17511a44a9596c49fc069cb1d417547f00741a0adc98ae`
- Artifact root:
  `7a33f2e367bc0c70cfbace8db24fcc6c395313f8553231f85cfaaaa38a9745b5`
- Author-evidence root:
  `51e0cd6a857773d7cd78b0ca1b9b9a27e78d5a52ee13fc3fbdd41834b5b130e1`
- Exact spectator final-state SHA-256:
  `4899b4040b3d8bac10645fe542122b6330cd3594e50925092fff689b35134b78`
- Exact spectator PNG SHA-256:
  `15552c1d0ec0213def7b82928417eee014816d7a52cdf93301c6bf5e5757f0df`
- Spectator room revision: `4`
- Task ID: `dev-architecture-create-checkout`
- Exact evaluator-rubric commitment:
  `sha256:6fbd874f70c42f8119a3ae71234b40a987720514347dfa8aa1075a3754832cce`

The evaluator must recompute every commitment and fail before a provider call
on any mismatch. It may use only the sanitized final semantic state, exact
revision-bound PNG, and the frozen evaluator rubric. Author events, author
pixels, author prose, room credentials, condition labels, pair metadata, and
source code are prohibited evaluator inputs.

## Frozen reviewer condition and budgets

- Opaque reviewer ID: `rvw-7f4c2d91`
- Role: one independent primary reviewer
- Model: `gpt-5.6-sol`
- Reasoning effort: `high`
- Input-token ceiling: `60,000`
- Output-token ceiling: `8,000`
- Storage: `store: false`
- Tools: none
- Parallel tool calls: disabled

Pricing is frozen at USD $4.00 per million uncached input tokens, $0.40 per
million cached input tokens, and $20.00 per million output tokens from the
official GPT-5.6 Sol price published on 2026-08-30. The runner must retain
provider usage and compute a cost estimate from those frozen inputs. This
single review is an infrastructure/scorer smoke, not a substitute for the
two-primary plus independent-adjudicator design required by EXP-0001A.

## Stopping, retention, and claims

Any evidence mismatch, rubric mismatch, leakage, provider error, schema error,
budget exceedance, or failed reviewer output is the retained result for this
opaque reviewer ID. It must not be overwritten or rerun under the same ID.
Acceptance requires complete evidence and every mandatory criterion passing;
indeterminate is not acceptance.

Regardless of outcome, this one review cannot estimate product quality,
success rate, evaluator reliability, A/A bias, causal lift, equivalence, or a
percentage improvement. It only decides whether the v3 evidence/evaluator path
is sufficiently complete to proceed to a separately frozen calibration gate.
