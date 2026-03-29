import path from "node:path";
import type { GitContext, SessionContext, SessionMessage, SessionMeta, SessionRecord, Source } from "./types.js";

import * as claude from "./session-claude.js";
import * as codex from "./session-codex.js";
import * as opencode from "./session-opencode.js";

// Re-export for backward compatibility (doctor.ts etc.)
export { CLAUDE_DIR, PROJECTS_DIR } from "./session-claude.js";
export { CODEX_DIR } from "./session-codex.js";
export { OPENCODE_DB_PATH } from "./session-opencode.js";

export function listSessionsForProject(cwd: string, source: Source): SessionRecord[] {
  switch (source) {
    case "claude":
      return claude.listSessionsForProject(cwd);
    case "codex":
      return codex.listSessionsForProject(cwd);
    case "opencode":
      return opencode.listSessionsForProject(cwd);
  }
}

export function findLatestSession(cwd: string, source: Source): SessionRecord | null {
  switch (source) {
    case "claude":
      return claude.findLatestSession(cwd);
    case "codex":
      return codex.findLatestSession(cwd);
    case "opencode":
      return opencode.findLatestSession(cwd);
  }
}

export function resolveSessionPath(selection: string | null, cwd: string, source: Source): string | null {
  switch (source) {
    case "claude":
      return claude.resolveSessionPath(selection, cwd);
    case "codex":
      return codex.resolveSessionPath(selection, cwd);
    case "opencode":
      return opencode.resolveSessionPath(selection, cwd);
  }
}

export function parseSession(sessionPathOrId: string, source: Source): { messages: SessionMessage[]; meta: SessionMeta } {
  switch (source) {
    case "claude":
      return claude.parseSession(sessionPathOrId);
    case "codex":
      return codex.parseSession(sessionPathOrId);
    case "opencode":
      return opencode.parseSession(sessionPathOrId);
  }
}

function extractFilePath(input: Record<string, unknown>): string | null {
  const value = input.file_path || input.path || input.target_file || input.filePath;
  return typeof value === "string" ? value : null;
}

function extractCommand(input: Record<string, unknown>): string | null {
  const value = input.command || input.cmd;
  return typeof value === "string" ? value : null;
}

export function buildSessionContext({
  messages,
  meta,
  cwd,
  sessionPath,
  gitContext,
}: {
  messages: SessionMessage[];
  meta: SessionMeta;
  cwd: string;
  sessionPath: string;
  gitContext: GitContext;
}): SessionContext {
  const filesModified = new Set<string>();
  const filesRead = new Set<string>();
  const commands: string[] = [];
  const transcript: SessionContext["transcript"] = [];

  for (const message of messages) {
    if (message.role === "assistant" && message.toolCalls.length > 0) {
      for (const toolCall of message.toolCalls) {
        const toolName = String(toolCall.tool || "").toLowerCase();
        const filePath = extractFilePath(toolCall.input);
        const command = extractCommand(toolCall.input);

        if (filePath && /(edit|write|create|multi_edit)/.test(toolName)) {
          filesModified.add(filePath);
        } else if (filePath && /(read|grep|glob|search)/.test(toolName)) {
          filesRead.add(filePath);
        }

        if (command && /(bash|command|run|exec_command)/.test(toolName)) {
          commands.push(command);
        }
      }
    }

    const summaryParts: string[] = [];
    if (message.content) {
      summaryParts.push(message.content);
    }
    if (message.role === "assistant" && message.toolCalls.length > 0) {
      const toolSummary = message.toolCalls
        .map((toolCall) => {
          const filePath = extractFilePath(toolCall.input);
          const command = extractCommand(toolCall.input);
          let summary = "";
          if (filePath) summary = `${toolCall.tool} ${filePath}`;
          else if (command) summary = `${toolCall.tool}: ${command}`;
          else summary = toolCall.tool;

          if (toolCall.isError && toolCall.result) {
            summary += ` [ERROR: ${toolCall.result.slice(0, 200)}]`;
          }
          return summary;
        })
        .join(", ");
      if (toolSummary) {
        summaryParts.push(`[tools] ${toolSummary}`);
      }
    }

    if (summaryParts.length > 0) {
      transcript.push({
        role: message.role,
        text: summaryParts.join(" | "),
        timestamp: message.timestamp || null,
      });
    }
  }

  return {
    cwd,
    sessionCwd: meta.cwd || cwd,
    sessionPath,
    sessionId: meta.sessionId || path.basename(sessionPath, ".jsonl"),
    branch: gitContext.branch || meta.gitBranch || null,
    transcript,
    filesModified: [...filesModified],
    filesRead: [...filesRead],
    commands,
    messages,
    gitContext,
  };
}
