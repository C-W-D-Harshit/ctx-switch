import assert from "node:assert/strict";
import test from "node:test";
import { buildRawPrompt } from "../src/prompt.js";
import type { SessionContext } from "../src/types.js";

function createBaseContext(messages: SessionContext["messages"]): SessionContext {
  return {
    cwd: "/tmp/project",
    sessionCwd: "/tmp/project",
    sessionPath: "/tmp/project/session.jsonl",
    sessionId: "demo-session",
    branch: "main",
    transcript: [],
    filesModified: [],
    filesRead: [],
    commands: [],
    messages,
    gitContext: {
      isGitRepo: true,
      branch: "main",
      status: "",
      staged: { stat: "", diff: "" },
      unstaged: { stat: "", diff: "" },
      untracked: [],
      hasChanges: false,
      recentCommits: "abc123 recent commit",
      committedDiff: "src/cli.ts | 10 +++++-----",
    },
  };
}

function createContextWithGit(
  messages: SessionContext["messages"],
  overrides: Partial<SessionContext["gitContext"]>
): SessionContext {
  const base = createBaseContext(messages);
  return {
    ...base,
    gitContext: {
      ...base.gitContext,
      ...overrides,
    },
  };
}

test("buildRawPrompt focuses on the latest completed Q&A tail instead of stale earlier work", () => {
  const ctx = createBaseContext([
    {
      role: "user",
      content: "Add Codex and OpenCode support.",
      toolCalls: [],
      timestamp: "2026-03-01T10:00:00.000Z",
    },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "1",
          tool: "Edit",
          input: { file_path: "/tmp/project/src/cli.ts" },
        },
      ],
      timestamp: "2026-03-01T10:05:00.000Z",
    },
    {
      role: "assistant",
      content: "Done.",
      toolCalls: [],
      timestamp: "2026-03-01T10:06:00.000Z",
    },
    {
      role: "user",
      content: "this project is built with?",
      toolCalls: [],
      timestamp: "2026-03-01T10:10:00.000Z",
    },
    {
      role: "assistant",
      content: "Node.js + TypeScript, bundled with esbuild.",
      toolCalls: [],
      timestamp: "2026-03-01T10:10:30.000Z",
    },
  ]);

  const prompt = buildRawPrompt(ctx);

  assert.match(prompt, /latest exchange in this session appears complete/i);
  assert.match(prompt, /this project is built with\?/);
  assert.match(prompt, /Last Answer Already Given/);
  assert.match(prompt, /Node\.js \+ TypeScript, bundled with esbuild\./);
  assert.doesNotMatch(prompt, /Add Codex and OpenCode support\./);
  assert.doesNotMatch(prompt, /Work Already Completed/);
  assert.doesNotMatch(prompt, /src\/cli\.ts/);
  assert.doesNotMatch(prompt, /Recent commits:/);
});

test("buildRawPrompt keeps the active unfinished work thread and touched files", () => {
  const ctx = createBaseContext([
    {
      role: "user",
      content: "Add Codex support using the latest session from the current project.",
      toolCalls: [],
      timestamp: "2026-03-01T10:00:00.000Z",
    },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "1",
          tool: "Read",
          input: { file_path: "/tmp/project/src/session-codex.ts" },
        },
      ],
      timestamp: "2026-03-01T10:02:00.000Z",
    },
    {
      role: "user",
      content: "Yes, please.",
      toolCalls: [],
      timestamp: "2026-03-01T10:03:00.000Z",
    },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "2",
          tool: "Edit",
          input: { file_path: "/tmp/project/src/session-codex.ts" },
        },
        {
          id: "3",
          tool: "Bash",
          input: { command: "npm test" },
        },
      ],
      timestamp: "2026-03-01T10:05:00.000Z",
    },
  ]);

  const prompt = buildRawPrompt(ctx, { target: "codex" });

  assert.doesNotMatch(prompt, /latest exchange in this session appears complete/i);
  assert.match(prompt, /Add Codex support using the latest session from the current project\./);
  assert.match(prompt, /Session History/);
  assert.match(prompt, /USER: Add Codex support using the latest session from the current project\./);
  assert.match(prompt, /ASSISTANT: \[tools\] Read \/tmp\/project\/src\/session-codex\.ts/);
  assert.match(prompt, /\/tmp\/project\/src\/session-codex\.ts/);
  assert.match(prompt, /Recent Commands \/ Checks/);
  assert.match(prompt, /`npm test`/);
  assert.match(prompt, /Read These Files First/);
  assert.match(prompt, /Recent commits:/);
  assert.match(prompt, /The next agent is Codex\./);
  assert.match(prompt, /Current Status/);
  assert.match(prompt, /Likely Remaining Work/);
});

