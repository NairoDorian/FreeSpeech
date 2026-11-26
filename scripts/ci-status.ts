// scripts/ci-status.ts
//
// What GitHub made of a commit: every workflow run for it, each job's result,
// and, for a job that failed, the first line of its log that says why.
// Learned from NodeVibeCode's `cargo pipeline --wait`: push as soon as a change
// is green here, let this report the result in the background, and fix a red
// result forward. CI is a queue; nothing waits on it.
//
//   bun run ci:status                  HEAD, once
//   bun run ci:status -- --wait        until every run of the commit finishes
//   bun run ci:status -- <sha>         another commit (a prefix works)
//
// Needs an authenticated `gh`. It asks the repository `gh` resolves, which
// `gh repo set-default` pins to this repository in this clone (otherwise the
// `upstream` remote, the project this one forked from, would win).

import { spawnSync } from "node:child_process";

interface Run {
  databaseId: number;
  workflowName: string;
  status: string;
  conclusion: string | null;
  event: string;
}

interface Job {
  databaseId: number;
  name: string;
  status: string;
  conclusion: string | null;
}

const args = process.argv.slice(2);
const wait = args.includes("--wait");

function run(command: string, argv: string[]): string {
  const result = spawnSync(command, argv, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${argv.join(" ")}: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

const sha = run("git", [
  "rev-parse",
  args.find((arg) => !arg.startsWith("--")) ?? "HEAD",
]);
const subject = run("git", ["log", "-1", "--format=%s", sha]);
const repo = run("gh", [
  "repo",
  "view",
  "--json",
  "nameWithOwner",
  "--jq",
  ".nameWithOwner",
]);

function runs(): Run[] {
  return JSON.parse(
    run("gh", [
      "run",
      "list",
      "--commit",
      sha,
      "--limit",
      "50",
      "--json",
      "databaseId,workflowName,status,conclusion,event",
    ]),
  ) as Run[];
}

function jobs(id: number): Job[] {
  return (
    JSON.parse(run("gh", ["run", "view", String(id), "--json", "jobs"])) as {
      jobs: Job[];
    }
  ).jobs;
}

/** Lines that name a cause, most specific first; a log's first match wins. */
const CAUSES = [
  /failed to decode secret key/,
  /error\[E\d+\]: .*/,
  /CMake Error.*/,
  /CUDA Toolkit not found/,
  /Could NOT find \w+.*/,
  /ERROR: .*/,
  /panicked at .*/,
  /test result: FAILED.*/,
  /error: .*/,
  /##\[error\].+/,
];

/** The first line of a failed job's log that says why, without timestamps. */
function cause(job: Job): string {
  let log = "";
  try {
    // Logs carry ANSI colours, which `gh` refuses to print without the flag.
    log = run("gh", [
      "api",
      "--allow-escape-sequences",
      `repos/${repo}/actions/jobs/${job.databaseId}/logs`,
    ]);
  } catch {
    return "(log not available yet)";
  }
  // GitHub prints each step's script between `##[group]Run …` and
  // `##[endgroup]` before running it; a pattern found there is the script's
  // own text (an `echo "ERROR: …"`, a comment), not something that happened.
  let inScript = false;
  const lines = log
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\S+Z\s/, "").trim())
    .filter((line) => {
      if (line.startsWith("##[group]Run ")) inScript = true;
      else if (line.startsWith("##[endgroup]")) {
        inScript = false;
        return false;
      }
      return !inScript && !line.startsWith("#");
    });
  for (const pattern of CAUSES) {
    const hit = lines.find((line) => pattern.test(line));
    if (hit) {
      if (pattern.source.includes("secret key")) {
        return "update signing: the TAURI_SIGNING_PRIVATE_KEY secret is not set (the build itself succeeded)";
      }
      return hit.slice(0, 200);
    }
  }
  return "(no recognisable error line; open the run)";
}

const mark = (conclusion: string | null, status: string): string =>
  status !== "completed"
    ? "…"
    : conclusion === "success"
      ? "✓"
      : conclusion === "skipped" || conclusion === "cancelled"
        ? "-"
        : "✗";

function report(all: Run[]): void {
  console.log(`CI for ${sha.slice(0, 8)} ${subject}`);
  if (all.length === 0) console.log("  no runs (yet) for this commit");
  for (const item of all) {
    console.log(
      `  ${mark(item.conclusion, item.status)} ${item.workflowName} [${item.event}]: ${item.conclusion ?? item.status}`,
    );
    if (item.status !== "completed" || item.conclusion === "success") continue;
    for (const job of jobs(item.databaseId)) {
      const line = `      ${mark(job.conclusion, job.status)} ${job.name}`;
      console.log(
        job.conclusion === "failure"
          ? `${line}\n          ${cause(job)}`
          : line,
      );
    }
  }
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

let all = runs();
if (wait) {
  // A push takes a few seconds to become runs; then poll until all finish.
  for (let tries = 0; all.length === 0 && tries < 12; tries++) {
    await sleep(10_000);
    all = runs();
  }
  while (all.some((item) => item.status !== "completed")) {
    await sleep(30_000);
    all = runs();
  }
}
report(all);
const failed = all.some(
  (item) => item.status === "completed" && item.conclusion === "failure",
);
process.exit(failed ? 1 : 0);
