import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "../src/args.js";

test("parseArgs handles product flags", () => {
  const parsed = parseArgs([
    "--refine",
    "--session",
    "abc123",
    "--provider",
    "openrouter",
    "--model",
    "openrouter/auto",
    "--target",
    "codex",
    "--output",
    "./handoff.md",
  ]);

  assert.equal(parsed.refine, true);
  assert.equal(parsed.session, "abc123");
  assert.equal(parsed.provider, "openrouter");
  assert.equal(parsed.model, "openrouter/auto");
  assert.equal(parsed.target, "codex");
  assert.match(parsed.output || "", /handoff\.md$/);
});

test("parseArgs supports claude target", () => {
  const parsed = parseArgs(["--source", "codex", "--target", "claude"]);
  assert.equal(parsed.source, "codex");
  assert.equal(parsed.target, "claude");
});

test("parseArgs supports doctor command", () => {
  const parsed = parseArgs(["doctor", "--provider", "openrouter"]);
  assert.equal(parsed.command, "doctor");
  assert.equal(parsed.provider, "openrouter");
});

test("parseArgs supports sessions command and limit", () => {
  const parsed = parseArgs(["sessions", "--limit", "5"]);
  assert.equal(parsed.command, "sessions");
  assert.equal(parsed.limit, 5);
});

test("parseArgs supports manual user focus flags", () => {
  const parsed = parseArgs(["--pick-user", "--from-user", "2"]);
  assert.equal(parsed.pickUser, true);
  assert.equal(parsed.fromUser, 2);
});
