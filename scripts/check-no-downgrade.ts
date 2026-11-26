// scripts/check-no-downgrade.ts
//
// The pre-commit gate's "no dependency went backwards" step. Compares
// src-tauri/Cargo.lock and bun.lock in the working tree with the same files
// at HEAD and fails when any dependency is older than it was there (see
// `lib/lock-downgrades.ts` for what counts). Dependencies only move forward in
// this project: a downgrade found here is undone, not committed.
//
//   bun run check:no-downgrade

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  bunLockDowngrades,
  cargoLockDowngrades,
  type Downgrade,
  formatDowngrades,
} from "./lib/lock-downgrades";

const ROOT = resolve(import.meta.dirname, "..");
const TAG = "[no-downgrade]";

const LOCKS: {
  path: string;
  compare: (before: string, after: string) => Downgrade[];
}[] = [
  { path: "src-tauri/Cargo.lock", compare: cargoLockDowngrades },
  { path: "bun.lock", compare: bunLockDowngrades },
];

let failed = false;
for (const lock of LOCKS) {
  const head = spawnSync("git", ["show", `HEAD:${lock.path}`], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  // A lockfile HEAD does not have yet has nothing to be older than.
  if (head.status !== 0) continue;
  const now = readFileSync(resolve(ROOT, lock.path), "utf8");
  if (now.replace(/\r\n/g, "\n") === head.stdout.replace(/\r\n/g, "\n"))
    continue;
  const found = lock.compare(head.stdout, now);
  if (found.length === 0) continue;
  failed = true;
  console.error(
    `${TAG} ${lock.path} has ${found.length} ` +
      `${found.length === 1 ? "dependency" : "dependencies"} older than at HEAD:\n` +
      formatDowngrades(found),
  );
}

if (failed) {
  console.error(
    `${TAG} dependencies only move forward here. Restore the lockfile from ` +
      "HEAD (`git show HEAD:<path> > <path>`) and move only what you meant " +
      'to; for one git pin, edit its `source = "git+…#<commit>"` lines and ' +
      "build with `--locked` (docs/FORKS.md).",
  );
  process.exit(1);
}
console.log(`${TAG} no dependency is older than at HEAD`);
