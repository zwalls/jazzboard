# Jazzboard — WebMCP Multiplayer Architecture Room

Status: Implementation-aligned collaboration-milestone specification
Last updated: 2026-08-27
Purpose: Preserve the product, privacy, authorization, semantic-model, attributable-review, interchange, sharing, and deployment decisions that define Jazzboard's implemented collaboration milestone.

## Product thesis

Jazzboard is a shared, agent-native architecture and feature-planning room that feels closer to several people working together at a physical whiteboard than a transcript, ticket board, or single-agent note taker.

The site does not own or run a central AI agent. It provides the shared world: rooms, the infinite canvas, membership, multiplayer synchronization, permissions, persistence, history, presence, and a WebMCP-native semantic tool surface. Each participant may bring an independently operated assistant through a text interaction, voice interaction, or another agent interface. The visual interface remains fully usable, but it is not the only way to complete a core workflow.

The defining experience is multiple humans and participant-owned agents collaborating spatially in one authoritative room. A one-person room remains a supported mode.

## Non-negotiable product requirements

### 1. Private rooms and exact-code joining

- Every room owns one persistent infinite canvas and one short, unique four-digit join code.
- A room is created privately and is never published to a Jazzboard directory.
- Joining requires the exact four-digit code supplied by the person or their AI interaction.
- Jazzboard provides no global room directory, search, autocomplete, room enumeration, or tool that lists rooms created by other people.
- A previously authorized room may be reopened only through a private recent-room reference stored by the current browser on the Jazzboard origin.

### 2. Guest-session authorization and abuse resistance

- The first demo has no account, password, or login flow.
- The server issues a cryptographically random participant ID in an HMAC-signed, `HttpOnly`, `SameSite=Lax` guest cookie; production cookies are `Secure`.
- The server associates that session ID with room membership, display name, assigned color, and participant or spectator role.
- After join, the signed session and server-side membership—not a room code, local storage, IP address, tool argument, or browser-provided actor ID—authorize every server room read and shared mutation.
- Exact-code joins are throttled by the signed session participant ID, never by IP address. The first-demo policy permits eight attempts per 60-second fixed window; production coordinates the counter atomically through Redis.
- The browser can remember room metadata locally, but it never stores a bearer token or replaces server authorization.
- Every direct edit is attributed to the authorized session's human or participant-owned agent. A caller cannot impersonate another participant or choose an arbitrary actor identity.

### 3. Roles and role-scoped WebMCP

- A person joins as a `participant` or `spectator`.
- Participants can manipulate the canvas, operate Follow and Spotlight, and expose their connected agent as a visible presence.
- Spectators can observe the authoritative room and may use the normal visual spectator experience, but they cannot contribute canvas or shared-lifecycle mutations through WebMCP.
- A spectator page registers passive reads plus authorized export operations. It never receives canvas, viewport, Follow, Spotlight, role, session, or other shared-state mutation tools. `export_canvas_png` truthfully omits a read-only annotation because it initiates a local browser download, but it does not change or persist Jazzboard state.
- Server authorization remains the source of truth even when a browser incorrectly or maliciously calls a route directly.
- Becoming a participant remains an explicit human UI decision. After a successful role upgrade, the room re-registers the participant tool surface.

### 4. AI interaction, agent activation, and presence

- WebMCP is the product's semantic interaction contract for text, voice, and other agent interfaces; it is not chat-only support.
- First contact is agent-readable before hydration: the initial document advertises `/llms.txt`, `/agent-guide.md`, and the Markdown alternate while client instrumentation begins registering the landing surface.
- Landing-page WebMCP tools can create a room, join by exact code, and operate the current browser's private recent-room references without requiring visual clicks.
- The five landing tools register through one pre-hydration singleton, before React effects. Hydration attaches UI callbacks to that same registry rather than replacing it; leaving the landing page removes the complete landing surface before room tools register.
- Room WebMCP tools expose the meaningful semantic canvas and collaboration workflows available to the current role.
- A participant can submit a private Ask message to their own agent with an immutable semantic snapshot of the currently selected objects, containing Diagrams, bounds, and room revision. This is grounding, not live edit authority.
- The agent inbox is pull-only. Submitting a message does not wake, schedule, or push to an agent; the agent polls with server-provided cadence guidance, claims one message for a bounded lease, refreshes authoritative state before edits, and records a private reply.
- Spectators receive no Ask submission or inbox WebMCP surface. Ask prompts, context, claim tokens, and replies are private participant-agent state rather than shared room chat.
- Passive read tools do not create fake presence or mark an agent active.
- The first successful shared-state mutation (canvas, Spotlight, lease, transaction, or layout) or shared agent-viewport action activates the current participant's agent and updates attributable presence. Private Follow changes and leaving the local room view do not manufacture shared agent presence.
- The first demo supports one participant-owned agent per browser guest session. Persistent accounts, cross-device identity, and multiple independently identified agents per participant are deferred.
- Human cursor activity and agent activity remain visibly distinct while sharing the participant's identity and color family.

### 5. Infinite canvas and shared object model

