// scripts/update-toolchain.ts
//
// Brings the machine's build toolchain to its newest version: the tools every
// later step of `bun run update` runs on.
//
//   bun run update:toolchain             update everything below
//   bun run update:toolchain --dry-run   report what would move, change nothing
//
// 1. **Rust**: rustup itself and every installed channel toolchain
//    (`rustup update`: stable, nightly, beta, with their components and
//    targets). Dated toolchains (`nightly-2026-11-21`, `1.91.1`) are fixed by
//    definition and left alone, and the default toolchain stays whatever the
//    user set with `rustup default`.
// 2. **Bun**, on the canary channel (`bun upgrade --canary`): the same line as
//    the `bun-types` canary in package.json, and "newest" here means newest
//    published, prereleases included, like every other dependency.
// 3. **Cargo-installed developer tools**: every crates.io entry of
//    `cargo install --list` (cargo-binstall, cargo-update, cargo-edit, …) plus
//    sccache however it was installed, moved to crates.io's newest stable
//    through cargo-binstall's prebuilt binaries (or `cargo install --locked`
//    when binstall is missing). Git installs are skipped: rtk, the only one, has
//    its own script (`update-rtk.ts`), run right after this one.
//
// sccache is why step 3 exists. It wraps every rustc this project's scripts
// run (`lib/compiler-cache.ts`), so a stale one breaks the build rather than
// slowing it: cargo 1.100 moved to the per-unit build-dir layout, which hands
// rustc one `-L dependency=` per dependency (231 for `tauri`, a 33.7K-character
// command line), and sccache before 0.20.0 re-spawned rustc with that line
// expanded instead of through a response file, so Windows refused it with
// os error 206. Nothing updated sccache until this script did.
//
// Every step runs even when an earlier one fails (a registry that is down must
// not stop rustup), and the summary at the end lists what moved, what was
// already current and what failed; the exit code is 1 when anything failed.
//
// Cost: one `rustup check`, one `bun --revision`, one `cargo install --list`
// and one crates.io request per installed tool, then only the installs that
// are actually needed. Nothing here touches the repository.

import { spawnSync } from "node:child_process";

import { APP } from "./app-meta";
import { findCompilerCacheDynamically } from "./lib/compiler-cache";

const TAG = "[toolchain]";
const DRY_RUN = process.argv.includes("--dry-run");
const USER_AGENT = `${APP.slug}-toolchain-updater`;
const QUERY_TIMEOUT_MS = 15_000;

type Status = "updated" | "current" | "would-update" | "failed";
interface Outcome {
  step: string;
  status: Status;
  detail: string;
}
const outcomes: Outcome[] = [];
const record = (step: string, status: Status, detail: string) => {
  outcomes.push({ step, status, detail });
  console.log(`${TAG} ${step}: ${status} — ${detail}`);
};

interface RunResult {
  ok: boolean;
  out: string;
  missing: boolean;
}

/**
 * Runs a command without a shell (every tool here is a real `.exe` on Windows,
 * which libuv finds on PATH by itself, so no argument is ever re-quoted).
 * `capture` returns its output instead of streaming it.
 */
function run(cmd: string, args: string[], capture = false): RunResult {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  const missing =
    (r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
  return {
    ok: r.status === 0,
    out: `${r.stdout ?? ""}${r.stderr ?? ""}`,
    missing,
  };
}

/** `1.2.3` style versions only (build metadata dropped); null otherwise. */
function parseVersion(v: string): number[] | null {
  const core = v.trim().replace(/^v/, "").split(/[+-]/)[0] ?? "";
  const parts = core.split(".").map(Number);
  return parts.length >= 2 && parts.every(Number.isInteger) ? parts : null;
}

function isNewer(candidate: string, installed: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(installed);
  if (!a || !b) return candidate !== installed;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

// --- 1. Rust ------------------------------------------------------------------

function updateRust(): void {
  const check = run("rustup", ["check"], true);
  if (check.missing) {
    record("rust", "failed", "rustup is not on PATH");
    return;
  }
  const lines = check.out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => / - /.test(l));
  for (const line of lines) console.log(`${TAG}   ${line}`);
  const pending = lines.filter((l) => /update available/i.test(l));
  const understood = lines.some((l) => /up to date|update available/i.test(l));
  const active = run("rustup", ["show", "active-toolchain"], true).out.trim();
  if (active) console.log(`${TAG}   default: ${active}`);

  if (understood && pending.length === 0) {
    record("rust", "current", "rustup and every channel toolchain");
    return;
  }
  if (DRY_RUN) {
    record(
      "rust",
      "would-update",
      understood
        ? pending.map((l) => l.split(" - ")[0]).join(", ")
        : "`rustup check` gave no answer; the real run calls `rustup update`",
    );
    return;
  }
  // Updates rustup itself too (its `auto-self-update` default), then every
  // channel toolchain. A toolchain in use by a running cargo can fail to be
  // replaced on Windows: the summary then says so, and a rerun finishes it.
  const update = run("rustup", ["update"]);
  record(
    "rust",
    update.ok ? "updated" : "failed",
    update.ok
      ? pending.map((l) => l.split(" - ")[0]).join(", ") || "rustup update ran"
      : "`rustup update` failed (is a cargo build holding the toolchain?)",
  );
}

// --- 2. Bun -------------------------------------------------------------------

/** The commit the published canary build was made from, read from its name. */
async function latestBunCanaryCommit(): Promise<string | null> {
  try {
    const res = await fetch(
      "https://api.github.com/repos/oven-sh/bun/releases/tags/canary",
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": USER_AGENT,
        },
        signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
      },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { name?: string };
    return /\(([0-9a-f]{7,40})\)/.exec(body.name ?? "")?.[1] ?? null;
  } catch {
    return null;
  }
}

