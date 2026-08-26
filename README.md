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

Use `apply_canvas_transaction` to create a multi-node diagram and its labeled connectors in one all-or-nothing call. Request-local `tempRef` values can connect nodes and populate diagram membership before stable IDs exist; the response returns the resolved IDs. Existing-object updates require exact revisions and honor active-object leases. Any invalid reference, stale revision, busy object, authorization failure, or bad membership rejects the complete transaction.

Use `query_objects` for bounded content/type/group/relationship/region searches, `find_diagrams` for metadata discovery, `read_diagram` or `describe_diagram` for a semantic unit, and `read_neighborhood` for a bounded local subgraph. `layout_objects` deterministically arranges revision-checked targets as a flow, grid, or acyclic hierarchy while retaining connector identity and recomputing connector geometry and diagram bounds.

### Immutable activity and conflict-safe compensation

Every committed canvas mutation appends immutable activity derived from the signed session. Authorized summaries include the human-or-agent actor, action, optional intent and summary, affected object and Diagram IDs, affected canvas bounds, room revision, and exact post-state guards. The full before/after entity snapshots remain private to the service.

`list_activity` and `read_activity` expose that concise timeline. `revert_activity` does not delete or rewind history: it applies an all-or-nothing forward compensation only when every object/Diagram presence and revision guard still holds and no active foreign lease or later relationship dependency makes restoration unsafe. A successful compensation creates fresh revisions, current agent attribution, and a new activity linked to the original.

### Live editing and review-before-apply

Each room has a server-authoritative agent edit policy: `live` or `review`. In live mode, an authorized agent canvas mutation commits immediately and returns activity. In review mode, canvas commands, semantic transactions, layouts, activity compensation, and template instantiation create proposals that retain an immutable exact validated request and original agent attribution plus baseline revision, purpose, intent, and summary; canvas state does not change yet, while status and human review fields advance by proposal revision.

`list_agent_edit_proposals` and `read_agent_edit_proposal` expose the bounded review queue. An agent may call `enable_agent_review` to tighten a live room, but agents can never approve or reject proposals or loosen review mode back to live. Those remain explicit human-participant decisions. Approval revalidates revisions, leases, membership, and relationships and conflicts safely rather than replaying stale intent.

### Privacy-safe interchange and reusable templates

The Share & Export panel produces versioned semantic JSON for a board, one Diagram, or an exact selection; directive-free Mermaid for one Diagram; and fixed-vocabulary, script-free SVG. Portable attribution retains only display name and human/agent kind. Room codes/IDs, session and participant IDs, participant colors, presence, leases, review queues, and private or external image URLs are omitted. Images become non-networked placeholders, and scoped connector endpoints outside the artifact lose their semantic ID. The client can rasterize the safe SVG into PNG locally; PNG is deliberately not a server or WebMCP export format.

`create_diagram_template` turns one exact Diagram into an audit-free, create-only JSON template. It preserves classification, decision/open-question lifecycle data, grouping, relationships, metadata, and layout, but drops revisions, attribution, source-room state, and media; a Diagram containing an image is rejected. `instantiate_diagram_template` requires the exact room revision, generates fresh object, Diagram, and group IDs, returns the complete ID map, and submits one atomic transaction through the same live-or-review policy.

### Expiring private read-only snapshots

Participants can issue an immutable snapshot for the whole authorized board or one exact Diagram revision, list only their own creator-scoped summaries, and revoke one by creator-visible ID. A snapshot defaults to 24 hours and is capped at seven days. Its 256-bit high-entropy path is returned once and stored only as a hash, so neither the UI nor WebMCP can recover an already-issued secret from the later list. If the path is lost, issue a new snapshot and revoke the old ID if needed.

Anyone possessing the exact private path can view only the frozen, privacy-safe artifact until expiry or revocation; it does not grant source-room membership or mutation access. The snapshot page exposes four local read-only tools: `read_snapshot_state`, `query_snapshot_objects`, `read_snapshot_diagram`, and `export_snapshot_artifact`.

## Suggested first demo

1. Use landing WebMCP to create a room, then join its exact code from another browser as a participant.
2. Add a website image with tldraw's Media tool and annotate it with separate text, freehand, shape, and connector objects.
3. Use `apply_canvas_transaction` to create a titled architecture diagram with at least four explicitly classified nodes and three labeled connectors.
4. Give one decision and one open question structured status/owner/resolution state. Find the Diagram semantically, read one neighborhood, and apply `layout_objects`; verify connectors remain attached and metadata/revisions advance.
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

`npm run check` runs lint, TypeScript, unit/integration tests, and a production build. Coverage includes guest authorization, exact-code privacy, pre-hydration discovery, role-scoped registration, structured node lifecycle metadata, immutable activity, guarded compensation, live/review policy and human approval, redacted interchange, safe renderers, fresh-ID templates, expiring snapshot secrets, revisions, human-and-agent leases, transactions, semantic diagrams, deterministic layout, two-browser projection, Follow, Spotlight, WebMCP lifecycle calls, and image selection/upload. `npm run test:e2e` uses installed Google Chrome when available; set `PLAYWRIGHT_SKIP_WEBSERVER=1` only when a compatible server is already running on port 3000.

## One-project Vercel architecture

- `src/lib/domain`: semantic objects and Diagrams, structured decision/open-question lifecycle state, activity/review records, guarded compensation, optimistic revisions, transactions, layouts, role checks, and active-object leases.
- `src/lib/interchange`: versioned redacted artifacts, safe Mermaid/SVG renderers, audit-free templates, and fresh-ID instantiation plans.
- `src/lib/server`: memory/Redis room, activity, and expiring snapshot stores; signed guest authorization; review/interchange/snapshot services; Redis Streams; and the Vercel WebSocket hub.
- `src/lib/canvas`: bidirectional semantic-to-tldraw projection for connectors, groups, z-order, images, drawings, and diagram-backed objects.
- `src/lib/webmcp`: pre-hydration landing; role-scoped semantic, activity, review, interchange, snapshot, lifecycle, transaction, layout, and Diagram tools registered through `document.modelContext.registerTool`.
- `src/components/room`: multiplayer canvas, human/agent presence, Follow, Spotlight, spectator UX, outline, and conflict feedback.

The server—not tldraw and not a browser agent—is authoritative. Redis stores room snapshots and replayable events, coordinates cross-instance optimistic transactions, and supports WebSocket fanout without assuming one long-lived tldraw sync process. Vercel Blob is the primary image store; a bounded four-megabyte, seven-day Redis fallback keeps image bytes out of room state when account-level Blob provisioning is unavailable. `/api/health` reports readiness and names `blob` as a warning while the fallback is active.

Create one Vercel project from this directory and configure `.env.example`:

- `SESSION_SECRET`: at least 32 random characters.
- `REDIS_URL`: the Vercel Marketplace Redis connection URL.
- `BLOB_READ_WRITE_TOKEN`: the Vercel Blob client-upload token.

`vercel.json` enables Fluid compute and gives the native WebSocket route a five-minute duration. A deployed instance fails closed when Redis is missing instead of silently switching to process-local state.

Jazzboard pins `tldraw` and `@tldraw/assets` to `3.15.6`. That version permits production use only while its built-in “Made with tldraw” watermark remains visible. Jazzboard does not pass a license key and must not hide, cover, alter, or interfere with the watermark or license validation. Moving to tldraw 4 or newer requires a valid production license and a fresh API migration. The pinned SDK license is included in [`TLDRAW-LICENSE.md`](./TLDRAW-LICENSE.md).
