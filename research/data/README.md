# Research data

Commit only compact data that is reviewable and appropriate for source control:
task manifests, provenance records, schemas, curated annotations, licenses, and
artifact hashes.

Store raw traces and media under `data/raw/` and reproducible transformations
under `data/derived/`; both are ignored by Git. A checked-in manifest must point
to their durable location and record content hashes so another evaluator can
verify the exact inputs without committing large or sensitive files.

Never include guest sessions, room secrets, private repository contents, or
personally identifying production data.

`development-execution-manifest-v1.json` freezes the 48 EXP-0001A development
assignments. `development-runner-profile-v1.json` freezes their baseline build,
model, browser, viewport, budgets, tool allowlist, and live-contract hashes.
Before every batch, obtain an authenticated Vercel CLI or API preflight proving
that `https://www.jazzboard.xyz` still resolves to deployment
`dpl_2m1qqwE4xXuTX1huy4nwoEqy5fmD`; the immutable deployment URL is protected and
must not be substituted into an author run.
