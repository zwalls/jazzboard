# EXP-0004 draft-correction transport result

- Date: 2026-09-02
- Status: positive production development evidence; replication required
- Candidate commit: `cc6508b4601981b3842bc5f3210b62d6a5a75bb6`
- Production deployment: `dpl_dkMwMkUsV9At8JHBVWkvp4JDWqPS`
- Production origin: `https://www.jazzboard.xyz`
- Author: fresh projectless `gpt-5.6-terra`, reasoning `medium`
- Reviewer: separate fresh projectless `gpt-5.6-sol`, reasoning `high`

## Result

The frozen dense-routing author completed in 270,038 ms, compared with 335,809
ms for the retained matched production attempt. The observed difference was
-65,771 ms (-19.6%). This is one development task, not a population estimate.

The more diagnostic result is correction transport:

- draft transaction calls fell from 11 to 6;
- four candidate calls used `update_draft_connector` with stable temporary
  references and exact draft revisions;
- unsupported draft-correction calls fell from three to zero;
- WebMCP calls fell from 15 to 10;
- initial-authoring phase wall time fell from 238,758 ms to 192,827 ms;
- model-and-coordination time fell from 260,867 ms to 213,786 ms.

The candidate did not choose layout or route geometry. The author selected and
revised every node position, connector endpoint, route, label, and style. The
new operation only reconstructed one complete unpublished connector from the
agent's partial semantic edit while preserving unaffected draft state.

## Quality result

The final room reached authoritative room revision 2 with exactly nine nodes,
nine labeled directed connectors, and one first-class Diagram containing every
required member and relationship. The author completed exact rendered-pixel
inspection after atomic publication.

Fresh blinded reviewer task `01a063d8-af37-7751-9fef-965b0cbb5d21` received
only the public requirement, frozen rubric, sanitized semantic state, and exact
clean-canvas PNG. It returned:

- `criterion-dense-facts`: PASS
- `criterion-dense-routing`: PASS
- `criterion-dense-antigaming`: PASS
- overall: PASS
- material defects: none

## Provenance

- Author task: `01a063d1-9627-71e2-a748-7082052a498c`
- Author turn: `01a063d1-9783-7f11-bb82-d7e690f0fcec`
- Author session SHA-256:
  `a67cd1556dbf5f727dfdd0b1932b268b2e797f017c7ddf582918101472ea4f26`
- Reviewer turn: `01a063d8-b0b7-7740-a7a2-1fd88750918e`
- Reviewer session SHA-256:
  `23a58bbef2bc53f00091998f23f9a2b27d5c5a98488f38f80b6ee6724de291b1`
- Sanitized semantic evidence SHA-256:
  `0aa244015b65344ccacaad5a785c0455cd1ea642927d5eb6fd31d91de7e58792`
- Clean PNG SHA-256:
  `743fc6800acdfa03cdd69aa76f2e3844058fda23286d9dcd267a5d867b693c5c`

Raw author/reviewer sessions and private room credentials are not copied into
the repository. The sanitized timing record is retained in
`research/data/exp-0004-speed-phase-diagnostic-v1.json`.

## Decision

Keep the connector-patch mechanism and advance to a small randomized,
interleaved replication spanning both architecture and drawing tasks. The
primary outcome is time to blinded acceptance; semantic and perceptual quality
remain non-inferiority gates. Do not advertise a general percentage gain from
this micro-pilot.
