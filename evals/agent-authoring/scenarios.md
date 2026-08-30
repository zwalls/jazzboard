# Goal scenarios

## Mona Lisa — held-out visual reconstruction

### Brief given to the authoring agent

Create an original, recognizable canvas interpretation of Leonardo da Vinci's *Mona Lisa* using only Jazzboard's native semantic shapes, paths, polygons, text, and grouping. Do not upload or embed the painting or any other raster image. Preserve the portrait's defining composition—three-quarter seated pose, enigmatic expression, dark hair and clothing, folded hands, and atmospheric landscape—while making intentional aesthetic choices that suit the available primitives.

### Acceptance criteria

- A reviewer can identify the subject without reading the room title.
- Face, hair, eyes, nose, mouth, torso, both folded hands, garment, chair or ledge, and layered landscape are semantically retrievable by stable name or role.
- The focal hierarchy favors face and hands; no essential feature is accidentally hidden, clipped, or illegibly small.
- Deliberate overlaps remain possible and are described by the composition; generic bounds-overlap findings do not erase them.
- A fresh focused inspection follows every coherent pass, and corrections name the finding or visual criterion they address.
- The final score is compared against the pinned baseline at the same 1280 x 720 framing.

## Netflix — public-source reference architecture

### Brief given to the authoring agent

Create a complex but readable system-context and container view of how Netflix streams a title to a member. Synthesize only from the public Netflix sources attached to the run. Clearly separate control/API traffic from video-byte delivery, distinguish AWS-hosted services from the Open Connect CDN and member/ISP edge, and include the supporting personalization, data/event, compute, observability, and media-processing planes. Label uncertain or historically sourced details rather than presenting them as one official current internal diagram.

### Minimum semantic content

- Member devices and ISP/network edge.
- Open Connect Appliances and the video/audio-byte delivery path.
- Global request routing or edge gateway, including Zuul where supported by the sources.
- Identity/profile, catalog or metadata, personalization, and playback/session/license responsibilities.
- A cache and durable-data plane, an event-streaming path, compute orchestration, and observability.
- A content-ingest or media-processing path that feeds distributable assets.
- Explicit trust or deployment boundaries and a legend that distinguishes request/control flow, asynchronous events, and media delivery.

### Acceptance criteria

- The primary member playback story can be followed left-to-right without a connector crossing an unrelated node.
- Architecture layers, boundaries, labels, and relationship directions are semantically retrievable.
- Connector labels remain readable at the full-diagram framing, with ports/routes chosen by the agent from current scene evidence.
- The diagram is complex enough to demonstrate local inspection and correction: at least 18 named nodes, 24 relationships, 4 visual zones, and 3 relationship styles.
- The authoring agent cites the supplied public sources in the diagram description or run manifest and marks synthesis/inference honestly.
- The final render receives an independent pixel review and at least one bounded correction pass unless it already meets every criterion.

