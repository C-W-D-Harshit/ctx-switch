import path from "node:path";
import {
  SUPPORTED_COMMANDS,
  SUPPORTED_PROVIDERS,
  SUPPORTED_SOURCES,
  SUPPORTED_TARGETS,
  type PackageInfo,
  type ParsedOptions,
} from "./types.js";

function requireValue(flag: string, args: string[]): string {
  const value = args.shift();
  if (!value || value.startsWith("-")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

export function parseArgs(argv: string[]): ParsedOptions {
  const args = [...argv];
  const options: ParsedOptions = {
    command: "continue",
    refine: false,
    help: false,
    version: false,
    session: null,
    model: null,
    provider: "openrouter",
    output: null,
    apiKey: null,
    target: "generic",
    source: null,
    limit: 10,
  };

  if (args[0] === "doctor" || args[0] === "sessions") {
    options.command = args[0];
    args.shift();
  }

  while (args.length > 0) {
    const arg = args.shift();

    switch (arg) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--version":
      case "-v":
        options.version = true;
        break;
      case "--refine":
        options.refine = true;
        break;
      case "--session":
        options.session = requireValue(arg, args);
        break;
      case "--model":
        options.model = requireValue(arg, args);
        break;
      case "--provider":
        options.provider = requireValue(arg, args) as ParsedOptions["provider"];
        break;
      case "--output":
      case "-o":
        options.output = path.resolve(requireValue(arg, args));
        break;
      case "--api-key":
        options.apiKey = requireValue(arg, args);
        break;
      case "--target":
        options.target = requireValue(arg, args) as ParsedOptions["target"];
        break;
      case "--source":
        options.source = requireValue(arg, args) as ParsedOptions["source"];
        break;
      case "--limit":
      case "-n":
        options.limit = Number(requireValue(arg, args));
        break;
      default:
        if (!arg) {
          break;
        }
        if (arg.startsWith("-")) {
          throw new Error(`Unknown flag: ${arg}`);
        }
        if (!options.session) {
          options.session = arg;
          break;
        }
        throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  if (!SUPPORTED_PROVIDERS.includes(options.provider)) {
    throw new Error(
      `Unsupported provider "${options.provider}". Supported providers: ${SUPPORTED_PROVIDERS.join(", ")}`
    );
  }

  if (!SUPPORTED_TARGETS.includes(options.target)) {
    throw new Error(
      `Unsupported target "${options.target}". Supported targets: ${SUPPORTED_TARGETS.join(", ")}`
    );
  }

  if (options.source && !SUPPORTED_SOURCES.includes(options.source)) {
    throw new Error(
      `Unsupported source "${options.source}". Supported sources: ${SUPPORTED_SOURCES.join(", ")}`
    );
  }

  if (!SUPPORTED_COMMANDS.includes(options.command)) {
    throw new Error(
      `Unsupported command "${options.command}". Supported commands: ${SUPPORTED_COMMANDS.join(", ")}`
    );
  }

  if (!Number.isInteger(options.limit) || options.limit <= 0) {
    throw new Error(`Invalid limit "${options.limit}". Expected a positive integer.`);
  }

  return options;
}

export function getHelpText({ name, version }: PackageInfo): string {
  return [
    `${name} ${version}`,
    "",
    "Turn AI coding agent sessions into high-quality continuation prompts for Codex, Cursor, ChatGPT, or any other agent.",
    "Supports Claude Code, Codex, and OpenCode as session sources.",
    "",
    "Usage",
    `  ${name} [options]`,
    `  ${name} doctor [options]`,
    `  ${name} sessions [options]`,
    "",
    "Core Options",
    "  -h, --help              Show help",
    "  -v, --version           Show version",
    "  -o, --output <file>     Write the final prompt to a file",
    "      --source <name>     Session source: claude, codex, opencode (interactive if omitted)",
    "      --session <id|path> Use a specific session file or session id",
    "      --target <name>     Prompt target: generic, claude, codex, cursor, chatgpt",
    "  -n, --limit <count>     Limit rows for the sessions command (default: 10)",
    "",
    "Refinement (optional)",
    "      --refine             Refine the prompt via an LLM provider (default: raw mode)",
    "      --provider <name>   Refinement provider (default: openrouter)",
    "      --model <name>      Provider model override (default: openrouter/free)",
    "      --api-key <key>     Provider API key override",
    "",
    "Doctor",
    "  Verifies session discovery, git context, clipboard support, and API key availability.",
    "",
    "Sessions",
    "  Lists recent session files for the current project from the selected source.",
    "",
    "Examples",
    `  ${name}                              # interactive source picker`,
    `  ${name} --source claude               # use Claude Code sessions`,
    `  ${name} --source codex --target claude`,
    `  ${name} --source codex --target codex`,
    `  ${name} --source opencode`,
    `  ${name} --refine --model openrouter/free`,
    `  ${name} --output ./handoff.md`,
    `  ${name} doctor`,
    `  ${name} sessions --source claude --limit 5`,
  ].join("\n");
}
