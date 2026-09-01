# EXP-0001A qualification v2 — live run 8

Date: 2026-08-31 (America/Los_Angeles)  
Disposition: retained author setup failure; A/A release remains blocked  
Private evidence: retained under the dated `exp0001a-qualification-v2-aborted-live-*` archive

## What happened

Run 8 started from clean commit `c4a7d02` after the complete 19-file / 148-test release gate, typecheck, scoped lint, and production build passed. Production provisioning and one-time fresh Terra/medium author creation passed. The compact unique title and complete delegation witness matched exactly.

The author attempted the mandated one-time browser-skill read, but constructed a nonexistent path by combining the Sites plugin cache root with the Browser plugin's versioned path. The command failed. The author then correctly honored the prohibition on further terminal access, returned the exact setup failure, and made no browser or WebMCP call. The fail-closed receipt sealed as `failed`.

## Classification and final transport correction

This is an observed Terra author setup failure under the released prompt, not a false-positive validator rejection. However, locating a platform plugin file is nuisance variance unrelated to Jazzboard authoring, visual reasoning, or WebMCP capability. The system catalog already contained the authoritative path, and prior fresh Terra authors resolved it correctly, but this attempt did not.

The final transport correction supplies one portable exact command using the stable home-relative frozen Browser-plugin path (`~/.codex/plugins/cache/openai-bundled/browser/26.825.51511/...`). The validator accepts only that exact frozen path or its resolved absolute equivalent, requires a complete successful read, and still permits no other command or filesystem access. This adds no task answer, artifact content, repository context, geometry, or evaluator information.

## Scientific handling

- The created author task is consumed and will not be rerun, replaced, or rescored.
- This run is retained as an author setup failure, not evidence about diagram quality.
- One final fresh qualification restart is permitted solely to remove this infrastructure ambiguity.
- After that correction, any authoring or proof-protocol failure is treated as a real Terra compatibility result rather than prompting more transport tailoring.
