import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runGit } from "../dist/git/git-command.js";

test("Git runner returns output and nonzero exit status without invoking a shell", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "kanban-git-command-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  const success = await runGit(["--version"], { cwd });
  assert.equal(success.exitCode, 0);
  assert.match(success.stdout, /git version/i);

  const failure = await runGit(["not-a-real-git-subcommand"], { cwd });
  assert.notEqual(failure.exitCode, 0);
});

test("Git runner rejects timed out commands", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "kanban-git-timeout-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  await assert.rejects(runGit(["--version"], { cwd, timeoutMs: 1 }), /timed out/);
});
