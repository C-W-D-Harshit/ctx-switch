import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildSessionContext, parseSession } from "../src/session.js";

test("parseSession extracts nested progress tool calls and ignores tool-only user results", () => {
  const fixture = path.join(import.meta.dirname, "fixtures", "sample-session.jsonl");
  const { messages, meta } = parseSession(fixture, "claude");

  assert.equal(meta.sessionId, "demo-session");
  assert.equal(meta.gitBranch, "feature/demo");
  assert.equal(messages.length, 5);

  const assistantWithBash = messages.find(
    (message) => message.role === "assistant" && message.toolCalls.some((call) => call.tool === "Bash")
  );

  assert.ok(assistantWithBash);

  const ctx = buildSessionContext({
    messages,
    meta,
    cwd: "/tmp/project",
    sessionPath: fixture,
    gitContext: {
      isGitRepo: false,
      branch: null,
      status: "",
      staged: { stat: "", diff: "" },
      unstaged: { stat: "", diff: "" },
      untracked: [],
      hasChanges: false,
      recentCommits: "",
      committedDiff: "",
    },
  });

  assert.deepEqual(ctx.filesModified, ["/tmp/project/src/auth.js"]);
  assert.deepEqual(ctx.filesRead, ["/tmp/project/src/auth.js"]);
  assert.deepEqual(ctx.commands, ["npm test"]);
});

test("parseSession extracts Codex custom tool calls and exec metadata", () => {
  const fixture = path.join(import.meta.dirname, "fixtures", "sample-codex-session.jsonl");
  const { messages, meta } = parseSession(fixture, "codex");

  assert.equal(meta.sessionId, "codex-demo-session");
  assert.equal(meta.gitBranch, "feature/codex");
  assert.equal(messages.length, 3);

  const assistantTools = messages.find(
    (message) => message.role === "assistant" && message.toolCalls.some((call) => call.tool === "apply_patch")
  );

  assert.ok(assistantTools);
  assert.deepEqual(assistantTools.toolCalls.map((call) => call.tool), ["exec_command", "apply_patch"]);
  const parsedCommands = assistantTools.toolCalls[0].input.parsed_cmd as Array<Record<string, unknown>> | undefined;
  assert.equal(parsedCommands?.[0]?.type, "read");
  assert.match(String(assistantTools.toolCalls[1].input.patch), /\*\*\* Update File: src\/session-codex\.ts/);
  assert.match(String(assistantTools.toolCalls[1].result), /Success\. Updated the following files:/);

  const ctx = buildSessionContext({
    messages,
    meta,
    cwd: "/tmp/project",
    sessionPath: fixture,
    gitContext: {
      isGitRepo: false,
      branch: null,
      status: "",
      staged: { stat: "", diff: "" },
      unstaged: { stat: "", diff: "" },
      untracked: [],
      hasChanges: false,
      recentCommits: "",
      committedDiff: "",
    },
  });

  assert.deepEqual(ctx.filesModified, ["/tmp/project/src/session-codex.ts"]);
  assert.deepEqual(ctx.filesRead, ["/tmp/project/src/session-codex.ts"]);
  assert.deepEqual(ctx.commands, ["sed -n '1,80p' src/session-codex.ts"]);
  assert.match(ctx.transcript[1].text, /apply_patch \/tmp\/project\/src\/session-codex\.ts/);
});

test("parseSession extracts OpenCode apply_patch and avoids false-positive read errors", () => {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ctx-switch-opencode-")), "opencode.db");

  execFileSync("sqlite3", [
    dbPath,
    `
      CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER);
      CREATE TABLE part (message_id TEXT, data TEXT, time_created INTEGER);

      INSERT INTO session (id, title, directory) VALUES ('ses_demo', 'OpenCode demo', '/tmp/project');
      INSERT INTO message (id, session_id, data, time_created)
      VALUES
        ('msg_user', 'ses_demo', '{"role":"user","path":{"cwd":"/tmp/project"}}', 1),
        ('msg_assistant', 'ses_demo', '{"role":"assistant","path":{"cwd":"/tmp/project"}}', 2);

      INSERT INTO part (message_id, data, time_created)
      VALUES
        (
          'msg_user',
          '{"type":"text","text":"Inspect the OpenCode parser."}',
          1
        ),
        (
          'msg_assistant',
          '{"type":"tool","callID":"call_read","tool":"bash","state":{"status":"completed","input":{"command":"head -40 /tmp/project/src/openrouter.ts","description":"Read file"},"output":"import type { OpenRouterErrorDetails } from \\"./types.js\\";\\n"}}',
          2
        ),
        (
          'msg_assistant',
          '{"type":"tool","callID":"call_patch","tool":"apply_patch","state":{"status":"completed","input":{"patchText":"*** Begin Patch\\n*** Update File: src/session-opencode.ts\\n@@\\n-old\\n+new\\n*** End Patch"},"output":"Success. Updated the following files:\\nM src/session-opencode.ts"}}',
          3
        ),
        (
          'msg_assistant',
          '{"type":"text","text":"Done."}',
          4
        );
    `,
  ]);

  process.env.CTX_SWITCH_OPENCODE_DB_PATH = dbPath;

  try {
    const { messages, meta } = parseSession("ses_demo", "opencode");

    assert.equal(meta.sessionId, "ses_demo");
    assert.equal(meta.cwd, "/tmp/project");
    assert.equal(messages.length, 2);

    const assistant = messages.find((message) => message.role === "assistant");
    assert.ok(assistant);
    assert.deepEqual(assistant.toolCalls.map((call) => call.tool), ["bash", "apply_patch"]);
    assert.equal(assistant.toolCalls[0].isError, undefined);
    assert.match(String(assistant.toolCalls[1].input.patch), /\*\*\* Update File: src\/session-opencode\.ts/);

    const ctx = buildSessionContext({
      messages,
      meta,
      cwd: "/tmp/project",
      sessionPath: "ses_demo",
      gitContext: {
        isGitRepo: false,
        branch: null,
        status: "",
        staged: { stat: "", diff: "" },
        unstaged: { stat: "", diff: "" },
        untracked: [],
        hasChanges: false,
        recentCommits: "",
        committedDiff: "",
      },
    });

    assert.deepEqual(ctx.filesModified, ["/tmp/project/src/session-opencode.ts"]);
    assert.deepEqual(ctx.filesRead, ["/tmp/project/src/openrouter.ts"]);
    assert.deepEqual(ctx.commands, ["head -40 /tmp/project/src/openrouter.ts"]);
  } finally {
    delete process.env.CTX_SWITCH_OPENCODE_DB_PATH;
  }
});

