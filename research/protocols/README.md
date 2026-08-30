# Protocols

Create one immutable protocol for each experiment before running the sealed
test split. A protocol must define:

- the hypothesis and exact baseline/candidate commits;
- task-set version, model snapshot, reasoning effort, budgets, and repetitions;
- primary metrics, guardrails, exclusion rules, and stopping rule;
- the clean-room capability boundary and evidence required to prove it;
- the statistical analysis and wording allowed for any improvement claim.

Amendments are new versioned files; do not edit a protocol after observing its
sealed-test results.
