# EXP-0036 execution amendment v1

Recorded before any author attempt. The user authorized the eight author and
four reviewer tasks with “yes” after reviewing the preparation report. Exact
product commits, task content, seeds, fixed order, correctness/visual gates,
and advancement thresholds remain those of the frozen packet.

## Neutral browser bootstrap

Prepend the same operational instruction to all eight author prompts:

> Before joining the supplied room, call the landing-page native
> `list_recent_rooms` tool once. If it returns any existing room references,
> stop and report that isolation failed. Then join the supplied room and
> complete the task using your own workflow.

The host-clock measurement includes this bootstrap. Do not mandate a canvas
read for admission: a forced full-room read would bias the workflow under test,
especially known-scope edits and blank creation tasks. Admission instead checks
the captured native join and first naturally chosen successful room tool,
alongside the independently observed server participant identity.

## Preflight evidence

The original preflight contract required two CDP cookie probes to both remain
fresh within 60 seconds. Actual CDP calls previously exceeded requested timeouts
by 126–523 seconds; repeating them is not a reliable freshness test.

Retain the original v1 validator and evidence. The execution validator uses the
immutable, hashed, complete native isolation/capture checks on the two distinct
smoke origins, plus a fresh normal CUA host-availability check before each task.
Each author still receives a never-used hostname, empty native recent-room
result, fresh signed membership, fresh projectless task, exact frozen build,
and its own recorder epoch. Missing facts fail admission; no cookie probe or
unobserved state may be invented. This adjustment does not waive storage or
session isolation and does not change the author’s application workflow.

The first live availability check reported a locked Mac. No task was created;
no attempt was consumed. Author creation remains blocked until a fresh check
establishes that browser access is available.

## Viewport policy

Authors use the native in-app browser window; the controller does not invoke
undocumented resize APIs. Retain observed screenshot dimensions and do not
claim that author viewport size was experimentally controlled. Independent
review captures use a 1400 × 1000 CSS-pixel viewport at device scale factor 1,
with consistent framing, and are bound to the exact final document revision.
This distinction is fixed before any author run and must remain visible in the
results and limitations.