- Humans and agents operate the same authoritative semantic objects: text, shapes, classified nodes, connectors, images, and freehand drawings.
- Both can create, edit, move, resize, connect, group, and delete supported objects; the visual canvas is a projection of the semantic model, not a competing source of truth.
- Image annotation is non-destructive: text, drawings, shapes, and connectors remain separate objects layered over the image.
- Images can be placed, resized, reordered, grouped with annotations, and locked.
- Human-uploaded images use a private Vercel Blob store. The provider URL never enters room state: the canvas persists one origin-neutral, room-local proxy reference whose room ID and opaque hashed Blob namespace are validated again on every create, update, and read. This keeps images usable across Jazzboard aliases while preserving signed-session authorization.
- Upload capabilities are participant-only, scoped to one pre-generated UUID pathname, non-overwritable, MIME/size constrained, valid at the provider for five minutes, and limited to twelve unique grants per signed guest session per minute across all rooms. Spectators may render authorized room images but cannot mint upload capabilities.
- The server enforces a UUID-v4 prefix on every Blob leaf and creates one atomic 15-minute, 10 MiB reservation before capability issuance. At most two reservations may remain outstanding per participant. Reserved plus committed usage is bounded at 128 MiB and 100 assets per room, and 512 MiB and 500 assets deployment-wide; a capability-issuance failure rolls its new reservation back. Client and signed-provider completion paths finalize from provider metadata idempotently, while status/generation checks keep finalize and cleanup race-safe. Unregistered or uncommitted Blob paths are never readable through the room proxy.
- Expired reservations are reclaimed in bounded batches. A secured daily cleanup examines at most a bounded candidate set and deletes only the same status/generation it proved stale: exact, dedicated private `jazzboard/` paths that remain unreferenced or unregistered for at least 24 hours. Provider listing and cron timing are treated as bounded and approximate. The 512 MiB ceiling keeps conservative headroom under Vercel Blob Hobby's included 1 GB, and Blob deletion is free.
- Agents can place an accessible HTTPS image, including an authorized Jazzboard-hosted asset URL. Arbitrary conversational attachment bytes are excluded until a scoped, authorized asset-transfer protocol exists.
- Connectors retain semantic object-ID endpoints and authoritative routing intent. A missing legacy route remains straight; new agent connectors default to obstacle-aware `auto`, whose deterministic concrete `straight`, `curved`, or `elbow` result chooses cardinal ports, readable corridors, and stable lane offsets while avoiding unrelated node bounds and reducing crossings. Explicit `straight`, signed-bend `curved`, and `elbow` modes plus route-relative label placement preserve deliberate visual composition. Connected geometry recomputes when nodes move, including transaction and layout operations.
- Resolved endpoint metadata records normalized anchors, precision, exactness, and snap intent. Human bend, elbow, and attachment edits round-trip into authoritative semantic state without snapback and promote an automatic route to an explicit route. Routing and endpoint metadata survive persistence, multiplayer projection, Diagram metadata, activity/review/revert, templates, and semantic JSON. Safe SVG renders resolved route geometry and labels, exact first-party canvas previews retain the live result, and Mermaid remains topology-only.
- Node classification is authoritative data, never inferred from color or style. Supported first-demo classifications are `service`, `component`, `requirement`, `decision`, and `open_question`.
- A decision node carries structured status (`proposed`, `accepted`, `rejected`, or `superseded`), optional owner, resolution, and server-managed `resolvedAt`. A proposed decision cannot already have a resolution; every non-proposed state requires one.
- An open-question node carries structured status (`open`, `answered`, `deferred`, or `closed`), optional owner, resolution or deferral note, and server-managed `resolvedAt`. An open question cannot already have a resolution; every non-open state requires one.
- Lifecycle metadata is created, updated, queried by status/owner, described, exported, and templated as semantic data rather than inferred from labels or style. Already-issued legacy snapshots retain the metadata they froze.

### 6. First-class semantic diagrams

A diagram is an authoritative container, not a visual grouping convention. Every diagram stores:

- a stable diagram ID;
- a human-readable title and short description of purpose and contents;
- an explicit diagram type (`architecture`, `flow`, `hierarchy`, `system_context`, `process`, or `custom`) and optional category;
- optional tags or keywords;
- member object IDs and connector IDs;
- an automatically maintained, connector-label-aware bounding region;
- a revision, creation and update times, creator attribution, and last-editor attribution.

Diagram records are the source of truth for membership. Each object's `diagramIds` field is a normalized reverse index for efficient query and neighborhood reads. Metadata, membership, connector relationships, bounds, revisions, and attribution remain intact as nodes move, connections change, or the diagram is laid out again.

The shared semantic transaction path accepts authorized human and agent actors. Human canvas edits preserve existing diagram membership and trigger authoritative bounds/revision maintenance; an agent can create, describe, find, read, update, and lay out diagrams directly through WebMCP.

### 7. AI-native reads and compound editing

- `query_objects` can filter bounded results by text content or label, object kind, explicit node type, group, diagram membership, relationship, and canvas region without returning the entire board.
- `find_diagrams` searches title, description, type, category, tags, or contained object and returns stable IDs plus concise summaries suitable for discovery inside an already-authorized room.
- `read_neighborhood` starts from exact object IDs and returns the bounded local subgraph: members, connectors, related endpoints, diagram metadata, and current revisions. `read_diagram` is the corresponding entry point for a diagram ID.
- `read_diagram` retrieves a first-class diagram and its authoritative membership; `describe_diagram` returns its agent-readable identity, purpose, structure, bounds, revision, and attribution.
- `layout_objects` applies deterministic `flow`, `grid`, and `hierarchy` layouts while preserving object IDs, semantic connectors, routing intent, metadata, and attribution. `comfortable` density is the default; `compact` is opt-in. Numeric gaps are minimums, and an individual corridor expands when needed to keep its connector label readable. Automatic routes choose clean ports, obstacle-avoiding elbow corridors, and parallel lane offsets after layout. Hierarchy layout rejects cyclic directed graphs rather than guessing.
- Automatic layout is opt-in. Exact `x` and `y` coordinates remain authoritative when layout is omitted, including intentional overlap for stacked objects, annotations, character drawing, and other freeform composition. A transaction rejects the ambiguous case where the same new object has explicit coordinates and is also an automatic-layout target.
- `apply_canvas_transaction` can atomically create classified nodes, shapes, text, connectors, and diagram records while revision-checking object and diagram updates. Request-local references let a connector or diagram membership target an object created earlier in the same call, and at most one `auto_layout` operation can arrange newly created node, shape, or text references plus an optional new Diagram reference inside the same all-or-nothing commit. Existing objects use `layout_objects` with exact revisions and leases.
- `render_canvas_preview` lets a participant visually verify exact object revisions or one exact Diagram revision through the authoritative first-party canvas renderer. It paints only that bounded authorized scope into a short-lived local PNG surface and returns exact viewport screenshot bounds. Current WebMCP result serialization is JSON-only, so the consuming browser agent captures that clip as a second step; the tool never returns an unusable Blob URL or claims native image-content transport.
- Request-local references never become shared aliases. The response resolves them to stable authoritative IDs.
- Every existing object or diagram update requires its exact current revision. Optional lease IDs are honored for active edits.
- Transactions and layouts are all-or-nothing: invalid references, stale revisions, busy objects, authorization failures, or diagram membership errors reject the entire operation with no partial write.

### 8. Concurrent editing and active-object leases

