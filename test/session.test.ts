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
