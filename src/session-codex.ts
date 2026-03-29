import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionMessage, SessionMeta, SessionRecord, ToolCall } from "./types.js";

export const CODEX_DIR = path.join(os.homedir(), ".codex");
export const CODEX_SESSIONS_DIR = path.join(CODEX_DIR, "sessions");
export const CODEX_INDEX_PATH = path.join(CODEX_DIR, "session_index.jsonl");

interface CodexSessionMeta {
  id: string;
  timestamp: string;
  cwd: string;
  cli_version?: string;
  git?: { branch?: string };
}

interface CodexResponseItem {
  type: string;
  payload: {
    type?: string;
    role?: string;
    name?: string;
    arguments?: string;
    input?: string | Record<string, unknown>;
    call_id?: string;
    output?: string;
    parsed_cmd?: Array<Record<string, unknown>>;
    aggregated_output?: string;
    exit_code?: number;
    content?: Array<{ type?: string; text?: string }>;
  };
}

function parseJsonRecord(line: string): CodexResponseItem | null {
  try {
    return JSON.parse(line) as CodexResponseItem;
  } catch {
    return null;
  }
}

function parseFunctionArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function parseCustomToolInput(toolName: string | undefined, raw: string | Record<string, unknown> | undefined): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw !== "string") return raw;

  const trimmed = raw.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Keep the raw string below.
    }
  }

  if (toolName === "apply_patch") {
    return { patch: raw };
  }

  return { input: raw };
}

function parseToolOutput(raw: string | undefined): { text: string; isError?: boolean } {
  if (!raw) return { text: "" };

  let text = raw;
  let exitCode: number | undefined;

  try {
    const parsed = JSON.parse(raw) as { output?: unknown; metadata?: { exit_code?: unknown } };
    if (typeof parsed.output === "string") {
      text = parsed.output;
    }
    if (typeof parsed.metadata?.exit_code === "number") {
      exitCode = parsed.metadata.exit_code;
    }
  } catch {
    // Keep raw text.
  }

  const isError =
    exitCode !== undefined ? exitCode !== 0 : /Process exited with code [^0]/.test(text) || /error|Error|ERROR/.test(text.slice(0, 200));

  return {
    text: text.slice(0, 1500),
    isError: isError || undefined,
  };
}

export function listSessionsForProject(cwd: string): SessionRecord[] {
  if (!fs.existsSync(CODEX_SESSIONS_DIR)) {
    return [];
  }

  const resolvedCwd = path.resolve(cwd);
  const allSessions: SessionRecord[] = [];

  // Walk the date-based directory structure
  function walkDir(dir: string) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        allSessions.push({
          id: entry.name.replace(/\.jsonl$/, ""),
          name: entry.name,
          path: fullPath,
          mtimeMs: fs.statSync(fullPath).mtimeMs,
        });
      }
    }
  }

  walkDir(CODEX_SESSIONS_DIR);

  // Filter to sessions matching the current project cwd
  const filtered = allSessions.filter((session) => {
    try {
      const firstLine = fs.readFileSync(session.path, "utf8").split("\n")[0];
      const record = JSON.parse(firstLine);
      if (record.type === "session_meta" && record.payload?.cwd) {
        return path.resolve(record.payload.cwd) === resolvedCwd;
      }
    } catch {
      // skip malformed files
    }
    return false;
  });

  return filtered.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export function findLatestSession(cwd: string): SessionRecord | null {
  const sessions = listSessionsForProject(cwd);
  return sessions[0] || null;
}