- Objects remain freely editable until a human or agent actively manipulates one.
- Active manipulation creates a short-lived, automatically renewed lease associated with that actor and operation.
- A compound human gesture resolves the selected outer group before movement, then acquires every persisted member and affected connector as one all-or-nothing lease cohort. The cohort renews and releases in one coordination mutation rather than producing per-object request storms.
- Lease coordination stays unobtrusive in the production canvas: do not render lease-owner names, lock icons, or operation badges. A subtle object outline may indicate that an object is temporarily busy; local development may retain the detailed badge as a diagnostic. Server enforcement and structured busy/conflict feedback remain unchanged.
- Other actors can continue editing unrelated objects in parallel.
- A competing change is never queued. It fails with structured `OBJECT_BUSY` context naming the actor, actor kind, operation, expiry, and current object revision.
- Optimistic object and diagram revisions prevent stale intent from overwriting newer state after a lease expires.
- Compound transactions validate authorization, revisions, leases, references, and membership against one room snapshot before commit.
- Leases expire automatically when an actor disconnects or stops renewing; there is no manual checkout flow.

### 9. Follow and Spotlight

- Follow privately tracks an exact participant's human cursor or active agent viewport; it never mirrors application chrome.
- The follower sees the owner's color and an explicit human-versus-agent label, can stop at any time, and leaves Follow when directly taking canvas control.
- Any eligible participant can start Spotlight with their human cursor or active agent as target.
- The room receives a five-second invitation window before auto-follow. A participant can join, decline, leave, or rejoin while Spotlight remains active.
- A participant can request a handoff. The current presenter can approve or dismiss it, and only the presenter can stop Spotlight.
- Participant WebMCP covers the complete lifecycle: read collaboration state, Follow, stop following, start/request/stop/join/leave Spotlight, approve/dismiss handoff, and leave the room view.
- Leaving the room view navigates home. It does not delete the room or revoke the signed session's existing membership.

### 10. Persistence and private recents

- Redis-backed server state is authoritative for rooms, objects, diagrams, membership, leases, and Spotlight. Internally, it is separated into a durable document plane, an ephemeral awareness plane, and a lease-coordination plane, then composed into the existing authorized `RoomState` response. `roomRevision` is the durable semantic precondition; `stateRevision` is the monotonic aggregate synchronization watermark. Presence, Spotlight, and lease churn must not advance `roomRevision` or rewrite the durable document plane. Moving pointer and viewport updates use socket-local transient delivery at about 50 ms and structural sharing so untouched participant records and durable object/Diagram maps retain identity. Durable keyframes commit every 1 second while active and every 30 seconds while visibly idle; 75 seconds without human or agent activity makes the presence non-live. High-frequency presence authorizes from a bounded membership mirror, touches only awareness/coordination state, and broadcasts a document-fenced one-participant delta. Clients apply that non-cumulative delta only at the exact next `stateRevision`; a gap reconciles once from authoritative state without repainting an unchanged canvas. A live WebSocket suppresses redundant polling, with visible polling every 5 seconds only when realtime is unavailable. Participant liveness, expired leases, and presenter-owned Spotlight teardown are persisted as revisioned live-state transitions. Generic cross-plane commits use bounded full-jitter contention recovery so overlapping awareness or coordination writes do not keep retrying in lockstep with a document save.
- Pre-plane whole-room state has one strict lazy retirement path. Migration `WATCH`es the legacy record and every target plane, conservatively merges durable state without allowing embedded legacy awareness or leases to overwrite initialized live planes, then atomically writes only changed planes, emits at most one compact invalidation, marks coordination `legacyRetired`, and deletes the old key. A retired room performs no steady-state reads, writes, watches, or mirrors of legacy state. Stale browser bundles receive `CLIENT_UPGRADE_REQUIRED` before reading or mutating live state.
- Durable mutation requests accept an optional participant-scoped `Idempotency-Key`. The canonical digest includes the resource scope, so reusing a key for another request or room is a conflict. Activity-bearing mutations atomically compare expected plane digests and commit changed room planes, one compact invalidation, the compact private 24-hour receipt, and normalized activity history. A receipt race returns the already-committed result without duplicating history. First-party requests always provide a key; room creation uses a deterministic same-key resource identity. If a possibly committed mutation cannot verify its receipt or authoritative result, Jazzboard returns `MUTATION_OUTCOME_UNKNOWN`; the client reconciles authoritative state and does not blindly retry.
- Capacity is evaluated after semantic validation but before persistence. Separate byte and structural budgets cover the durable document, awareness, coordination, activity, retained proposal, object, Diagram, participant, and aggregate drawing-point surfaces. Enforced limits reject the complete mutation atomically and disclose only controlled numeric usage; an unconditional eight-megabyte per-plane/aggregate transaction ceiling remains below the provider request maximum. A grandfathered oversized room remains readable and may shrink plane-by-plane, but unrelated awareness cannot rewrite it and no mutation may worsen the applicable overage. Telemetry contains controlled operation names, durations, numeric capacity data, and one-way identifier hashes—never codes, cookies, names, content, labels, request bodies, URLs, or bearer paths.
- Reconnect establishes a fresh authorized composed room snapshot behind a live-event fence; Redis Stream cursors are transport checkpoints, never application-state authority.
- The current browser stores at most eight Recent Jazzboards references for rooms it accessed. Each entry contains room ID, code, title, role, and last-opened time.
- `list_recent_rooms` starts only from this origin's browser-local candidates, then verifies the current signed session's membership for each exact room ID before returning it. It never calls a server listing endpoint.
- `open_recent_room` accepts only an exact locally remembered room ID and verifies the signed session's server access before navigation.
- `remove_recent_room` deletes only the local shortcut; it does not leave, modify, or delete the shared room.
- Another browser or device receives no recent-room history in the account-free first demo.

### 11. Public agent discovery and reusable guidance

