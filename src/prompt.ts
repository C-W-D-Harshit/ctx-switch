import type { DoctorReport, SessionContext, Target } from "./types.js";

function compactText(text: string, maxChars: number = 800): string {
  let compacted = String(text || "")
    .replace(/[ \t]+/g, " ")       // collapse horizontal whitespace only
    .replace(/\n{3,}/g, "\n\n")    // collapse excessive blank lines
    .trim();
  if (compacted.length <= maxChars) return compacted;
  return `${compacted.slice(0, maxChars)}...`;
}

function unique<T>(list: T[]): T[] {
  return [...new Set(list.filter(Boolean))];
}

function extractFilePath(input: Record<string, unknown>): string | null {
  const value = input.file_path || input.path || input.target_file || input.filePath;
  return typeof value === "string" ? value : null;
}

function extractCommand(input: Record<string, unknown>): string | null {
  const value = input.command || input.cmd;
  return typeof value === "string" ? value : null;
}

function buildTargetGuidance(target: Target | undefined): string {
  switch (target) {
    case "claude":
      return "The next agent is Claude Code. It should read the active files first, trust the current workspace and git diff over stale transcript details, and continue the implementation or debugging directly.";
    case "codex":
      return "The next agent is Codex. It should inspect the current files first, avoid redoing completed work, and finish any remaining implementation or verification.";
    case "cursor":
      return "The next agent is Cursor. It should continue the implementation directly from the current workspace state and verify behavior in-editor.";
    case "chatgpt":
      return "The next agent is ChatGPT. It should reason from the current workspace state, explain what remains, and provide explicit next actions.";
    default:
      return "The next agent should read the active files first, trust the current workspace and git diff over stale transcript details, continue the interrupted work directly, and avoid redoing completed steps.";
  }
}

function isNoiseMessage(text: string): boolean {
  const trimmed = text.trim().toLowerCase();
  const normalized = trimmed.replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  // Very short messages are almost always noise
  if (trimmed.length < 5) return true;
  // Common confirmations and acknowledgements
  const noise = ["yes", "yes please", "no", "ok", "okay", "try", "sure", "do it", "go ahead", "works", "nice", "cool",
    "thanks", "thank you", "lgtm", "ship it", "push it", "works push it", "try low effort",
    "try turn off thinking", "try without timeout"];
  if (noise.includes(normalized)) return true;
  // Messages that are just "try X" or "yes X"
  if (/^(try|yes|ok|sure|test|run)\s/i.test(normalized) && normalized.length < 40) return true;
  // "[Request interrupted by user...]" system messages
  if (trimmed.startsWith("[request interrupted")) return true;
  return false;
}

function isReferentialMessage(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > 220) return false;
  return /^(ok|okay|alright|now|so)\b/.test(normalized) ||
    /\b(it|that|again|better|same|continue|still|also|another|more)\b/.test(normalized);
}

function filterUserMessages(messages: SessionContext["messages"]): string[] {
  const all = messages
    .filter((m) => m.role === "user" && m.content)
    .map((m) => m.content.trim());
  // Always keep first and last, filter noise from middle
  if (all.length <= 2) return all;
  const first = all[0];
  const last = all[all.length - 1];
  const middle = all.slice(1, -1).filter((msg) => !isNoiseMessage(msg));
  return [first, ...middle, last];
}

function extractUnresolvedErrors(messages: SessionContext["messages"]): string[] {
  // Track tool calls that errored, then check if the same tool+target succeeded later
  const errorEntries: Array<{ tool: string; target: string; error: string; index: number }> = [];
  const successes = new Set<string>();

  for (let i = 0; i < messages.length; i++) {
    for (const tc of messages[i].toolCalls) {
      const target = String(tc.input.file_path || tc.input.path || tc.input.command || "").slice(0, 100);
      const key = `${tc.tool}:${target}`;
      if (tc.isError && tc.result) {
        errorEntries.push({ tool: tc.tool, target, error: tc.result.slice(0, 300), index: i });
      } else if (!tc.isError) {
        successes.add(key);
      }
    }
  }

  // Only return errors that were NOT later resolved by a successful call
  return errorEntries
    .filter((e) => !successes.has(`${e.tool}:${e.target}`))
    .map((e) => `${e.tool}(${e.target}): ${e.error}`);
}

