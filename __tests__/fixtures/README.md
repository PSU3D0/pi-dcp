# Long-run fixture conventions

These fixtures are shared regression inputs for DCP tickets that need long autonomous timelines.

## Conventions

- Build timelines with `LongRunFixtureBuilder` so timestamps and tool-call ids stay deterministic.
- Prefer short, readable synthetic payloads over opaque blobs; each payload should still look like a real `read` or `bash` result.
- Mark older payloads in `stalePayloads` when later tickets should be free to prune them.
- Mark current work products in `frontier` when later tickets should keep them visible.
- Track tool-result messages rather than assistant narration so preservation/pruning assertions map directly to DCP strategies.

## Current fixtures

- `createSingleTurnAutonomousRunFixture()` models many tool cycles inside one user turn, including repeated verification loops and repeated reads of a modified file.
- `createRepeatedVerificationLoopFixture()` isolates repeated verification output.
- `createRepeatedReadsOfModifiedFileFixture()` isolates repeated reads of the same edited file.
- `createStaleLogsWithFreshFrontierFixture()` models old giant payloads plus newer frontier artifacts across user turns.