- The root response advertises `/llms.txt` with `rel="describedby"` before client hydration. The homepage also advertises `/index.md` as its `text/markdown` alternate and returns that representation when a caller explicitly sends `Accept: text/markdown`.
- `/llms.txt` is treated accurately as an emerging community convention, not an authorization mechanism or formal W3C/IETF standard. It stays concise and directs an agent to discover the live page's WebMCP registry before DOM, click, coordinate, screenshot, or pixel automation.
- Public Markdown guidance documents the page-scoped registration lifecycle, landing/participant/spectator tool surfaces, efficient semantic reads and transactions, revision/lease handling, and the exact-code privacy boundary.
- Jazzboard publishes a script-free Agent Skills `SKILL.md` that an agent host may download into its documented local skill directory. Remote skill installation remains host-specific and never grants browser, session, room, or role access.
- A `/.well-known/agent-skills/index.json` compatibility manifest exposes the public skill and an exact SHA-256 digest for clients implementing the emerging Agent Skills Discovery draft. Jazzboard does not present that draft as part of the core Agent Skills specification.
- Agent discovery documents are static public product guidance. They contain no room IDs or example live codes, recent-room contents, session or participant identifiers, cookies, credentials, internal authorization material, or room/API listing instructions.
- Public sitemaps include only the homepage and agent-readable documentation. Private room URLs remain excluded and marked `noindex`; API routes remain excluded and crawler-disallowed. These indexing controls are advisory and never replace server authorization.
- Jazzboard does not publish an A2A agent card, a remote MCP server card, or an OpenAPI catalog for internal cookie-authorized endpoints. The product supplies a page-local WebMCP surface, not a central agent or remote MCP service.
- Native agent hosts may impose implementation-specific aggregate descriptor and re-registration limits beyond the WebMCP specification. Automated coverage serializes the exact production-shaped descriptor set, including origin and UUID room URL provenance, caps it at 60,000 UTF-8 bytes and 80 tools, enforces Chrome's published name/description budgets, and prevents stable page registrations from churning during hydration.

### 12. Immutable attributable activity and compensating revert

- Every committed canvas command, semantic transaction, layout, or compensating revert appends an immutable activity record. History is never edited, removed, or rewound by an undo operation.
- Activity attribution is derived from the signed guest session and actor kind; a caller cannot choose another participant or agent identity.
- An authorized activity summary contains a stable activity ID, room revision and time, actor, action, human-readable label, optional intent and summary, affected object and Diagram IDs, one affected canvas bounding region, exact post-state object/Diagram guards, and the original activity ID when the record is itself a compensation.
- Full before/after entity snapshots are private persisted service data. WebMCP and normal authorized activity reads receive only the concise summary and guards required to understand and safely compensate the change.
- Activity persistence normalizes compact authorized summaries, private details, metadata, and indexes. One detail is capped at 1 MiB; retained logical storage is capped at 8 MiB and 200 records per room and 32 MiB deployment-wide, with bounded oldest-first eviction included in the same atomic append.
- `list_activity` is bounded, newest-first, cursorable by room revision, and filterable by human/agent actor, affected object, or affected Diagram. `read_activity` resolves one stable ID inside the already-authorized room.
- `revert_activity` is a new all-or-nothing forward compensation. The caller must echo every presence/absence and revision guard from the activity summary and supply a current lease where required.
- Revert rejects stale revisions, recreated entities, active foreign leases, and later relationship or membership dependencies. Success restores semantic state as fresh revisions with current agent attribution and appends a new activity linked to the target.

### 13. Live versus review-before-apply agent policy

- Every room stores a server-authoritative agent edit policy: `live` or `review`. Existing rooms normalize to `live` unless a human or permitted agent explicitly tightens the policy.
- In live mode, an authorized agent canvas command, semantic transaction, layout, activity compensation, or template instantiation applies immediately and returns immutable activity.
- In review mode, the same agent operation does not change canvas state. It creates a pending proposal whose exact validated request and original agent attribution are retained immutably, with baseline room revision, purpose and affected semantic IDs, optional intent and summary, proposal revision, and review status.
- `list_agent_edit_proposals` returns a bounded room-authorized summary queue and current policy. `read_agent_edit_proposal` returns one exact retained request. These are passive reads and do not confer approval authority.
- `enable_agent_review` may only tighten `live` to `review`. An agent cannot loosen the policy back to `live`, approve a proposal, or reject a proposal.
- Only a human participant may approve or reject a pending proposal, using its exact current proposal revision. Approval revalidates current object and Diagram revisions, leases, authorization, membership, and relationships and fails on conflict rather than replaying stale work. Rejection records the human reviewer without mutating the canvas.
- An approved change retains the proposal author's agent attribution on the canvas activity while the proposal separately records the human reviewer and decision.

### 14. Privacy-safe interchange and reusable Diagram templates

- Jazzboard publishes a strict versioned `jazzboard.semantic` JSON schema for portable board, Diagram, selection, template, and already-issued legacy snapshot artifacts.
- Authorized exports may cover a whole room, one exact first-class Diagram, or an exact object selection. Portable state retains semantic IDs, geometry, classifications, structured decision/open-question metadata, relationships, revisions, times, Diagram metadata, and attribution limited to display name plus human/agent kind.
- Exports omit source room IDs and codes, guest-session and participant IDs, participant colors, presence, leases, review queues, and private or external image URLs. Images become non-networked placeholders with warnings. A connector endpoint outside a selected scope retains its point but loses the external semantic ID.
- Semantic JSON is canonical and schema-validated. Mermaid renders one explicit Diagram with encoded plain-text labels and no directives. SVG uses deterministic semantic geometry and a fixed vocabulary with no script, style, `foreignObject`, networked image, `use`, or `href` features.
- PNG is a visual sharing convenience rendered locally from the authorized first-party canvas, not from the redacted SVG. It faithfully includes currently renderable images, annotations, drawings, connectors, labels, and z-order in the requested board, Diagram, or selection scope. The browser downloads the result without uploading it to Jazzboard, creating a hosted URL, or retaining a server record. PNG remains outside the server interchange formats; `export_canvas_png` is an authorized participant-or-spectator WebMCP action that requests this local download and never returns or persists image bytes.
- `export_canvas_artifact` is passive and available to an authorized spectator as well as a participant. It never publishes the artifact or grants access beyond the current signed room.
- `create_diagram_template` converts one exact Diagram into an audit-free, create-only template. It preserves classification, lifecycle metadata, geometry, grouping, connector relationships, layout, and Diagram metadata while removing revisions, attribution, source-room state, sessions, and media. A Diagram containing an image is rejected rather than copying a URL or byte payload.
- `instantiate_diagram_template` requires the exact current room revision, plans one atomic create-only semantic transaction at the requested origin, and replaces every object, Diagram, and group identity with a fresh generated ID. The response returns a complete source-to-target ID map. Collision, invalid schema, stale revision, or policy failure rejects the whole operation.
- Template instantiation uses the normal agent edit policy: live mode applies with fresh attribution/revisions/times; review mode stores the exact transaction as a human-review proposal.

### 15. Live sharing, local PNGs, and retired hosted snapshots

