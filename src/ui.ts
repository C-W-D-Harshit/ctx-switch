import type { DoctorReport, GitContext, ParsedOptions, SessionContext, SessionRecord, Source } from "./types.js";

function createColors(enabled: boolean) {
  const wrap = (code: string) => (text: string) => (enabled ? `\u001b[${code}m${text}\u001b[0m` : text);
  return {
    bold: wrap("1"),
    dim: wrap("2"),
    cyan: wrap("36"),
    green: wrap("32"),
    yellow: wrap("33"),
    red: wrap("31"),
  };
}

export function createTheme(stream: NodeJS.WriteStream = process.stderr) {
  const enabled = Boolean(stream.isTTY) && !process.env.NO_COLOR;
  const colors = createColors(enabled);

  function write(line: string = ""): void {
    stream.write(`${line}\n`);
  }

  return {
    step(message: string) {
      write(`${colors.cyan("[..]")} ${message}`);
    },
    success(message: string) {
      write(`${colors.green("[ok]")} ${message}`);
    },
    warn(message: string) {
      write(`${colors.yellow("[!!]")} ${message}`);
    },
    note(message: string) {
      write(`${colors.dim(" -> ")} ${message}`);
    },
    section(title: string) {
      write(colors.bold(title));
    },
    plain(message: string = "") {
      write(message);
    },
  };
}

function pad(value: string | number, width: number): string {
  return String(value).padEnd(width, " ");
}

function formatRelativeTime(timestamp: number): string {
  if (!timestamp) return "unknown";
  const deltaSeconds = Math.max(1, Math.round((Date.now() - timestamp) / 1000));
  if (deltaSeconds < 60) return `${deltaSeconds}s ago`;
  const minutes = Math.round(deltaSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function summarizeGitContext(gitContext: GitContext): string {
  if (!gitContext.isGitRepo) {
    return "not a git repo";
  }

  const changed = gitContext.status ? gitContext.status.split("\n").filter(Boolean).length : 0;
  const untracked = gitContext.untracked.length;

  if (!changed && !untracked) {
    return gitContext.branch ? `${gitContext.branch}, clean` : "clean";
  }

  const parts: string[] = [];
  if (gitContext.branch) parts.push(gitContext.branch);
  if (changed) parts.push(`${changed} changed`);
  if (untracked) parts.push(`${untracked} untracked`);
  return parts.join(", ");
}

export function formatRunSummary({
  ctx,
  options,
  mode,
  model,
}: {
  ctx: SessionContext;
  options: ParsedOptions;
  mode: "raw" | "refined";
  model: string | null;
}): string {
  const lines = [];
  lines.push("Run Summary");
  lines.push(`  Session: ${ctx.sessionId}`);
  lines.push(`  Source: ${ctx.sessionPath}`);
  lines.push(`  Messages: ${ctx.messages.length}`);
  lines.push(`  Files: ${ctx.filesModified.length} modified, ${ctx.filesRead.length} read`);
  lines.push(`  Git: ${summarizeGitContext(ctx.gitContext)}`);
  lines.push(`  Target: ${options.target}`);
  lines.push(`  Mode: ${mode === "raw" ? "raw" : `refined via ${options.provider}${model ? ` (${model})` : ""}`}`);
  return lines.join("\n");
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = ["ctx-switch doctor", ""];

  for (const check of report.checks) {
    lines.push(`${pad(check.status, 4)} ${pad(check.label, 16)} ${check.detail}`);
  }

  if (report.notes.length > 0) {
    lines.push("");
    lines.push("Notes");
    for (const note of report.notes) {
      lines.push(`- ${note}`);
    }
  }

  if (report.nextSteps.length > 0) {
    lines.push("");
    lines.push("Next Steps");
    for (const step of report.nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  return lines.join("\n");
}

export function formatSessionsReport({
  cwd,
  sessions,
  limit,
  source,
}: {
  cwd: string;
  sessions: SessionRecord[];
  limit: number;
  source?: Source;
}): string {
  const sourceLabel = source === "codex" ? "Codex" : source === "opencode" ? "OpenCode" : "Claude";
  const lines = ["ctx-switch sessions", "", `Project: ${cwd}`, `Source: ${sourceLabel}`, ""];

  if (sessions.length === 0) {
    lines.push(`No ${sourceLabel} session files were found for this project.`);
    lines.push("");
    lines.push("Next Steps");
    lines.push(`- Run ${sourceLabel} in this project at least once.`);
    lines.push("- Run `ctx-switch doctor` to verify the expected session directory.");
    return lines.join("\n");
  }

  const visible = sessions.slice(0, limit);
  const idWidth = Math.max(7, ...visible.map((session) => session.id.length));
  const ageWidth = 10;

  lines.push(`${pad("Session", idWidth)}  ${pad("Updated", ageWidth)}  File`);
  lines.push(`${"-".repeat(idWidth)}  ${"-".repeat(ageWidth)}  ${"-".repeat(40)}`);

  for (const session of visible) {
    lines.push(`${pad(session.id, idWidth)}  ${pad(formatRelativeTime(session.mtimeMs), ageWidth)}  ${session.path}`);
  }

  if (sessions.length > visible.length) {
    lines.push("");
    lines.push(`Showing ${visible.length} of ${sessions.length} session(s). Use --limit to see more.`);
  }

  return lines.join("\n");
}
