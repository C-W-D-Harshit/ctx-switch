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


function buildTargetGuidance(target: Target | undefined): string {
  switch (target) {
    case "codex":
      return "The next agent is Codex. It should inspect the current files first, avoid redoing completed work, and finish any remaining implementation or verification.";
    case "cursor":
      return "The next agent is Cursor. It should continue the implementation directly from the current workspace state and verify behavior in-editor.";
    case "chatgpt":
      return "The next agent is ChatGPT. It should reason from the current workspace state, explain what remains, and provide explicit next actions.";
    default:
      return "The next agent should continue the interrupted work from the current workspace state without redoing completed steps.";
  }
}

function isNoiseMessage(text: string): boolean {
  const trimmed = text.trim().toLowerCase();
  // Very short messages are almost always noise
  if (trimmed.length < 5) return true;
  // Common confirmations and acknowledgements
  const noise = ["yes", "no", "ok", "okay", "try", "try?", "sure", "do it", "go ahead", "works", "nice", "cool",
    "thanks", "thank you", "lgtm", "ship it", "push it", "works push it", "try low effort",
    "try turn off thinking", "try without timeout"];
  if (noise.includes(trimmed)) return true;
  // Messages that are just "try X" or "yes X"
  if (/^(try|yes|ok|sure|test|run)\s/i.test(trimmed) && trimmed.length < 40) return true;
  // "[Request interrupted by user...]" system messages
  if (trimmed.startsWith("[request interrupted")) return true;
  return false;
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
    if (lower.includes("instead") || lower.includes("let me try") || lower.includes("switching to") ||
        lower.includes("the issue is") || lower.includes("the problem is") || lower.includes("root cause")) {
      decisions.push(compactText(msg.content, 300));
    }
  }
  return decisions.slice(-5);
}

export function buildRawPrompt(ctx: SessionContext, options: { target?: Target } = {}): string {
  const userMessages = filterUserMessages(ctx.messages);
  const errors = extractUnresolvedErrors(ctx.messages);
  const decisions = extractKeyDecisions(ctx.messages);

  let prompt = "";

  // — SECTION 1: What to do —
  prompt += "# Task\n\n";
  prompt += `Project: \`${ctx.sessionCwd}\`\n`;
  if (ctx.branch) prompt += `Branch: \`${ctx.branch}\`\n`;
  prompt += "\nThis is a continuation of an interrupted AI coding session. ";
  prompt += "The previous agent was working on the task below. Pick up where it left off.\n\n";

  prompt += "## What The User Asked (chronological)\n\n";
  for (const msg of userMessages) {
    prompt += `- ${compactText(msg, 500)}\n`;
  }
  prompt += "\n";

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
  prompt += "## Work Already Completed\n\n";
  if (unique(ctx.filesModified).length > 0) {
    prompt += "**Files modified:**\n";
    for (const filePath of unique(ctx.filesModified)) {
      prompt += `- \`${filePath}\`\n`;
    }
    prompt += "\n";
  }
  if (ctx.gitContext.recentCommits) {
    prompt += "**Recent commits:**\n```\n";
    prompt += `${ctx.gitContext.recentCommits}\n`;
    prompt += "```\n\n";
  }
  if (ctx.gitContext.committedDiff) {
    prompt += "**Files changed in recent commits:**\n```\n";
    prompt += `${ctx.gitContext.committedDiff}\n`;
    prompt += "```\n\n";
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
  prompt += `${buildTargetGuidance(options.target)}\n\n`;
  prompt += "1. **Read modified files first** — verify their current state before changing anything.\n";
  if (errors.length > 0) {
    prompt += "2. **Check the errors above** — do NOT repeat failed approaches. Try a different strategy.\n";
  }
  prompt += `${errors.length > 0 ? "3" : "2"}. **Identify what's done vs what remains** — the commits and modified files above show completed work.\n`;
  prompt += `${errors.length > 0 ? "4" : "3"}. **Do the remaining work** — pick up exactly where the previous agent stopped.\n`;
  prompt += `${errors.length > 0 ? "5" : "4"}. **Verify** — run tests/builds to confirm everything works.\n`;

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