- Sharing a Jazzboard means sharing a live-room invitation. The private URL fragment may prefill the exact four-digit code, but the joining browser still supplies its own identity and completes normal signed guest-session authorization with a participant or spectator role.
- A frozen visual is a local PNG download. The authorized client renders the requested board, Diagram, or selection directly through the first-party canvas so images and annotations are preserved as pixels. Jazzboard does not upload, persist, index, host, or issue a URL for the PNG.
- Semantic JSON, Mermaid, and SVG remain separate privacy-safe interchange formats. They continue to omit private or external image URLs and use non-networked media placeholders; their redaction rules do not apply to the local PNG's visual pixels.
- Jazzboard no longer issues, lists, or manages new hosted read-only snapshot URLs through the visual UI or any room WebMCP surface.
- Already-issued snapshot links remain available only until their existing expiry or revocation. Their stored frozen payloads, bearer-secret rules, crawler exclusions, and four passive page tools remain unchanged for compatibility; no legacy page can contact or change its source room.
- Unknown, expired, revoked, or malformed legacy snapshot references continue to return the same generic unavailable result. Expired legacy records and indexes age out through the existing retention path; retiring issuance does not require migrating their payloads into the new PNG workflow.

## Implemented WebMCP contract

Tools use strict semantic schemas and structured success/failure results. Read operations carry truthful read-only annotations; returned room and participant content is marked as untrusted where supported. Mutation tools do not claim to be read-only. The server revalidates session, membership, role, revisions, and leases for every request.

### Agent discovery surface

- `/llms.txt` — concise entry point describing WebMCP-first operation and linking only to LLM-readable Markdown context.
- `/index.md` — exact Markdown representation of the public landing page, also available through explicit `Accept: text/markdown` negotiation.
- `/agent-guide.md` — discovery order, authorization timing, efficient read/edit workflows, conflict handling, collaboration lifecycle, and verification guidance.
- `/webmcp.md` — landing, participant, and spectator tool inventory generated from a test-synchronized contract.
- `/privacy.md` and `/glossary.md` — authorization, untrusted-content, crawler, and terminology context.
- `/AGENTS.md` — concise installation, configuration, usage, and reference instructions for clients that do not install a skill.
- `/skills/jazzboard-webmcp/SKILL.md` — installable open-format Agent Skill.
- `/.well-known/agent-skills/index.json` — explicitly draft remote-discovery compatibility manifest with an exact skill digest.
- `/schemas/jazzboard-artifact-v1.json` — public JSON Schema for privacy-safe semantic artifacts and templates.
- `/robots.txt`, `/sitemap.xml`, and `/sitemap.md` — public crawler and discovery indexes containing no private rooms.

### Landing page

- `create_room` — create a private room as a participant, remember it locally, and navigate into it.
- `join_room` — join only an exact four-digit code as participant or spectator, remember that authorized room locally, and navigate.
- `list_recent_rooms` — return only browser-local recent references still authorized to the current signed guest session.
- `open_recent_room` — open an exact private recent reference after server authorization is verified.
- `remove_recent_room` — remove only that browser-local shortcut.

### Room reads and exports for participants and spectators

- `read_room_state` — authoritative semantic room/object state, optionally restricted to exact IDs.
- `read_selection` — this browser's current semantic selection and current server revisions.
- `read_collaboration_state` — signed-session role, human-and-agent presence, private Follow target, and Spotlight lifecycle state.
- `query_objects` — bounded semantic object search.
- `read_neighborhood` — bounded relationship and diagram-context read around exact object IDs.
- `find_diagrams` — bounded semantic diagram discovery inside the authorized room.
- `read_diagram` — authoritative diagram record and members.
- `describe_diagram` — concise agent-readable diagram purpose, structure, bounds, revision, and attribution.
- `list_activity` — bounded newest-first immutable activity summaries filtered by actor kind, object, Diagram, or revision cursor.
- `read_activity` — one attributable activity summary with affected bounds and exact safe-compensation guards.
- `list_agent_edit_proposals` — current live/review policy plus a bounded review queue without exact request bodies.
- `read_agent_edit_proposal` — one exact immutable agent request and its attribution, baseline, purpose, status, and human review record.
- `export_canvas_artifact` — privacy-safe semantic JSON, one-Diagram Mermaid, or fixed-vocabulary SVG for an authorized room/Diagram/selection scope.
- `export_canvas_png` — render an exact revision-guarded room, Diagram, or object set through the authorized local first-party canvas and download an image-faithful PNG without server persistence.

### Participant private Ask inbox

- `list_agent_messages` — pull a count- and byte-bounded private inbox by pending, claimed, answered, or all states. Poll actionable states without a cursor so expired claims reappear; `afterSequence` is reserved for newly created messages requested with `all`. It returns polling cadence guidance and never holds the request open or wakes an agent.
- `claim_agent_message` — claim one exact message for a bounded lease using a generated idempotency ID, returning the claim token required to answer it.
- `reply_to_agent_message` — answer a claimed message with `completed`, `needs_input`, or `failed` and a stable reply ID.

Every message contains the participant's prompt and an immutable submission-time semantic selection snapshot. The snapshot and all user-authored fields are untrusted grounding; current authoritative object and Diagram revisions must be refreshed before edits. Claiming or replying does not itself prove that a requested canvas change committed. These three tools are participant-only and absent from spectator registration.

### Participant canvas and collaboration mutations

- Primitive canvas tools: `create_text`, `create_shape`, `create_node`, `create_drawing`, `add_image`, `draw_connection`, `update_object`, `move_objects`, `group_objects`, and `delete_objects`.
- Compound semantic tools: `apply_canvas_transaction`, `layout_objects`, `create_diagram`, and `edit_diagram`.
- Exact visual verification: `render_canvas_preview` for revision-guarded object or Diagram scope; its temporary in-room image is local, non-persistent, and expires automatically.
- Activity compensation: `revert_activity`.
- Review-policy tightening: `enable_agent_review`.
- Reusable interchange: `create_diagram_template` and `instantiate_diagram_template`.
- Shared viewport tool: `focus_viewport`.
- Collaboration lifecycle tools: `follow_participant`, `stop_following`, `start_spotlight`, `request_spotlight`, `stop_spotlight`, `join_spotlight`, `leave_spotlight`, `approve_spotlight_handoff`, `dismiss_spotlight_request`, and `leave_room`.

