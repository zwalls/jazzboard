# WebMCP workflows: speed with correctness and visual quality

Experimental successor to the context-recovery candidate, on
`codex/webmcp-context-recovery`. No merge or deployment.

## Product change

EXP-0035 showed that availability alone was insufficient: a candidate author
requested a full board before discovering summary mode, and another performed
12 serial mutations where baseline used one atomic batch.

The registered descriptors, core capabilities, architecture/illustration
quickstarts, and generated agent guides now agree on two workflows:

- Broad inventory and orientation start with a bounded room summary. Known IDs
  or narrow semantic scopes go directly to scoped reads without an extra
  orientation call. Full records remain available when required content or
  geometry is absent from a summary. Blank creation targets skip unnecessary reads.
- Related metadata edits use atomic transactions of up to 200 revision-guarded
  operations, with no draft delivery. A generic two-object example shows the
  contract. Larger sets obey transaction limits; no instruction paces animation.

The candidate preserves authoritative revision checks, progressive visible
creation, relationship assertions, correction of unintended findings, deliberate
artistic overlap, and final exact-revision pixel inspection. It supplies no
benchmark-specific answers or predetermined artistic geometry. Public guidance
version is 1.36.0.

## Experiment change

The next pilot includes existing-board tasks plus a technical checkout diagram
and a layered character portrait. Correct facts, readable routes, visual
coherence, deliberate layering, and protected content are hard gates before
accepted completion speed is compared.

Research-only recording wraps actual native tool invocations, including loops
and concurrent calls. It retains exact JSON/UTF-8 counts, error classifications,
and a sealed ledger. Missing, truncated, restarted, pending, or dropped capture
invalidates completeness. It does not change production tool results or add
author-facing telemetry tools.

Independent validators check preflight evidence and recompute ledger counts and
hashes rather than trusting an author's claimed success or partial host output.
The integration passed native browser smoke checks on both frozen builds.

## Current evidence

- 343 focused WebMCP, agent-guidance, and experiment tests passed at this stage
  with loopback permission and Node's experimental web storage disabled.
- Production build and full TypeScript check passed.
- Registration, core, and quickstart payload limits remain enforced.
- Two distinct `.localhost` hostnames successfully loaded native Jazzboard tools.
  The first had a host-scoped HttpOnly guest cookie; the second started with no
  cookies and no recent rooms, then obtained a distinct signed guest identity.
- Developer-protocol calls exceeded requested timeouts during preflight. Those
  observations are a transport limitation, not speed evidence.
- Product candidate commit: `5a67b21505b50c643bf282774f0e7bf4698edf05`.
  The final browser-only observer produced complete native ledgers on baseline
  and candidate, including loop invocations and a structured revision error.
- A synthetic Chromium calibration measured 13.900 ms median / 18.090 ms p95
  added callback cost for a 267,642-byte result. The prior failed Node VM method
  and subsequent method amendment are preserved in the preparation report;
  neither result establishes actual author latency.

See [the preparation report](../research/reports/exp-0036-preparation.md) for
the failed development probes, final verified capture, calibration limitations,
and frozen eight-author/four-reviewer study.

This is an implemented candidate and measurement work, not a proven agent speed
or quality gain. The failed EXP-0035 advancement decision remains unchanged.
