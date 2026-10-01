# WebMCP context and recovery upgrade

Implemented on `codex/webmcp-context-recovery`. No merge or deployment is part of this change.

## Problem and behavior

Previously, object and Diagram searches could only return the first bounded page. Room orientation returned full object geometry and presence, and checking draft status repeated the entire candidate. An agent working on a large board had no complete, revision-consistent pagination path and paid unnecessary context costs for status reads.

The existing tools now support:

- `read_room_state({detail: "summary"})`: counts, policy, exact revision, a bounded Diagram index, selection, and actionable next reads. Full reads can also pin `expectedRoomRevision`.
- `query_objects({objectIds: [...]})`: exact IDs combined with existing semantic filters, with explicit missing IDs.
- `query_objects` and `find_diagrams`: `nextPageInput` carries filters, offset, and the exact room revision. Concurrent edits reject continuation; recovery instructs the agent to discard partial pages and restart.
- `read_canvas_drafts({detail: "summary", owner: "self"})`: bounded status, counts, expiry, and presentation progress. One exact full read retrieves geometry and temporary references when needed.

Room and draft reads still default to full detail. Authorization, mutation behavior, the 54/18 participant/spectator inventories, and authoritative revision checks remain intact. Capability guidance and generated agent documents advertise the new workflow. Equivalent routing-schema constraints and shorter descriptions keep registration within the existing 57,000-byte budget; core capabilities remain below 5,000 bytes.

## Verification

- 473 focused WebMCP, domain, draft, and agent-document tests passed under Node 25 with `NODE_OPTIONS=--no-experimental-webstorage`.
- The new Chrome/Playwright regression passed: room creation, registered-tool discovery, summary orientation, complete pagination, exact-ID reads, rejection after a concurrent edit, draft summary/full recovery, and discard.
- TypeScript, lint on changed code, and a production build passed. Repository lint reports existing research warnings.
- A 5,000-object/500-Diagram fixture verifies summary output below 16 KiB and below 1% of the equivalent full response.
- The full repository suite is not green: research fixture preflight, frozen-runtime/catalog, timeout, and Node 25 web-storage failures remain. The fixture preflight failure was reproduced against an untouched archive of baseline commit `f7762da4ea7d1603671a35b4912143c4bff83f34`.

## Limits of the evidence

These changes reduce model-visible responses when summary mode is used; the client still retrieves full authorized room/draft state internally. Full detail is preserved for compatibility, so agents must select summary mode to realize that saving. The browser regression uses the repository's WebMCP registration shim with real application execution, not an external AI host. Tests establish retrieval correctness and response-size reduction, not improved model task success or visual quality.

The subsequent eight-attempt [EXP-0035 study](../research/reports/exp-0035-context-recovery.md) did **not** demonstrate improved agent performance. Both conditions passed 3/4 under the frozen grader (one candidate host-lock failure and one baseline exact-output failure). The candidate was slower in both fully accepted matched edit pairs. Summary and exact-ID reads were used, but complete byte measurements were unavailable and browser storage was shared across attempts. Keep this feature experimental pending better-isolated replication and stronger workflow guidance.