### Existing exact-token snapshot page

- `read_snapshot_state` — frozen artifact, expiry, and privacy-safe creator metadata.
- `query_snapshot_objects` — bounded local semantic queries by text, kind, node classification, Diagram, or region.
- `read_snapshot_diagram` — one exact first-class Diagram and only its members/connectors.
- `export_snapshot_artifact` — local semantic JSON, safe SVG, or one-Diagram Mermaid; no publication or source-room request.

The generated `/webmcp.md` and skill inventory import the executable landing, participant, spectator, and legacy snapshot-page name constants. Their tests assert equality and uniqueness so documented inventories and counts cannot drift silently.

## Capability matrix

| Meaningful capability | Visual UI | Landing WebMCP | Participant room WebMCP | Spectator room WebMCP |
| --- | --- | --- | --- | --- |
| Create a private room | Yes | `create_room` | Not applicable | Not applicable |
| Join by exact code | Yes | `join_room` | Not applicable | Not applicable |
| List/open/remove private browser recents | Yes | Yes | Not applicable | Not applicable |
| Search or enumerate other people's rooms | No | No | No | No |
| Read room, objects, diagrams, relationships, revisions | Yes | No | Read-only | Read-only |
| Query objects/diagrams or read a neighborhood | Outline/selection | No | Read-only | Read-only |
| Read structured decision/open-question lifecycle metadata | Yes | No | Read-only | Read-only |
| Create/edit/delete canvas objects and drawings | Participant | No | Yes | No |
| Atomic multi-object/diagram transaction | Shared model | No | Yes | No |
| Deterministic comfortable/compact flow/grid/hierarchy layout | Shared model | No | Yes | No |
| Obstacle-aware auto and explicit straight/curved/elbow connector routing | First-party canvas | No | Yes | Read only |
| Exact first-party canvas visual verification with a temporary screenshot clip | Participant | No | Yes, local-only | No |
| Inspect immutable attributable activity and affected bounds | Yes | No | Read-only | Read-only |
| Conflict-safe compensating revert | Participant | No | Yes, apply or propose | No |
| Inspect agent proposal queue and exact proposal | Yes | No | Read-only | Read-only |
| Send, claim, and answer a private contextual Ask message | Submit/read reply | No | Pull/claim/reply | No |
| Tighten agent policy to review-before-apply | Participant | No | Yes | No |
| Approve/reject proposal or loosen policy to live | Human participant only | No | No | No |
| Export redacted semantic JSON, Mermaid, or SVG | Yes | No | Read-only | Read-only |
| Download an image-faithful local PNG | Yes | No | `export_canvas_png` | `export_canvas_png` |
| Save/instantiate fresh-ID Diagram template | Participant | No | Yes | No |
| Create a new hosted read-only snapshot URL | No | No | No | No |
| Open an already-issued unexpired snapshot URL | Legacy compatibility | No | No | No |
| Focus shared agent viewport | Participant agent | No | Yes | No |
| Private Follow / stop following | Yes | No | Yes | No mutation tool |
| Spotlight full lifecycle and handoff | Yes | No | Yes | No mutation tool |
| Leave current room view | Yes | No | Participant tool | UI only |
| Upgrade spectator to participant | Human, explicit consent | No | Not needed | UI only |
| Share board / open panels and dialogs | Yes | Semantic state already supplies the exact room code | Not a semantic tool | Not a semantic tool |

## Confirmed implementation architecture

- Jazzboard is one Vercel project containing the Next.js application, server APIs, realtime endpoint, and infrastructure integrations.
- Vercel WebSockets carry room synchronization, socket-local transient presence at about 50 ms, durable active/visible-idle presence keyframes at 1 second/30 seconds, cursors, canvas activity, view state, compact cross-instance invalidations, and bounded semantic presence deltas. Presence becomes non-live after 75 seconds without human or agent activity. Reconnect starts from one authorized authoritative snapshot, then drains only live events that raced it. A delta applies only when its document fence matches and it is the exact next aggregate revision; any gap reconciles through one authoritative snapshot without replacing structurally shared unchanged canvas state. Live realtime suppresses polling; a visible client polls every 5 seconds only as fallback. Stale bundles receive `CLIENT_UPGRADE_REQUIRED` before reading or mutating live state.
- Redis from the Vercel Marketplace stores versioned document, awareness, and coordination planes; normalized bounded activity summary/detail records; retained legacy snapshot metadata/detail records until their existing expiry; compact idempotency receipts; and bounded compact event history. It coordinates optimistic transactions across function instances and provides cross-instance fanout. Activity-bearing changes commit their changed planes, history, receipt, and at most one revision invalidation atomically. Ambiguous post-commit verification returns `MUTATION_OUTCOME_UNKNOWN`, never an automatic second mutation. Stream entries never embed complete rooms or private activity snapshots, and reconnect never scans global history. A pre-plane room is imported once under legacy-and-plane `WATCH` fences, conservatively merged, atomically retired and deleted, and never mirrored or consulted in steady state afterward.
- The canvas renderer is not a synchronization authority. Vercel Functions cannot guarantee one long-lived in-memory room process, so Jazzboard uses its Redis-backed authoritative semantic room service and projects state into first-party canvas clients.
- A private Vercel Blob store is the required deployed image-write path. Client uploads receive a five-minute, participant-scoped, non-overwritable provider capability for one UUID-v4 pathname only after an atomic 15-minute global/per-room capacity reservation; a participant may hold at most two outstanding reservations. Capability failure rolls the new reservation back. Client follow-up and signed provider callbacks idempotently commit provider `head` metadata, while status/generation-safe finalization and cleanup prevent stale work from deleting newer state. Authoritative state stores only a canonical origin-neutral room proxy reference; every read re-authorizes the signed guest, exact room membership, opaque room namespace, and committed registry entry before streaming with private/no-cache and script-hostile headers. A read-only cached health probe verifies private access. Bounded reclamation clears expired reservations, and a secured daily cron deletes only the exact stale generation of a dedicated private orphan retained for at least 24 hours. All provider calls receive the dedicated token explicitly. Previously issued room-scoped Redis asset URLs remain readable for their original lifetime, while a bounded Redis image fallback requires an explicit emergency operator opt-in. A deployment without verified private Blob access, Redis registry authority, or that opt-in fails image uploads closed; image bytes never enter room state.
- The server remains authoritative for membership, guest sessions, roles, permissions, private Ask messages and claims, agent edit policy, proposal review, object and Diagram revisions, lifecycle metadata, leases, transactions, activity guards, legacy snapshot expiry/revocation, template instantiation, and attribution.
- The validated infinite-canvas renderer and human manipulation toolkit are implemented in first-party Jazzboard code over the authoritative semantic model, with no canvas-vendor license key, runtime validation, or required watermark.
- The semantic model and first-party canvas projection preserve stable IDs, connectors, groups, images, drawings, z-order, structured decision/open-question state, and first-class Diagram metadata across human edits, agent edits, reviewed proposals, guarded compensation, reconnects, and layout operations.
- Portable artifacts are projections, never authorization records. Safe JSON/Mermaid/SVG rendering and fresh-ID template planning live outside the interactive canvas. The separate visual PNG path uses the authorized first-party renderer locally, includes renderable images, and never persists the output.