function extractKeyDecisions(messages: SessionContext["messages"]): string[] {
  const decisions: string[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant" || !msg.content) continue;
    const lower = msg.content.toLowerCase();
    if (/\b(handoff|prompt)\b/.test(lower) && /\b(good|bad|better|worse|quality)\b/.test(lower)) {
      continue;
    }
    if (
      /\b(root cause|the issue is|the problem is|caused by|failed because|failing because|need to)\b/.test(lower) ||
      /\b(exposed|revealed|showed)\b.*\b(gap|issue|problem|bug)\b/.test(lower) ||
      /\bmissing\b/.test(lower)
    ) {
      decisions.push(compactText(msg.content, 300));
    }
  }
  return decisions.slice(-5);
}

function findFocusedWindow(messages: SessionContext["messages"]): {
  messages: SessionContext["messages"];
  sessionAppearsComplete: boolean;
} {
  if (messages.length === 0) {
    return { messages, sessionAppearsComplete: false };
  }

  const substantiveUserIndexes = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role === "user" && message.content && !isNoiseMessage(message.content))
    .map(({ index }) => index);

  if (substantiveUserIndexes.length === 0) {
    return { messages, sessionAppearsComplete: false };
  }

  const lastToolIndex = messages.reduce(
    (last, message, index) => (message.role === "assistant" && message.toolCalls.length > 0 ? index : last),
    -1
  );

  const postToolUsers = substantiveUserIndexes.filter((index) => index > lastToolIndex);
  let startIndex = 0;
  if (postToolUsers.length > 0) {
    startIndex = postToolUsers[0];
  } else if (lastToolIndex >= 0) {
    startIndex = substantiveUserIndexes.filter((index) => index <= lastToolIndex).at(-1) ?? 0;
  } else {
    startIndex = substantiveUserIndexes.at(-1) ?? 0;
  }

  const startMessage = messages[startIndex];
  if (startMessage?.role === "user" && isReferentialMessage(startMessage.content)) {
    const previousSubstantive = substantiveUserIndexes.filter((index) => index < startIndex).at(-1);
    if (typeof previousSubstantive === "number") {
      startIndex = previousSubstantive;
    }
  }

  const focused = messages.slice(startIndex);
  const hasToolActivity = focused.some((message) => message.role === "assistant" && message.toolCalls.length > 0);
  const lastMessage = focused.at(-1);
  const sessionAppearsComplete =
    Boolean(lastMessage) &&
    lastMessage!.role === "assistant" &&
    lastMessage!.toolCalls.length === 0 &&
    !hasToolActivity;

  return { messages: focused, sessionAppearsComplete };
}

function extractWorkSummary(messages: SessionContext["messages"]): {
  filesModified: string[];
  commands: string[];
} {
  const filesModified = new Set<string>();
  const commands: string[] = [];

  for (const message of messages) {
    if (message.role !== "assistant" || message.toolCalls.length === 0) continue;

    for (const toolCall of message.toolCalls) {
      const toolName = String(toolCall.tool || "").toLowerCase();
      const filePath = extractFilePath(toolCall.input);
      const command = extractCommand(toolCall.input);

      if (filePath && /(edit|write|create|multi_edit)/.test(toolName)) {
        filesModified.add(filePath);
      }

      if (command && /(bash|command|run|exec_command)/.test(toolName)) {
        commands.push(command);
      }
    }
  }

  return {
    filesModified: [...filesModified],
    commands,
  };
}

function extractLastAssistantAnswer(messages: SessionContext["messages"]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "assistant" && message.content.trim()) {
      return compactText(message.content, 500);
    }
  }
  return null;
}

function summarizeCommand(command: string): string {
  return compactText(command.replace(/\s+/g, " ").trim(), 140);
}

function extractRecentCommands(commands: string[]): string[] {
  return unique(commands.map(summarizeCommand)).slice(-6);
}

function extractStatusPaths(status: string): string[] {
  if (!status) return [];

  return status
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const renamed = line.includes(" -> ") ? line.split(" -> ").at(-1)?.trim() || "" : "";
      if (renamed) {
        return renamed.replace(/^(?:\?\?|[A-Z?!]{1,2})\s+/, "");
      }
      const match = line.match(/^(?:\?\?|[A-Z?!]{1,2})\s+(.*)$/);
      return match?.[1]?.trim() || line;
    })
    .filter(Boolean);
}