async function updateBun(): Promise<void> {
  const before = run("bun", ["--revision"], true).out.trim();
  const commit = await latestBunCanaryCommit();
  const localCommit = before.split("+")[1] ?? "";
  const known =
    commit !== null && localCommit !== "" && commit.startsWith(localCommit);
  console.log(
    `${TAG}   bun ${before}${commit ? `; newest canary build: ${commit.slice(0, 9)}` : ""}`,
  );
  if (DRY_RUN) {
    record(
      "bun",
      known ? "current" : "would-update",
      known
        ? `${before} is the newest canary`
        : "`bun upgrade --canary` decides on the real run",
    );
    return;
  }
  // `bun upgrade` replaces its own running executable, so the bun running this
  // script holding the same image is no obstacle; later steps spawn the new one.
  const upgrade = run("bun", ["upgrade", "--canary"]);
  const after = run("bun", ["--revision"], true).out.trim();
  if (!upgrade.ok) {
    record("bun", "failed", "`bun upgrade --canary` failed");
  } else {
    record(
      "bun",
      after !== before ? "updated" : "current",
      after !== before ? `${before} → ${after}` : `${after} (newest canary)`,
    );
  }
}

// --- 3. Cargo-installed tools -------------------------------------------------

/** Registry installs from `cargo install --list` (`name vX.Y.Z:` lines). */
function installedCargoTools(): Map<string, string> {
  const tools = new Map<string, string>();
  const list = run("cargo", ["install", "--list"], true);
  for (const line of list.out.split(/\r?\n/)) {
    // A git or path install carries its source in parentheses and is skipped.
    const m = /^(\S+) v(\S+):$/.exec(line);
    if (m?.[1] && m[2]) tools.set(m[1], m[2]);
  }
  // sccache downloaded by hand is not in cargo's list, and is still the
  // RUSTC_WRAPPER every build script here uses.
  const cache = findCompilerCacheDynamically();
  if (cache && /sccache/i.test(cache) && !tools.has("sccache")) {
    const v = /sccache (\S+)/.exec(run(cache, ["--version"], true).out)?.[1];
    if (v) tools.set("sccache", v);
  }
  return tools;
}

async function latestStableCrate(name: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://crates.io/api/v1/crates/${encodeURIComponent(name)}`,
      {
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
      },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as {
      crate?: { max_stable_version?: string | null };
    };
    return body.crate?.max_stable_version ?? null;
  } catch {
    return null;
  }
}

function installCrate(name: string, version: string, binstall: boolean) {
  if (name === "sccache") {
    // A running server holds sccache.exe open, and Windows will not replace
    // it. The next build starts the new server on demand.
    run("sccache", ["--stop-server"], true);
  }
  const spec = `${name}@${version}`;
  return binstall
    ? run("cargo", ["binstall", "-y", "--disable-telemetry", spec])
    : run("cargo", ["install", "--locked", spec]);
}

async function updateCargoTools(): Promise<void> {
  const tools = installedCargoTools();
  if (tools.size === 0) {
    record("cargo tools", "current", "none installed from crates.io");
    return;
  }
  const latest = await Promise.all(
    [...tools.keys()].map(
      async (n) => [n, await latestStableCrate(n)] as const,
    ),
  );
  const outdated: [string, string, string][] = [];
  for (const [name, newest] of latest) {
    const installed = tools.get(name) ?? "";
    if (newest === null) {
      record(
        `cargo ${name}`,
        "failed",
        `crates.io did not answer (${installed})`,
      );
    } else if (isNewer(newest, installed)) {
      outdated.push([name, installed, newest]);
    } else {
      console.log(`${TAG}   ${name} ${installed} is current`);
    }
  }
  if (outdated.length === 0) {
    record("cargo tools", "current", [...tools.keys()].join(", "));
    return;
  }
  if (DRY_RUN) {
    for (const [name, from, to] of outdated) {
      record(`cargo ${name}`, "would-update", `${from} → ${to}`);
    }
    return;
  }
  const binstall = tools.has("cargo-binstall");
  // cargo-binstall last, so it is never replaced while it installs the rest.
  outdated.sort(
    ([a], [b]) =>
      Number(a === "cargo-binstall") - Number(b === "cargo-binstall"),
  );
  for (const [name, from, to] of outdated) {
    const r = installCrate(name, to, binstall);
    record(
      `cargo ${name}`,
      r.ok ? "updated" : "failed",
      r.ok ? `${from} → ${to}` : `could not install ${to} (still ${from})`,
    );
  }
}

// --- main ---------------------------------------------------------------------

console.log(
  DRY_RUN
    ? `${TAG} dry run — nothing is installed`
    : `${TAG} rustup + Rust toolchains, bun canary, cargo tools → newest`,
);
updateRust();
await updateBun();
await updateCargoTools();

const failed = outcomes.filter((o) => o.status === "failed");
const moved = outcomes.filter(
  (o) => o.status === "updated" || o.status === "would-update",
);
console.log(
  `${TAG} summary: ${moved.length} ${DRY_RUN ? "would move" : "moved"}, ` +
    `${outcomes.filter((o) => o.status === "current").length} current, ` +
    `${failed.length} failed`,
);
for (const o of failed) console.log(`${TAG}   FAILED ${o.step}: ${o.detail}`);
process.exit(failed.length > 0 ? 1 : 0);