## Intentional exclusions

- **Global discovery:** no room directory, server list endpoint, global search, fuzzy code lookup, autocomplete, or enumeration. Privacy takes precedence over convenience.
- **Arbitrary actor identity:** a WebMCP caller cannot act as another human or participant-owned agent; server routes derive identity from the signed cookie.
- **Spectator mutations and role upgrade:** spectators receive no shared-state mutation tools. They may perform passive reads, return a redacted semantic export, or initiate an authorized local PNG download. Becoming a participant is deliberately an explicit human UI choice before an editing or collaboration-mutation surface is introduced.
- **Ask as shared chat or agent wake:** Ask messages and replies are private to one signed participant's agent inbox. They do not broadcast into the room, appear for spectators, or wake/schedule an agent; processing requires bounded polling and a claim lease.
- **Agent self-approval and policy loosening:** agents may inspect proposals and tighten a live room to review mode, but only a human participant may approve or reject a proposal or loosen review mode back to live. No WebMCP operation performs those human decisions.
- **New hosted snapshot URLs:** Jazzboard no longer creates them. Live invitations cover collaboration, and a locally downloaded PNG covers frozen visual sharing without Jazzboard persistence. Already-issued links remain isolated legacy artifacts until expiry or revocation and never grant source-room access.
- **Unsafe semantic export features:** semantic artifacts never embed private/external image URLs, executable Mermaid directives, or scriptable/networked SVG features. The local visual PNG is rendered from the authorized first-party canvas and may contain image pixels, but it is never uploaded or exposed as a Jazzboard URL. The separate exact-scope preview tool remains ephemeral visual verification, not a portable export.
- **Arbitrary custom waypoint paths:** the semantic connector contract intentionally exposes bounded straight, curved, and elbow primitives rather than an unbounded waypoint language. Freehand drawings and exact object placement remain available for illustration, and explicit routing preserves deliberate overlap. Automatic routing is a deterministic bounded heuristic, not a global graph optimizer; callers read and visually verify the authoritative result.
- **Clipboard and UI chrome:** copying a code, opening a popover, toggling a panel, and choosing a visual tool are presentation mechanics rather than semantic product operations. The room code and equivalent semantic outcomes are available through read or action tools.
- **Unscoped local attachment bytes:** human paste, drag-and-drop, and file selection remain supported. Agent image placement accepts an accessible HTTPS URL, including an authorized Jazzboard-hosted asset URL, until a scoped asset-transfer design can safely bind conversational bytes to the signed room session.
- **Fake presence:** passive reads, private Follow changes, and local room-view navigation do not activate or advertise an agent. Presence begins with a successful shared-state mutation or shared agent-viewport action.
- **Pixel automation:** WebMCP does not expose synthetic clicks, pixel searches, or renderer implementation details where a semantic operation exists.
- **Accounts and cross-device recents:** persistent identity and synchronized history remain deferred beyond the guest-session first demo.
- **False protocol identity:** Jazzboard does not claim to be an A2A agent, remote MCP server, or public OpenAPI service. Its semantic tools are registered by the live page through WebMCP.
- **Guaranteed host behavior:** discovery routes make WebMCP-first operation explicit but cannot force every browser-agent host to inspect them or prefer tools. The host must implement discovery after navigation; the live registry remains authoritative.

## Release acceptance checklist