function extractFocusFiles(ctx: SessionContext, work: { filesModified: string[] }): string[] {
  return unique([
    ...work.filesModified,
    ...extractStatusPaths(ctx.gitContext.status),
    ...ctx.gitContext.untracked.map((file) => file.path),
  ]).slice(0, 6);
}

export function buildRawPrompt(ctx: SessionContext, options: { target?: Target } = {}): string {
  const focused = findFocusedWindow(ctx.messages);
  const userMessages = filterUserMessages(focused.messages);
  const errors = extractUnresolvedErrors(focused.messages);
  const decisions = extractKeyDecisions(focused.messages);
  const work = extractWorkSummary(focused.messages);
  const focusFiles = extractFocusFiles(ctx, work);
  const recentCommands = extractRecentCommands(work.commands);
  const lastAssistantAnswer = extractLastAssistantAnswer(focused.messages);

  let prompt = "";

  // — SECTION 1: What to do —
  prompt += "# Task\n\n";
  prompt += `Project: \`${ctx.sessionCwd}\`\n`;
  if (ctx.branch) prompt += `Branch: \`${ctx.branch}\`\n`;
  if (focused.sessionAppearsComplete) {
    prompt += "\nThe latest exchange in this session appears complete. ";
    prompt += "Use the focused context below only if the user wants to continue from that point.\n\n";
  } else {
    prompt += "\nThis is a continuation of an interrupted AI coding session. ";
    prompt += "The previous agent was working on the task below. Pick up where it left off.\n\n";
  }

  prompt += `## What The User Asked (${focused.sessionAppearsComplete ? "recent focus" : "chronological"})\n\n`;
  for (const msg of userMessages) {
    prompt += `- ${compactText(msg, 500)}\n`;
  }
  prompt += "\n";

  if (focused.sessionAppearsComplete && lastAssistantAnswer) {
    prompt += "## Last Answer Already Given\n\n";
    prompt += `- ${lastAssistantAnswer}\n\n`;
  }

  // — SECTION 2: What to avoid —
  if (errors.length > 0) {
    prompt += "## DO NOT REPEAT — Unresolved Errors\n\n";
    prompt += "These errors occurred and were NOT fixed. Avoid the same approaches.\n\n";
    for (const error of errors.slice(-6)) {
      prompt += `- ${error}\n`;
    }
    prompt += "\n";
  }

  if (decisions.length > 0) {
    prompt += "## Key Discoveries From Previous Agent\n\n";
    for (const decision of decisions) {
      prompt += `- ${decision}\n`;
    }
    prompt += "\n";
  }

  // — SECTION 3: What was done —
  if (work.filesModified.length > 0) {
    prompt += "## Work Already Completed\n\n";
  }
  if (work.filesModified.length > 0) {
    prompt += "**Files modified:**\n";
    for (const filePath of unique(work.filesModified)) {
      prompt += `- \`${filePath}\`\n`;
    }
    prompt += "\n";
  }
  if (!focused.sessionAppearsComplete && work.filesModified.length > 0 && ctx.gitContext.recentCommits) {
    prompt += "**Recent commits:**\n```\n";
    prompt += `${ctx.gitContext.recentCommits}\n`;
    prompt += "```\n\n";
  }
  if (!focused.sessionAppearsComplete && work.filesModified.length > 0 && ctx.gitContext.committedDiff) {
    prompt += "**Files changed in recent commits:**\n```\n";
    prompt += `${ctx.gitContext.committedDiff}\n`;
    prompt += "```\n\n";
  }

  if (recentCommands.length > 0) {
    prompt += "## Recent Commands / Checks\n\n";
    for (const command of recentCommands) {
      prompt += `- \`${command}\`\n`;
    }
    prompt += "\n";
  }

  if (focusFiles.length > 0) {
    prompt += "## Read These Files First\n\n";
    for (const filePath of focusFiles) {
      prompt += `- \`${filePath}\`\n`;
    }
    prompt += "\n";
  }

  // — SECTION 4: Current state —
  const git = ctx.gitContext;
  if (git.isGitRepo && git.hasChanges) {
    prompt += "## Uncommitted Changes\n\n";
    if (git.status) {
      prompt += "```\n" + git.status + "\n```\n\n";
    }
    if (git.staged.diff) {
      prompt += "**Staged diff:**\n```diff\n" + git.staged.diff + "\n```\n\n";
    }
    if (git.unstaged.diff) {
      prompt += "**Unstaged diff:**\n```diff\n" + git.unstaged.diff + "\n```\n\n";
    }
    if (git.untracked.length > 0) {
      const shown = git.untracked.slice(0, 6);
      prompt += "**Untracked files:**\n";
      for (const file of shown) {
        prompt += `- \`${file.path}\`\n`;
      }
      if (git.untracked.length > shown.length) {
        prompt += `- ... and ${git.untracked.length - shown.length} more\n`;
      }
      prompt += "\n";
    }
  }

  // — SECTION 5: Action plan —
  prompt += "## Your Instructions\n\n";
  if (focused.sessionAppearsComplete) {
    prompt += "The latest thread appears finished. Do not resume older tasks unless the user explicitly asks for them.\n\n";
    prompt += "1. **Start from the recent focus above** — ignore stale history unless the user points back to it.\n";
    prompt += "2. **Use the last answer as prior context** — avoid restating or redoing already completed work.\n";
    prompt += `3. **Inspect the workspace only as needed** — respond to follow-up questions or new work from the current repo state${focusFiles.length > 0 ? `, starting with ${focusFiles.map((filePath) => `\`${filePath}\``).join(", ")}` : ""}.\n`;
  } else {
    prompt += `${buildTargetGuidance(options.target)}\n\n`;
    prompt += `1. **Read the active files first** — verify their current state before changing anything${focusFiles.length > 0 ? `: ${focusFiles.map((filePath) => `\`${filePath}\``).join(", ")}` : ""}.\n`;
    if (errors.length > 0) {
      prompt += "2. **Check the errors above** — do NOT repeat failed approaches. Try a different strategy.\n";
    }
    prompt += `${errors.length > 0 ? "3" : "2"}. **Identify what's done vs what remains** — use the recent commands, active files, and git state above as the source of truth for the current thread.\n`;
    prompt += `${errors.length > 0 ? "4" : "3"}. **Do the remaining work** — pick up exactly where the previous agent stopped.\n`;
    prompt += `${errors.length > 0 ? "5" : "4"}. **Verify** — rerun or extend the relevant commands/checks above to confirm everything works.\n`;
  }

  return prompt;
}

