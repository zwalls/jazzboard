# EXP-0003 qualification 4 — targeted draft repair and direct pixel capture

- Date: 2026-09-02
- Status: non-scoring local development qualification
- Branch: `feature/agent-speed-quality`
- Author task: `01a0611e-11dc-70c1-a806-fec000403e52`
- Author model: `gpt-5.6-terra`, reasoning `medium`
- Room: `room_dec7c3ad-99e4-b7f5-4a29-4b580151f80f` (`XBU52N`)
- Candidate origin: `http://localhost:3010`

## Isolation and transport

The author ran in a fresh projectless Codex task using ChatGPT subscription
authentication. It received only the frozen public dense-routing task packet
and the exact private room URL. It had no Jazzboard repository, private API,
prepared coordinates, evaluator context, prior author history, or paired
result. All canvas work used browser-exposed WebMCP.

This is not the frozen production `J1` result because the candidate ran on a
local development origin. It is retained as development evidence and cannot
be pooled with the production baseline as a sealed causal estimate.

## Observed result

| Measure | Production `J0` | Qualification 4 | Observed change |
| --- | ---: | ---: | ---: |
| Author wall time | 477,603 ms | 253,862 ms | -223,741 ms (-46.8%) |
| Required entities | 9 / 9 | 9 / 9 | preserved |
| Required relationships | 9 / 9 | 9 / 9 | preserved |
| Deterministic failures | 9 | 0 | -9 |
| Deterministic warnings | 3 | 3 | unchanged |

The authoritative room ended at revision 2 with one first-class Diagram at
revision 1, nine semantic nodes, nine directed labeled connectors, no active
lease, and exact Diagram membership for all 18 objects. The retained geometry
report contained two connector-crossing warnings and one connector-label/edge
warning. There were no object intrusions, label/object collisions, truncated
labels, congested ports, unsupported geometry, or blocking findings.

The author used one architecture quickstart, staged the whole artifact as an
atomic progressive draft, performed draft-time correction, used the targeted
patch path for the final narrow connector repairs, committed once, requested
exact Diagram inspection, and captured the returned clip directly. The pixel
capture itself took 76 ms and avoided the prior projectless image-library
failure and full-viewport crop detour.

The trace contains 13 browser-host calls, including nine explicit WebMCP calls
visible in the retained task output: two capability reads, five draft
transactions, one draft commit, and one exact inspection. One failed shell
call attempted an obsolete browser-skill path before the author found the
installed browser skill; this is host setup noise rather than Jazzboard
transport time.

## Candidate mechanism supported by this qualification

1. Strict registered transaction schemas and compact examples prevented the
   unsupported-field and ambiguous curved-route failures seen earlier.
2. Draft receipts returned actionable semantic geometry context before
   publication.
3. `updateMode: patch` allowed the author to resend only an affected stable
   connector reference instead of the complete cumulative candidate for a
   narrow repair.
4. Quantitative label-corridor and routing guidance improved the first-pass
   composition without choosing coordinates or layout on the author's behalf.
5. The inspection contract exposed a documented non-mutating direct clip as
   the preferred pixel path while preserving full-viewport crop as a fallback.

## Promotion decision

Qualification 4 satisfies the development promotion threshold: exact
semantics, zero blocking deterministic findings, actual pixel inspection,
progressive atomic construction, and materially lower wall time. Freeze the
candidate, run the full automated/build gates, deploy it, and release one
fresh matched production `J1`. Broad product claims remain prohibited until
multi-task randomized replication.
