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