test("parseSession inlines delegated OpenCode task assistant work without child user prompts", () => {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ctx-switch-opencode-task-")), "opencode.db");

  execFileSync("sqlite3", [
    dbPath,
    `
      CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER);
      CREATE TABLE part (message_id TEXT, data TEXT, time_created INTEGER);

      INSERT INTO session (id, title, directory)
      VALUES
        ('ses_parent', 'Parent session', '/tmp/project'),
        ('ses_child', 'Child session', '/tmp/project');

      INSERT INTO message (id, session_id, data, time_created)
      VALUES
        ('parent_user', 'ses_parent', '{"role":"user","path":{"cwd":"/tmp/project"}}', 1),
        ('parent_assistant', 'ses_parent', '{"role":"assistant","path":{"cwd":"/tmp/project"}}', 2),
        ('child_user', 'ses_child', '{"role":"user","path":{"cwd":"/tmp/project"}}', 3),
        ('child_assistant', 'ses_child', '{"role":"assistant","path":{"cwd":"/tmp/project"}}', 4);

      INSERT INTO part (message_id, data, time_created)
      VALUES
        (
          'parent_user',
          '{"type":"text","text":"Explore this repo."}',
          1
        ),
        (
          'parent_assistant',
          '{"type":"tool","callID":"call_task","tool":"task","state":{"status":"completed","input":{"description":"Explore codebase structure","prompt":"Explore this repository and summarize it.","subagent_type":"pan-wala"},"output":"task_id: ses_child (for resuming to continue this task if needed)","metadata":{"sessionId":"ses_child"}}}',
          2
        ),
        (
          'child_user',
          '{"type":"text","text":"Synthetic child prompt that should not surface as a top-level user ask."}',
          3
        ),
        (
          'child_assistant',
          '{"type":"tool","callID":"call_child_read","tool":"bash","state":{"status":"completed","input":{"command":"cat /tmp/project/package.json","description":"Read package"},"output":"{\\"name\\": \\"ctx-switch\\"}\\n"}}',
          4
        ),
        (
          'child_assistant',
          '{"type":"tool","callID":"call_child_patch","tool":"apply_patch","state":{"status":"completed","input":{"patchText":"*** Begin Patch\\n*** Update File: src/session-opencode.ts\\n@@\\n-old\\n+new\\n*** End Patch"},"output":"Success. Updated the following files:\\nM src/session-opencode.ts"}}',
          5
        ),
        (
          'child_assistant',
          '{"type":"text","text":"Delegated exploration completed."}',
          6
        );
    `,
  ]);

  process.env.CTX_SWITCH_OPENCODE_DB_PATH = dbPath;

  try {
    const { messages, meta } = parseSession("ses_parent", "opencode");

    assert.equal(meta.sessionId, "ses_parent");
    assert.equal(messages[0].role, "user");
    assert.equal(messages[1].role, "assistant");
    assert.equal(messages[2].role, "assistant");
    assert.equal(messages.filter((message) => message.role === "user").length, 1);
    assert.deepEqual(messages[2].toolCalls.map((call) => call.tool), ["bash", "apply_patch"]);

    const ctx = buildSessionContext({
      messages,
      meta,
      cwd: "/tmp/project",
      sessionPath: "ses_parent",
      gitContext: {
        isGitRepo: false,
        branch: null,
        status: "",
        staged: { stat: "", diff: "" },
        unstaged: { stat: "", diff: "" },
        untracked: [],
        hasChanges: false,
        recentCommits: "",
        committedDiff: "",
      },
    });

    assert.deepEqual(ctx.filesRead, ["/tmp/project/package.json"]);
    assert.deepEqual(ctx.filesModified, ["/tmp/project/src/session-opencode.ts"]);
    assert.deepEqual(ctx.commands, ["cat /tmp/project/package.json"]);
  } finally {
    delete process.env.CTX_SWITCH_OPENCODE_DB_PATH;
  }
});