export function resolveSessionPath(selection: string | null, cwd: string): string | null {
  if (!selection) {
    const latest = findLatestSession(cwd);
    return latest ? latest.path : null;
  }

  // Direct path
  const looksLikePath =
    path.isAbsolute(selection) || selection.includes(path.sep) || selection.endsWith(".jsonl");

  if (looksLikePath) {
    const resolved = path.resolve(selection);
    return fs.existsSync(resolved) ? resolved : null;
  }

  // Search by ID match
  const sessions = listSessionsForProject(cwd);
  const match = sessions.find((s) => s.id === selection || s.id.includes(selection));
  return match ? match.path : null;
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

  // Collect function calls and their outputs for matching
  const pendingCalls = new Map<string, ToolCall>();
  let currentAssistantText = "";
  let currentToolCalls: ToolCall[] = [];

  function flushAssistant() {
    if (currentAssistantText || currentToolCalls.length > 0) {
      messages.push({
        role: "assistant",
        content: currentAssistantText.trim(),
        toolCalls: [...currentToolCalls],
        timestamp: null,
      });
      currentAssistantText = "";
      currentToolCalls = [];
    }
  }

  for (const line of lines) {
    const record = parseJsonRecord(line);
    if (!record) continue;

    // Extract session metadata
    if (record.type === "session_meta") {
      const payload = record.payload as unknown as CodexSessionMeta;
      if (payload.cwd) meta.cwd = payload.cwd;
      if (payload.git?.branch) meta.gitBranch = payload.git.branch;
      if (payload.id) meta.sessionId = payload.id;
      continue;
    }

    if (record.type === "event_msg" && record.payload.type === "exec_command_end" && record.payload.call_id) {
      const tc = pendingCalls.get(record.payload.call_id);
      if (tc) {
        if (Array.isArray(record.payload.parsed_cmd)) {
          tc.input.parsed_cmd = record.payload.parsed_cmd;
        }
        if (typeof record.payload.aggregated_output === "string" && !tc.result) {
          tc.result = record.payload.aggregated_output.slice(0, 1500);
        }
        if (typeof record.payload.exit_code === "number") {
          tc.isError = record.payload.exit_code !== 0;
        }
      }
      continue;
    }

    if (record.type !== "response_item") continue;

    const payload = record.payload;
    const payloadType = payload.type;

    // User message
    if (payload.role === "user" && payloadType === "message") {
      flushAssistant();
      const text = (payload.content || [])
        .filter((c) => c.type === "input_text")
        .map((c) => c.text || "")
        .join("\n")
        .trim();
      if (text) {
        messages.push({
          role: "user",
          content: text,
          toolCalls: [],
          timestamp: null,
        });
      }
      continue;
    }

    // Assistant text message
    if (payload.role === "assistant" && payloadType === "message") {
      const text = (payload.content || [])
        .filter((c) => c.type === "output_text")
        .map((c) => c.text || "")
        .join("\n")
        .trim();
      if (text) {
        // Flush any pending tool calls before this text
        flushAssistant();
        currentAssistantText = text;
      }
      continue;
    }

    // Function call (tool use)
    if (payloadType === "function_call" && payload.name) {
      const input = parseFunctionArguments(payload.arguments);

      const tc: ToolCall = {
        id: payload.call_id || null,
        tool: payload.name,
        input,
      };
      currentToolCalls.push(tc);
      if (payload.call_id) {
        pendingCalls.set(payload.call_id, tc);
      }
      continue;
    }

    if (payloadType === "custom_tool_call" && payload.name) {
      const tc: ToolCall = {
        id: payload.call_id || null,
        tool: payload.name,
        input: parseCustomToolInput(payload.name, payload.input),
      };
      currentToolCalls.push(tc);
      if (payload.call_id) {
        pendingCalls.set(payload.call_id, tc);
      }
      continue;
    }

    // Function call output (tool result)
    if ((payloadType === "function_call_output" || payloadType === "custom_tool_call_output") && payload.call_id) {
      const tc = pendingCalls.get(payload.call_id);
      if (tc) {
        const parsed = parseToolOutput(payload.output);
        tc.result = parsed.text;
        if (parsed.isError !== undefined) {
          tc.isError = parsed.isError;
        }
      }
      continue;
    }
  }

  // Flush remaining
  flushAssistant();

  return { messages, meta };
}
