# Codex/WebMCP disposable transport spike protocol v2

Status: **verified PASS; fixed-authority gate signed**

Public evidence:

- [`exp0001a-codex-webmcp-spike-public-v2.json`](../data/exp0001a-codex-webmcp-spike-public-v2.json)
- [`exp0001a-codex-webmcp-spike-gate-public-v2.json`](../data/exp0001a-codex-webmcp-spike-gate-public-v2.json)
- [`exp0001a-codex-webmcp-spike-v2.md`](../reports/exp0001a-codex-webmcp-spike-v2.md)

## Question

Can a brand-new projectless Codex task, authenticated through ChatGPT rather
than an API key, enter one freshly provisioned private Jazzboard room, discover
the page's browser-exposed WebMCP tools, author a non-empty first-class Diagram,
inspect exact revisions, return a terminal result, and leave independently
reconstructable authoritative semantic and activity evidence?

This is a transport-eligibility spike. It is not an author-quality score, an
experimental observation, or a PNG provenance test. It supersedes v1 for
release eligibility because v1's local PNG-download metadata did not
cryptographically bind the downloaded bytes.

## Frozen isolation and settings

- ChatGPT-authenticated Codex only; API-key, unknown, failed, or contradictory
  authentication blocks execution.
- Fresh projectless task with no fork, source-task history, saved project, or
  Jazzboard checkout.
- Requested model `gpt-5.6-sol`, reasoning effort `max`; resolved model and
  reasoning are recorded as `unobservable` when Codex does not expose them.
- The task receives only the public brief, one exact private invite, one random
  coordinator challenge, and Browser/WebMCP permission.
- One shell command may read the installed Browser skill. The retained task
  must contain no repository read, filesystem write, direct HTTP/provider call,
  private API access, dynamic code escape, or other execution surface.

## Evidence and authority model

The gate accepts only the independently audited retained task. The SHA-256 of
the complete raw `read_thread` CallToolResult and the canonical SHA-256 of all
28 ordered Browser source blocks are fixed in the recovery verifier. Changing
the prompt, task items, code, call order, status, or terminal answer invalidates
the gate.

Every source block is parsed before reconstruction. The verifier rejects Node
capability identifiers, computed or dynamic imports, computed capability
members, assignments, prototype/constructor escapes, dynamic callables,
filesystem/network methods, non-Browser tools, hidden or caught WebMCP calls,
and calls without an immediate fail-closed result guard. Executed adversarial
tests cover `process.getBuiltinModule` filesystem and HTTPS access, computed
provider destinations, dynamic import, direct assignment monkey-patching, and
`Object.assign` monkey-patching.

Attribution is an authority-reconstructed inference, not an end-to-end
provider signature. The pinned task joins the private room, obtains its session
participant ID, writes the coordinator challenge and participant ID into the
sole Diagram transaction, verifies the same `selfParticipantId` in the final
room read, and reports the same Diagram and revisions. Independent Jazzboard
activity then matches that participant, display name, task window, affected
objects, Diagram, and final revision guards. The local EXP-0001A Ed25519
authority signs this reconstruction.

## PASS conditions

A v2 PASS requires all of the following:

- a fresh pre-run and signing-time `codex login status` receipt proving ChatGPT
  authentication;
- exactly one completed projectless Codex turn with the frozen requested model
  and reasoning level;
- exact raw-task and ordered Browser-trace commitments matching the audited
  one-shot constants;
- one fresh private room, exact invite join, browser WebMCP discovery, and no
  failed WebMCP call;
- at least one authoritative canvas transaction creating exactly one non-empty
  first-class Diagram;
- post-mutation `read_diagram`, `analyze_diagram_layout`,
  `inspect_canvas_scope`, and `read_room_state` calls;
- final Diagram membership, semantic state, activity, participant attribution,
  object/Diagram guards, and terminal result that reconcile at exact revisions;
- no private room code, room ID, invite URL, guest session, or credential in
  public evidence; and
- a non-revoked fixed-authority `spike_gate` signature.

The transport spike does not require layout quality to pass. Layout status and
finding count remain evidence; they are not rewritten into a success. Artifact
quality belongs to the frozen benchmark and blinded evaluation stages.

## Deliberate PNG boundary

No PNG bytes or digest appear in v2 evidence. Jazzboard's
`export_canvas_png` performs a local browser download and returns revision,
dimension, and byte-length metadata, but not an authoritative byte digest.
Those fields cannot prove that a later local file is the exported image.

The full experiment uses a different reviewer-artifact path that retains image
content at collection time, validates the complete PNG structure and CRCs, and
binds its byte length and SHA-256 into the sealed evidence packet. That later
path does not retroactively validate a spike PNG and is not used to justify the
v2 transport decision.

## Release rule

The signed v2 gate is necessary but not sufficient to release an A/A brief.
The coordinator must still verify the complete prebrief freeze, deterministic
runtime bundle, deployment and WebMCP contracts, ChatGPT authentication,
append-only scheduler/accounting state, no-brief checkpoint, and exact next
action. A usage-limit pause, missing authority, stale checkpoint, unobservable
required trace, or any digest mismatch remains a hard stop.
