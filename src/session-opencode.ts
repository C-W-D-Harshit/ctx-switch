import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { SessionMessage, SessionMeta, SessionRecord, ToolCall } from "./types.js";

export const OPENCODE_DB_PATH = path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");

function getOpenCodeDbPath(): string {
  return process.env.CTX_SWITCH_OPENCODE_DB_PATH || OPENCODE_DB_PATH;
}

function runSqlite(query: string, dbPath: string = getOpenCodeDbPath()): { ok: boolean; stdout: string } {
  try {
    const stdout = execFileSync("sqlite3", ["-json", dbPath, query], {
      encoding: "utf8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout: stdout.trim() };
  } catch {
    return { ok: false, stdout: "" };
  }
}

function parseSqliteJson<T>(result: { ok: boolean; stdout: string }): T[] {
  if (!result.ok || !result.stdout) return [];
  try {
    return JSON.parse(result.stdout) as T[];
  } catch {
    return [];
  }
}

export function listSessionsForProject(cwd: string): SessionRecord[] {
  const resolvedCwd = path.resolve(cwd);

  // First find the project ID for this directory
  const projectResult = runSqlite(
    `SELECT id FROM project WHERE worktree = '${resolvedCwd.replace(/'/g, "''")}';`
  );
  const projects = parseSqliteJson<{ id: string }>(projectResult);
  if (projects.length === 0) return [];

  const projectId = projects[0].id;
  const sessionsResult = runSqlite(
    `SELECT id, title, directory, time_created, time_updated FROM session WHERE project_id = '${projectId}' ORDER BY time_updated DESC;`
  );
  const sessions = parseSqliteJson<{
    id: string;
    title: string;
    directory: string;
    time_created: number;
    time_updated: number;
  }>(sessionsResult);

  return sessions.map((s) => ({
    id: s.id,
    name: s.title || s.id,
    path: s.id, // OpenCode uses DB IDs, not file paths
    mtimeMs: s.time_updated,
  }));
}

export function findLatestSession(cwd: string): SessionRecord | null {
  const sessions = listSessionsForProject(cwd);
  return sessions[0] || null;
}

export function resolveSessionPath(selection: string | null, cwd: string): string | null {
  if (!selection) {
    const latest = findLatestSession(cwd);
    return latest ? latest.id : null;
  }

  // Try as direct session ID
  const sessions = listSessionsForProject(cwd);
  const match = sessions.find((s) => s.id === selection || s.id.includes(selection));
  return match ? match.id : null;
}

interface OpenCodePartData {
  type: string;
  text?: string;
  callID?: string;
  tool?: string;
  state?: {
    status?: string;
    input?: Record<string, unknown>;
    output?: string;
    metadata?: Record<string, unknown>;
  };
  time?: { start?: number; end?: number };
}

function detectToolError(tool: string, status: string | undefined, output: string): boolean | undefined {
  if (status === "error") return true;
  if (!output) return undefined;

  if (/Process exited with code [1-9]\d*/.test(output)) return true;
  if (/^npm ERR!/m.test(output)) return true;
  if (/^(Error|TypeError|ReferenceError|SyntaxError):/m.test(output)) return true;
  if (/^(bash|sh|zsh):/m.test(output)) return true;

  // Avoid treating file contents like `OpenRouterErrorDetails` as tool failures.
  if (tool === "read" || tool === "glob" || tool === "grep") return undefined;

  return undefined;
}

function extractDelegatedSessionId(part: OpenCodePartData): string | null {
  const metadataSessionId = part.state?.metadata?.sessionId;
  if (typeof metadataSessionId === "string" && metadataSessionId.trim()) {
    return metadataSessionId.trim();
  }

  const output = part.state?.output;
  if (typeof output !== "string") return null;

  const match = output.match(/\btask_id:\s*(ses_[^\s)]+)/);
  return match?.[1] || null;
}

export function parseSession(sessionId: string): { messages: SessionMessage[]; meta: SessionMeta } {
  return parseSessionInternal(sessionId, new Set());
}

function parseSessionInternal(
  sessionId: string,
  seenSessions: Set<string>
): { messages: SessionMessage[]; meta: SessionMeta } {
  seenSessions.add(sessionId);
  const messages: SessionMessage[] = [];
  const meta: SessionMeta = {
    cwd: null,
    gitBranch: null,
    sessionId,
  };

  // Get session metadata
  const sessionResult = runSqlite(
    `SELECT title, directory FROM session WHERE id = '${sessionId.replace(/'/g, "''")}';`
  );
  const sessionRows = parseSqliteJson<{ title: string; directory: string }>(sessionResult);
  if (sessionRows.length > 0) {
    meta.cwd = sessionRows[0].directory;
  }

  // Get messages in order
  const msgResult = runSqlite(
    `SELECT id, data FROM message WHERE session_id = '${sessionId.replace(/'/g, "''")}' ORDER BY time_created;`
  );
  const msgRows = parseSqliteJson<{ id: string; data: string }>(msgResult);

  for (const row of msgRows) {
    let msgData: { role?: string; path?: { cwd?: string } };
    try {
      msgData = JSON.parse(row.data);
    } catch {
      continue;
    }

    if (msgData.path?.cwd && !meta.cwd) {
      meta.cwd = msgData.path.cwd;
    }

    // Get parts for this message
    const partsResult = runSqlite(
      `SELECT data FROM part WHERE message_id = '${row.id.replace(/'/g, "''")}' ORDER BY time_created;`
    );
    const partRows = parseSqliteJson<{ data: string }>(partsResult);

    const role = msgData.role as "user" | "assistant" | undefined;
    if (!role || (role !== "user" && role !== "assistant")) continue;

    const textParts: string[] = [];
    const toolCalls: ToolCall[] = [];
    const delegatedAssistantMessages: SessionMessage[] = [];

    for (const partRow of partRows) {
      let part: OpenCodePartData;
      try {
        part = JSON.parse(partRow.data);
      } catch {
        continue;
      }

      if (part.type === "text" && part.text) {
        textParts.push(part.text);
      } else if (part.type === "tool" && part.tool) {
        const input = part.state?.input || {};
        const output = part.state?.output || "";
        const isError = detectToolError(part.tool, part.state?.status, output);

        // Normalize tool names to match Claude's conventions
        const toolName = normalizeToolName(part.tool);
        const normalizedInput = normalizeInput(part.tool, input);
        if (toolName === "task") {
          const delegatedSessionId = extractDelegatedSessionId(part);
          if (delegatedSessionId && !seenSessions.has(delegatedSessionId)) {
            normalizedInput.delegated_session_id = delegatedSessionId;
            const delegated = parseSessionInternal(delegatedSessionId, seenSessions);
            delegatedAssistantMessages.push(...delegated.messages.filter((message) => message.role === "assistant"));
          }
        }

        toolCalls.push({
          id: part.callID || null,
          tool: toolName,
          input: normalizedInput,
          result: output.slice(0, 1500) || undefined,
          isError: isError || undefined,
        });
      }
    }

    const content = textParts.join("\n").trim();
    if (!content && toolCalls.length === 0) continue;

    messages.push({
      role,
      content,
      toolCalls,
      timestamp: null,
    });

    if (role === "assistant" && delegatedAssistantMessages.length > 0) {
      messages.push(...delegatedAssistantMessages);
    }
  }

  return { messages, meta };
}

function normalizeToolName(tool: string): string {
  // Map OpenCode tool names to familiar conventions
  const mapping: Record<string, string> = {
    apply_patch: "apply_patch",
    read: "read",
    edit: "edit",
    write: "write",
    grep: "grep",
    glob: "glob",
    bash: "bash",
    search: "search",
    task: "task",
    skill: "skill",
    todowrite: "todowrite",
    question: "question",
  };
  return mapping[tool.toLowerCase()] || tool;
}

function normalizeInput(tool: string, input: Record<string, unknown>): Record<string, unknown> {
  // Normalize input keys to match what buildSessionContext expects
  const normalized: Record<string, unknown> = { ...input };

  if (normalized.filePath && !normalized.file_path) {
    normalized.file_path = normalized.filePath;
  }

  if (tool === "apply_patch" && typeof normalized.patchText === "string" && !normalized.patch) {
    normalized.patch = normalized.patchText;
  }

  return normalized;
}