test("buildRawPrompt keeps the previous user ask when the latest message is referential", () => {
  const ctx = createContextWithGit(
    [
      {
        role: "user",
        content: "Run ctx-switch with Codex and inspect the handoff prompt as a receiving agent.",
        toolCalls: [],
        timestamp: "2026-03-01T10:00:00.000Z",
      },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "1",
            tool: "Bash",
            input: { command: "node dist/index.mjs --source codex" },
          },
        ],
        timestamp: "2026-03-01T10:02:00.000Z",
      },
      {
        role: "user",
        content: "Ok, let's think again as a real user and make Codex switch even better.",
        toolCalls: [],
        timestamp: "2026-03-01T10:03:00.000Z",
      },
      {
        role: "assistant",
        content: "The failed run exposed another heuristic gap: the prompt lost the prior request when the latest user message was referential.",
        toolCalls: [],
        timestamp: "2026-03-01T10:04:00.000Z",
      },
    ],
    {
      status: "M src/prompt.ts\n?? test/prompt.test.ts",
      hasChanges: true,
      unstaged: { stat: "", diff: "diff --git a/src/prompt.ts b/src/prompt.ts" },
      untracked: [{ path: "test/prompt.test.ts", preview: "test contents" }],
    }
  );

  const prompt = buildRawPrompt(ctx, { target: "codex" });

  assert.match(prompt, /Run ctx-switch with Codex and inspect the handoff prompt as a receiving agent\./);
  assert.match(prompt, /make Codex switch even better/i);
  assert.match(prompt, /The failed run exposed another heuristic gap/);
  assert.match(prompt, /Read These Files First/);
  assert.match(prompt, /`src\/prompt\.ts`/);
  assert.match(prompt, /`test\/prompt\.test\.ts`/);
});

test("buildRawPrompt excludes meta quality commentary from key discoveries", () => {
  const ctx = createBaseContext([
    {
      role: "user",
      content: "Improve the Codex handoff.",
      toolCalls: [],
      timestamp: "2026-03-01T10:00:00.000Z",
    },
    {
      role: "assistant",
      content: "The handoff is much better now and the prompt quality looks good.",
      toolCalls: [],
      timestamp: "2026-03-01T10:01:00.000Z",
    },
    {
      role: "assistant",
      content: "The failed run exposed another heuristic gap: apply_patch edits are missing from the active work summary.",
      toolCalls: [],
      timestamp: "2026-03-01T10:02:00.000Z",
    },
  ]);

  const prompt = buildRawPrompt(ctx);

  assert.match(prompt, /apply_patch edits are missing/);
  assert.doesNotMatch(prompt, /prompt quality looks good/);
});

test("buildRawPrompt supports claude target guidance for codex handoff", () => {
  const ctx = createContextWithGit(
    [
      {
        role: "user",
        content: "Codex hit the limit. Generate a handoff I can paste into Claude Code.",
        toolCalls: [],
        timestamp: "2026-03-01T10:00:00.000Z",
      },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "1",
            tool: "Bash",
            input: { command: "npm test" },
          },
        ],
        timestamp: "2026-03-01T10:01:00.000Z",
      },
    ],
    {
      status: "M src/prompt.ts\n?? test/prompt.test.ts",
      hasChanges: true,
      unstaged: { stat: "", diff: "diff --git a/src/prompt.ts b/src/prompt.ts" },
      untracked: [{ path: "test/prompt.test.ts", preview: "test contents" }],
    }
  );

  const prompt = buildRawPrompt(ctx, { target: "claude" });

  assert.match(prompt, /The next agent is Claude Code\./);
  assert.match(prompt, /Recent Commands \/ Checks/);
  assert.match(prompt, /`npm test`/);
  assert.match(prompt, /Read These Files First/);
  assert.match(prompt, /`src\/prompt\.ts`/);
  assert.match(prompt, /git status --short/);
  assert.match(prompt, /git diff --stat/);
  assert.match(prompt, /git diff -- src\/prompt\.ts test\/prompt\.test\.ts/);
  assert.doesNotMatch(prompt, /\*\*Staged diff:\*\*/);
  assert.doesNotMatch(prompt, /\*\*Unstaged diff:\*\*/);
});

