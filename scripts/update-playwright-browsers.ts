// scripts/update-playwright-browsers.ts
//
// Installs the Chromium build the installed `@playwright/test` expects, so the
// browser harness (`bun run test:playwright`, playwright.config.ts: the one
// `chromium` project) works after a dependency update moved Playwright:
//
//   bun run update:browsers             install when missing
//   bun run update:browsers --dry-run   report only
//
// `bun run update` runs it right after the npm update, because every
// `@playwright/test` alpha can name a new browser revision and the harness then
// fails until that revision is on disk.
//
// The revision and the Chrome for Testing version come from the resolved
// `playwright-core/browsers.json`; the browsers live in
// `PLAYWRIGHT_BROWSERS_PATH` or the platform default (`%LOCALAPPDATA%\
// ms-playwright` on Windows). An installed revision has an
// `INSTALLATION_COMPLETE` marker in both `chromium-<rev>` and
// `chromium_headless_shell-<rev>`.
//
// The installer first, then a fallback on Windows. `playwright install` can
// hang on a machine whose IPv6 route is black-holed: its downloader resolves
// `cdn.playwright.dev` with `family: 6` first and waits on an AAAA address
// that never answers, which no Playwright setting changes. The fallback fetches
// the same two zips over IPv4 (`curl -4`) from the same CDN path Playwright
// builds (`builds/cft/<browserVersion>/win64/…`), unpacks them where Playwright
// looks and writes the marker. Older revisions are left for `playwright
// install`'s own cleanup.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const TAG = "[browsers]";
const DRY_RUN = process.argv.includes("--dry-run");
const REPO_ROOT = resolve(import.meta.dirname, "..");
const INSTALL_TIMEOUT_MS = 300_000;

interface BrowserEntry {
  name: string;
  revision: string;
  browserVersion?: string;
}

/** Folder prefix and Windows zip for each browser the chromium project uses. */
const WANTED: Record<string, { folder: string; zip: string }> = {
  chromium: { folder: "chromium", zip: "chrome-win64.zip" },
  "chromium-headless-shell": {
    folder: "chromium_headless_shell",
    zip: "chrome-headless-shell-win64.zip",
  },
};

function browsersRoot(): string {
  const custom = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (custom && custom !== "0") return custom;
  if (process.platform === "win32") {
    return join(
      process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
      "ms-playwright",
    );
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Caches", "ms-playwright");
  }
  return join(
    process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
    "ms-playwright",
  );
}

/** playwright-core as `@playwright/test` resolves it (bun's isolated layout). */
function browsersJson(): BrowserEntry[] {
  const testPkg = realpathSync(
    join(REPO_ROOT, "node_modules", "@playwright", "test", "package.json"),
  );
  const playwrightPkg = Bun.resolveSync(
    "playwright/package.json",
    dirname(testPkg),
  );
  const corePkg = Bun.resolveSync(
    "playwright-core/package.json",
    dirname(realpathSync(playwrightPkg)),
  );
  const json = JSON.parse(
    readFileSync(join(dirname(corePkg), "browsers.json"), "utf8"),
  ) as { browsers: BrowserEntry[] };
  return json.browsers.filter((b) => b.name in WANTED);
}

const installed = (root: string, b: BrowserEntry) =>
  existsSync(
    join(
      root,
      `${WANTED[b.name]!.folder}-${b.revision}`,
      "INSTALLATION_COMPLETE",
    ),
  );

function playwrightInstall(): boolean {
  const r = spawnSync("bun", ["x", "playwright", "install", "chromium"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    timeout: INSTALL_TIMEOUT_MS,
    shell: process.platform === "win32",
  });
  return r.status === 0;
}

/** The IPv4 fallback described in the header (Windows x64 only). */
function ipv4Install(root: string, missing: BrowserEntry[]): boolean {
  const work = mkdtempSync(join(tmpdir(), "pw-browsers-"));
  try {
    for (const b of missing) {
      const { folder, zip } = WANTED[b.name]!;
      if (!b.browserVersion) {
        console.error(`${TAG} ${b.name} has no browserVersion to download`);
        return false;
      }
      const url = `https://cdn.playwright.dev/builds/cft/${b.browserVersion}/win64/${zip}`;
      const archive = join(work, zip);
      console.log(`${TAG} curl -4 ${url}`);
      const dl = spawnSync(
        "curl",
        ["-4", "-L", "--fail", "--silent", "--show-error", "-o", archive, url],
        { stdio: "inherit", timeout: INSTALL_TIMEOUT_MS },
      );
      if (dl.status !== 0) return false;
      const dest = join(root, `${folder}-${b.revision}`);
      mkdirSync(dest, { recursive: true });
      // Windows 10+ ships bsdtar, which reads zip archives.
      const unpack = spawnSync("tar", ["-xf", archive, "-C", dest], {
        stdio: "inherit",
      });
      if (unpack.status !== 0) return false;
      writeFileSync(join(dest, "INSTALLATION_COMPLETE"), "");
    }
    return true;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const root = browsersRoot();
let wanted: BrowserEntry[];
try {
  wanted = browsersJson();
} catch (err) {
  console.error(
    `${TAG} cannot read playwright-core's browsers.json (${err instanceof Error ? err.message : String(err)}); is \`bun install\` done?`,
  );
  process.exit(1);
}

const missing = wanted.filter((b) => !installed(root, b));
const label = wanted.map((b) => `${b.name} r${b.revision}`).join(", ");
if (missing.length === 0) {
  console.log(`${TAG} current — ${label} in ${root}`);
  process.exit(0);
}
if (DRY_RUN) {
  console.log(
    `${TAG} would install ${missing.map((b) => `${b.name} r${b.revision}`).join(", ")} into ${root}`,
  );
  process.exit(0);
}

console.log(`${TAG} installing ${label} …`);
let ok = playwrightInstall() && missing.every((b) => installed(root, b));
if (!ok && process.platform === "win32" && process.arch === "x64") {
  console.log(`${TAG} playwright install failed; trying the IPv4 download`);
  ok = ipv4Install(
    root,
    missing.filter((b) => !installed(root, b)),
  );
}
console.log(
  ok ? `${TAG} installed ${label}` : `${TAG} FAILED to install ${label}`,
);
process.exit(ok ? 0 : 1);