- [x] Landing page registers private room lifecycle tools.
- [x] Landing lifecycle tools register before React hydration, reject duplicate-name drift in tests, and are removed before a room registers its role-scoped surface.
- [x] Exact-code joining has strict input validation and signed-session throttling.
- [x] No API or WebMCP tool lists, searches, or enumerates global rooms.
- [x] Private recent rooms remain browser-local and are authorization-checked when reopened.
- [x] Participant and spectator room tool sets are role-scoped; spectators receive passive reads and local export operations but no shared-state mutations.
- [x] Passive reads do not activate an agent; the first successful shared-state mutation or shared agent-viewport action does.
- [x] Participant WebMCP covers canvas drawing/editing plus Follow, stop, Spotlight, handoff, and leave lifecycle.
- [x] Participant WebMCP exposes a private pull-only Ask inbox with immutable semantic selection context, bounded claim leases, idempotent replies, and no spectator tools.
- [x] Semantic query and neighborhood reads avoid whole-board payloads for localized work.
- [x] Atomic transactions support request-local references, exact revisions, leases, attribution, and all-or-nothing failure.
- [x] Flow, grid, and hierarchy layouts are deterministic and preserve semantic connectors.
- [x] Diagrams are authoritative first-class records with stable IDs, metadata, membership, bounds, revisions, and attribution.
- [x] Node classifications are explicit authoritative fields, not visual-style inference.
- [x] Decision and open-question nodes carry validated status, owner, resolution, and server-managed resolution time and can be queried/described semantically.
- [x] Every committed canvas mutation appends immutable signed-session-attributed activity with semantic affected IDs/bounds and exact post-state guards; private entity snapshots stay server-side.
- [x] Activity compensation is a new all-or-nothing revision/absence/lease/relationship-checked mutation and never rewinds history.
- [x] Agent edits honor room-level live versus review-before-apply policy; exact proposals retain original agent attribution and stale approval conflicts safely.
- [x] Only human participants can approve/reject proposals, loosen review mode to live, or upgrade spectators; WebMCP cannot perform those decisions.
- [x] Semantic JSON, directive-free Mermaid, and fixed-vocabulary SVG exports redact identity/session/presence/lease/media secrets; local PNG download uses the authorized first-party renderer, preserves renderable images, and creates no Jazzboard record or URL.
- [x] Reusable Diagram templates omit audit/source/media state and instantiate atomically with fresh object, Diagram, and group IDs through the room's review policy.
- [x] New hosted read-only snapshot issuance is absent from the visual UI and every room WebMCP surface; already-issued links retain their passive four-tool page only until expiry or revocation.
- [x] Human and agent changes converge through the same server-authoritative model and first-party canvas projection.
- [x] Comfortable automatic layout reserves readable connector-label corridors, compact density remains explicit, and connector labels contribute to Diagram and safe-export bounds.
- [x] Exact-coordinate transactions preserve intentional overlap and freeform composition, while a transaction `auto_layout` operation can arrange temporary references atomically without double revisions or partial writes.
- [x] Agent connectors default to deterministic obstacle-aware auto routing with clean ports, elbow corridors, lane offsets, and crossing reduction; explicit straight, curved, and elbow routes preserve deliberate composition.
- [x] Human bend, elbow, and attachment edits round-trip without snapback, and routing/endpoint metadata survives persistence, revisions, leases, Diagram lifecycle, templates, exports, previews, and multiplayer projection.
- [x] Participants can render exact revision-guarded object or Diagram scopes through the first-party canvas into one expiring local preview surface and use the returned screenshot clip; spectators receive no preview tool and no preview image is persisted or exposed by URL.
- [x] Automated tests cover schemas, permissions, privacy boundaries, revisions, leases, transactions, layouts, diagrams, registration, and browser workflows.
- [x] Production release is complete only after live browser QA calls the deployed, browser-exposed WebMCP tools against a genuinely multi-node diagram.
- [x] The initial HTML response advertises `/llms.txt`, the landing page advertises an exact Markdown alternate, and explicit Markdown content negotiation works without changing the visual design.
- [x] Public agent guidance derives landing, participant, spectator, and snapshot-page inventories/counts from executable constants and fails automated tests if registration drifts.
- [x] Realtime reconnect is snapshot-first and race-safe: it never bulk-reads historical room snapshots, compact revision signals coalesce through authoritative room reads, and buffered events at or below the snapshot revision are discarded without losing newer changes.
- [x] Durable document, ephemeral awareness, and active-lease coordination persist independently; awareness and lease traffic advances `stateRevision` without changing the semantic `roomRevision`.
- [x] Complex group gestures resolve the selected ancestor up front and use one all-or-nothing acquire/renew/release lease cohort; bounded jittered persistence retries prevent ordinary presence overlap from starving the document commit.
- [x] Pointer and viewport presence uses about 50 ms socket-local transient delivery with structural sharing; the steady-state path does not read, return, transmit, or re-project the durable canvas.
- [x] Durable presence keyframes use 1-second active and 30-second visible-idle cadence with 75-second liveness; live realtime suppresses polling, a visible fallback polls every 5 seconds, revision gaps reconcile once, and stale clients fail closed behind explicit capability negotiation.
- [x] Existing single-snapshot rooms retire through one fenced lazy import: legacy and plane keys are watched, durable state merges conservatively, changed planes plus at most one compact invalidation commit atomically, and the legacy key is deleted and never mirrored or consulted again.
- [x] First-party durable mutations carry participant-scoped idempotency keys; activity-bearing room changes, normalized history, compact 24-hour receipts, and invalidations commit atomically, different-request or cross-room key reuse conflicts safely, and unverifiable outcomes return `MUTATION_OUTCOME_UNKNOWN` without blind retry.
- [x] Same-key room creation replays one deterministic resource; retired snapshot issuance cannot create another hosted bearer link.
- [x] Pre-commit room capacity budgets and bounded JSON parsing fail all-or-nothing with privacy-safe numeric details; health and structured telemetry expose modes without room content or identity.
- [x] Activity and snapshot storage use normalized compact-summary/metadata indexes plus direct private details, with enforced 1/8/32 MiB and 200-record activity limits and 3.5/8/16/48 MiB plus 8/64/128-count snapshot limits.
- [x] A private Vercel Blob store is the primary deployed image path; UUID-v4 enforcement, 15-minute reservations capped at two outstanding per participant, five-minute provider capabilities, issuance rollback, idempotent status/generation-safe finalization and cleanup, fail-closed registered reads, 24-hour orphan retention, short-lived global participant rate limits, opaque room namespaces, alias-neutral canonical proxy references, cached private-access health probing, explicit-token provider calls, and authorized legacy Redis reads are covered automatically.
- [x] The complete participant registry stays within a conservative production-shaped native-host descriptor budget without merging read-only and mutation operations or weakening runtime validation.
- [x] A valid script-free `SKILL.md` is downloadable, and the draft discovery manifest's SHA-256 digest matches its exact response bytes.
- [x] Agent resources preserve exact-code privacy, signed-session authorization, role scope, untrusted-content handling, revisions, and leases without publishing private room/session data.
- [x] Agent Ready and live production route audits verify the discovery surface after deployment.

## First-demo success condition

Two developers join one room with distinct identities and participant-owned agents. A website image is annotated non-destructively. An agent uses one atomic transaction to create and comfortably lay out a classified, titled architecture Diagram with structured decision/open-question workflow state, a crossing-prone blocker, and readable labeled auto, curved, and elbow connectors. It retrieves a bounded neighborhood and rearranges the Diagram without breaking relationships; auto routes avoid unrelated nodes and explicit routes retain their intent. Exact coordinates can still create an intentionally overlapping freeform composition. The agent renders the exact Diagram revision through the first-party canvas, captures the returned temporary screenshot clip, and visually checks ports, paths, crossings, and labels. A conflicting edit commits nothing. Review mode turns a later agent change into an exact proposal that only a human can approve or reject; committed work appears as bounded attributable activity and one unchanged activity can be safely compensated without rewriting history. The Diagram exports as redacted semantic JSON, Mermaid, and SVG, instantiates from a reusable template with entirely fresh IDs, and downloads through `export_canvas_png` as an image-faithful local PNG with no Jazzboard persistence. A live invitation brings another signed guest into the room. Follow and Spotlight complete through WebMCP. A spectator in another browser can inspect the authorized room, activity, proposals, redacted semantic export, and local PNG export but receives no shared-state mutation, preview, or role-upgrade surface. The deployed site's actual browser-exposed tools—not only test shims—complete the workflow.
