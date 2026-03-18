#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const https = require("https");
const { execSync } = require("child_process");

const HOME = require("os").homedir();
const CLAUDE_DIR = path.join(HOME, ".claude");
const PROJECTS_DIR = path.join(CLAUDE_DIR, "projects");
const CONFIG_PATH = path.join(HOME, ".cc-continue.json");

// ── Config ──

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

function getApiKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  const config = loadConfig();
  return config.openrouter_api_key || null;
}

function promptForApiKey() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question("🔑 Enter your OpenRouter API key: ", (answer) => {
      rl.close();
      const key = answer.trim();
      if (!key) return resolve(null);
      const config = loadConfig();
      config.openrouter_api_key = key;
      saveConfig(config);
      console.error(`✅ Saved to ${CONFIG_PATH}\n`);
      resolve(key);
    });
  });
}

// ── Session Discovery ──

function cwdToProjectDir(cwd) {
  return cwd.replace(/\//g, "-");
}

function findLatestSession(cwd) {
  const projectKey = cwdToProjectDir(cwd);
  const projectPath = path.join(PROJECTS_DIR, projectKey);

  if (!fs.existsSync(projectPath)) {
    console.error(`No Claude Code sessions found for: ${cwd}`);
    console.error(`Expected project dir: ${projectPath}`);
    process.exit(1);
  }

  const jsonlFiles = fs
    .readdirSync(projectPath)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({
      name: f,
      path: path.join(projectPath, f),
      mtime: fs.statSync(path.join(projectPath, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);

  if (jsonlFiles.length === 0) {
    console.error("No session files found.");
    process.exit(1);
  }

  return jsonlFiles[0].path;
}

// ── Git Context ──

function getGitDiff(cwd) {
  try {
    // staged + unstaged changes, limited to keep prompt sane
    const diff = execSync("git diff HEAD --stat 2>/dev/null", {
      cwd,
      encoding: "utf-8",
      timeout: 5000,
    }).trim();

    const fullDiff = execSync("git diff HEAD 2>/dev/null", {
      cwd,
      encoding: "utf-8",
      timeout: 5000,
    }).trim();

    return { stat: diff, full: fullDiff.slice(0, 15000) }; // cap at 15k chars
  } catch {
    return null;
  }
}

function getGitBranch(cwd) {
  try {
    return execSync("git branch --show-current 2>/dev/null", {
      cwd,
      encoding: "utf-8",
      timeout: 3000,
    }).trim();
  } catch {
    return null;
  }
}

// ── Session Parsing ──

function extractTextFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function extractToolCalls(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter((c) => c.type === "tool_use")
    .map((c) => ({ tool: c.name, input: c.input }));
}

function parseSession(sessionPath) {
  const lines = fs.readFileSync(sessionPath, "utf-8").trim().split("\n");
  const messages = [];

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === "file-history-snapshot" || obj.type === "progress") continue;

      if (obj.type === "user") {
        const content = obj.message?.content;
        if (Array.isArray(content)) {
          const hasText = content.some((c) => c.type === "text");
          const hasToolResult = content.some((c) => c.type === "tool_result");
          if (hasToolResult && !hasText) continue;
        }
        messages.push({
          role: "user",
          content: typeof content === "string" ? content : extractTextFromContent(content),
          timestamp: obj.timestamp,
        });
      } else if (obj.type === "assistant") {
        const content = obj.message?.content;
        if (!content) continue;
        const text = extractTextFromContent(content);
        const toolCalls = extractToolCalls(content);
        if (text || toolCalls.length > 0) {
          messages.push({ role: "assistant", content: text, toolCalls, timestamp: obj.timestamp });
        }
      }
    } catch {}
  }

  return messages;
}

// ── Context Building ──

function buildRichContext(messages, cwd) {
  // Collect all files touched (Edit/Write)
  const filesModified = new Set();
  const filesRead = new Set();
  const bashCommands = [];

  for (const msg of messages) {
    if (msg.role !== "assistant" || !msg.toolCalls) continue;
    for (const tc of msg.toolCalls) {
      if (["Edit", "Write"].includes(tc.tool) && tc.input?.file_path) {
        filesModified.add(tc.input.file_path);
      }
      if (tc.tool === "Read" && tc.input?.file_path) {
        filesRead.add(tc.input.file_path);
      }
      if (tc.tool === "Bash" && tc.input?.command) {
        bashCommands.push(tc.input.command);
      }
    }
  }

  // Build conversation transcript (compact)
  // Include full conversation but keep assistant messages concise
  const transcript = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      transcript.push(`USER: ${msg.content}`);
    } else if (msg.role === "assistant") {
      if (msg.content && msg.content.trim().length > 30) {
        transcript.push(`ASSISTANT: ${msg.content}`);
      }
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        const tools = msg.toolCalls
          .filter((tc) => ["Edit", "Write", "Bash"].includes(tc.tool))
          .map((tc) => {
            if (tc.tool === "Edit") return `Edit ${tc.input?.file_path || ""}`;
            if (tc.tool === "Write") return `Write ${tc.input?.file_path || ""}`;
            if (tc.tool === "Bash") return `Run: ${(tc.input?.command || "").slice(0, 100)}`;
            return tc.tool;
          });
        if (tools.length > 0) {
          transcript.push(`ASSISTANT [tools]: ${tools.join(", ")}`);
        }
      }
    }
  }

  // Git context
  const branch = getGitBranch(cwd);
  const diff = getGitDiff(cwd);

  return {
    transcript,
    filesModified: [...filesModified],
    filesRead: [...filesRead],
    bashCommands,
    branch,
    diff,
    messageCount: messages.length,
  };
}

