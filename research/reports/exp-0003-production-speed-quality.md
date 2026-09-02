# EXP-0003 production speed-with-quality result

- Date: 2026-09-02
- Status: positive production development evidence; replication required
- Branch: `feature/agent-speed-quality`
- Final candidate commits: `18460d8`, `09ae3b2`, `85f8bd5`
- Final production deployment: `dpl_B2QMi4VXcv8cA1hnMoUXUNrVC9xP`
- Verified production origin: `https://www.jazzboard.xyz`
- Author model: `gpt-5.6-terra`, reasoning `medium`
- Blinded reviewer model: `gpt-5.6-sol`, reasoning `high`

## Outcome

The final production qualification completed the frozen dense-routing task in
335,809 ms versus the retained 477,603 ms production baseline. The observed
difference was -141,794 ms (-29.7%). This percentage describes wall time for
one public development task; it is not a population estimate.

Author task `01a06175-e883-7222-80a5-59d68ff377e0` ran in a fresh projectless
workspace with only the public task brief and exact private room URL. It used
the browser-exposed WebMCP surface and had no Jazzboard repository, private
API, prepared coordinate file, evaluator context, or prior author history.

The authoritative room ended at revision 3 with:

- exactly 9 required semantic nodes;
- exactly 9 required directed, labeled connectors;
- one first-class architecture Diagram at revision 1 with complete membership;
- no active object leases or pending review proposal;
- 0 deterministic failures and 1 connector-crossing warning.

The final inspection used pixel protocol schema v5 and its preferred stable
clean-viewport capture. Fresh blinded reviewer task
`01a0617c-3e31-79a1-bc91-4bde15237677` received only the public requirement,
frozen rubric, sanitized semantic state, and final clean pixels. It passed:

- semantic facts: PASS;
- route readability and direction: PASS;
- anti-gaming visibility: PASS;
- no unsupported invention: PASS.

The reviewer judged the one orthogonal Monitor-to-Service-A versus
Gateway-to-Service-B crossing visible but not materially defective: neither
label nor node was obscured, and endpoint arrowheads kept both relationships
unambiguous.

## Product changes supported by the trace

1. One compact architecture/illustration quickstart replaces redundant bundle
   loading while leaving live schemas and server authorization authoritative.
2. Draft receipts expose bounded intent-unaware validation before atomic
   publication, so authors can repair real routing defects without waiting for
   the final render.
3. Draft patch updates permit narrow correction of stable temporary references
   instead of resending an entire candidate for every small change.
4. Public guidance treats every relevant warning or failure as blocking when
   the user's explicit acceptance criteria forbid collisions, intrusion, or
   ambiguous routing, while preserving deliberate overlap for creative work.
5. Pixel protocol v5 prefers a stable clean-viewport capture and treats the
   returned screenshot clip as the primary inspection region. Direct clipped
   capture remains compatibility-only because the production browser showed
   that it can perturb responsive canvas geometry.

## Integrity record and limitations

No unsuccessful attempt was removed. The initial production attempt recovered
exact semantics but not usable pixels; the next recovered pixels but failed a
blinded visual review; a later attempt accidentally exercised the old custom-
domain deployment because the alias had not advanced. The final attempt was
released only after the intended deployment, public guidance, and protocol v5
were verified on `www.jazzboard.xyz`.

Because the candidate was reopened after observed failures, this report is
development evidence rather than a clean preregistered causal estimate. The
result warrants promotion of the product changes, followed by a randomized,
immutable multi-task replication to estimate general speed and acceptance
effects.
