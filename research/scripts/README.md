# Research scripts

Scripts in this directory must be deterministic, non-interactive, and safe to
run from a clean checkout. Each executable should document its inputs, outputs,
seed handling, and artifact schema.

Keep authoring and evaluation processes separate. Author runners may expose
only public browser WebMCP capabilities. Evaluator scripts may record traces,
screenshots, semantic state, and timing, but must never send hints or mutations
to the authoring session.

Prefer machine-readable JSON or JSONL outputs with schema versions. Emit hashes
for prompts, traces, room-state snapshots, media, and scorer configuration.
