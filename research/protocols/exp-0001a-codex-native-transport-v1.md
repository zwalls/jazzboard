# EXP-0001A Codex-native transport amendment v1

- Status: active amendment; the version-1 gate is revoked; the narrowly scoped
  fixed-key-signed version-2 semantic transport/activity gate has passed; full
  A/A execution remains blocked pending the immutable prebrief freeze and
  complete coordinator validation
- Supersedes: every direct OpenAI Responses API, API-key, token-price, and
  dollar-spend execution provision in EXP-0001A
- Authentication: ChatGPT sign-in only
- Author model: `gpt-5.6-sol`
- Author reasoning: `max`
- Scope: public development partition only

Official transport basis: [Codex authentication](https://learn.chatgpt.com/docs/auth)
distinguishes ChatGPT sign-in from API-key sign-in, and
[Codex pricing](https://learn.chatgpt.com/docs/pricing) documents subscription
access separately from standard API billing.

## Correction

EXP-0001A uses isolated Codex tasks backed by the signed-in ChatGPT account.
It must not read `OPENAI_API_KEY`, authenticate Codex with an API key, or send
requests to the OpenAI Responses API. A preflight must run the supported
`codex login status` command and release work only when the result proves
ChatGPT authentication. API-key, unauthenticated, ambiguous, or failed status
is a hard stop. The preflight records only the authentication method and safe
command evidence; it never reads or retains credentials.

The experiment has no dollar-denominated spend authorization, token-price
model, or API spend ledger. Subscription or ChatGPT-credit usage is recorded
only when Codex exposes it authoritatively. Exact token counts, resolved model
snapshots, or credits that are not exposed are the literal value
`unobservable`; they are never inferred or estimated.

## Mandatory disposable spike

The 48-attempt A/A remains blocked until one disposable run passes all of the
following checks:

1. a fresh projectless Codex task is created with GPT-5.6 Sol and `max`
   reasoning through the signed-in ChatGPT account;
2. the task receives only one public brief, one exact private Jazzboard invite
   URL, and permission to use the ordinary browser/WebMCP surface;
3. it has no Jazzboard repository, private room API, prepared coordinates,
   prior task history, fork, evaluator context, or answer material;
4. it opens and joins the private room, discovers browser-exposed WebMCP
   tools, builds an artifact, performs a bounded inspection, and returns a
   terminal result; and
5. an independent coordinator read proves authoritative Jazzboard objects,
   revisions, attribution, and artifact hashes for that same room and task.

A partial run, a UI-only mutation, an author assertion without server evidence,
or evidence from a different room/task cannot pass the spike. Historical
version-1 evidence is not itself release authority. The active runtime accepts
only the exact, non-revoked version-2 recovery payload and its fixed Ed25519
`spike_gate` signature. That v2 gate proves semantic transport and
authoritative activity; it does not claim PNG-byte provenance, which is
collected separately for each experimental attempt.

## Codex task transport

Every author attempt is a brand-new projectless Codex task. Its context is
limited to the public task brief, exact private room invite, and permitted
browser/WebMCP access. It receives no project, shared history, fork, prepared
geometry, author transcript from another attempt, condition meaning, or
evaluation material. Fresh room and Codex task identifiers are retained in
private provenance and replaced by digests or redacted references in
publishable artifacts.

Primary reviewers, adjudicators, and pairwise visual judges each run in fresh,
separate Codex tasks. A reviewer receives only the public requirement, frozen
rubric, sanitized semantic state, and revision-matched images. It receives no
author transcript, opaque condition label, paired outcome, private room
credential, or repository access. Author and reviewer task identifiers must
never be equal.

## Accounting and interruptions

Per task, retain:

- Codex task count and immutable task identifier;
- requested model and reasoning setting;
- resolved model only when exposed, otherwise `unobservable`;
- wall time;
- WebMCP calls and failures;
- room revision and inspection counts;
- subscription usage or ChatGPT credits only when exposed, otherwise
  `unobservable`;
- exact tokens only when exposed, otherwise `unobservable`; and
- usage-limit interruption state and evidence.

When a usage limit is reached, the coordinator stops before releasing the next
brief. Every begun attempt remains in its assigned denominator. Resumption
starts at the next assignment that is provably `not_started`; it never replaces
or silently reruns a begun attempt. Dispatch remains interleaved and keeps A0
and A1 balanced across chronological blocks and usage-reset windows.

The v1 coordinator preallocates capacity for 216 neutral availability probes.
Exhausting that capacity is a fail-closed infrastructure stop: it cannot drop,
replace, reorder, or retry an experimental assignment. Continuing beyond that
bound requires a new reviewed protocol/runtime version rather than mutating an
active run.

## Unchanged scientific contract

The twelve-task architecture/drawing benchmark, frozen rubrics, randomized A/A
schedule, artifact hashing and provenance, blinded independent review,
adjudication, pairwise visual comparison, failure taxonomy, cluster-aware
analysis, all-attempt retention, and sealed-test protections remain unchanged.

## Execution gate

The A/A batch gate is closed until both the Codex authentication preflight and
the disposable spike receipt pass. A direct API runner or dollar spend receipt
cannot open it. Any change to the task transport, prompt envelope, isolation
boundary, accounting schema, or pause/resume policy after the first A/A brief
requires a new version and freeze.
