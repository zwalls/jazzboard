# Jazzboard

Jazzboard is a multiplayer architecture canvas where humans and participant-owned agents share one authoritative semantic model. tldraw provides the infinite-canvas UI, while browser-native WebMCP tools let text, voice, and other agent interfaces operate the same room without pixel automation. The deployed demo is [jazzboard-rho.vercel.app](https://jazzboard-rho.vercel.app).

## Run locally

Requirements: Node.js 22+ and Google Chrome for browser tests.

```bash
npm install
npm run dev
```

Open `http://localhost:3000`. Ordinary `next dev` intentionally uses process-memory room/image storage and reconnecting polling because the Vercel WebSocket upgrade runtime is not present. Use `npm run dev:vercel` to validate the native upgrade path.

## WebMCP workflow

The landing page registers five tools, so a compatible AI interaction can complete the room lifecycle without visual clicks:

- `create_room`
- `join_room`
- `list_recent_rooms`
- `open_recent_room`
- `remove_recent_room`

`join_room` requires one exact four-digit code and never searches or enumerates rooms. Recent-room candidates come only from this browser's local storage; listing and opening them verify the current signed guest session's access to each exact room ID. There is no global room directory, room-search endpoint, or cross-user recent history.

Inside a room, tool registration follows the signed session's current role:

| Surface | Tools |
| --- | --- |
| Passive semantic reads | `read_room_state`, `read_selection`, `read_collaboration_state`, `query_objects`, `read_neighborhood`, `find_diagrams`, `read_diagram`, `describe_diagram` |
| Passive activity and review reads | `list_activity`, `read_activity`, `list_agent_edit_proposals`, `read_agent_edit_proposal` |
| Passive privacy-safe export | `export_canvas_artifact` |
| Participant object editing | `create_text`, `create_shape`, `create_node`, `create_drawing`, `add_image`, `draw_connection`, `update_object`, `move_objects`, `group_objects`, `delete_objects` |
| Participant compound editing | `apply_canvas_transaction`, `layout_objects`, `create_diagram`, `edit_diagram` |
| Participant visual verification | `render_canvas_preview` |
| Participant activity and policy actions | `revert_activity`, `enable_agent_review` |
| Participant reusable-work actions | `create_diagram_template`, `instantiate_diagram_template` |
| Participant private-snapshot lifecycle | `create_readonly_snapshot`, `list_readonly_snapshots`, `revoke_readonly_snapshot` |
| Participant view and collaboration lifecycle | `focus_viewport`, `follow_participant`, `stop_following`, `start_spotlight`, `request_spotlight`, `stop_spotlight`, `join_spotlight`, `leave_spotlight`, `approve_spotlight_handoff`, `dismiss_spotlight_request`, `leave_room` |

Spectators receive only the passive rows above and no mutation tools. They can inspect activity and proposals and export an already-authorized redacted artifact, but they cannot revert, issue a snapshot, create or instantiate a template, change review policy, or operate canvas/collaboration state. Passive reads do not activate an agent or create fake presence. The first successful shared-state mutation or shared agent-viewport operation activates the current session's agent and keeps its activity attributable; private Follow changes and leaving the local room view do not.

The generated `/webmcp.md` and downloadable skill take their landing, participant, spectator, and snapshot-page inventories and counts directly from executable WebMCP constants. Tests fail if those public inventories drift from registration.

## Agent discovery and reusable guidance

Jazzboard advertises its WebMCP-first operating contract on first contact, before React hydrates. The root HTML links `/llms.txt` with `rel="describedby"` and `/agent-guide.md` with `rel="help"`; the root HTTP `Link` header advertises `/llms.txt` and the `/index.md` Markdown alternate. The homepage returns that Markdown representation for an explicit `Accept: text/markdown` request. A Next.js client-instrumentation singleton registers all five landing lifecycle tools before hydration and keeps one registry through the landing page lifetime. Room tools still wait for signed-session authorization and current role resolution; an exact read-only snapshot page registers its local frozen-artifact tools after loading. Hosts should listen for or recheck the registry after navigation rather than assuming an initial empty list is final. The live page's registry remains authoritative.

Chrome currently ships WebMCP through an origin trial. Set `WEBMCP_ORIGIN_TRIAL_TOKEN` to the token enrolled for the exact deployed origin; Jazzboard conditionally emits it only on document routes and never commits or invents a token. Unsupported browsers retain the complete visual workflow.

Native agent hosts may apply descriptor and lifecycle budgets beyond the WebMCP specification. Jazzboard's registration test serializes the exact consumer shape, including production `origin` and a UUID room `pageUrl`, and caps it at 55,000 UTF-8 bytes and 80 tools. It also enforces Chrome's recommended text budgets: 30-character tool names, 500-character tool descriptions, and 150-character parameter descriptions. Shared schemas use references where that removes repetition, while strict Zod validation still runs at execution. Stable page surfaces register once and use callback bridges so ordinary hydration does not create descriptor churn.

Public resources are:

- `/llms.txt`: concise community-convention entry point.
- `/agent-guide.md` and `/webmcp.md`: detailed workflow and complete tool inventory.
- `/privacy.md` and `/glossary.md`: authorization, untrusted-content, crawler, and terminology guidance.
- `/AGENTS.md`: installation, configuration, and usage summary.
- `/skills/jazzboard-webmcp/SKILL.md`: a script-free Agent Skills file suitable for a host's documented local skills directory.
- `/.well-known/agent-skills/index.json`: emerging-draft remote-discovery compatibility with a SHA-256 digest of the exact skill bytes.
- `/robots.txt`, `/sitemap.xml`, and `/sitemap.md`: public discovery indexes that exclude private rooms and APIs.

`llms.txt` is a useful emerging convention, not a formal W3C/IETF standard. Agent Skills defines the `SKILL.md` format, while remote well-known discovery is still a separate draft. Jazzboard labels those boundaries truthfully and does not publish a fake A2A card, remote MCP card, or public catalog of its cookie-authorized internal APIs.

### AI-native diagrams

A `Diagram` is a first-class authoritative record with a stable ID, title, description, explicit type/category, tags, member object IDs, connector IDs, computed bounds, revision, timestamps, creator, and last editor. Shapes also carry an explicit `nodeType` (`service`, `component`, `requirement`, `decision`, or `open_question`); style is never used as the source of classification. Decisions carry structured `proposed`, `accepted`, `rejected`, or `superseded` status, while open questions carry `open`, `answered`, `deferred`, or `closed`. Both support owner and resolution fields, and the server manages `resolvedAt` when workflow state resolves.

Use `apply_canvas_transaction` to create a multi-node diagram and its labeled connectors in one all-or-nothing call. Request-local `tempRef` values can connect nodes and populate diagram membership before stable IDs exist; the response returns the resolved IDs. One optional `auto_layout` operation can arrange newly created node, shape, or text references and a new Diagram reference within that same commit. Existing objects use the separate revision- and lease-checked `layout_objects` tool. Any invalid reference, stale revision, busy object, authorization failure, or bad membership rejects the complete transaction.

Use `query_objects` for bounded content/type/group/relationship/region searches, `find_diagrams` for metadata discovery, `read_diagram` or `describe_diagram` for a semantic unit, and `read_neighborhood` for a bounded local subgraph. `layout_objects` deterministically arranges revision-checked targets as a flow, grid, or acyclic hierarchy while retaining connector identity and recomputing connector geometry and label-aware Diagram bounds. `comfortable` density is the default and expands a corridor when a connector label needs more room; `compact` is opt-in. Exact `x`/`y` placement remains authoritative when automatic layout is omitted, so deliberate overlap, stacked objects, annotations, and freeform illustration remain supported.

Agent-created connectors default to obstacle-aware `auto` routing. The server deterministically chooses cardinal ports, readable elbow corridors, and stable parallel lanes, returning both the requested `routing.mode` and concrete rendered `routing.kind`. `draw_connection`, `update_object`, and atomic connector operations also accept explicit `straight`, signed-bend `curved`, or `elbow` routing plus route-relative label placement when visual intent should override avoidance. Human tldraw bend, elbow, and attachment edits round-trip into authoritative state without snapback; they promote an automatic route to an explicit one. Routing and endpoint metadata survive Diagram reads, activity/review/revert, templates, semantic JSON, persistence, and multiplayer projection. SVG faithfully renders resolved route geometry and labels; Mermaid intentionally preserves topology rather than visual route geometry.

Participants can call `render_canvas_preview` with exact object revisions or one exact Diagram revision to inspect the real tldraw result. It renders only that authorized scope into a bounded, temporary in-room PNG surface and returns its exact viewport `screenshotClip`; a vision-capable browser agent captures that clip before expiry. This is intentionally a two-step tool-plus-screenshot workflow because current WebMCP tool results are JSON rather than native image content. The preview is neither persisted nor shared, and spectators do not receive the tool.

### Immutable activity and conflict-safe compensation

Every committed canvas mutation appends immutable activity derived from the signed session. Authorized summaries include the human-or-agent actor, action, optional intent and summary, affected object and Diagram IDs, affected canvas bounds, room revision, and exact post-state guards. The full before/after entity snapshots remain private to the service.

Redis stores compact authorized summaries separately from private full-detail records and their bounded indexes. One activity detail is capped at 1 MiB; retained logical storage is capped at 8 MiB and 200 records per room and 32 MiB deployment-wide, with bounded oldest-first eviction performed in the same atomic write as the incoming record.

`list_activity` and `read_activity` expose that concise timeline. `revert_activity` does not delete or rewind history: it applies an all-or-nothing forward compensation only when every object/Diagram presence and revision guard still holds and no active foreign lease or later relationship dependency makes restoration unsafe. A successful compensation creates fresh revisions, current agent attribution, and a new activity linked to the original.

### Live editing and review-before-apply

Each room has a server-authoritative agent edit policy: `live` or `review`. In live mode, an authorized agent canvas mutation commits immediately and returns activity. In review mode, canvas commands, semantic transactions, layouts, activity compensation, and template instantiation create proposals that retain an immutable exact validated request and original agent attribution plus baseline revision, purpose, intent, and summary; canvas state does not change yet, while status and human review fields advance by proposal revision.

`list_agent_edit_proposals` and `read_agent_edit_proposal` expose the bounded review queue. An agent may call `enable_agent_review` to tighten a live room, but agents can never approve or reject proposals or loosen review mode back to live. Those remain explicit human-participant decisions. Approval revalidates revisions, leases, membership, and relationships and conflicts safely rather than replaying stale intent.

### Privacy-safe interchange and reusable templates

The Share & Export panel produces versioned semantic JSON for a board, one Diagram, or an exact selection; directive-free Mermaid for one Diagram; and fixed-vocabulary, script-free SVG. Portable attribution retains only display name and human/agent kind. Room codes/IDs, session and participant IDs, participant colors, presence, leases, review queues, and private or external image URLs are omitted. Images become non-networked placeholders, and scoped connector endpoints outside the artifact lose their semantic ID. The client can rasterize the safe SVG into PNG locally; PNG is deliberately not a server or WebMCP export format.

`create_diagram_template` turns one exact Diagram into an audit-free, create-only JSON template. It preserves classification, decision/open-question lifecycle data, grouping, relationships, metadata, and layout, but drops revisions, attribution, source-room state, and media; a Diagram containing an image is rejected. `instantiate_diagram_template` requires the exact room revision, generates fresh object, Diagram, and group IDs, returns the complete ID map, and submits one atomic transaction through the same live-or-review policy.

### Expiring private read-only snapshots

Participants can issue an immutable snapshot for the whole authorized board or one exact Diagram revision, list only their own creator-scoped summaries, and revoke one by creator-visible ID. A snapshot defaults to 24 hours and is capped at seven days. Its 256-bit high-entropy path is returned once and stored only as a hash, so neither the UI nor WebMCP can recover an already-issued secret from the later list. If the path is lost, issue a new snapshot and revoke the old ID if needed.

Snapshot indexes retain compact metadata while the frozen payload is read directly through its secret hash. One record is capped at 3.5 MiB; retained storage is capped at 8 MiB per creator, 16 MiB per room, and 48 MiB deployment-wide, with count caps of 8 per creator, 64 per room, and 128 deployment-wide.

Anyone possessing the exact private path can view only the frozen, privacy-safe artifact until expiry or revocation; it does not grant source-room membership or mutation access. The snapshot page exposes four local read-only tools: `read_snapshot_state`, `query_snapshot_objects`, `read_snapshot_diagram`, and `export_snapshot_artifact`.

## Suggested first demo

1. Use landing WebMCP to create a room, then join its exact code from another browser as a participant.
2. Add a website image with tldraw's Media tool and annotate it with separate text, freehand, shape, and connector objects.
3. Use `apply_canvas_transaction` with one `auto_layout` operation to create and comfortably arrange a titled architecture diagram with at least four explicitly classified nodes, a crossing-prone blocker, and labeled auto, curved, and elbow connectors in one commit.
4. Give one decision and one open question structured status/owner/resolution state. Find the Diagram semantically, read one neighborhood, and apply `layout_objects`; verify auto routes avoid unrelated nodes, connector labels have readable corridors, parallel routes use separate lanes, connectors remain attached, and metadata/revisions advance. Then call `render_canvas_preview`, capture its returned screenshot clip, and visually inspect the exact Diagram revision.
5. Edit an object as a human while the other participant's agent attempts a revision-checked change. The agent receives structured `OBJECT_BUSY` details and the transaction commits nothing.
6. Switch to review-before-apply, let an agent submit a proposal, and have a human approve or reject it. Inspect attributable activity and perform one guarded compensating revert.
7. Export semantic JSON, Mermaid, SVG, and client-rendered PNG; save and re-instantiate a Diagram template and verify every identity is fresh.
8. Issue a short-lived private snapshot, use its four passive WebMCP tools in another browser, then revoke it and verify the same path is unavailable.
9. Follow the other participant's agent and exercise Spotlight start, join/leave, request, approve/dismiss handoff, and stop through WebMCP.
10. Join a third browser as a spectator and verify its exposed WebMCP surface contains passive reads only, including safe export but no mutation or role-upgrade tool.

## Privacy and authorization boundaries

- Guest identity comes from a cryptographically random participant ID in an HMAC-signed `HttpOnly`, `SameSite=Lax` cookie (`Secure` in production), never an IP address.
- Exact-code joins are limited to eight attempts per signed session ID per 60 seconds; production uses one atomic Redis fixed window.
- Every room-scoped route rechecks membership and role. Tools cannot supply an arbitrary actor identity or impersonate another participant.
- Humans alone may approve or reject agent proposals, loosen review mode back to live, or upgrade a spectator role. None has a WebMCP operation. An agent may only tighten a live room to review mode.
- An issued snapshot secret is unrecoverable for both humans and agents: copy the path at creation or issue a replacement. Listing snapshots never returns bearer paths.
- Spectators stay passive. Their safe-export and review/activity reads do not grant canvas, policy, snapshot, template, collaboration, session, or role mutations.
- Portable exports and snapshots omit room/session identity, participant IDs/colors, presence, leases, and image URLs; an exact snapshot path grants frozen artifact access only.
- `leave_room` exits the room view but retains membership and does not delete the room.
- Copying to the clipboard and opening UI panels are presentation mechanics, not semantic tools; read tools already return the room code and underlying state.
- Agent image placement accepts an accessible HTTPS URL. Arbitrary conversational attachment bytes remain excluded until Jazzboard has a scoped, session-authorized asset-transfer protocol.

The authoritative decision record and capability matrix are in [`PRODUCT-SPEC.md`](./PRODUCT-SPEC.md).

## Verification

```bash
npm run check
npm run test:e2e
```

`npm run check` runs lint, TypeScript, unit/integration tests, and a production build. Coverage includes guest authorization, exact-code privacy, pre-hydration discovery, role-scoped registration, structured node lifecycle metadata, immutable bounded activity, guarded compensation, normalized snapshot retention, one-way legacy-room retirement, transient/durable presence cadence and structural sharing, idempotent replay and unknown-outcome handling, live/review policy and human approval, redacted interchange, label-aware safe renderers, fresh-ID templates, revisions, human-and-agent leases, atomic transaction layout, comfortable/compact and exact-overlap placement, deterministic obstacle-aware connector routing, human bend/elbow/port round-tripping, revision-guarded tldraw previews, semantic diagrams, two-browser projection, Follow, Spotlight, WebMCP lifecycle calls, and private-Blob reservation/finalization/cleanup. `npm run test:e2e` uses installed Google Chrome when available; set `PLAYWRIGHT_SKIP_WEBSERVER=1` only when a compatible server is already running on port 3000.

## One-project Vercel architecture

- `src/lib/domain`: semantic objects and Diagrams, structured decision/open-question lifecycle state, activity/review records, guarded compensation, optimistic revisions, transactions, layouts, role checks, and active-object leases.
- `src/lib/interchange`: versioned redacted artifacts, safe Mermaid/SVG renderers, audit-free templates, and fresh-ID instantiation plans.
- `src/lib/server`: memory/Redis room, activity, and expiring snapshot stores; signed guest authorization; review/interchange/snapshot services; Redis Streams; and the Vercel WebSocket hub.
- `src/lib/canvas`: bidirectional semantic-to-tldraw projection for connectors, groups, z-order, images, drawings, and diagram-backed objects.
- `src/lib/webmcp`: pre-hydration landing; role-scoped semantic, activity, review, interchange, snapshot, lifecycle, transaction, layout, Diagram, and exact canvas-preview tools registered through `document.modelContext.registerTool`.
- `src/components/room`: multiplayer canvas, human/agent presence, Follow, Spotlight, spectator UX, outline, and conflict feedback.

The server—not tldraw and not a browser agent—is authoritative. Redis stores each room as three versioned planes: durable document and membership state, ephemeral participant/Spotlight awareness, and active-object lease coordination. `roomRevision` advances only for durable document changes; additive `stateRevision` orders the composed room seen by polling and WebSockets. While a pointer or viewport is moving, socket-local transient updates are coalesced at about 50 ms and projected with structural sharing, so untouched participant records and the durable object/Diagram maps keep their identity. Durable presence keyframes commit every 1 second while active and every 30 seconds while visibly idle; 75 seconds without human or agent activity makes that presence non-live. Current clients apply a document-fenced delta only at the exact next `stateRevision`; a gap reconciles once from authoritative state without repainting an unchanged canvas. Live WebSockets suppress redundant polling; visible clients poll every 5 seconds only as the fallback when realtime is unavailable. Wall-clock presence/lease expiry and presenter Spotlight teardown remain revisioned live-state transitions.

Pre-plane whole-room records have a strict one-way lazy cutover. Migration `WATCH`es the legacy record and all target planes, conservatively merges durable state without letting embedded legacy awareness or leases replace initialized live planes, then atomically writes only changed planes, emits at most one compact invalidation, marks coordination `legacyRetired`, and deletes the legacy key. Retired rooms never read, write, watch, or mirror that key during steady state. Current bundles negotiate split-state/delta support; stale bundles receive `CLIENT_UPGRADE_REQUIRED` before they can read or mutate live state.

Redis Streams contain only bounded revision invalidations. Reconnect is snapshot-first: the server establishes a live-event fence, reads one authorized authoritative room, then drains only newer events that raced the read. It never scans global full-room history. Durable HTTP mutations accept participant-scoped `Idempotency-Key` values and reject reuse for a different canonical request or room scope. Activity-bearing mutations atomically compare the expected room-plane digests and commit the changed room planes, compact invalidation, 24-hour receipt, and normalized activity summary/detail in one Redis script; receipt races return the already-committed response without appending duplicate history. First-party calls generate one fresh key per logical mutation, while room and snapshot creation use deterministic same-key resource identities. If a possibly committed mutation cannot verify its receipt or authoritative result, Jazzboard returns `MUTATION_OUTCOME_UNKNOWN`; clients retain local state and reconcile rather than blindly retrying a mutation that may already have committed.

Pre-commit capacity accounting independently budgets the durable document, awareness, coordination, activity, retained proposal, object, Diagram, participant, and aggregate drawing-point surfaces. `JAZZBOARD_CAPACITY_MODE=warn` measures only; `enforce` rejects an oversized mutation atomically before Redis persistence, and every Redis plane write has an eight-megabyte hard provider guard. Structured Vercel logs contain only controlled operation names, numeric usage, and one-way identifier hashes.

A private Vercel Blob store is the required deployed image-write path. Uploads use a rate-limited five-minute provider capability for one server-validated UUID-v4 pathname; the provider URL never enters room state. Before issuing it, one atomic Redis registry creates a 15-minute, 10 MiB reservation against 128 MiB/100-asset per-room limits and 512 MiB/500-asset deployment limits, with at most two outstanding reservations per participant. A capability-issuance failure rolls back the reservation. Client and signed-provider completion paths idempotently finalize from provider `head` metadata, and status/generation checks prevent a stale cleanup or callback from deleting or replacing newer state. Reads fail closed for unregistered or uncommitted paths. Jazzboard persists one canonical origin-neutral room proxy reference and rechecks the signed guest, room membership, and opaque hashed namespace on every read, so collaborators can use different Jazzboard aliases safely. `/api/health` performs a cached, read-only private-access probe instead of trusting token presence.

The 512 MiB application ceiling deliberately leaves headroom inside Vercel Blob Hobby's included 1 GB storage rather than treating the provider limit as an operating target. Expired reservations are reclaimed in bounded batches. A secured, timing-inexact daily Vercel Cron deletes only the same status/generation it proved stale: exact registry-known unreferenced assets or dedicated `jazzboard/` orphans retained for at least 24 hours. Vercel Blob deletion is free. Every provider `get`, `head`, `list`, and `del` call supplies the dedicated private token explicitly. Previously issued, room-authorized Redis asset URLs remain readable for their original seven-day lifetime, and operators can explicitly enable the bounded four-megabyte Redis fallback during an emergency. Without verified private Blob access or that opt-in, deployed image uploads fail closed and health reports `assetStorage` as missing.

Create one Vercel project from this directory and configure `.env.example`:

- `SESSION_SECRET`: at least 32 random characters.
- `REDIS_URL`: the Vercel Marketplace Redis connection URL.
- `JAZZBOARD_PRIVATE_READ_WRITE_TOKEN`: the Vercel Blob client-upload token, supplied automatically by connecting the private asset store with the `JAZZBOARD_PRIVATE_` prefix.
- `JAZZBOARD_BLOB_ACCESS=private`: required fail-closed assertion for the connected private store; health also verifies it with a read-only private access probe.
- `JAZZBOARD_ALLOW_REDIS_ASSET_FALLBACK=1`: optional emergency-only override; omit it during normal operation.
- `JAZZBOARD_CAPACITY_MODE=enforce`: reject oversized room mutations before persistence; use `warn` only for an observation rollout.
- `CRON_SECRET`: distinct high-entropy bearer secret required by the daily private-asset cleanup route.

`vercel.json` enables Fluid compute, gives the native WebSocket route a five-minute duration, and schedules bounded private-asset cleanup once daily. Hobby cron timing is intentionally treated as approximate. A deployed instance fails closed when Redis is missing instead of silently switching to process-local state.

Jazzboard pins `tldraw` and `@tldraw/assets` to `3.15.6`. That version permits production use only while its built-in “Made with tldraw” watermark remains visible. Jazzboard does not pass a license key and must not hide, cover, alter, or interfere with the watermark or license validation. Moving to tldraw 4 or newer requires a valid production license and a fresh API migration. The pinned SDK license is included in [`TLDRAW-LICENSE.md`](./TLDRAW-LICENSE.md).
