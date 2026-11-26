// scripts/brief.ts
//
// The state of the project at the start of a session, on one screen: where the
// branch stands against origin, what is uncommitted, the last commits, what CI
// made of origin/main, the paired engine's working copy, and the handoff the
// last session left (docs/HANDOFF.md). Learned from NodeVibeCode's
// `cargo xtask brief`: an agent that starts from this does not re-derive the
// state from git and CI, and does not trample work another session left.
//
//   bun run brief            everything, CI included (one `gh` round trip)
//   bun run brief -- --quick no network: no fetch, no CI
//
// Every section is best effort: a missing `gh`, no network or no engine
// checkout prints a line saying so, and the brief still exits 0.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const quick = process.argv.includes("--quick");
const ENGINE = resolve("..", "transcribe-fork");

function run(command: string, args: string[], cwd = "."): string | null {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return result.status === 0 ? result.stdout.trimEnd() : null;
}

function section(title: string) {
  console.log(`\n== ${title}`);
}

/** Branch, upstream distance, dirty files and stashes of the repo at `cwd`. */
function repoState(cwd: string) {
  const branch = run("git", ["branch", "--show-current"], cwd) || "(detached)";
  const head = run("git", ["log", "-1", "--format=%h %s"], cwd) ?? "?";
  const counts = run(
    "git",
    ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
    cwd,
  );
  const [ahead, behind] = counts?.split(/\s+/) ?? [];
  console.log(`branch ${branch} at ${head}`);
  if (counts) console.log(`ahead ${ahead}, behind ${behind} of its upstream`);
  const dirty = (run("git", ["status", "--porcelain"], cwd) ?? "")
    .split("\n")
    .filter(Boolean);
  if (dirty.length === 0) {
    console.log("working tree clean");
  } else {
    console.log(`${dirty.length} uncommitted path(s):`);
    for (const line of dirty.slice(0, 12)) console.log(`  ${line}`);
    if (dirty.length > 12) console.log(`  … and ${dirty.length - 12} more`);
  }
  const stashes = (run("git", ["stash", "list"], cwd) ?? "")
    .split("\n")
    .filter(Boolean);
  if (stashes.length > 0) console.log(`${stashes.length} stash(es)`);
}

section("FreeSpeech");
if (!quick && run("git", ["fetch", "--quiet", "origin"]) === null) {
  console.log("(git fetch failed: the numbers below may be stale)");
}
repoState(".");
const log = run("git", ["log", "-6", "--format=  %h %ad %s", "--date=short"]);
if (log) console.log(`last commits:\n${log}`);

section("CI of origin/main");
if (quick) {
  console.log("skipped (--quick)");
} else {
  const result = spawnSync("bun", ["scripts/ci-status.ts", "origin/main"], {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  console.log(
    (result.stdout || result.stderr || "ci:status gave no answer").trimEnd(),
  );
}

section("Engine (transcribe-fork)");
if (existsSync(ENGINE)) {
  repoState(ENGINE);
  const worktrees = run("git", ["worktree", "list"], ENGINE);
  if (worktrees && worktrees.split("\n").length > 1) {
    console.log(`worktrees:\n${worktrees.replace(/^/gm, "  ")}`);
  }
  console.log(
    "uncommitted work there may be another session's: never discard it",
  );
} else {
  console.log(`no checkout at ${ENGINE}`);
}

section("Handoff (docs/HANDOFF.md)");
const handoff = "docs/HANDOFF.md";
console.log(
  existsSync(handoff)
    ? readFileSync(handoff, "utf8").trimEnd()
    : "none yet: write one at the end of this session",
);