test("buildRawPrompt includes a compact recent session history tail", () => {
  const ctx = createBaseContext([
    {
      role: "user",
      content: "Investigate the OpenCode handoff.",
      toolCalls: [],
      timestamp: "2026-03-01T10:00:00.000Z",
    },
    {
      role: "assistant",
      content: "I am inspecting the OpenCode parser.",
      toolCalls: [
        {
          id: "1",
          tool: "Bash",
          input: { command: "sed -n '1,200p' src/session-opencode.ts" },
        },
      ],
      timestamp: "2026-03-01T10:01:00.000Z",
    },
    {
      role: "user",
      content: "We likely need the session history in the handoff.",
      toolCalls: [],
      timestamp: "2026-03-01T10:02:00.000Z",
    },
  ]);

  const prompt = buildRawPrompt(ctx);

  assert.match(prompt, /Session History/);
  assert.match(prompt, /USER: Investigate the OpenCode handoff\./);
  assert.match(prompt, /ASSISTANT: I am inspecting the OpenCode parser\. \| \[tools\] Bash: sed -n '1,200p' src\/session-opencode\.ts/);
  assert.match(prompt, /USER: We likely need the session history in the handoff\./);
});

test("buildRawPrompt drops local command noise and preserves the last meaningful assistant answer after rate limits", () => {
  const ctx = createBaseContext([
    {
      role: "user",
      content: "I want to write a blog on How Image compression works?",
      toolCalls: [],
      timestamp: "2026-03-30T09:10:00.000Z",
    },
    {
      role: "assistant",
      content: "Let me fetch the reference blog and explore your blog setup first.",
      toolCalls: [
        {
          id: "1",
          tool: "WebFetch",
          input: { url: "https://leerob.com/compression" },
        },
        {
          id: "2",
          tool: "Agent",
          input: { description: "Explore blog setup in codebase" },
        },
      ],
      timestamp: "2026-03-30T09:11:00.000Z",
    },
    {
      role: "assistant",
      content:
        "Got it. I've studied leerob's blog and your writing voice across your site. Here's the draft copy for the post.",
      toolCalls: [],
      timestamp: "2026-03-30T09:13:00.000Z",
    },
    {
      role: "user",
      content: "I like it",
      toolCalls: [],
      timestamp: "2026-03-30T09:15:00.000Z",
    },
    {
      role: "assistant",
      content: "You're out of extra usage · resets 3:30pm (Asia/Calcutta)",
      toolCalls: [],
      timestamp: "2026-03-30T09:15:01.000Z",
    },
    {
      role: "user",
      content:
        "<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>",
      toolCalls: [],
      timestamp: "2026-03-30T09:16:00.000Z",
    },
    {
      role: "user",
      content:
        "<command-name>/rate-limit-options</command-name>\n<command-message>rate-limit-options</command-message>",
      toolCalls: [],
      timestamp: "2026-03-30T09:16:01.000Z",
    },
    {
      role: "user",
      content: "<local-command-stdout>Login interrupted</local-command-stdout>",
      toolCalls: [],
      timestamp: "2026-03-30T09:16:02.000Z",
    },
    {
      role: "user",
      content: "continue",
      toolCalls: [],
      timestamp: "2026-03-30T09:16:03.000Z",
    },
    {
      role: "assistant",
      content: "You're out of extra usage · resets 3:30pm (Asia/Calcutta)",
      toolCalls: [],
      timestamp: "2026-03-30T09:16:04.000Z",
    },
  ]);

  const prompt = buildRawPrompt(ctx);

  assert.match(prompt, /I want to write a blog on How Image compression works\?/);
  assert.match(prompt, /- I like it/);
  assert.match(prompt, /- continue/);
  assert.match(prompt, /Last active step: Got it\. I've studied leerob's blog/);
  assert.match(prompt, /Continue from the last meaningful assistant answer above/);
  assert.match(prompt, /ASSISTANT: Let me fetch the reference blog and explore your blog setup first\. \| \[tools\] WebFetch: https:\/\/leerob\.com\/compression, Agent: Explore blog setup in codebase/);
  assert.doesNotMatch(prompt, /rate-limit-options/);
  assert.doesNotMatch(prompt, /local-command-caveat/);
  assert.doesNotMatch(prompt, /Login interrupted/);
  assert.doesNotMatch(prompt, /You're out of extra usage/);
});

test("buildRawPrompt supports starting preserved context from a chosen user prompt", () => {
  const ctx = createBaseContext([
    {
      role: "user",
      content: "Old bugfix request.",
      toolCalls: [],
      timestamp: "2026-03-01T10:00:00.000Z",
    },
    {
      role: "assistant",
      content: "Done.",
      toolCalls: [],
      timestamp: "2026-03-01T10:01:00.000Z",
    },
    {
      role: "user",
      content: "Write the image compression blog copy first, then implement it after approval.",
      toolCalls: [],
      timestamp: "2026-03-01T10:02:00.000Z",
    },
    {
      role: "assistant",
      content: "Here is the draft copy.",
      toolCalls: [],
      timestamp: "2026-03-01T10:03:00.000Z",
    },
  ]);

  const prompt = buildRawPrompt(ctx, { fromUserMessage: 2 });

  assert.match(prompt, /Write the image compression blog copy first/);
  assert.doesNotMatch(prompt, /Old bugfix request/);
});
