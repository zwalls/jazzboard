# EXP-0001A Codex/WebMCP transport spike v2

Status: **verified pass and fixed-authority signed**

## Result

One fresh projectless Codex task authenticated through ChatGPT completed the
public transport brief using only its single Browser-skill bootstrap and the
Jazzboard page's browser-exposed WebMCP tools. It requested `gpt-5.6-sol` with
reasoning effort `max`, built one first-class semantic Diagram in one atomic
transaction, inspected it, read final authoritative room state, and returned a
terminal result.

Observed evidence:

- Codex tasks: 1
- wall time: 491,878 ms
- Browser source blocks: 28, all retained and completed
- WebMCP calls: 11
- WebMCP failures: 0
- authoritative canvas transactions: 1
- semantic objects: 11
- Diagrams: 1
- final room revision: 3
- final Diagram revision: 1
- requested model/reasoning: `gpt-5.6-sol` / `max`
- resolved model snapshot: `unobservable`
- resolved reasoning effort: `unobservable`
- subscription plan/tier: `unobservable`
- exact token counts and ChatGPT-credit usage: `unobservable`

The authoritative layout analyzer reported `fail` with 13 findings. That is
retained truthfully and does not invalidate a transport spike; this run is not
used as benchmark-quality evidence.

## Independent audit correction

The first recovery verifier was rejected before signing because generic Node
source filtering could be bypassed and the local PNG bytes were not bound to
Jazzboard's export metadata. The corrected v2 gate:

1. accepts only the exact independently audited raw task and 28-block trace;
2. rejects demonstrated filesystem, computed HTTPS/provider, dynamic-import,
   and WebMCP monkey-patch escapes;
3. reconstructs participant/challenge/activity attribution from the pinned
   trace, the `read_collaboration_state` session participant ID, and
   authoritative final `selfParticipantId` guards; and
4. removes every PNG byte/digest claim from the spike.

After those corrections, the independent re-audit found no remaining P0 or P1
blocker under the declared local-authority reconstruction model. The public
evidence omits private room identifiers and access material.

## Scope

This pass opens only the Codex-native coordinator rebuild. It does not release
the 48 author assignments, claim visual-quality improvement, validate a sealed
test set, or authorize an API-key/provider transport. The experiment remains
blocked until every remaining prebrief and execution gate passes.
