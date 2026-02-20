# Pi Dynamic Context Pruning (DCP)

An extension for the [Pi Coding Agent](https://github.com/badlogic/pi-mono) that drastically reduces token usage and context bloat during long sessions. It aggressively yet safely prunes stale, duplicate, and massive tool outputs from the LLM context window without mutating your local session history.

## Why DCP?

As sessions grow, tool results (like huge file reads, massive bash stack traces, or repeated `ls` commands) push the LLM's context window to its limits. This increases latency, drives up API costs, and drastically increases the chance of "Lost in the Middle" syndrome, where the LLM forgets instructions hidden amidst thousands of lines of terminal output.

While Pi has native compaction, compaction operates blindly on all text before a certain cutoff point. **DCP operates semantically across the entire active branch**, safely discarding duplicate or obsolete data while preserving the semantic "breadcrumbs" of what the agent did.

### Core Safety Invariants
- **Never** deletes user messages or final assistant answers.
- **Never** overwrites the actual Pi session JSONL file (perfectly survives `/undo` and `/tree` branch hopping).
- **Never** deletes the causal history (e.g. knowing that a file *was* read, even if the payload is pruned).
- **Never** touches tool outputs from recent turns (default 8 turns protection).

## Installation

```bash
# Clone the repository
git clone https://github.com/PSU3D0/pi-dcp.git

# Run Pi with the extension
pi -e path/to/pi-dcp/index.ts
```

*Note: Once published, you can install via npm.*

## How it Extends a Session
Imagine a deep debugging session:
1. You run a massive test suite that fails with a 50-line stack trace.
2. The agent reads 3 files (thousands of lines of code) to find the bug.
3. The agent writes a fix, then reads the file again to verify.
4. The agent re-runs the exact same test suite command.

Without DCP, the LLM context holds: 2 massive stack traces, 4 huge file reads, and a massive write payload. 
**With DCP:**
- The first 3 file reads are replaced with `[DCP: Large output pruned]` because their data is stale.
- The `write` argument payload is pruned because it was superseded by the subsequent `read`.
- The first stack trace is shrunk to 150 characters because it's no longer the active error.
- The first `test` command output is pruned because it's an exact duplicate of the second.

DCP easily slices **30-50% of tokens** off long debugging sessions, letting you stay in the flow for hours without degrading model intelligence.

## Pruning Strategies

DCP operates through a series of pure-function strategies that execute backward over the session history in less than ~2 milliseconds.

### 1. Exact Deduplicate (Enabled)
If you run the exact same tool with the exact same arguments (e.g. `bash ls -la src/`) multiple times, DCP prunes the payload of all but the most recent one.
- **Why it matters:** Agents frequently re-run commands to check their bearings. You only ever need the newest output of a repeated deterministic command.
- **Default:** Protected if within the last 8 turns.

### 2. Purge Errors (Enabled)
When a bash script or compiler fails, the stack trace is crucial for the next 1-2 turns. But 10 turns later, once the bug is fixed, that 150-line trace is useless noise.
- **Why it matters:** Stack traces are the #1 cause of sudden context spikes. DCP shrinks old stack traces to just the first 150 characters, preserving the causal memory of the error (*"Ah, I tried that and it threw a TypeError"*) without the bloat.
- **Default:** Prunes errors older than 3 turns.

### 3. Output Replace (Enabled)
Ancient, massive payloads (like a 20,000 char file read) are swapped with a compact placeholder: `[DCP: Large output from read(...) pruned due to age (Turn 12). If you need this data again, re-run the tool.]`
- **Why it matters:** If a read simply vanished, the LLM might hallucinate that it never saw the file. The placeholder acts as a perfect long-term memory pointer—the agent knows it looked at it, and knows how to fetch it again if it suddenly becomes relevant.
- **Default:** Replaces outputs > 1200 chars older than 8 turns.

### 4. Supersede Writes (Disabled by default)
If the LLM uses `write` or `edit` to update a file, and subsequently uses `read` to check it, the massive `write` payload is redacted because the `read` inherently contains the new state.
- **Why it matters:** Code generation arguments take up massive amounts of input tokens.
- **Warning:** Disabled in the `safe` profile because Pi's `read` supports offset/limits. If the agent edits line 500, but only reads lines 1-100, pruning the write would cause the agent to forget the code it just wrote.

## Commands

While in Pi, you can use the interactive `/dcp` command to see what is happening under the hood:

- `/dcp status` - View total token savings, turn protection status, and pruning mode.
- `/dcp detail` - Opens a full-screen Markdown editor showing a categorized breakdown of exactly what was pruned and when.
- `/dcp manual on|off` - Enable or disable DCP mid-session.

*Note: DCP also places a non-intrusive status indicator (e.g., `✂️ DCP: ~17k tokens saved`) in the TUI footer whenever it successfully reduces your context payload.*

## Configuration

DCP is extremely conservative by default (`mode: "safe"`). You can override defaults globally at `~/.pi/agent/dcp.json` or locally per-project at `.pi/dcp.json`.

```json
{
  "enabled": true,
  "mode": "safe",
  "turnProtection": {
    "enabled": true,
    "turns": 8
  },
  "protectedTools": ["todo", "subagent", "send_to_session", "plan_enter", "plan_exit"],
  "protectedFilePatterns": ["**/CHANGELOG.md", "**/*.plan.md", "**/progress.md"],
  "strategies": {
    "deduplicate": { "enabled": true },
    "purgeErrors": { "enabled": true, "minTurnAge": 3 },
    "outputBodyReplace": { "enabled": true, "minChars": 1200 },
    "supersedeWrites": { "enabled": false }
  }
}
```

## Development

DCP is built using Bun, TypeScript, and the `@mariozechner/pi-coding-agent` SDK.

```bash
bun install
bun test
bun run typecheck
bun run format
```

## License

MIT
