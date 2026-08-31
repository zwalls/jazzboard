# EXP-0001A Codex/WebMCP transport spike

Status: **historical pass record; revoked as execution authority**

Public evidence: [`research/data/exp0001a-codex-webmcp-spike-public-v1.json`](../data/exp0001a-codex-webmcp-spike-public-v1.json)

This report is retained for audit history only. Its PNG claim was not bound to
authoritative export bytes, so its gate cannot release EXP-0001A. The current
transport-only result is documented in
[`exp0001a-codex-webmcp-spike-v2.md`](exp0001a-codex-webmcp-spike-v2.md).

## Question

Can one fresh, projectless Codex task authenticated through the signed-in ChatGPT
account operate a private Jazzboard exclusively through the page's browser-exposed
WebMCP tools, produce a non-trivial artifact, inspect and correct it, return a
terminal result, and leave independently verifiable authoritative canvas evidence?

## Result

Yes. The retained task used the frozen `gpt-5.6-sol` / `max` request, joined an
exact private invite, discovered the page's WebMCP surface, and authored a
first-class three-stage semantic diagram with two labeled connectors and a
heading. Its first transaction was rejected by strict input validation without a
room mutation. The task consulted the exposed authoring contract, resubmitted a
valid cumulative draft, committed it, inspected semantic and live pixel evidence,
then corrected a truncated heading and two connector-label collisions while
preserving semantic identities.

The terminal report was followed by an independent authoritative readback:

- final room revision: 4
- final diagram revision: 2
- authoritative semantic objects: 6
- WebMCP calls retained in the trace: 19
- WebMCP failures: 1 schema-valid, non-mutating rejection
- private task workspace: projectless
- Jazzboard repository reads: 0
- private API calls: 0
- direct provider API calls: 0
- direct HTTP requests: 0

The browser workflow required one platform bootstrap command to read Codex's
installed Browser skill. The evidence model records this explicitly: one allowed
filesystem read of the exact installed skill, zero writes, zero project or
repository reads, and zero other command executions. It is not silently treated
as an empty trace.

## Integrity and privacy

Ten private evidence artifacts are bound by exact byte length, SHA-256 digest,
and an artifact-set root. The private evidence and A/A gate are retained below
the ignored `.research-private` root with owner-only permissions. The committed
public projection contains only digests, frozen settings, task identity, aggregate
outcomes, and the literal room location `[REDACTED]`; it contains no room code,
room ID, invite URL, or authorized room URL.

The A/A execution gate was emitted only after the evidence passed strict schema,
artifact, isolation, revision, terminal-result, public-redaction, and freshness
verification. This pass authorizes rebuilding and exercising the Codex-native
coordinator; it does not authorize any legacy API-key or direct provider path.
