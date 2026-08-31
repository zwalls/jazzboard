# Codex/WebMCP disposable spike protocol v1

Status: **historical and revoked as execution authority**

This version required a PNG artifact but could bind only local-export metadata,
not the downloaded bytes. It therefore must not authorize EXP-0001A. The
current transport-only eligibility protocol is
[`codex-webmcp-disposable-spike-v2.md`](codex-webmcp-disposable-spike-v2.md).
Version 2 deliberately proves projectless Codex/WebMCP semantic authoring and
authoritative Jazzboard activity; it makes no PNG provenance claim.

The passing run is summarized in
[`research/reports/exp0001a-codex-webmcp-spike-v1.md`](../reports/exp0001a-codex-webmcp-spike-v1.md)
and its secret-free projection is retained at
[`research/data/exp0001a-codex-webmcp-spike-public-v1.json`](../data/exp0001a-codex-webmcp-spike-public-v1.json).
This result does not authorize any legacy provider transport.

## Purpose

This spike proves the experiment can use the signed-in ChatGPT Codex subscription as its model transport without exposing the Jazzboard repository, private APIs, API credentials, prepared geometry, or evaluator context to an author. It is deliberately one disposable author task and one fresh private room. It is not an experimental observation and must not enter the A/A analysis denominator.

The spike implementation and evidence contract live in `src/lib/research/codex-webmcp-spike.ts`. A reported success is insufficient: `createCodexWebMcpAaGate` releases A/A only when the immutable evidence validates as `pass`.

## Frozen task configuration

- Create a brand-new Codex task with the Codex task-creation interface.
- Use an empty **projectless** workspace, not a saved project or worktree.
- Request `gpt-5.6-sol` with reasoning effort `max`; mark both settings frozen.
- Do not fork a task, reuse a conversation, share history, or supply a source task ID.
- Do not grant Jazzboard-repository access, filesystem project context, private API access, `OPENAI_API_KEY`, direct HTTP access, or any direct provider API transport.
- Give the author only:
  1. a public artifact brief;
  2. the exact fresh private Jazzboard room URL; and
  3. permission to use the browser and the WebMCP tools exposed by that page.

The prompt must be created with `createCodexWebMcpPromptEnvelope`. The constructor rejects prepared coordinates, repository paths, undeclared URLs, private API instructions, evaluator/rubric context, author transcripts, previous-attempt context, forks, and shared history.

The private access URL must be one of two exact credential-free production forms:

- `https://www.jazzboard.xyz/#join=<CODE>` where `<CODE>` is exactly six uppercase unambiguous Jazzboard characters; this is the required cross-browser-session flow for the fresh disposable task; or
- `https://www.jazzboard.xyz/room/room_...` only when that browser session is already server-authorized for the room.

Arbitrary hosts or subdomains, ports, user information, query parameters, additional fragments, fragment parameters, lowercase/fuzzy codes, and legacy four-digit codes are invalid. The invite URL and the authoritative room ID must be joined by `computePrivateRoomAccessBinding`; this private SHA-256 binding is mandatory even though an invite URL does not itself reveal the room ID.

## Preflight

Before creating either the room or task:

1. Record a credential-free Codex authentication receipt that says the active method is `chatgpt`.
2. Stop with `AUTH_NOT_CHATGPT` if the method is `api_key`.
3. Stop with `AUTH_UNOBSERVABLE` if the authentication method cannot be determined safely.
4. Confirm the experiment transport contains no direct provider API request and the task environment will not receive an API key.

The receipt may record the authentication method and observation time. It must never retain a credential, cookie, token, or authorization header.

## Disposable run