// ── Raw Prompt (fallback) ──

function buildRawPrompt(ctx) {
  let prompt = "# Continue Claude Code Session\n\n";

  if (ctx.branch) {
    prompt += `**Branch:** \`${ctx.branch}\`\n\n`;
  }

  prompt += "## Conversation History\n\n";
  // Show last 20 transcript entries to keep it focused
  const recent = ctx.transcript.slice(-20);
  for (const line of recent) {
    prompt += line + "\n\n";
  }

  if (ctx.filesModified.length > 0) {
    prompt += "## Files Modified This Session\n\n";
    for (const f of ctx.filesModified) prompt += `- \`${f}\`\n`;
    prompt += "\n";
  }

  if (ctx.diff?.stat) {
    prompt += "## Uncommitted Changes (git diff --stat)\n\n```\n" + ctx.diff.stat + "\n```\n\n";
  }

  prompt += "## Instructions\n\n";
  prompt += "The previous Claude Code session was interrupted due to usage limits. ";
  prompt += "Continue the work from where it left off. Do NOT redo completed work. ";
  prompt += "Check the current state of modified files, then finish any remaining tasks.\n";

  return prompt;
}

// ── OpenRouter ──

async function refineWithOpenRouter(ctx, apiKey) {
  // Build a rich dump for the model to distill
  let dump = "=== SESSION DUMP ===\n\n";

  if (ctx.branch) dump += `Git branch: ${ctx.branch}\n\n`;

  dump += "--- CONVERSATION ---\n\n";
  for (const line of ctx.transcript) {
    dump += line + "\n\n";
  }

  if (ctx.filesModified.length > 0) {
    dump += "--- FILES MODIFIED ---\n";
    for (const f of ctx.filesModified) dump += f + "\n";
    dump += "\n";
  }

  if (ctx.diff?.stat) {
    dump += "--- GIT DIFF STAT ---\n" + ctx.diff.stat + "\n\n";
  }

  if (ctx.diff?.full) {
    dump += "--- GIT DIFF (truncated) ---\n" + ctx.diff.full + "\n\n";
  }

  const systemPrompt = `You are an expert at creating continuation prompts for AI coding agents.

You receive a FULL dump of an interrupted Claude Code session — conversation history, files changed, and git diff.

Your job: produce a perfect handoff prompt so that another AI agent (Codex, Cursor, Claude, etc.) can seamlessly continue the work.

The output prompt MUST include:

1. **Context** — What project/branch, what the user has been working on (not just the last message, but the full picture from the conversation)
2. **What was requested** — The user's actual goal, synthesized from the conversation (the last message might be vague like "still some issues" — you need to explain what "issues" means from context)
3. **What was completed** — Specific changes made, files modified, decisions taken. Include file paths.
4. **What remains** — Clearly state what's left to do. If the session ended mid-task, say exactly where it stopped.
5. **Current state of the code** — Use the git diff to describe what the code looks like now (what was added/changed)

Rules:
- Output ONLY the prompt, no preamble
- Be specific — file paths, function names, line references
- The new agent has NO memory of the previous session. Give it everything it needs.
- Keep it focused and actionable, not a wall of text
- If the session seems complete (assistant gave a final summary), note that and suggest verification steps instead`;

  const body = JSON.stringify({
    model: "openrouter/free",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: dump },
    ],
  });

  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: "openrouter.ai",
        path: "/api/v1/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            if (json.error) {
              console.error(`   API error: ${json.error.message || JSON.stringify(json.error)}`);
              resolve(null);
              return;
            }
            const text = json.choices?.[0]?.message?.content;
            resolve(text || null);
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on("error", (err) => {
      console.error(`   Network error: ${err.message}`);
      resolve(null);
    });
    req.write(body);
    req.end();
  });
}

