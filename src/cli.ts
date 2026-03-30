import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { getHelpText, parseArgs } from "./args.js";
import { copyToClipboard } from "./clipboard.js";
import {
  CONFIG_PATH,
  getApiKey,
  getDefaultModel,
  loadConfig,
  promptForApiKey,
  storeApiKey,
} from "./config.js";
import { runDoctor } from "./doctor.js";
import { getGitContext } from "./git.js";
import { buildRawPrompt, buildRefinementDump, buildRefinementSystemPrompt, listSubstantiveUserMessages } from "./prompt.js";
import { refineWithOpenRouter } from "./openrouter.js";
import { buildSessionContext, listSessionsForProject, parseSession, resolveSessionPath } from "./session.js";
import { createTheme, formatDoctorReport, formatRunSummary, formatSessionsReport } from "./ui.js";
import type { AppError, PackageInfo, SessionContext, Source } from "./types.js";

declare const __PACKAGE_NAME__: string;
declare const __PACKAGE_VERSION__: string;

const SOURCE_LABELS: Record<Source, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

function fail(message: string, { exitCode = 1, suggestions = [] as string[] } = {}): never {
  const error = new Error(message) as AppError;
  error.exitCode = exitCode;
  error.suggestions = suggestions;
  throw error;
}

function createActivityReporter(label: string) {
  const stream = process.stderr;
  const start = Date.now();
  let status = "starting";
  let timer: NodeJS.Timeout | null = null;
  let lastRendered = "";
  const frames = ["|", "/", "-", "\\"];
  let frameIndex = 0;

  function elapsedSeconds(): number {
    return Math.max(1, Math.round((Date.now() - start) / 1000));
  }

  function render(): void {
    const line = `${frames[frameIndex]} ${label}: ${status} (${elapsedSeconds()}s)`;
    frameIndex = (frameIndex + 1) % frames.length;

    if (stream.isTTY) {
      const padded = line.padEnd(Math.max(lastRendered.length, line.length), " ");
      stream.write(`\r${padded}`);
      lastRendered = padded;
      return;
    }

    if (elapsedSeconds() === 1 || elapsedSeconds() % 5 === 0) {
      stream.write(`${line}\n`);
    }
  }

  function startTimer(): void {
    render();
    timer = setInterval(render, 1000);
    timer.unref();
  }

  function update(nextStatus: string): void {
    status = nextStatus;
    if (stream.isTTY) {
      render();
    }
  }

  function stop(finalStatus: string): void {
    if (timer) {
      clearInterval(timer);
    }
    const message = `${label}: ${finalStatus} (${elapsedSeconds()}s)`;
    if (stream.isTTY) {
      const padded = message.padEnd(Math.max(lastRendered.length, message.length), " ");
      stream.write(`\r${padded}\n`);
    } else {
      stream.write(`${message}\n`);
    }
  }

  startTimer();

  return { update, stop };
}

