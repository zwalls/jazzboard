# EXP-0029 endpoint and shared-route evidence replication

- Date: 2026-09-03
- Status: complete; prior defects corrected, visual quality gate still failed
- Product candidate: `e0a6787`
- Benchmark: unchanged frozen `dev-architecture-stress-dense-routing`
- Author: fresh projectless `gpt-5.6-terra`, reasoning `medium`
- Reviewers: two separate fresh projectless `gpt-5.6-sol`, reasoning `high`

## Result

The candidate made the two exact EXP-0028 reviewer defects visible before
commit. During draft correction the author received two fail-level endpoint
re-entry findings, removed them, and finished with zero endpoint re-entry and
zero ambiguous multi-flow shared-route groups. The authoritative fact audit
matched all nine required entities and all nine directed relationships.

This did not produce a quality-qualified speed win. Author wall time was
301,391 ms, effectively flat against EXP-0028 (+243 ms, +0.08%). The author
used 15 WebMCP business calls rather than 12, six accepted draft transactions
rather than five, and 144,685 accepted draft response bytes rather than
116,457 (+24.24%).

Both blinded reviewers failed the rendered artifact. They independently found
that routes crossed through labels or formed false visible junctions, making
otherwise-correct semantic relationships difficult to trace. Reviewer A found
two blocking geometry violations and reviewer B found five. Both passed factual
accuracy, anti-gaming, frame containment, membership, and unsupported-claim
checks.

## Scientific interpretation

The intervention worked on its intended local mechanism: the author observed
and removed the exact endpoint re-entry and three-flow shared-corridor pattern
that failed EXP-0028. The artifact nevertheless remained unreadable because a
different class of route ambiguity survived as nine warning-level signals:
five connector crossings, three label-edge collisions, and one congested port.

This is evidence against continuing to add isolated local checks without
summarizing their combined semantic effect. The author can clear each current
fail signal while moving ambiguity elsewhere. The next candidate should expose
holistic route-conflict clusters, especially a route crossing another route's
label and multiple unrelated connectors forming a false-junction cluster. It
must report exact evidence and stable identities without choosing routes,
moving objects, or composing the diagram for the author.

The accepted historical EXP-0004 run finished in 270,038 ms. EXP-0029 was
31,353 ms slower, but because EXP-0029 failed visual quality this is not an
accepted-completion speed comparison. No causal percentage quality-improvement
claim is made.

## Protocol notes

The author used only WebMCP for canvas state and mutations. One WebMCP
inspection call failed without mutating the room and was corrected. The author
also took one DOM snapshot despite the WebMCP-only interaction instruction;
the deviation is retained rather than hidden. The author inspected unpublished
draft pixels, committed autonomously, and inspected authoritative state and
pixels after commit.

The complete sanitized record is
`research/data/exp-0029-ambiguous-route-evidence-dense-routing-v1.json`.
Private room credentials, raw sessions, semantic state, pixels, and exact canvas
object identifiers remain gitignored.
