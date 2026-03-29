import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { getClipboardStrategy } from "./clipboard.js";
import { getApiKey } from "./config.js";
import { getGitContext } from "./git.js";
import { CLAUDE_DIR, PROJECTS_DIR } from "./session-claude.js";
import { CODEX_DIR } from "./session-codex.js";
import { OPENCODE_DB_PATH } from "./session-opencode.js";
import { listSessionsForProject, findLatestSession } from "./session.js";
import type { AppConfig, DoctorReport, Provider, Source } from "./types.js";

function checkSqliteAvailable(): boolean {
  try {
    execFileSync("sqlite3", ["--version"], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

export function runDoctor({
  cwd,
  source,
  provider,
  cliApiKey,
  env,
  config,
}: {
  cwd: string;
  source: Source;
  provider: Provider;
  cliApiKey: string | null;
  env: NodeJS.ProcessEnv;
  config: AppConfig;
}): DoctorReport {
  const checks: DoctorReport["checks"] = [];
  const notes: string[] = [];
  const nextSteps: string[] = [];

  // Source-specific checks
  if (source === "claude") {
    const claudeDirExists = fs.existsSync(CLAUDE_DIR);
    checks.push({
      status: claudeDirExists ? "OK" : "WARN",
      label: "Claude dir",
      detail: claudeDirExists ? CLAUDE_DIR : `Missing: ${CLAUDE_DIR}`,
    });
    if (!claudeDirExists) {
      nextSteps.push("Install or run Claude Code so ~/.claude/projects is created.");
    }
  } else if (source === "codex") {
    const codexDirExists = fs.existsSync(CODEX_DIR);
    checks.push({
      status: codexDirExists ? "OK" : "WARN",
      label: "Codex dir",
      detail: codexDirExists ? CODEX_DIR : `Missing: ${CODEX_DIR}`,
    });
    if (!codexDirExists) {
      nextSteps.push("Install or run Codex so ~/.codex/sessions is created.");
    }
  } else if (source === "opencode") {
    const dbExists = fs.existsSync(OPENCODE_DB_PATH);
    checks.push({
      status: dbExists ? "OK" : "WARN",
      label: "OpenCode DB",
      detail: dbExists ? OPENCODE_DB_PATH : `Missing: ${OPENCODE_DB_PATH}`,
    });
    const sqliteOk = checkSqliteAvailable();
    checks.push({
      status: sqliteOk ? "OK" : "WARN",
      label: "sqlite3",
      detail: sqliteOk ? "Available" : "sqlite3 command not found (required for OpenCode)",
    });
    if (!dbExists) {
      nextSteps.push("Install or run OpenCode so the database is created.");
    }
    if (!sqliteOk) {
      nextSteps.push("Install sqlite3 (required for reading OpenCode sessions).");
    }
  }

  const sessions = listSessionsForProject(cwd, source);
  const sourceLabel = source === "claude" ? "Claude" : source === "codex" ? "Codex" : "OpenCode";
  if (sessions.length > 0) {
    checks.push({
      status: "OK",
      label: "Project sessions",
      detail: `${sessions.length} ${sourceLabel} session(s) found, latest: ${sessions[0].name}`,
    });
  } else {
    checks.push({
      status: "WARN",
      label: "Project sessions",
      detail: `No ${sourceLabel} session files found for the current directory`,
    });
    nextSteps.push(`Run ${sourceLabel} in this project once so a session file exists.`);
  }

  const latest = findLatestSession(cwd, source);
  if (latest) {
    checks.push({
      status: "OK",
      label: "Latest session",
      detail: latest.path,
    });
  }

  const gitContext = getGitContext(cwd);
  if (gitContext.isGitRepo) {
    checks.push({
      status: "OK",
      label: "Git",
      detail: gitContext.branch ? `Repo detected on ${gitContext.branch}` : "Repo detected",
    });
  } else {
    checks.push({
      status: "WARN",
      label: "Git",
      detail: "Current directory is not a git repository",
    });
  }

  const apiKey = getApiKey({
    provider,
    cliValue: cliApiKey,
    env,
    config,
  });
  checks.push({
    status: apiKey ? "OK" : "WARN",
    label: "API key",
    detail: apiKey ? `Available for provider ${provider}` : `Missing for provider ${provider}`,
  });

  const clipboard = getClipboardStrategy();
  checks.push({
    status: clipboard ? "OK" : "WARN",
    label: "Clipboard",
    detail: clipboard ? `Using ${clipboard.command}` : "No supported clipboard utility found",
  });

  if (!apiKey) {
    notes.push("Refined mode will prompt for an API key when running interactively.");
    nextSteps.push("Set OPENROUTER_API_KEY or run ctx-switch once interactively to save it.");
  }

  if (!gitContext.isGitRepo) {
    notes.push("Raw continuation prompts still work outside git, but code-state fidelity is lower.");
    nextSteps.push("Initialize git in this project if you want better code-state summaries.");
  }

  return { checks, notes, nextSteps };
}
