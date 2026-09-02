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

## Active research program

Start with these persisted documents after any handoff or context reset:

- [`protocols/roadmap-v1.md`](protocols/roadmap-v1.md) defines the estimand,
  benchmark partitions, phased research program, analysis principles, and
  permitted claim language.
- [`protocols/exp-0001a-execution-readiness.md`](protocols/exp-0001a-execution-readiness.md)
  is the operational continuation record for the current A/A measurement
  calibration. Its unchecked closures and fixed execution order are
  authoritative until a versioned protocol amendment replaces them.
- [`protocols/exp-0001a-codex-native-transport-v1.md`](protocols/exp-0001a-codex-native-transport-v1.md)
  replaces the unexecuted API-key transport with fresh projectless Codex tasks
  backed by ChatGPT sign-in. The verified transport prerequisite is the
  narrowly scoped [v2 disposable-spike protocol](protocols/codex-webmcp-disposable-spike-v2.md),
  [v2 report](reports/exp0001a-codex-webmcp-spike-v2.md), and fixed-key-signed
  [v2 recovery gate](data/exp0001a-codex-webmcp-spike-gate-public-v2.json).
  The original behavior spike is preserved as
  [historical redacted evidence](data/exp0001a-codex-webmcp-spike-public-v1.json)
  and a [historical spike report](reports/exp0001a-codex-webmcp-spike-v1.md), but
  its version-1 gate is revoked and cannot authorize A/A execution. The v2
  spike proves semantic transport and authoritative activity only; final PNG
  bytes are collected and verified independently for each real attempt.
- [`protocols/exp-0001a-model-policy-amendment-v2.md`](protocols/exp-0001a-model-policy-amendment-v2.md)
  freezes the three-task Terra/medium author qualification and keeps the
  existing 48-attempt A/A blocked and unmodified until that gate passes.
- [`reports/exp0001a-terra-medium-qualification-v2.md`](reports/exp0001a-terra-medium-qualification-v2.md)
  records the signed three-task compatibility pass: three valid Terra/medium
  authors, six accepting blinded Sol/high primary reviews, and no adjudication
  or usage-limit interruption. The pass makes a separately signed successor
  runtime eligible; it does not by itself release the 48-attempt A/A.
- [`reports/exp0001a-browser-attached-transport-spike-v1.md`](reports/exp0001a-browser-attached-transport-spike-v1.md)
  records the direct-origin Terra/medium production transport pass. A fresh
  browser-attached author self-provisioned a private room and produced an
  independently re-read WebMCP artifact with no confirmation prompt or DOM
  product automation. The result validates the transport family but does not
  release the 48-attempt A/A: immutable task-ID export, progressive-draft
  reliability, and the frozen three-task qualification remain open.
- [`protocols/public-gold-rater-validation-v1.md`](protocols/public-gold-rater-validation-v1.md)
  separates reviewer validity from A/A reliability. A later A/B claim remains
  blocked until a preregistered public gold corpus passes that gate.
- [`protocols/failure-taxonomy-v2.md`](protocols/failure-taxonomy-v2.md) resolves
  the version-1 adjudication contradiction prospectively while preserving all
  historical version-1 records.

The current experiment is an A/A calibration on public development tasks. It
does not authorize access to a sealed benchmark or a product-improvement
claim. Direct API execution is prohibited. A task brief may be released only
through the ChatGPT-authenticated Codex task transport after the complete
receipt-bound chain passes; the 48-attempt run additionally requires a passing
disposable Codex/WebMCP spike with a currently valid signed recovery gate.

## Reproducibility contract

Every reported experiment must identify the product commit, harness version,
model and reasoning settings, task-set version, randomization inputs, budgets,
complete run count, exclusions, scorer version, and artifact hashes. Percentage
claims require a preregistered ratio-scale metric or pass rate, an uncertainty
interval, and explicit guardrail results.
