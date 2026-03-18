# Contributing to cc-continue

Thanks for your interest in contributing!

## Getting Started

1. Fork the repo
2. Clone your fork:
   ```bash
   git clone git@github.com:YOUR_USERNAME/cc-continue.git
   cd cc-continue
   ```
3. Link it locally for testing:
   ```bash
   npm link
   ```
4. Make your changes to `index.js`
5. Test by running `cc-continue` in a project directory where you've used Claude Code

## Development

This is a single-file CLI tool with zero dependencies. Let's keep it that way.

### Project Structure

```
index.js        # The entire CLI
package.json
README.md
LICENSE
```

### Testing Your Changes

```bash
# Test raw output (no API key needed)
cd /path/to/any/project/with/claude-sessions
cc-continue --raw

# Test with OpenRouter
cc-continue
```

## Guidelines

- **Zero dependencies** — everything uses Node.js built-ins (`fs`, `path`, `https`, `readline`, `child_process`)
- **Keep it simple** — this is a single-purpose tool, not a framework
- **macOS first** — clipboard uses `pbcopy`. PRs to support `xclip`/`xsel` on Linux or `clip` on Windows are welcome
- **Don't break `--raw`** — the raw fallback should always work without any API key or network access

## Submitting a PR

1. Create a branch: `git checkout -b my-feature`
2. Make your changes
3. Test both `--raw` and OpenRouter modes
4. Push and open a PR

## Ideas for Contributions

- Linux/Windows clipboard support
- `--last N` flag to grab context from the last N conversation turns
- Support for other session formats (Cursor, Windsurf, etc.)
- Better handling of very large sessions (streaming JSONL parse)
- `--model` flag to pick a specific OpenRouter model

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