export function buildRefinementDump(ctx: SessionContext, options: { target?: Target } = {}): string {
  // Reuse the raw prompt — it's already well-structured and concise
  return buildRawPrompt(ctx, options);
}

export function buildRefinementSystemPrompt(target: Target): string {
  return `You are an expert at creating continuation prompts for AI coding agents. You receive a structured dump of an interrupted AI coding session and must produce a handoff prompt that lets the next agent pick up exactly where the previous one left off.

Your output must be a single, actionable prompt with these sections:

## Goal
State what the user wants in 1-2 sentences. Use the user's own words where possible.

## Completed Work
List what was already done — files created/modified, features implemented, tests passing. Be specific with file paths.

## Errors & Failed Approaches
If any errors or failures occurred, list them clearly so the next agent does NOT waste time repeating them. Include what was tried and why it failed.

## Remaining Work
List exactly what still needs to be done. Be specific — "implement the validation logic in src/validator.ts" not "finish the feature".

## Current Code State
Summarize the git state: branch, what's committed, what's staged, what's modified but uncommitted. Mention specific files.

## Key Files
List the most important files the next agent should read first to understand the current state.

## Action Plan
Give the next agent a concrete numbered list of steps to follow, starting with "Read [specific files] to verify current state" and ending with verification steps.

Rules:
- Output ONLY the handoff prompt. No preamble, no meta-commentary.
- Be specific and concrete. File paths, function names, error messages — not vague descriptions.
- If the data is incomplete or ambiguous, say so explicitly rather than guessing.
- Prioritize information density. Every sentence should help the next agent.
- If errors/failures were found in the session, make them prominent — avoiding repeated mistakes is critical.
- Target agent: ${target}. ${buildTargetGuidance(target)}`;
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = ["ctx-switch doctor", ""];

  for (const check of report.checks) {
    lines.push(`${check.status.padEnd(4)} ${check.label}: ${check.detail}`);
  }

  if (report.notes.length > 0) {
    lines.push("");
    lines.push("Notes");
    for (const note of report.notes) {
      lines.push(`- ${note}`);
    }
  }

  return lines.join("\n");
}
