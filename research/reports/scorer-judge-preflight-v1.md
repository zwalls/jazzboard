# Scorer and judge preflight validation v1

- Status: deterministic preflight passed; live-rater calibration pending
- Scope: public synthetic fixtures only
- Sealed data accessed: no
- Product-improvement claim supported: no

## Purpose

This report validates that the version-1 measurement code reacts in the
intended direction to known synthetic corruptions and that the blinded
two-reviewer/adjudication accounting is executable. It does not estimate how
accurately a model or human reviewer will score real Jazzboard artifacts. That
requires the preregistered A/A development calibration.

## Frozen inputs

| Input | Contents | File SHA-256 |
| --- | --- | --- |
| Scorer calibration corpus | 6 architecture, 6 drawing, and 2 correction cases | `01f319a20a11e44fc6261b0e819fb7e20275169875bf398f1c4d6a620fa4e688` |
| Judge accounting fixture | 10 synthetic artifacts, 20 primary ratings, 1 adjudication | `72017615a1821e30017459742fd284066104e32c68a074e1bdfc7330206502d3` |
| Evaluator instructions | Individual-first blinded scoring and adjudication contract | `921cb0536f7c7f2069d1fef295926daaaaf8fa829b79f3a8c88a4943b574a1d5` |

Hashes above are hashes of the exact checked-in file bytes. Attempt and run
receipts separately use canonical-JSON hashes where their schemas require it.

## Deterministic scorer results

All 14 complete scorer fixtures produced determinate results, and all 19
declared monotonicity or invariance relations passed. The corpus specifically
tests:

- off-frame, microscopic, transparent, and duplicated semantic stuffing;
- architecture member overlap, connector direction, routing intrusion, and
  connector-label collision;
- preservation of deliberate drawing overlap without architecture-only
  spacing penalties;
- missing or ineligible drawing parts; and
- correction improvement, regression, new defects, and failure to retain the
  best observed state.

The calibration proves code-path sensitivity to these constructed inputs. It
does not prove that an upstream pixel or semantic observer will identify every
real defect; evidence coverage remains explicit and incomplete coverage cannot
silently become a pass.

## Judge-accounting results

The checked-in synthetic fixture replayed to:

| Diagnostic | Result | Preregistered alarm | Status |
| --- | ---: | ---: | --- |
| Binary agreement | 9/10 (0.90) | below 0.80 | pass |
| Primary-class agreement | 9/10 (0.90) | reported separately | observed |
| Cohen's kappa | 0.80 | below 0.60 | pass |
| Adjudication | 1/10 (0.10) | above 0.20 | pass |
| Diagnostic triggers | 0 | any listed trigger | pass |

The executable contract also rejects treatment-label leakage, viewing a paired
artifact before the individual lock, ratings locked after unblinding, reused
primary reviewers as adjudicators, duplicate ratings, missing adjudication,
or outcome-selective adjudication of an agreement. It reports binary agreement
separately from failure-class agreement and preserves both original ratings.

These values were intentionally constructed to exercise the formulas and
thresholds. They are not empirical reviewer-reliability estimates and may not
be cited as evidence that Jazzboard's evaluators are 90% accurate.

## Decision

The deterministic scorer and reviewer-accounting layers are ready to enter the
clean-room A/A calibration. They are not yet sufficient to start an A/B harness
claim. Before that step, real development artifacts must be independently
rated, every original rating and adjudication retained, deterministic scores
replayed from hashed evidence, and every A/A diagnostic threshold disposition
published without exposing a sealed partition.
