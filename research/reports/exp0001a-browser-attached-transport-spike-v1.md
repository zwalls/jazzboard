# EXP-0001A browser-attached transport spike v1

Date: 2026-09-01 (America/Los_Angeles)  
Disposition: **PASS for browser-attached WebMCP transport; full A/A remains blocked**  
Public evidence: [`../data/exp0001a-browser-attached-transport-spike-public-v1.json`](../data/exp0001a-browser-attached-transport-spike-public-v1.json)

## Question

Can a fresh Terra/medium author context, directly grounded in the user's current request and attached to the Codex in-app browser, operate production Jazzboard without repository access, private APIs, DOM product automation, or a confirmation gate?

## Conditions

- one fresh `gpt-5.6-terra` / `medium` author context;
- only the public checkout-architecture brief and the production website;
- no Jazzboard repository, source files, shell, prepared coordinates, evaluator context, private room API, or prior author transcript;
- the author self-provisioned a new private room using landing-page WebMCP;
- every product action used a browser-exposed WebMCP tool; and
- the requested product behavior was zero-confirmation participant authoring.

## Result

The transport passed. The author discovered production WebMCP, created a private room, and produced one first-class checkout architecture Diagram containing five explicitly classified nodes and five labeled semantic connectors. It performed authoritative semantic reads and a visual screenshot check. No confirmation prompt appeared, and no DOM automation was used for a product capability.

The author made 24 WebMCP calls. One initial `apply_canvas_transaction` input failed schema validation; the author corrected the input and the next atomic transaction succeeded. This is retained as an observable tool failure rather than hidden.

The primary orchestration context then independently reopened the same private room from local browser provenance and repeated `read_room_state`, `read_diagram`, and `inspect_canvas_scope`. Those reads proved room revision 2, Diagram revision 1, ten semantic objects split into five shapes and five connectors, complete Diagram metadata, five members, and five connector references. Only redacted SHA-256 digests are published.

Exact author wall time was not exported by the transport and is therefore `unobservable`; the observed wall-time upper bound was 289 seconds. Exact tokens, resolved model snapshot, and subscription usage were also unobservable and were not estimated.

## Caveat found by the spike

The progressive canvas draft expired before it reported a committable completion state. The author preserved task success by submitting the final artifact through the direct atomic transaction path. That is a valid transport result, but it means this spike does **not** prove progressive-draft reliability. No explicit agent-session lifecycle tool was exposed to the author.

## Decision

The direct-origin, browser-attached path is the correct transport family. The standalone CLI path remains unsuitable because it lacks an in-app browser attachment. Jazzboard remains agent-first and zero-confirmation for an authorized participant; this result does not justify consent dialogs or manual approval.

The spike is not permission to release the 48-attempt A/A. Before batch execution, the coordinator still needs a reproducible way to export immutable Codex task identifiers, the progressive-draft expiry must be understood or cleanly excluded from the measurement contract, and the frozen three-task Terra/medium qualification must pass.
