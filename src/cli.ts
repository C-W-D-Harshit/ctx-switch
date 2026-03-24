import fs from "node:fs";
import path from "node:path";
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
import { buildRawPrompt, buildRefinementDump, buildRefinementSystemPrompt } from "./prompt.js";
import { refineWithOpenRouter } from "./openrouter.js";
import { buildSessionContext, listSessionsForProject, parseSession, resolveSessionPath } from "./session.js";
import { createTheme, formatDoctorReport, formatRunSummary, formatSessionsReport } from "./ui.js";
import type { AppError, PackageInfo } from "./types.js";

declare const __PACKAGE_NAME__: string;
declare const __PACKAGE_VERSION__: string;

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

  if (options.command === "doctor") {
    const report = runDoctor({
      cwd,
      provider: options.provider,
      cliApiKey: options.apiKey,
      env: process.env,
      config,
    });
    process.stdout.write(`${formatDoctorReport(report)}\n`);
    return;
  }

  if (options.command === "sessions") {
    const sessions = listSessionsForProject(cwd);
    process.stdout.write(`${formatSessionsReport({ cwd, sessions, limit: options.limit })}\n`);
    return;
  }

  ui.step("Finding Claude session");
  const sessionPath = resolveSessionPath(options.session, cwd);
  if (!sessionPath) {
    fail(
      options.session
        ? `Unable to find session "${options.session}" for ${cwd}`
        : `No Claude session files found for ${cwd}.`,
      {
        suggestions: [
          "Run `cc-continue sessions` to inspect project sessions.",
          "Run `cc-continue doctor` for diagnostics.",
          "Run Claude Code in this project at least once if no sessions exist yet.",
        ],
      }
    );
  }
  ui.success(`Using session ${path.basename(sessionPath)}`);

  ui.step("Parsing session");
  const { messages, meta } = parseSession(sessionPath);
  if (messages.length === 0) {
    fail(`Parsed zero usable messages from ${sessionPath}`);
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

  if (options.raw) {
    ui.step("Building raw continuation prompt");
    finalPrompt = buildRawPrompt(ctx, { target: options.target });
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
        userPrompt: buildRefinementDump(ctx, { target: options.target }),
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
        finalPrompt = buildRawPrompt(ctx, { target: options.target });
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
