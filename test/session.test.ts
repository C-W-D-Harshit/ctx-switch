import assert from "node:assert/strict";
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
