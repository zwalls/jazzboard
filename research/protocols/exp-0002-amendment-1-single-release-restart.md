# EXP-0002 Amendment 1 — Single-release restart

- Frozen: `2026-09-02T04:38:00Z`, before restart author release
- Parent: `exp-0002-composition-perception-micro-pilot.md`

The initial operator invocation created all four projectless author tasks, but
its response parser discarded the returned task identifiers. The operator then
incorrectly treated the empty projection as creation failure and released a
second author into each room. This violated the one-author-per-room isolation
contract before any outcome was interpreted.

Every affected room and known task is retained as invalid setup evidence. None
is counted, retried in-place, used as a control, or supplied to a reviewer. The
architecture candidate visibly contained duplicate graphs; the architecture
baseline's second author detected and removed its own duplicate. The drawing
rooms did not visibly duplicate objects, but remain invalid because two author
contexts were released.

The micro-pilot restarts prospectively with four new private rooms at revision
2 and fresh author tasks. Product arms, benchmark bytes, fixtures, rubrics,
model, reasoning, viewport, public prompts, outcomes, review policy, and
interpretation rules remain unchanged. Each author is created individually,
and its exact task identifier must be read back and persisted before the next
author is released.

This is a new restart cohort, not a substitution inside the invalid cohort.
The incident is part of the report and the invalid cohort remains outside the
effect denominator.

