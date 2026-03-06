# Pi Dynamic Context Pruning (DCP)

An extension for the [Pi Coding Agent](https://github.com/badlogic/pi-mono) that drastically reduces token usage and context bloat during long sessions. It aggressively yet safely prunes stale, duplicate, and massive tool outputs from the LLM context window without mutating your local session history.

## Why DCP?

As sessions grow, tool results (like huge file reads, massive bash stack traces, or repeated `ls` commands) push the LLM's context window to its limits. This increases latency, drives up API costs, and distracts the model from the current task.

DCP solves this by functioning as a "Zero-Mutation Context Hook". It sits between Pi and the LLM, creating a clean, deep-copied subset of your message history just in time for the API request.

### Core Safety Invariants

- **Never** deletes user messages or final assistant answers.
- **Never** overwrites the actual Pi session JSONL file (perfectly survives `/undo` and `/tree` branch hopping).
- **Never** deletes the causal history (e.g. knowing that a file _was_ read, even if the payload is pruned).
- **Never** touches tool outputs from recent turns (default 8 turns protection).

## Installation

### Install as a Pi package

```bash
# Install from GitHub and let Pi discover the extension via package metadata
pi install git:github.com/PSU3D0/pi-dcp

# Or try it for just the current run
pi -e git:github.com/PSU3D0/pi-dcp
```

### Install from a local checkout

```bash
git clone git@github.com:PSU3D0/pi-dcp.git
cd pi-dcp

# Temporary test load
pi -e ./index.ts

# Or install the package from the local directory
pi install .
```

## Features & Strategies

DCP operates through a series of pure-function strategies that execute backward over the session history in less than ~2 milliseconds:

1. **Exact Deduplicate**: If you run the exact same tool with the exact same arguments (e.g. `bash ls -la`) multiple times, DCP prunes the payload of all but the most recent one.
2. **Purge Errors**: Colossal compilation stack traces are crucial for fixing bugs, but useless 10 turns later. DCP shrinks old stack traces to just the first 150 characters (preserving the causal memory of the error type).
3. **Supersede Writes**: If the LLM uses `write` or `edit` to update a massive file, and subsequently uses `read` to check it, the massive `write` payload is redacted because the `read` inherently contains the new state.
4. **Output Replace**: Ancient, massive payloads (like a 20,000 char file read) are swapped with a compact placeholder: `[DCP: Large output from read(...) pruned due to age. If you need this data again, re-run the tool.]`

## Commands

While in Pi, you can use the interactive `/dcp` command to see what is happening under the hood:

- `/dcp status` - View total token savings, turn protection status, and pruning mode.
- `/dcp detail` - Opens a full-screen Markdown editor showing a categorized breakdown of exactly what was pruned and when.
- `/dcp manual on|off` - Enable or disable DCP mid-session.

_Note: DCP also places a non-intrusive status indicator (e.g., `✂️ DCP: ~17k tokens saved`) in the TUI footer whenever it successfully reduces your context payload._

## Configuration

DCP is conservative by default (`mode: "safe"`). It now supports both JSON and JSONC configs.

Search order:

- `~/.pi/agent/dcp.json`
- `~/.pi/agent/dcp.jsonc`
- `.pi/dcp.json`
- `.pi/dcp.jsonc`

Later files override earlier ones, so project-local JSONC wins last.

Recommended:

- use JSONC for human-edited configs
- start from [`dcp.config.example.jsonc`](./dcp.config.example.jsonc)
- keep `supersedeWrites` off until you have confidence in your workflow

Current default behavior:

- `turnProtection` keeps recent prior user turns stable
- `stepProtection` keeps the current autonomous frontier stable once a same-turn run gets deep enough
- pressure bands gate strategy aggression (`low`, `medium`, `high`, `critical`)
- `protectedFilePatterns` are enforced
- frontier pinning keeps the latest modified-file reads, latest verification outputs, and narrow plan/progress artifacts visible
- extra names in `protectedTools` are harmless if your Pi setup does not define those tools; treat them as optional examples for coordination-heavy setups

Minimal example:

```jsonc
{
  "enabled": true,
  "mode": "safe",
  "turnProtection": {
    "enabled": true,
    "turns": 8
  },
  "stepProtection": {
    "enabled": true,
    "steps": 2
  },
  "thresholds": {
    "nudge": 0.7,
    "autoPrune": 0.8,
    "forceCompact": 0.9
  },
  "protectedTools": [
    "todo",
    "subagent",
    "send_to_session",
    "plan_enter",
    "plan_exit"
  ],
  "protectedFilePatterns": [
    "**/CHANGELOG.md",
    "**/*.plan.md",
    "**/progress.md"
  ],
  "strategies": {
    "deduplicate": { "enabled": true },
    "purgeErrors": { "enabled": true, "minTurnAge": 3 },
    "outputBodyReplace": { "enabled": true, "minChars": 1200 },
    "supersedeWrites": { "enabled": false }
  },
  "advanced": {
    "distillTool": { "enabled": false },
    "compressTool": { "enabled": false },
    "llmAutonomy": false
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
