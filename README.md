# cc-continue

Hit the Claude Code usage limit mid-task? `cc-continue` picks up your last session, extracts the full context, and generates a handoff prompt you can paste into **Codex**, **Cursor**, **ChatGPT**, or any other AI agent to keep going.

## The Problem

You're deep in a Claude Code session — it's editing files, running commands, making progress — and then:

> **Usage limit reached. Please wait before sending more messages.**

Your work is half-done. You can't continue. You switch to another AI agent but now you have to explain everything from scratch.

## The Solution

```bash
npx cc-continue
```

That's it. It reads your Claude Code session, grabs the conversation history, checks `git diff` for what changed, and produces a ready-to-paste continuation prompt.

## How It Works

1. Maps your current directory to Claude Code's session storage (`~/.claude/projects/`)
2. Finds the most recent session `.jsonl` file
3. Parses the full conversation — user messages, assistant responses, tool calls (edits, writes, commands)
4. Grabs `git diff` to see the current state of changes
5. Sends everything to **OpenRouter** (free) to distill a clean, actionable handoff prompt
6. Outputs to stdout (and optionally copies to clipboard)

## Install

```bash
# Run directly (no install needed)
npx cc-continue

# Or install globally
npm i -g cc-continue
```

## Usage

```bash
# cd into the project where Claude Code was running
cd my-project

# Generate a refined handoff prompt (uses OpenRouter)
cc-continue

# Skip OpenRouter, output raw context
cc-continue --raw

# Copy to clipboard
cc-continue -c

# Both
cc-continue --raw -c
```

### First Run

On first run, it'll ask for your OpenRouter API key:

```
🔑 Enter your OpenRouter API key: sk-or-v1-...
✅ Saved to ~/.cc-continue.json
```

Get a free key at [openrouter.ai/keys](https://openrouter.ai/keys). The key is saved locally and reused for future runs.

You can also set it via environment variable:

```bash
export OPENROUTER_API_KEY=sk-or-v1-...
```

## What the Output Looks Like

Instead of a raw dump of tool calls, you get something like:

```
## Context
Working on social media preview components in a React app on branch `main`.

## What Was Requested
Fix minor issues with Instagram gradient ring, raw markdown showing in previews,
and non-functional "more" buttons.

## What Was Completed
- Replaced Tailwind gradient classes with inline style for Instagram story ring
- Added stripMarkdown() utility for clean text in all three previews
- Wired up useState for expand/collapse in LinkedIn and Instagram previews

## Files Modified
- apps/web/src/routes/posts/$id.tsx

## What Remains
Verify all three fixes work correctly. Check for any remaining visual issues.
```

## How It Finds Your Session

Claude Code stores sessions at:

```
~/.claude/projects/<project-path>/<session-id>.jsonl
```

Where `<project-path>` is your working directory with `/` replaced by `-`. `cc-continue` finds the most recently modified `.jsonl` file for your current directory.

## Requirements

- **Node.js** >= 14
- **Claude Code** (must have been used in the current directory at least once)
- **OpenRouter API key** (free tier works fine) — optional if using `--raw`

## License

MIT