function writeOutputFile(outputPath: string, text: string): void {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${text}\n`);
}

async function promptForSource(): Promise<Source> {
  const sources: Source[] = ["claude", "codex", "opencode"];
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  process.stderr.write("\nSelect the AI agent to extract context from:\n\n");
  for (let i = 0; i < sources.length; i++) {
    process.stderr.write(`  ${i + 1}) ${SOURCE_LABELS[sources[i]]}\n`);
  }
  process.stderr.write("\n");

  return new Promise<Source>((resolve) => {
    rl.question("Enter choice (1-3): ", (answer) => {
      rl.close();
      const idx = Number.parseInt(answer.trim(), 10) - 1;
      if (idx >= 0 && idx < sources.length) {
        resolve(sources[idx]);
      } else {
        // Default to claude if invalid input
        process.stderr.write("Invalid choice, defaulting to Claude Code.\n");
        resolve("claude");
      }
    });
  });
}

function summarizePromptChoice(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 100);
}

async function promptForUserStart(messages: SessionContext["messages"]): Promise<number | null> {
  const userPrompts = listSubstantiveUserMessages(messages);
  if (userPrompts.length === 0) {
    return null;
  }
  if (userPrompts.length === 1) {
    process.stderr.write("\nOnly one substantive user prompt was found. Using it automatically.\n");
    return 1;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  process.stderr.write("\nSelect the user prompt to preserve context from:\n\n");
  for (const prompt of userPrompts) {
    process.stderr.write(`  ${prompt.index}) ${summarizePromptChoice(prompt.text)}\n`);
  }
  process.stderr.write("\n");

  return new Promise<number | null>((resolve) => {
    rl.question(`Enter choice (1-${userPrompts.length}): `, (answer) => {
      rl.close();
      const trimmed = answer.trim();
      if (!trimmed) {
        process.stderr.write("Invalid choice, using automatic focus.\n");
        resolve(null);
        return;
      }
      const idx = Number.parseInt(trimmed, 10);
      if (idx >= 1 && idx <= userPrompts.length) {
        resolve(idx);
      } else {
        process.stderr.write("Invalid choice, using automatic focus.\n");
        resolve(null);
      }
    });
  });
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv);
  const pkgInfo: PackageInfo = { name: __PACKAGE_NAME__, version: __PACKAGE_VERSION__ };
  const ui = createTheme(process.stderr);

  if (options.help) {
    process.stdout.write(`${getHelpText(pkgInfo)}\n`);
    return;
  }

  if (options.version) {
    process.stdout.write(`${pkgInfo.version}\n`);
    return;
  }

  const cwd = process.cwd();
  const config = loadConfig();

  // Resolve source: use --source flag or prompt interactively
  let source: Source;
  if (options.source) {
    source = options.source;
  } else if (process.stdin.isTTY) {
    source = await promptForSource();
  } else {
    // Non-interactive, default to claude
    source = "claude";
  }

  const sourceLabel = SOURCE_LABELS[source];

  if (options.command === "doctor") {
    const report = runDoctor({
      cwd,
      source,
      provider: options.provider,
      cliApiKey: options.apiKey,
      env: process.env,
      config,
    });
    process.stdout.write(`${formatDoctorReport(report)}\n`);
    return;
  }

  if (options.command === "sessions") {
    const sessions = listSessionsForProject(cwd, source);
    process.stdout.write(`${formatSessionsReport({ cwd, sessions, limit: options.limit, source })}\n`);
    return;
  }

  ui.step(`Finding ${sourceLabel} session`);
  const sessionPath = resolveSessionPath(options.session, cwd, source);
  if (!sessionPath) {
    fail(
      options.session
        ? `Unable to find session "${options.session}" for ${cwd} (source: ${sourceLabel})`
        : `No ${sourceLabel} session files found for ${cwd}.`,
      {
        suggestions: [
          `Run \`ctx-switch sessions --source ${source}\` to inspect project sessions.`,
          "Run `ctx-switch doctor` for diagnostics.",
          `Run ${sourceLabel} in this project at least once if no sessions exist yet.`,
        ],
      }
    );
  }
  const sessionDisplay = source === "opencode" ? sessionPath : path.basename(sessionPath);
  ui.success(`Using session ${sessionDisplay}`);

  ui.step("Parsing session");
  const { messages, meta } = parseSession(sessionPath, source);
  if (messages.length === 0) {
    fail(`Parsed zero usable messages from ${sessionPath}`);
  }

  let fromUserMessage = options.fromUser;
  const userPrompts = listSubstantiveUserMessages(messages);
  if (fromUserMessage !== null && fromUserMessage > userPrompts.length) {
    fail(
      `Requested --from-user ${fromUserMessage}, but only ${userPrompts.length} substantive user prompt(s) were found.`,
      {
        suggestions: ["Run `ctx-switch --pick-user` to choose interactively.", "Omit `--from-user` to use automatic focus."],
      }
    );
  }
  if (options.pickUser && process.stdin.isTTY) {
    ui.step("Choosing preserved context start");
    fromUserMessage = await promptForUserStart(messages);
  }

  ui.step("Capturing git context");
  const gitContext = getGitContext(cwd);
  const ctx = buildSessionContext({
    messages,
    meta,
    cwd,
    sessionPath,
    gitContext,
  });

  let finalPrompt = "";
  let mode: "raw" | "refined" = "raw";
  let activeModel: string | null = null;

  if (!options.refine) {
    ui.step("Building continuation prompt");
    finalPrompt = buildRawPrompt(ctx, { target: options.target, fromUserMessage });
  } else {
    const provider = options.provider;
    let apiKey = getApiKey({
      provider,
      cliValue: options.apiKey,
      env: process.env,
      config,
    });
    const model = getDefaultModel({
      provider,
      cliValue: options.model,
      config,
    });
    activeModel = model;

    if (!apiKey) {
      ui.warn(`No ${provider} API key found. A key can be saved to ${CONFIG_PATH}.`);
      apiKey = await promptForApiKey({ provider });
      if (apiKey) {
        storeApiKey({ provider, apiKey });
        ui.success(`Saved ${provider} API key to ${CONFIG_PATH}`);
      }
    }

    if (!apiKey) {
      ui.warn("No API key available. Falling back to raw continuation prompt.");
      finalPrompt = buildRawPrompt(ctx, { target: options.target });
    } else {
      mode = "refined";
      ui.section(formatRunSummary({ ctx, options, mode, model }));
      ui.plain();
      ui.step(`Refining prompt with ${provider} (${model})`);
      ui.note("Streaming response below:");
      const reporter = createActivityReporter("Refining prompt");
      let streamStarted = false;
      const refined = await refineWithOpenRouter({
        apiKey,
        model,
        systemPrompt: buildRefinementSystemPrompt(options.target),
        userPrompt: buildRefinementDump(ctx, { target: options.target, fromUserMessage }),
        timeoutMs: 0,
        onStatus: (status) => {
          if (!streamStarted) reporter.update(status);
        },
        onToken: (token) => {
          if (!streamStarted) {
            streamStarted = true;
            reporter.stop("streaming");
            process.stderr.write("\n");
          }
          process.stderr.write(token);
        },
      });
      if (streamStarted) {
        process.stderr.write("\n\n");
      } else {
        reporter.stop(refined.ok ? "done" : "failed");
      }

      if (refined.ok) {
        finalPrompt = refined.text;
      } else {
        mode = "raw";
        ui.warn(`Provider refinement failed: ${refined.error}`);
        if (Array.isArray(refined.suggestions)) {
          for (const suggestion of refined.suggestions) {
            ui.note(suggestion);
          }
        }
        if (refined.rawError && refined.rawError !== refined.error) {
          ui.note(`Provider detail: ${refined.rawError}`);
        }
        ui.note("Falling back to the raw structured prompt.");
        finalPrompt = buildRawPrompt(ctx, { target: options.target, fromUserMessage });
      }
    }
  }

  if (mode === "raw") {
    ui.section(formatRunSummary({ ctx, options, mode, model: activeModel }));
    ui.plain();
  }

  if (options.output) {
    writeOutputFile(options.output, finalPrompt);
    ui.success(`Wrote prompt to ${options.output}`);
  }

  const clipboard = copyToClipboard(finalPrompt);
  if (clipboard.ok) {
    ui.success(`Copied to clipboard (${finalPrompt.length} chars)`);
  } else {
    ui.warn(`Clipboard copy failed: ${clipboard.error}`);
    ui.success(`Prompt ready (${finalPrompt.length} chars)`);
  }

  process.stdout.write(`${finalPrompt}\n`);
}