1. Create a new private Jazzboard room and retain its private room ID, exact invite URL, invite/room binding, creation time when observable, and creation-receipt digest in restricted experimental evidence. Use literal `unobservable` for a room creation time the product does not expose; never invent one.
2. Create a fresh projectless Codex task. Retain the task ID, host ID, creation time, creation-receipt digest, requested settings, and the resolved settings when observable.
3. Permit exactly one platform bootstrap command: read the installed Browser skill at the frozen `CODEX_BROWSER_SKILL_PATH`. Retain the skill-file digest and command-trace digest. The bootstrap may perform one filesystem read and no write, project/repository read, direct HTTP request, or other command.
4. Send the clean prompt envelope to the task.
5. Require the task to open the supplied invite in its browser, discover the landing WebMCP tools, and successfully call `join_room` before any mutation. The join establishes the new guest session's server-side authorization.
6. Require the task to discover and use the participant room's browser-exposed WebMCP tools to build the requested artifact.
7. Require at least one successful semantic mutation.
8. Require a subsequent successful `read_room_state` call whose authoritative room revision matches the final retained canvas state.
9. Require a final canvas inspection and PNG evidence.
10. Require the Codex task to return a terminal result only after the authoritative state read.

The task must not be given Jazzboard source code, a Git checkout, a private server endpoint, prepared coordinates, an author transcript, a condition label, an evaluator rubric, or a paired result. Reading the platform-owned Browser skill is an instruction bootstrap outside every project; it does not relax the zero Jazzboard-repository/source-access boundary.

## PASS evidence

A PASS is valid only when all of the following are present, self-consistent, and bound by SHA-256 digests:

- ChatGPT authentication preflight;
- fresh projectless Codex task identity and creation receipt;
- fresh private Jazzboard room identity, exact invite/access URL, SHA-256 access binding, and creation receipt;
- frozen requested model and reasoning settings;
- one observable platform bootstrap limited to the exact installed Browser skill read;
- explicit absence of Jazzboard-repository/source reads, other command execution, filesystem writes, direct HTTP access, private API access, API-key availability, direct provider API requests, project context, fork ancestry, and shared history;
- clean prompt-envelope artifact;
- sorted, unique browser-exposed WebMCP inventory and its digest;
- contiguous WebMCP call trace with argument/result digests and retained failures, including `join_room` before the first invite-based mutation;
- successful mutation plus a later authoritative `read_room_state`;
- monotonically observed room revisions that advance during the run;
- final semantic object IDs and object revisions;
- authoritative semantic-state artifact and PNG artifact;
- terminal author result;
- observed spike start/completion timestamps and exact total wall time;
- fixed required-artifact set root; and
- an evidence digest covering the complete private record.

The verifier may also receive prior task and room ID sets. Any reused identifier fails freshness validation even if the creation attestation says `fresh`.

WebMCP-discovery, per-WebMCP-call, revision-observation, platform-bootstrap, and room-creation timestamps may be the literal `unobservable` when the task/browser/product record does not expose a trustworthy wall-clock time. They must never be estimated. Monotonic sequence numbers remain mandatory; only observed timestamps participate in temporal range and ordering checks.

## Failure retention

Any terminal state other than a verified PASS is retained as `fail` with one or more timestamped phase-specific reasons. Failure codes include authentication mismatch, task or room provisioning failure, isolation violation, WebMCP discovery/call failure, missing terminal result, missing authoritative evidence, artifact integrity failure, timeout, and subscription usage limit.

A failure record is evidence, not permission to continue. It always yields a blocking A/A gate. The coordinator must not retry this spike by overwriting its record; a retry receives a new spike, task, and room identity.

## Privacy and publication

The private room ID, invite code, invite/access URL, and access binding remain in access-controlled experimental evidence so freshness and authorization can be audited. Public evidence is generated only with `createPublicCodexWebMcpSpikeEvidence` and:

- replaces the private room location with `[REDACTED]`;
- omits the raw room ID, invite code, invite URL, and direct room URL;
- publishes no room code, credential, cookie, token, or session value;
- retains the Codex task ID, requested settings, isolation assertions, timestamps, terminal/state/image digests, creation-receipt digest, artifact-set root, and private-evidence root.

## Release rule

The experiment coordinator must call `assertCodexWebMcpAaExecutionAllowed` with both the gate and its private spike evidence before releasing any A/A author brief. The assertion revalidates the evidence and its freshness and verifies that the gate is bound to its exact evidence digest. The gate remains blocked when evidence is absent, structurally invalid, hash-invalid, semantically incomplete, a retained failure, stale/reused, API-key authenticated, or isolation-violating. Only the single reason `VERIFIED_CODEX_WEBMCP_SPIKE_PASS` is an executable allow decision.