// ── Clipboard ──

function copyToClipboard(text) {
  try {
    execSync("pbcopy", { input: text });
    return true;
  } catch {
    return false;
  }
}

// ── Main ──

async function main() {
  const cwd = process.cwd();
  const args = process.argv.slice(2);
  const skipRefine = args.includes("--raw");
  const copyFlag = args.includes("--copy") || args.includes("-c");

  console.error("🔍 Finding latest Claude Code session...");
  const sessionPath = findLatestSession(cwd);
  console.error(`📂 Session: ${path.basename(sessionPath)}`);

  console.error("📖 Parsing session...");
  const messages = parseSession(sessionPath);
  console.error(`   ${messages.filter((m) => m.role === "user").length} user messages, ${messages.filter((m) => m.role === "assistant").length} assistant messages`);

  console.error("🔧 Building context...");
  const ctx = buildRichContext(messages, cwd);

  if (ctx.diff?.stat) {
    console.error(`   ${ctx.filesModified.length} files modified, uncommitted changes detected`);
  } else {
    console.error(`   ${ctx.filesModified.length} files modified`);
  }
  console.error();

  let finalPrompt;

  if (skipRefine) {
    finalPrompt = buildRawPrompt(ctx);
  } else {
    let apiKey = getApiKey();
    if (!apiKey) {
      console.error("No OpenRouter API key found.\n");
      console.error("We use the openrouter/free model — completely free, no credits needed.");
      console.error("Get your key at: https://openrouter.ai/keys\n");
      apiKey = await promptForApiKey();
    }

    if (apiKey) {
      console.error("🤖 Refining with OpenRouter (openrouter/free)...");
      const refined = await refineWithOpenRouter(ctx, apiKey);
      if (refined) {
        finalPrompt = refined;
        console.error("✅ Done.\n");
      } else {
        console.error("⚠️  OpenRouter failed, falling back to raw prompt.\n");
        finalPrompt = buildRawPrompt(ctx);
      }
    } else {
      console.error("⚠️  No API key, using raw prompt.\n");
      finalPrompt = buildRawPrompt(ctx);
    }
  }

  if (copyFlag) {
    if (copyToClipboard(finalPrompt)) {
      console.error("📋 Copied to clipboard!");
    } else {
      console.error("⚠️  Failed to copy to clipboard.");
    }
  }

  console.log(finalPrompt);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
