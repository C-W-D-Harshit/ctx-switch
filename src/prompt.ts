import type { ConfidenceReport, DoctorReport, SessionContext, Target } from "./types.js";

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

function scoreTranscriptEntry(entry: SessionContext["transcript"][number], index: number, total: number): number {
  let score = 0;
  const text = entry.text.toLowerCase();

  // User messages are always important — they contain instructions
  if (entry.role === "user") score += 3;

  // Errors and failures are critical context for the next agent
  if (text.includes("[error") || text.includes("error:") || text.includes("failed") || text.includes("exception")) score += 5;

  // File modifications show what was actually done
  if (text.includes("edit ") || text.includes("write ") || text.includes("create ")) score += 2;

  // Test/build commands show verification state
  if (text.includes("npm test") || text.includes("npm run") || text.includes("make") || text.includes("cargo") || text.includes("pytest")) score += 2;

  // Recency matters — more recent is more relevant
  const recencyFactor = index / total;
  score += recencyFactor * 4;

  return score;
}

function selectTranscriptEntries(
  transcript: SessionContext["transcript"],
  options: { tailCount?: number; maxChars?: number } = {}
): string[] {
  const maxChars = options.maxChars || 9000;
  const maxEntries = options.tailCount || 20;

  if (transcript.length === 0) return [];

  // Always include first user message (the original goal)
  const firstUser = transcript.find((entry) => entry.role === "user");

  // Always include the tail (most recent context)
  const tailSize = Math.min(8, transcript.length);
  const tail = new Set(transcript.slice(-tailSize));

  // Score all middle entries and pick the best ones
  const middleEntries = transcript.slice(1, -tailSize);
  const scored = middleEntries.map((entry, i) => ({
    entry,
    score: scoreTranscriptEntry(entry, i, middleEntries.length),
  }));
  scored.sort((a, b) => b.score - a.score);

  // Build the selection in chronological order
  const selectedSet = new Set<SessionContext["transcript"][number]>();
  if (firstUser) selectedSet.add(firstUser);
  for (const entry of tail) selectedSet.add(entry);

  const remainingSlots = maxEntries - selectedSet.size;
  for (let i = 0; i < Math.min(remainingSlots, scored.length); i++) {
    selectedSet.add(scored[i].entry);
  }

  // Sort back to chronological order
  const selected = transcript.filter((entry) => selectedSet.has(entry));

  // Format with char budget
  let totalChars = 0;
  const result: string[] = [];
  for (const entry of selected) {
    const line = `${entry.role.toUpperCase()}: ${compactText(entry.text, 1200)}`;
    if (totalChars + line.length > maxChars) {
      result.push(`... [${selected.length - result.length} more entries omitted for space]`);
      break;
    }
    result.push(line);
    totalChars += line.length;
  }

  return result;
}

export function buildConfidenceReport(ctx: SessionContext): ConfidenceReport {
  const caveats: string[] = [];
  const git = ctx.gitContext;

  if (!git.isGitRepo) {
    caveats.push("Current working directory is not a git repository, so code state is limited to Claude session history.");
  } else if (!git.hasChanges) {
    caveats.push("No local git changes were detected at generation time.");
  }

  if (ctx.filesModified.length === 0) {
    caveats.push("No file-edit tool calls were detected in the parsed session.");
  }

  if (ctx.transcript.length < 3) {
    caveats.push("Parsed transcript is short; verify the selected session is the correct one.");
  }

  return {
    sessionId: ctx.sessionId,
    messageCount: ctx.messages.length,
    filesModified: ctx.filesModified.length,
    filesRead: ctx.filesRead.length,
    commandsCaptured: ctx.commands.length,
    caveats,
  };
}

