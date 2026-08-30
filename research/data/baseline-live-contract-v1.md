# Baseline live WebMCP contract verification v1

- Status: passed
- Product commit: `48a52e0837144ea0db8a09e43217397226759f83`
- Deployment: `dpl_2m1qqwE4xXuTX1huy4nwoEqy5fmD`
- Contract attempt: `contract-prod-baseline-v6`
- Responses API calls: none
- Sealed benchmark data accessed: none

The clean-room runner successfully created a fresh private production room,
verified all 54 participant WebMCP definitions, closed the author context, then
joined through a new spectator context and verified an exact 18-tool read/export
surface. The participant contract digest is
`sha256:d64cf3d25b9e275003438597b3b01c35419063d71613082d45aaf2f97c388b8e`;
the spectator contract digest is
`sha256:1760c6b1ec8cc4d8814b3de6a8f4516b3f4c215da69069c50072f23128541be2`.

This contract-only attempt used runner digest
`sha256:c2cbeaf5b216a5699b7e7fcc88326ff78763988d33943256f8eb193112426c24`.
Its author result records zero completed provider turns, so it verifies the new
provider-provenance artifact shape without calling the Responses API.

The immutable Vercel deployment URL is deployment-protected. The public alias
was therefore used only after an authenticated Vercel CLI inspection confirmed
that `www.jazzboard.xyz` still resolved to the exact frozen deployment. Every
future execution batch must repeat that alias preflight and pin both live
contract digests. A mismatch is a protocol failure, not a recoverable warning.

This result validates execution plumbing and role isolation only. It does not
measure autonomous authoring quality, reviewer reliability, or harness lift.
The complete compact receipt is
[`baseline-live-contract-v1.json`](baseline-live-contract-v1.json).
