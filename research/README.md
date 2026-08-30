# Jazzboard research workspace

This directory is the controlled workspace for measuring and improving agent
authoring quality. It keeps scientific protocols, benchmark definitions,
reproducible scripts, compact datasets, and published summaries separate from
product code and from ad hoc demo evidence.

## Non-negotiable evaluation boundary

An evaluated authoring agent may receive only the task brief, an authorized
room entry point, and the WebMCP capabilities available to a real Jazzboard
user. It may not read this repository, use a terminal, call private room APIs,
run `page.evaluate`, consume prepared coordinates, or access benchmark answers.
Every attempt counts, including failures. A passive evaluator may observe and
record the run but may not help the author.

## Directory map

- `protocols/` — preregistered hypotheses, metrics, budgets, exclusions, and
  analysis plans.
- `benchmarks/` — versioned task definitions, schemas, development splits, and
  public benchmark metadata. Sealed test prompts and answers must remain
  outside the authoring repository.
- `scripts/` — deterministic runners, trace validators, scorers, report
  generators, and integrity checks.
- `data/` — compact, reviewable manifests and curated annotations. Large raw or
  derived datasets are intentionally ignored.
- `results/` — checked-in aggregate summaries and claim reports. Per-run media,
  transcripts, and bulky outputs are intentionally ignored.

## Relationship to existing material

Historical evidence remains in [`evals/agent-authoring`](../evals/agent-authoring/README.md),
and prior harness-engineering research remains in [`learnings`](../learnings/README.md).
New controlled experiments should reference those sources without silently
rewriting their results.

## Reproducibility contract

Every reported experiment must identify the product commit, harness version,
model and reasoning settings, task-set version, randomization inputs, budgets,
complete run count, exclusions, scorer version, and artifact hashes. Percentage
claims require a preregistered ratio-scale metric or pass rate, an uncertainty
interval, and explicit guardrail results.