function formatGitSections(gitContext: SessionContext["gitContext"]): string {
  if (!gitContext.isGitRepo) {
    return "## Git State\n\nNot a git repository.\n";
  }

  const untrackedFiles = gitContext.untracked.slice(0, 6);
  const omittedUntrackedCount = Math.max(gitContext.untracked.length - untrackedFiles.length, 0);
  let output = "## Git State\n\n";

  if (gitContext.branch) {
    output += `Branch: \`${gitContext.branch}\`\n\n`;
  }

  if (gitContext.status) {
    output += "### git status --short\n\n```text\n";
    output += `${gitContext.status}\n`;
    output += "```\n\n";
  }

  if (gitContext.staged.stat) {
    output += "### Staged Changes\n\n```text\n";
    output += `${gitContext.staged.stat}\n`;
    output += "```\n\n";
  }

  if (gitContext.unstaged.stat) {
    output += "### Unstaged Changes\n\n```text\n";
    output += `${gitContext.unstaged.stat}\n`;
    output += "```\n\n";
  }

  if (untrackedFiles.length > 0) {
    output += "### Untracked Files\n\n";
    for (const file of untrackedFiles) {
      output += `- \`${file.path}\`\n`;
      if (file.preview) {
        output += "\n```text\n";
        output += `${file.preview}\n`;
        output += "```\n\n";
      }
    }
    if (omittedUntrackedCount > 0) {
      output += `- ... and ${omittedUntrackedCount} more untracked file(s)\n\n`;
    }
  }

  if (gitContext.staged.diff) {
    output += "### Staged Diff Snippet\n\n```diff\n";
    output += `${gitContext.staged.diff}\n`;
    output += "```\n\n";
  }

  if (gitContext.unstaged.diff) {
    output += "### Unstaged Diff Snippet\n\n```diff\n";
    output += `${gitContext.unstaged.diff}\n`;
    output += "```\n\n";
  }

  if (gitContext.recentCommits) {
    output += "### Recent Commits\n\n```text\n";
    output += `${gitContext.recentCommits}\n`;
    output += "```\n\n";
  }

  if (gitContext.committedDiff) {
    output += "### Recently Committed Changes (stat)\n\n```text\n";
    output += `${gitContext.committedDiff}\n`;
    output += "```\n\n";
  }

  return output;
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

function extractErrors(messages: SessionContext["messages"]): string[] {
  const errors: string[] = [];
  for (const msg of messages) {
    for (const tc of msg.toolCalls) {
      if (tc.isError && tc.result) {
        const filePath = tc.input.file_path || tc.input.path || tc.input.command || "";
        errors.push(`${tc.tool}(${filePath}): ${tc.result.slice(0, 300)}`);
      }
    }
  }
  return errors;
}

function extractKeyDecisions(messages: SessionContext["messages"]): string[] {
  const decisions: string[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant" || !msg.content) continue;
    const lower = msg.content.toLowerCase();
    // Detect when the agent changed approach, made a choice, or explained strategy
    if (lower.includes("instead") || lower.includes("let me try") || lower.includes("switching to") ||
        lower.includes("the issue is") || lower.includes("the problem is") || lower.includes("root cause")) {
      decisions.push(compactText(msg.content, 300));
    }
  }
  return decisions.slice(-5); // Keep only most recent decisions
}

export function buildRawPrompt(ctx: SessionContext, options: { target?: Target } = {}): string {
  const transcript = selectTranscriptEntries(ctx.transcript);
  const userMessages = ctx.messages
    .filter((message) => message.role === "user" && message.content)
    .map((message) => compactText(message.content, 500));
  const confidence = buildConfidenceReport(ctx);
  const errors = extractErrors(ctx.messages);
  const decisions = extractKeyDecisions(ctx.messages);

  let prompt = "# Continue Claude Code Session\n\n";
  prompt += `Target: \`${options.target || "generic"}\`\n`;
  prompt += `Project cwd: \`${ctx.sessionCwd}\`\n`;
  if (ctx.branch) {
    prompt += `Branch: \`${ctx.branch}\`\n`;
  }
  prompt += "\n";

  prompt += "## User Messages (chronological)\n\n";
  if (userMessages.length === 0) {
    prompt += "Continue the interrupted Claude Code session.\n\n";
  } else {
    for (const msg of userMessages) {
      prompt += `- ${msg}\n`;
    }
    prompt += "\n";
  }

  if (errors.length > 0) {
    prompt += "## Errors & Failures Encountered\n\n";
    prompt += "IMPORTANT: These errors occurred during the previous session. Do NOT repeat the same approaches that caused them.\n\n";
    for (const error of errors.slice(-8)) {
      prompt += `- ${error}\n`;
    }
    prompt += "\n";
  }

  if (decisions.length > 0) {
    prompt += "## Key Decisions & Discoveries\n\n";
    for (const decision of decisions) {
      prompt += `- ${decision}\n`;
    }
    prompt += "\n";
  }

  prompt += "## Parsed Transcript\n\n";
  for (const line of transcript) {
    prompt += `${line}\n\n`;
  }

  if (ctx.filesModified.length > 0) {
    prompt += "## Files Modified During Session\n\n";
    for (const filePath of unique(ctx.filesModified)) {
      prompt += `- \`${filePath}\`\n`;
    }
    prompt += "\n";
  }

  if (ctx.filesRead.length > 0) {
    prompt += "## Files Read During Session\n\n";
    for (const filePath of unique(ctx.filesRead).slice(0, 20)) {
      prompt += `- \`${filePath}\`\n`;
    }
    prompt += "\n";
  }

  if (ctx.commands.length > 0) {
    prompt += "## Commands Run\n\n";
    for (const command of unique(ctx.commands).slice(-12)) {
      prompt += `- \`${compactText(command, 180)}\`\n`;
    }
    prompt += "\n";
  }

  prompt += formatGitSections(ctx.gitContext);

  prompt += "## Confidence Report\n\n";
  prompt += `- Parsed messages: ${confidence.messageCount}\n`;
  prompt += `- Edited files detected: ${confidence.filesModified}\n`;
  prompt += `- Read files detected: ${confidence.filesRead}\n`;
  prompt += `- Commands detected: ${confidence.commandsCaptured}\n`;
  for (const caveat of confidence.caveats) {
    prompt += `- Caveat: ${caveat}\n`;
  }
  prompt += "\n";

  prompt += "## Instructions For The Next Agent\n\n";
  prompt += `${buildTargetGuidance(options.target)}\n\n`;
  prompt += "**Critical steps before doing anything:**\n";
  prompt += "1. Read the files listed in \"Files Modified\" to understand their CURRENT state — the diffs above may be outdated.\n";
  prompt += "2. Check the errors section above (if any) and avoid repeating failed approaches.\n";
  prompt += "3. Identify what is already complete vs what remains unfinished.\n";
  prompt += "4. Only then proceed with the remaining work.\n";
  prompt += "5. Run tests/builds to verify your changes work before declaring the task complete.\n";

  return prompt;
}

export function buildRefinementDump(ctx: SessionContext, options: { target?: Target } = {}): string {
  const transcript = selectTranscriptEntries(ctx.transcript, { tailCount: 24, maxChars: 12000 });
  const confidence = buildConfidenceReport(ctx);
  const errors = extractErrors(ctx.messages);
  const decisions = extractKeyDecisions(ctx.messages);
  const untrackedFiles = ctx.gitContext.untracked.slice(0, 6);
  const omittedUntrackedCount = Math.max(ctx.gitContext.untracked.length - untrackedFiles.length, 0);
  const sections: string[] = [];

  sections.push("=== PROJECT ===");
  sections.push(`Target: ${options.target || "generic"}`);
  sections.push(`Project cwd: ${ctx.sessionCwd}`);
  if (ctx.branch) sections.push(`Git branch: ${ctx.branch}`);

  sections.push("\n=== USER MESSAGES (chronological) ===");
  const userMessages = ctx.messages
    .filter((message) => message.role === "user" && message.content)
    .map((message) => `- ${compactText(message.content, 600)}`);
  sections.push(userMessages.join("\n") || "- No explicit user text found");

  if (errors.length > 0) {
    sections.push("\n=== ERRORS & FAILURES ===");
    sections.push("These errors occurred during the session. The next agent MUST NOT repeat these approaches.");
    for (const error of errors.slice(-8)) {
      sections.push(`- ${error}`);
    }
  }

  if (decisions.length > 0) {
    sections.push("\n=== KEY DECISIONS & DISCOVERIES ===");
    sections.push("Important conclusions reached during the session:");
    for (const decision of decisions) {
      sections.push(`- ${decision}`);
    }
  }

  sections.push("\n=== TRANSCRIPT EXCERPT ===");
  sections.push(transcript.join("\n"));

  sections.push("\n=== FILES TOUCHED ===");
  sections.push(
    unique(ctx.filesModified).length > 0
      ? unique(ctx.filesModified).map((filePath) => `- modified: ${filePath}`).join("\n")
      : "- No modified files detected"
  );
  if (ctx.filesRead.length > 0) {
    sections.push(unique(ctx.filesRead).slice(0, 20).map((filePath) => `- read: ${filePath}`).join("\n"));
  }

  sections.push("\n=== COMMANDS ===");
  sections.push(
    ctx.commands.length > 0
      ? unique(ctx.commands).slice(-12).map((command) => `- ${compactText(command, 200)}`).join("\n")
      : "- No shell commands detected"
  );

  sections.push("\n=== GIT STATE ===");
  sections.push(ctx.gitContext.status || "No git status entries");
  if (ctx.gitContext.staged.stat) {
    sections.push("\n--- STAGED STAT ---");
    sections.push(ctx.gitContext.staged.stat);
  }
  if (ctx.gitContext.unstaged.stat) {
    sections.push("\n--- UNSTAGED STAT ---");
    sections.push(ctx.gitContext.unstaged.stat);
  }
  if (ctx.gitContext.staged.diff) {
    sections.push("\n--- STAGED DIFF ---");
    sections.push(ctx.gitContext.staged.diff);
  }
  if (ctx.gitContext.unstaged.diff) {
    sections.push("\n--- UNSTAGED DIFF ---");
    sections.push(ctx.gitContext.unstaged.diff);
  }
  if (ctx.gitContext.recentCommits) {
    sections.push("\n--- RECENT COMMITS ---");
    sections.push(ctx.gitContext.recentCommits);
  }
  if (ctx.gitContext.committedDiff) {
    sections.push("\n--- RECENTLY COMMITTED CHANGES ---");
    sections.push(ctx.gitContext.committedDiff);
  }
  if (untrackedFiles.length > 0) {
    sections.push("\n--- UNTRACKED FILES ---");
    sections.push(
      untrackedFiles
        .map((file) => {
          if (!file.preview) return file.path;
          return `${file.path}\n${file.preview}`;
        })
        .join("\n\n")
    );
    if (omittedUntrackedCount > 0) {
      sections.push(`... and ${omittedUntrackedCount} more untracked file(s)`);
    }
  }

  sections.push("\n=== CONFIDENCE REPORT ===");
  sections.push(
    [
      `messageCount=${confidence.messageCount}`,
      `filesModified=${confidence.filesModified}`,
      `filesRead=${confidence.filesRead}`,
      `commandsCaptured=${confidence.commandsCaptured}`,
      `errorsDetected=${errors.length}`,
      ...confidence.caveats.map((caveat) => `caveat=${caveat}`),
    ].join("\n")
  );

  return sections.join("\n");
}

export function buildRefinementSystemPrompt(target: Target): string {
  return `You are an expert at creating continuation prompts for AI coding agents. You receive a structured dump of an interrupted Claude Code session and must produce a handoff prompt that lets the next agent pick up exactly where the previous one left off.

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
  const lines = ["cc-continue doctor", ""];

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
