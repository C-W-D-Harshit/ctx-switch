import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionMessage, SessionMeta, SessionRecord, ToolCall } from "./types.js";

export const CLAUDE_DIR = path.join(os.homedir(), ".claude");
export const PROJECTS_DIR = path.join(CLAUDE_DIR, "projects");

interface SessionContentItem {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
}

interface SessionRecordJson {
  type?: string;
  cwd?: string;
  gitBranch?: string;
  sessionId?: string;
  timestamp?: string;
  message?: {
    role?: "user" | "assistant";
    content?: string | SessionContentItem[];
  };
  data?: {
    message?: {
      type?: "user" | "assistant";
      timestamp?: string;
      message?: {
        role?: "user" | "assistant";
        content?: string | SessionContentItem[];
      };
    };
  };
}

export function cwdToProjectDir(cwd: string): string {
  const resolved = path.resolve(cwd);
  const projectKey = resolved.replace(/[:\\/]+/g, "-");
  return projectKey.startsWith("-") ? projectKey : `-${projectKey}`;
}

export function listSessionsForProject(cwd: string, projectsDir: string = PROJECTS_DIR): SessionRecord[] {
  const projectPath = path.join(projectsDir, cwdToProjectDir(cwd));
  if (!fs.existsSync(projectPath)) {
    return [];
  }

  return fs
    .readdirSync(projectPath, { withFileTypes: true })
    .filter((entry: fs.Dirent) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry: fs.Dirent) => {
      const sessionPath = path.join(projectPath, entry.name);
      return {
        id: entry.name.replace(/\.jsonl$/, ""),
        name: entry.name,
        path: sessionPath,
        mtimeMs: fs.statSync(sessionPath).mtimeMs,
      };
    })
    .sort((left: SessionRecord, right: SessionRecord) => right.mtimeMs - left.mtimeMs);
}

export function findLatestSession(cwd: string, projectsDir: string = PROJECTS_DIR): SessionRecord | null {
  const sessions = listSessionsForProject(cwd, projectsDir);
  return sessions[0] || null;
}

export function resolveSessionPath(
  selection: string | null,
  cwd: string,
  projectsDir: string = PROJECTS_DIR
): string | null {
  if (!selection) {
    const latest = findLatestSession(cwd, projectsDir);
    if (!latest) {
      return null;
    }
    return latest.path;
  }

  const looksLikePath =
    path.isAbsolute(selection) || selection.includes(path.sep) || selection.endsWith(".jsonl");

  if (looksLikePath) {
    const resolved = path.resolve(selection);
    return fs.existsSync(resolved) ? resolved : null;
  }

  const projectPath = path.join(projectsDir, cwdToProjectDir(cwd));
  const candidates = [selection, `${selection}.jsonl`];

  for (const candidate of candidates) {
    const candidatePath = path.join(projectPath, candidate);
    if (fs.existsSync(candidatePath)) {
      return candidatePath;
    }
  }

  return null;
}

function extractTextFromContent(content: string | SessionContentItem[] | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter((item) => item && (item.type === "text" || item.type === "input_text"))
    .map((item) => item.text || "")
    .join("\n")
    .trim();
}

function extractToolCalls(content: string | SessionContentItem[] | undefined): ToolCall[] {
  if (!Array.isArray(content)) return [];

  return content
    .filter((item) => item && item.type === "tool_use")
    .map((item) => ({
      id: item.id || null,
      tool: item.name || "unknown",
      input: item.input || {},
    }));
}

function extractToolResults(content: string | SessionContentItem[] | undefined): Map<string, { result: string; isError: boolean }> {
  const results = new Map<string, { result: string; isError: boolean }>();
  if (!Array.isArray(content)) return results;

  for (const item of content) {
    if (item && item.type === "tool_result" && item.tool_use_id) {
      const text = typeof item.content === "string"
        ? item.content
        : Array.isArray(item.content)
          ? (item.content as SessionContentItem[])
              .filter((c) => c.type === "text")
              .map((c) => c.text || "")
              .join("\n")
          : "";
      results.set(item.tool_use_id, {
        result: text.slice(0, 1500),
        isError: Boolean(item.is_error),
      });
    }
  }
  return results;
}

function collectMessageCandidates(record: SessionRecordJson) {
  const candidates: Array<{
    role: "user" | "assistant";
    message: NonNullable<SessionRecordJson["message"]>;
    timestamp: string | undefined;
  }> = [];

  if ((record.type === "user" || record.type === "assistant") && record.message) {
    candidates.push({
      role: record.type,
      message: record.message,
      timestamp: record.timestamp,
    });
  }

  const nestedMessage = record.data?.message?.message;
  const nestedRole = nestedMessage?.role || record.data?.message?.type;
  const nestedTimestamp = record.data?.message?.timestamp || record.timestamp;

  if ((nestedRole === "user" || nestedRole === "assistant") && nestedMessage) {
    candidates.push({
      role: nestedRole,
      message: nestedMessage,
      timestamp: nestedTimestamp,
    });
  }

  return candidates;
}

export function parseSession(sessionPath: string): { messages: SessionMessage[]; meta: SessionMeta } {
  const raw = fs.readFileSync(sessionPath, "utf8");
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const messages: SessionMessage[] = [];
  const meta: SessionMeta = {
    cwd: null,
    gitBranch: null,
    sessionId: path.basename(sessionPath, ".jsonl"),
  };

  for (const line of lines) {
    let record: SessionRecordJson;
    try {
      record = JSON.parse(line) as SessionRecordJson;
    } catch {
      continue;
    }

    if (record.cwd) meta.cwd = record.cwd;
    if (record.gitBranch) meta.gitBranch = record.gitBranch;
    if (record.sessionId) meta.sessionId = record.sessionId;

    const candidates = collectMessageCandidates(record);
    for (const candidate of candidates) {
      const content = candidate.message?.content;
      const text = extractTextFromContent(content);
      const toolCalls = extractToolCalls(content);

      if (candidate.role === "user") {
        const toolResults = extractToolResults(content);
        if (toolResults.size > 0 && messages.length > 0) {
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === "assistant") {
              for (const tc of messages[i].toolCalls) {
                if (tc.id && toolResults.has(tc.id)) {
                  const res = toolResults.get(tc.id)!;
                  tc.result = res.result;
                  tc.isError = res.isError;
                }
              }
              break;
            }
          }
        }

        const hasToolResultOnly =
          Array.isArray(content) &&
          content.some((item) => item.type === "tool_result") &&
          !content.some((item) => item.type === "text" || item.type === "input_text");
        if (hasToolResultOnly) {
          continue;
        }
      }

      if (!text && toolCalls.length === 0) {
        continue;
      }

      messages.push({
        role: candidate.role,
        content: text,
        toolCalls,
        timestamp: candidate.timestamp || null,
      });
    }
  }

  return { messages, meta };
}
