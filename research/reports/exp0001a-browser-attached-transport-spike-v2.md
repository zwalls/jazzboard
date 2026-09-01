# EXP-0001A browser-attached transport spike v2

Date: 2026-09-01 (America/Los_Angeles)

Disposition: **PASS for direct projectless Codex/WebMCP transport and progressive drafts; qualification still required**
Public evidence: [`../data/exp0001a-browser-attached-transport-spike-public-v2.json`](../data/exp0001a-browser-attached-transport-spike-public-v2.json)

## Question

After the production draft-lifetime fix, can one fresh projectless
`gpt-5.6-terra` / `medium` Codex task use only browser-exposed WebMCP to create,
progressively stage, atomically finish, inspect, and correct a real Jazzboard
artifact without repository access, private APIs, prepared coordinates, shared
history, evaluator context, or user confirmation?

## Result

Yes. The task created a private production room, discovered Jazzboard through
the page's WebMCP registry, staged one cumulative six-node/six-connector
architecture as draft revision 1, and called `finish_canvas_draft` once. The
finish returned `applied`; no direct-transaction creation fallback was used.
The task then read authoritative state, inspected the Diagram, reviewed live
pixels, and made one revision-checked connector-label correction.

The author task completed in 152.752 seconds. Its nine WebMCP calls include one
truthfully retained schema-validation failure for unsupported
`nodeMetadata.kind` values; the task corrected that public-schema error and
continued. Exact tokens, resolved model snapshot, and subscription consumption
were not observable and were not estimated.

## Independent audit

The primary orchestration context independently joined the exact room as a
spectator. The production page exposed no spectator mutation tools. Independent
reads verified:

- one first-class Diagram titled `Resilient Delivery Architecture`, revision 2;
- six explicitly classified semantic nodes and six object-bound connectors;
- two agent-attributed mutation activity records;
- room revision 3 at author completion and revision 4 after spectator join; and
- no remaining draft after commit.

The independent audit also framed the exact Diagram and reviewed the final
browser pixels. Room, invite, participant, and task identities remain only in
the private evidence root.

## Decision

This result supersedes the v1 spike's draft-expiration caveat. It proves that
the current production deployment supports the intended fresh projectless
Codex transport and progressive draft lifecycle without a consent gate. It is
not itself an A/A release authorization: the frozen three-task Terra/medium
qualification and its blinded reviews must still pass before any randomized
experiment assignment is released.
