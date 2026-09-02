# EXP-0005 speed-with-quality replication result

- Date: 2026-09-02
- Status: complete; positive quality direction, inconclusive speed direction
- Author: fresh projectless `gpt-5.6-terra`, reasoning `medium`
- Reviewer: separate fresh projectless `gpt-5.6-sol`, reasoning `high`
- Attempts: 8 authors and 8 blinded reviewers

## Result

The candidate passed all four blinded reviews. The preceding surface passed two
of four. On the target architecture tasks, the candidate passed two of two and
the preceding surface passed zero of two. Both conditions passed both drawing
controls, so this small sample found no drawing-quality regression.

This is meaningful development evidence, not a population estimate. Eight
attempts cannot support a general percentage claim.

| Task | A0 wall time | A0 review | A1 wall time | A1 review | A1 - A0 |
| --- | ---: | --- | ---: | --- | ---: |
| Observability architecture | 214,150 ms | Fail | 316,374 ms | Pass | +102,224 ms |
| Wayfinding drawing | 123,710 ms | Pass | 213,800 ms | Pass | +90,090 ms |
| Layered portrait | 210,893 ms | Pass | 167,933 ms | Pass | -42,960 ms |
| Checkout architecture | 241,810 ms | Fail | 171,941 ms | Pass | -69,869 ms |

The raw median wall time was 212,521.5 ms for A0 and 192,870.5 ms for A1, a
descriptive difference of -19,651 ms. That is not an accepted-completion speed
comparison: both rejected A0 architecture artifacts have no accepted completion
time. The matched differences also split evenly between candidate wins and
losses. Speed therefore remains inconclusive and high-variance.

## Mechanism evidence

The candidate architecture attempts each used three draft transaction calls,
versus four and six on A0. Both candidate authors exercised the new correction
operation:

- observability used two completed transaction calls containing five
  `update_draft_connector` operations each;
- checkout used one completed transaction call containing three operations;
- no candidate attempted an unsupported connector-correction form.

This is evidence that the operation is discoverable and can reduce correction
transport, but it does not prove that it is the sole cause of either quality or
timing differences. Observability A1 made more total WebMCP calls and was slower
despite passing, while checkout A1 used half as many draft transactions, passed,
and was faster.

Host execution medians were 38,027.5 ms for A0 and 34,762 ms for A1.
Model-and-coordination medians were 174,472.5 ms and 160,893 ms respectively.
Most wall time still sits outside tool execution, making concise discovery,
actionable diagnostics, and fewer decision loops the highest-leverage speed
targets.

## Quality failures and new blind spot

The A0 observability artifact failed because four required node labels were
truncated and the telemetry label was obscured. The A0 checkout artifact failed
because its Checkout API box covered the first letter of the required
`Commerce trust boundary` text.

The checkout artifact's deterministic geometry inspection reported no finding,
but the blinded pixel reviewer correctly rejected it. The large labeled trust
boundary was a visual contributor but was omitted from the Diagram's declared
members, so Diagram-only geometry never compared its label with the foreground
node. That is an actionable inspection blind spot: an agent cannot correct a
defect that Jazzboard says is absent.

## Decision

Keep `update_draft_connector` and exact draft-correction receipts. The candidate
met the frozen advancement rule: both architecture artifacts passed, drawing
controls did not regress, and no unsupported correction form was attempted.

Do not claim a general speed percentage. The next product change should add
paint-order-aware shape-label and text-object occlusion evidence with exact
object identities, revisions, and corrective guidance. After that focused
change, run a smaller prospective validation before expanding the speed study.

The complete sanitized record is
`research/data/exp-0005-speed-quality-replication-v1.json`. Raw sessions, private
room credentials, final semantic packets, and clean pixels remain outside Git;
their SHA-256 digests are retained in the public record.

## Accounting

- Codex tasks: 16 total (8 author, 8 reviewer)
- Usage-limit interruptions: 0
- Reset credits consumed: 0
- Exact tokens: unobservable
- Resolved model snapshots: unobservable
- Per-task subscription usage: unobservable
- Account primary-window usage after the study: 78% used, shared across account
  activity and therefore not attributable exactly to this experiment
