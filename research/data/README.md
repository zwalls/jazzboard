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
assignments. `development-runner-profile-v1.json` is a retained, pre-Codex
provider-era artifact and is not executable authority. The active replacement
is `exp-0001a-codex-prebrief-freeze-v2.json`, which binds the fresh-projectless
Codex task transport, ChatGPT-only authentication, frozen role settings,
randomized schedule, subscription accounting, and usage-limit policy.

For every assignment, the coordinator must retain a fresh authenticated Vercel
CLI or API preflight inside the no-brief release gate and before provisioning
the private room. It must prove that `https://www.jazzboard.xyz` still resolves
to the frozen deployment and bind the exact assignment plus prior append-only
registry root. The same release chain must run a fresh `codex login status`
preflight and accept only ChatGPT authentication. A pre-gate failure remains
`not_started`; no Codex task is created and no task brief is released.

EXP-0001A v2 has no API token-price table, dollar budget, spend reservation, or
spend authorization. Task, model/reasoning, wall-time, WebMCP, canvas, and
observable subscription-usage fields are retained; unavailable exact values
are the literal `unobservable` and are never estimated.

`exp0001a-codex-webmcp-spike-public-v2.json` and
`exp0001a-codex-webmcp-spike-gate-public-v2.json` are the secret-free evidence
and fixed-authority eligibility gate for the one disposable projectless
Codex/WebMCP spike. They prove semantic transport and authoritative activity
only. The retained version-1 files are historical/revoked and cannot satisfy
the active freeze. Neither version-2 file contains or claims PNG bytes.

`exp0001a-model-role-qualification-plan-v1.json` is the machine-verifiable
companion to the model-policy amendment. It freezes the candidate Terra/medium
primary author setting, separate Sol/Luna diagnostic roles, the exact
three-task public-development gate, and the disclosure that its first task was
observed before the gate freeze. It is not authority to release the 48-run A/A.
