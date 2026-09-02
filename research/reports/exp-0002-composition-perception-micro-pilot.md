# EXP-0002 composition-perception micro-pilot

- Status: complete exploratory micro-pilot
- Frozen protocol: `research/protocols/exp-0002-composition-perception-micro-pilot.md`
- Restart amendment: `research/protocols/exp-0002-amendment-1-single-release-restart.md`
- Product arms: `A0=eb69c38`, `A1=3d44902`
- Author: fresh projectless `gpt-5.6-terra`, medium reasoning
- Reviewer: fresh projectless `gpt-5.6-sol`, high reasoning
- Development tasks: dense architecture routing and cropped-illustration repair

This was a four-attempt exploratory mechanism test, not a powered product-lift
study. It cannot support a percentage-improvement claim.

## Integrity incidents and exclusions

The first coordinator release projected four successful task-creation results
as empty objects, then released a second author to the same rooms. Every room
in that cohort is retained but excluded. The preregistered amendment restarted
the pilot with four fresh rooms and persisted each returned task identifier
before releasing the next author.

The first reviewer packet was also excluded before result interpretation. A
coordinator capture error omitted unchanged fixture objects from one drawing
image. The replacement packet used independently recaptured, revision-matched
inspection clips. Both order-swapped reviewers received only the stable v3
images. Neither incident changed an author artifact or caused an in-place
retry.

## Clean author outcomes

| Attempt | Arm | Task | Wall time | Final room revision | Inspections | Targeted correction | Authoritative result |
| --- | --- | --- | ---: | ---: | ---: | --- | --- |
| `jade-06` | A1 | dense routing | 342.9 s | 15 | 5 | yes | 9 nodes, 9 connectors |
| `amber-07` | A0 | crop repair | 125.6 s | 4 | 1 | yes | intact 6-object scene |
| `indigo-08` | A0 | dense routing | 396.9 s | 8 | 4 | yes | 9 nodes, 9 connectors |
| `coral-09` | A1 | crop repair | 140.5 s | 4 | 2 | yes | intact 6-object scene |

Both architecture artifacts were semantically complete despite one A1 final
message undercounting its relationships. The authoritative room contained all
nine required connectors. Both drawing attempts preserved every required part
and intentional layer relationship.

## Mechanism observations

- Both A1 authors used exact whole-room `inspect_canvas_scope` requests, so the
  new room-scope mechanism was discoverable and usable.
- Both A1 authors made a bounded correction after inspection.
- Neither A1 author captured the exact returned `screenshotClip`; both captured
  the full viewport. The A0 drawing author did perform an exact clip capture,
  while the A0 architecture author also used full-viewport captures.
- The coordinator independently made a crop-selection mistake during evidence
  collection. This strengthens the diagnosis that clip metadata is available
  but the host-capture handoff remains unnecessarily error-prone.

The exact receipt payloads are not exposed by task-history retrieval, so
receipt-field observation itself is `unobservable`; exact downstream room
inspection calls are directly observed in author tool history.

## Blinded visual preference

Each task received two fresh order-swapped judges. Stable evidence hashes were:

| Attempt | SHA-256 |
| --- | --- |
| `amber-07` | `90c31d7f3c27eb011c1583dfba313608cc645df8ee6601c1002f97f5c55eddbb` |
| `coral-09` | `c72d58388ab392f2a41cf900346d66c3badd78aa6ec1b4e9d233b3cfdb687737` |
| `indigo-08` | `91612072ed6ada92791fa29752b7d2773ac8476a2eae8d7927bdc3659ee850bc` |
| `jade-06` | `d9ffdaaa44e6677283a257a09ff7e5b1c12c7a78aacb545180d44850129fe778` |

Architecture judges both preferred A0: `left` when A0 was left and `right`
when A0 was right. The A0 result used a tighter, more direct route structure;
the A1 result remained complete but used larger curved monitoring paths and
more corrective revisions.

Drawing judges each preferred the left image regardless of arm. With the order
swapped, that is position-dependent disagreement and is interpreted as visual
parity, not an arm win.

## Interpretation

The candidate demonstrated that whole-room composition evidence can trigger a
real inspection-and-correction loop. It did not demonstrate a visual-quality
gain in this micro-pilot. Architecture preference favored A0 twice under order
swap, drawing was parity, and A1 used more room revisions on both tasks. One
pair per task is too small to attribute the architecture difference solely to
the treatment, so the correct conclusion is **no demonstrated candidate lift**,
not that composition inspection is harmful.

The strongest cross-arm product finding is the pixel-handoff failure: agents
received exact clip metadata but often inspected a full viewport instead, and
the coordinator itself once captured the wrong visual packet. The next product
change should make the exact host screenshot action copy-ready and explicit in
the inspection result and agent guidance, without making layout decisions for
the author. That change should be evaluated independently before expanding the
experiment schedule.

