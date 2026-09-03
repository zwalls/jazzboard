# EXP-0028 draft inspection and waypoint dense-routing replication

- Date: 2026-09-03
- Status: complete; mechanism improved, visual quality gate still failed
- Product candidate: `2c1b30f`
- Benchmark: unchanged frozen `dev-architecture-stress-dense-routing`
- Author: fresh projectless `gpt-5.6-terra`, reasoning `medium`
- Reviewers: two separate fresh projectless `gpt-5.6-sol`, reasoning `high`

## Result

The candidate solved the exact missing-evidence failure from EXP-0027. The author
kept every essential route inside the fixed scaffold, used agent-authored
waypoints, inspected the unpublished draft, and committed all nine required
nodes and nine correctly directed relationships in one coherent first-class
Diagram. Author wall time was 301,148 ms: 20.96% less than the preceding failed
run, with 12 rather than 20 WebMCP business calls, five rather than nine
accepted draft transactions, and 116,457 rather than 186,418 accepted draft
response bytes.

That is useful diagnostic progress, but it is not an accepted speed result.
Both blinded reviewers failed the artifact on the same geometry: the Gateway to
Service B route re-entered the Gateway interior after leaving its anchor, while
the Primary DB replication route shared long collinear segments with both
Gateway request routes. Three distinct semantic flows therefore read as one
ambiguous path. The deterministic analyzer exposed the shared segments only as
warnings and did not expose endpoint re-entry at all.

## Scientific interpretation

The experiment separates two mechanisms. Exact draft inspection plus
containing-scaffold evidence improved convergence and eliminated the predecessor
failure. Authored waypoints gave the model enough control to keep the artifact
inside the frame. Neither mechanism supplied sufficiently strong evidence about
routes that re-enter their own endpoints or substantial corridors shared by
three distinct flows. The quality failure is therefore evidence for a narrower
context gap, not evidence that Jazzboard should choose routes for the model.

The accepted historical EXP-0004 run finished in 270,038 ms. EXP-0028 was
31,110 ms slower, but because EXP-0028 failed quality this difference is not an
accepted-completion comparison. No causal or percentage quality-improvement
claim is made.

## Protocol notes

One initial draft transaction was rejected because the author supplied
`nodeMetadata.kind` for component and service nodes. Jazzboard returned
actionable correction guidance and no state was changed. The author recovered
immediately. The author also took one DOM snapshot despite the WebMCP-only
interaction instruction; all canvas reads and writes used WebMCP, and the
deviation is retained in the record rather than hidden.

## Next intervention

Add precise, intent-unaware evidence for endpoint re-entry and materially
ambiguous multi-flow shared routes, and clarify the `nodeMetadata` schema so the
model avoids the rejected call. These checks must report geometry and stable
object references without moving anything, selecting a layout, or rerouting on
the author's behalf. Then rerun the identical benchmark with the same author
and blinded-review settings.

The complete sanitized record is
`research/data/exp-0028-draft-inspection-waypoint-dense-routing-v1.json`.
Private room credentials, raw sessions, semantic state, pixels, and exact canvas
object identifiers remain gitignored.
