# EXP-0033 surfaced route-comparison replication

- Date: 2026-09-03
- Status: complete; author terminated without an authoritative artifact
- Product candidate: `55f4a71`
- Benchmark: unchanged frozen `dev-architecture-stress-dense-routing`
- Author: fresh projectless `gpt-5.6-terra`, reasoning `medium`

## Result

The concise draft receipt and architecture quickstart successfully changed
behavior: unlike EXP-0032, the author invoked the exact-draft
`routeCandidates` mode of `analyze_diagram_layout`. It authored two alternatives
and received read-only deltas while the draft remained at revision 1.

The behavioral uptake did not produce a passing artifact. The initial draft
had 21 failures and three warnings. The better of the two alternatives reduced
that counterfactual result to 13 failures and one warning, but neither
alternative passed. The author did not apply either alternative, did not move
the cramped nodes, and did not author another comparison. It inspected the
unchanged draft semantically, attempted to classify 14 returned failures as
intentional, and tried to commit without accounting for seven omitted failure
keys. Jazzboard correctly rejected the commit without changing authoritative
canvas state. The author then stopped and reported the unresolved draft.

The exact facts were present in the draft: all nine required entities and all
nine directed relationships were represented, with one first-class Diagram
containing nine members and nine connectors. The frozen frame and legend were
preserved. The retained draft pixels visibly show labels touching or covering
nodes, monitoring routes crossing near Service B, and an overall cramped
central routing region. This is a factual pass but a terminal completion and
visual-quality failure.

Author wall time was 287,120 ms, 33,167 ms faster than EXP-0032 (-10.36%).
WebMCP business calls fell from 14 to eight, and only one draft transaction was
accepted. The lower call count is not a successful efficiency improvement:
the author stopped before correction or commit. Ten descriptor fetches and
multiple browser-handle reconstruction attempts also show that a substantial
fraction of latency remains outside Jazzboard's business operations.

## Scientific interpretation

The intervention solved discoverability, not recovery. The author used the
new evaluator exactly once, proving that putting the recommendation in the
receipt and quickstart can alter behavior. The evaluator truthfully showed
that both proposed alternatives still failed. The response did not make the
next recovery branch sufficiently explicit: when every route candidate fails,
the agent must not stop, commit, or rationalize conventional diagram defects.
It should use the finding evidence to change the underlying node spacing or
author materially different route candidates, then compare and recheck again.

The next intervention should add an explicit, deterministic completion gate to
route-comparison output: candidate pass count, whether all candidates still
fail, and a conditional next step. This must not rank or select candidates.
Finding-bearing correction context should also state that route comparison can
only evaluate connector patches; when short node gaps or an overloaded region
cause many collisions, the agent must first choose and patch new node geometry.
Finally, intentional-finding guidance should say that failure to find a good
candidate is not evidence that a conventional readability defect is deliberate.

## Protocol notes

The prompt, fixture, model, reasoning level, and projectless isolation were
unchanged from EXP-0032. The author had no repository access, private API
access, prepared coordinates, evaluator context, or paired result. It used
WebMCP for every canvas operation. The route comparison did not mutate the
draft or room.

No blinded reviewer tasks were released because the author produced no
authoritative committed artifact. The predeclared completion endpoint therefore
failed before the reviewer stage; spending reviewer contexts on an explicitly
unresolved, discarded draft would not change the experiment verdict. The
failed draft, exact semantic inspection, and pixel artifact were retained
privately and then discarded from the live room.

Exact tokens and resolved model snapshot were unobservable. Subscription usage
was observable at 95% after the attempt; no usage-limit interruption occurred.

