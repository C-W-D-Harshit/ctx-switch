# ctx-switch

> Formerly `cc-continue` — existing installs still work, just use `ctx-switch` going forward.

**Switch coding agents without losing context.**
Agent handoff for Claude Code, Codex, and OpenCode.

## Why this exists

You're in the middle of a coding session. Things are working. Progress is being made.

And then you need to switch.

- Maybe the session can't continue
- Maybe something isn't working as expected
- Maybe you just want to move to another agent

Now you're stuck.

You switch to another agent — but:

- it has no context
- you have to explain everything again
- you lose momentum

**Your work shouldn't reset just because you switched tools.**

## What ctx-switch does

```bash
npx ctx-switch
```

It captures your current session — code, context, decisions, errors — and generates a clean, structured handoff prompt so another agent can continue immediately.

No re-explaining.
No rebuilding context.
No wasted time.

**Just continue where you left off.**

### Core idea

> Switch agents. Don't restart.

## Features

- **Multi-agent support**: Claude Code, Codex, OpenCode
- **Smart session detection**: Finds the latest session for your current project
- **Context extraction**:
  - Filters noise (confirmations, filler)
  - Keeps only relevant context
- **Error awareness**:
  - Includes unresolved errors
  - Skips already-fixed issues
- **Codebase state capture**:
  - Recent commits
  - Diffs (staged & unstaged)
  - Untracked files
- **Decision tracking**:
  - Extracts key decisions and pivots
- **Structured output**:
  - Task → Errors → Decisions → Completed Work → Current State → Instructions
- **Target-aware prompts**:
  - `codex`, `cursor`, `chatgpt`, or `generic`
- **Clipboard ready**: Auto-copy across macOS, Linux, Windows
- **Optional LLM refinement** (`--refine`)
- `sessions` command to browse recent sessions
- `doctor` command for diagnostics

## How it works

1. Select your source agent (Claude / Codex / OpenCode)
2. `ctx-switch` finds the latest session for your project
3. Parses:
   - conversation
   - tool calls
   - errors
4. Captures git state:
   - branch
   - commits
   - diffs
5. Builds a structured handoff prompt
6. Copies it to clipboard and prints it

## Install

```bash
# Run instantly
npx ctx-switch

# Or install globally
npm i -g ctx-switch
```

## Usage

```bash
cd my-project

# Interactive mode
ctx-switch

# Specify source
ctx-switch --source claude
ctx-switch --source codex
ctx-switch --source opencode

# Target a specific agent
ctx-switch --source claude --target codex

# Use a specific session
ctx-switch --source claude --session <id>

# Refine output with LLM
ctx-switch --refine

# List sessions
ctx-switch sessions --source claude --limit 5

# Save to a file
ctx-switch --output ./handoff.md

# Run diagnostics
ctx-switch doctor --source codex
```

## Example use cases

- Continue work in another agent when switching is needed
- Move a session across tools without re-explaining everything
- Resume work seamlessly in a different environment
- Preserve context when changing workflows

## LLM Refinement (Optional)

Use `--refine` to improve the generated prompt via an LLM.

On first use:

```
Enter your OpenRouter API key: sk-or-v1-...
Saved to ~/.ctx-switch.json
```

Get a key: [openrouter.ai/keys](https://openrouter.ai/keys)

Or set manually:

```bash
export OPENROUTER_API_KEY=sk-or-v1-...
```

## Key Flags

| Flag | Description |
|------|-------------|
| `--source <name>` | `claude`, `codex`, `opencode` |
| `--target <name>` | `generic`, `codex`, `cursor`, `chatgpt` |
| `--output <file>` | Save prompt |
| `--session <id\|path>` | Use specific session |
| `--refine` | Refine prompt via LLM |
| `--provider` | Refinement provider (default: `openrouter`) |
| `--model` | Override model |
| `--api-key` | Override API key |

## Session Storage

| Source | Storage Path | Format |
|--------|-------------|--------|
| Claude Code | `~/.claude/projects/<encoded-cwd>/*.jsonl` | JSONL |
| Codex | `~/.codex/sessions/<year>/<month>/<day>/*.jsonl` | JSONL |
| OpenCode | `~/.local/share/opencode/opencode.db` | SQLite |

## Requirements

- **Node.js** >= 18
- **Claude Code, Codex, or OpenCode** (used in current directory)
- **sqlite3** (only for OpenCode sessions)
- **OpenRouter API key** (only if using `--refine`)

## Migrating from cc-continue

`cc-continue` still works — it's now an alias for `ctx-switch`.

```bash
npm uninstall -g cc-continue
npm i -g ctx-switch
```

## License

MIT
