# EXP-0001A second live A/A pair

- Run date: 2026-09-01 Pacific / 2026-09-02 UTC
- Status: second operational pair complete
- Scope: `dev-drawing-stress-concurrent-collage`, replicate 1
- Conditions: frozen A0 and A1 bytes are identical
- Author policy: `gpt-5.6-terra`, medium reasoning, fresh projectless task
- Evaluation policy: fresh blinded `gpt-5.6-sol`, high reasoning
- Product commit: `eb69c38`

## Result

| Attempt | Author wall time | Author outcome | Final room state | Blinded outcome |
| --- | ---: | --- | --- | --- |
| `attempt-dev-drawing-stress-concurrent-collage-r1-a1` | 157.975 s | completed | revision 5, 11 objects, human note preserved | accepted after primary disagreement and independent adjudication |
| `attempt-dev-drawing-stress-concurrent-collage-r1-a0` | 175.187 s | completed | revision 5, 11 objects, human note preserved | accepted by both valid primary reviewers |

Observed pair acceptance was 2/2. Pairwise visual comparison preferred A0. This
is descriptive evidence for one pair, not a population estimate or a product
improvement percentage.

## Concurrent-edit proof

Each fresh room received the same frozen three-object collage fixture. After
the author performed its first visual inspection, the coordinator used the
normal human canvas UI to add `Trip: Kyoto — October`. The authoritative state
identified the note as human-authored. Both agents later re-read revision 5,
preserved the note, and completed without requesting confirmation.

Both authors encountered one ordinary schema rejection and corrected it
without human help:

- A1 requested an unsupported response-detail value, then retried with the
  registered value.
- A0 supplied an unsupported room-revision field to draft staging, removed it,
  and retried the corrected transaction.

Both then called `finish_canvas_draft` themselves and reached authoritative
state. The confirmation-gate failure observed in the first pair did not recur.

## Visual quality

A0 received two accepting primary decisions. A1's primaries disagreed: one
rejected the style integration because the airplane appeared isolated from the
dense collage, while the other accepted all criteria. A fresh adjudicator
accepted A1.

The blinded pairwise judge preferred A0 because its airplane was smaller and
fully visible; A1's larger airplane was cropped at the canvas edge and visually
overwhelmed the base collage. This is the actionable product signal from the
pair: semantic completion and concurrent-edit recovery were reliable, while
bounded final-framing judgment remains inconsistent.

## Evaluator transport observations

Two fresh primary-review tasks could not reliably consume all supplied
loopback evidence. They are retained as non-counted transport failures and
were replaced by fresh isolated reviewers with the same evidence and rubric.

One additional pairwise task was unnecessarily released after the compact
`wait_threads` projection appeared to truncate the required root. The exact
`read_thread` result proved that the first pairwise response was valid. The
duplicate is retained and non-counted. Future ingestion must treat
`read_thread` as the exact terminal record and use `wait_threads` only for
status/wakeup.

## Interpretation after two pairs

Across the two completed pairs, three of four authors produced accepted
artifacts. The first pair observed one invented confirmation gate; the second
pair observed zero, and both agents autonomously recovered from a rejected
tool input. The descriptive author-completion rate therefore moved from 1/2 in
the first pair to 2/2 in the second pair, but the task changed from architecture
creation to concurrent drawing and the sample is far too small for causal or
percentage-improvement claims.

The next scheduled pair should continue unchanged. The product follow-up
should focus on evidence that helps an agent notice clipping, scale imbalance,
and weak integration before declaring visual completion, without replacing
the agent's creative judgment with deterministic layout.
