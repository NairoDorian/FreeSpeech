// scripts/update-all.ts
//
// Brings the toolchain and every dependency to its newest version, then proves
// the result still builds:
//
//   bun run update              toolchain + rtk + npm + Cargo + browsers, newest
//   bun run update --dry-run    report what would move, write nothing
//
// Run this before each release (the current version and the ones after it:
// patch, then minor, then 1.0.0) and whenever something has been pinned for a
// while. It is not part of the pre-commit hook: it reaches the network, it
// rewrites four lockfiles, and a dependency bump is a change that deserves its
// own commit with its own message.
//
// What it moves, in order:
//
//   1. The toolchain (`update-toolchain.ts`): rustup and every channel Rust
//      toolchain, bun on its canary channel, and the cargo-installed developer
//      tools, sccache included (a stale sccache broke the build on cargo 1.100;
//      that script's header has the story).
//   2. rtk (`update-rtk.ts`), the command proxy the maintainer's agent hook
//      routes every shell command through. Rebuilt only when a newer tag exists.
//   3. Every npm and Cargo dependency (`update-deps.ts`), with its validation:
//      `tsc -b` → `vite build` → `cargo check`.
//   4. The Playwright browser the updated `@playwright/test` expects
//      (`update-playwright-browsers.ts`).
//   5. The repomix pack, last, so it describes the tree the update produced.
//
// Toolchain first: every later step runs on it, so the dependency validation
// proves the new lockfiles against the compiler that will build them.
//
// **`--prerelease` is always passed to the dependency updater.** Newest-first
// is the point of running this at all: a pre-release that is newer than the
// stable tag is exactly the version this project wants to be testing, because
// a problem found here is a problem found before the stable release rather
// than after. The updater still refuses anything its validation steps reject
// (`tsc -b` → `vite build` → `cargo check`), so "newest" cannot mean "broken".
//
// Failure policy: the dependency update stops the run, because nothing after it
// means anything once the lockfiles did not build. The toolchain, rtk and the
// browsers do not: a registry that is down or an exe Windows will not replace
// is reported in the summary, the rest still runs, and the exit code is 1.

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const TAG = "[update]";
const dryRun = process.argv.includes("--dry-run");

interface Step {
  label: string;
  /** Arguments to `bun`. */
  argv: string[];
  /**
   * Arguments for a dry run, which must report and write nothing. A step
   * without them is skipped in a dry run: it installs a binary or writes a
   * generated file with no report-only form. The pack is the second kind —
   * regenerating it would be a write, and would also silently satisfy
   * `repomix:check` afterwards, which is exactly what a dry run must not do.
   */
  dryArgv?: string[];
  /** Reported in the summary instead of stopping the run. */
  continueOnFailure?: boolean;
}

const STEPS: Step[] = [
  {
    label: "toolchain (rustup, Rust, bun canary, cargo tools) → newest",
    argv: ["scripts/update-toolchain.ts"],
    dryArgv: ["scripts/update-toolchain.ts", "--dry-run"],
    continueOnFailure: true,
  },
  {
    label: "rtk → latest tag",
    argv: ["scripts/update-rtk.ts"],
    dryArgv: ["scripts/update-rtk.ts", "--check"],
    continueOnFailure: true,
  },
  {
    label: "npm + Cargo → newest (prerelease allowed)",
    argv: ["run", "update-deps", "--", "--prerelease"],
    dryArgv: ["run", "update-deps", "--", "--prerelease", "--dry-run"],
  },
  {
    label: "Playwright browsers for the installed @playwright/test",
    argv: ["scripts/update-playwright-browsers.ts"],
    dryArgv: ["scripts/update-playwright-browsers.ts", "--dry-run"],
    continueOnFailure: true,
  },
  {
    label: "repomix pack",
    argv: ["run", "repomix"],
  },
];

console.log(
  dryRun
    ? `${TAG} dry run — no tool, manifest, lockfile or generated file is written`
    : `${TAG} updating the toolchain, rtk and every dependency to the newest versions`,
);

const softFailures: string[] = [];
for (const step of STEPS) {
  const argv = dryRun ? step.dryArgv : step.argv;
  if (!argv) {
    console.log(`${TAG} ${step.label} — skipped in a dry run`);
    continue;
  }
  const started = Date.now();
  process.stdout.write(`${TAG} ${step.label} …\n`);
  const result = spawnSync("bun", argv, {
    cwd: REPO_ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  const took = `${Date.now() - started} ms`;
  if (result.status === 0) {
    console.log(`${TAG} ${step.label} ok (${took})`);
    continue;
  }
  if (step.continueOnFailure) {
    console.error(`${TAG} ${step.label} FAILED after ${took}; continuing`);
    softFailures.push(step.label);
    continue;
  }
  console.error(`${TAG} ${step.label} FAILED after ${took}`);
  process.exit(1);
}

if (softFailures.length > 0) {
  console.error(
    `${TAG} done with failures — rerun after fixing: ${softFailures.join("; ")}`,
  );
  process.exit(1);
}
console.log(
  `${TAG} done. Review the lockfile diff, then run \`bun run precommit:full\`.`,
);
