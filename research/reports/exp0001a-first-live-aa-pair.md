# EXP-0001A first live A/A pair

- Run date: 2026-09-01 Pacific / 2026-09-02 UTC
- Status: first operational pair complete
- Scope: `dev-architecture-create-checkout`, replicate 1
- Conditions: frozen A0 and A1 bytes are identical
- Author policy: `gpt-5.6-terra`, medium reasoning, fresh projectless task
- Evaluation policy: fresh blinded `gpt-5.6-sol`, high reasoning

## Result

| Attempt | Author wall time | Author outcome | Final room state | Blinded outcome |
| --- | ---: | --- | --- | --- |
| `attempt-dev-architecture-create-checkout-r1-a1` | 258.448 s | completed | revision 7, 9 objects, 1 Diagram | accepted after primary disagreement and independent adjudication |
| `attempt-dev-architecture-create-checkout-r1-a0` | 154.536 s | noncompletion | revision 2, 0 objects, 0 Diagrams | `FAIL_AUTHOR_NONCOMPLETION` |

Observed pair acceptance was 1/2. This is a descriptive result for one pair,
not a population estimate and not an improvement claim.

## Completed artifact

The completed attempt created the four required entities and exactly three
directed semantic relationships. It used blue straight routes for the two
synchronous requests, an orange elbow route for the asynchronous event, and a
visible commerce trust boundary that excluded the browser.

The two primary reviewers disagreed. One rejected the artifact because the
Browser-to-Checkout API connector line and arrowhead were visually obscured by
the long label; the other passed all criteria. A fresh adjudicator, without
either primary decision, accepted all criteria. The disagreement is retained
as evidence of a borderline visual-presentation issue.

## Noncompletion

The matched author used the live site, inspected the blank board, staged a
diagram, and then stopped with a request for confirmation before publishing.
No confirmation was provided and no retry or replacement was launched. The
authoritative room remained empty. This is the failure mode the product and
harness are intended to surface: an agent-first direct-edit workflow is not yet
reliably interpreted as authorization to apply the edit.

## Transport observations

- The completed author reported 16 WebMCP calls, one schema failure, and three
  structured inspections.
- Three evaluator task launches were retained as non-counted transport/output
  failures before a second countable primary decision was obtained: one
  approval wait and two malformed terminal JSON results.
- Exact room state and PNG evidence are retained under the ignored private
  experiment root; room secrets are not included in this report.

## Interpretation

The live path works end to end, but this pair does **not** support a percentage
improvement claim. It identifies two concrete reliability targets:

1. Authors must apply participant-authorized live edits without inventing an
   additional confirmation gate.
2. Connector label placement must preserve a clearly visible path and
   arrowhead, not merely correct semantic endpoints.

The scientific response is to preserve this pair exactly and continue the
frozen schedule after correcting only experiment-transport defects. It would
be invalid to replace either author attempt or retroactively edit its artifact.
