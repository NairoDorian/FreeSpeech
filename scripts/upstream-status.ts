// scripts/upstream-status.ts
//
// What the projects FreeSpeech learns from have landed that it has not
// reviewed yet. This replaced GitHub's "N commits behind" fork banner when the
// project left the S2B2S fork for its own repository (2026-11-26), and it
// covers what that banner never could:
//
//   Handy      commits on cjpais/Handy `main` that HEAD does not contain. Every
//              upstream intake ends with `git merge -s ours <commit>`, so this
//              is exactly the list the banner counted.
//   AIVORelay  MaxITService/AIVORelay's own commits (Handy's excluded) since
//              the commit recorded as reviewed in `docs/upstream-watch.json`.
//              A fork banner only ever compares against its one parent.
//   waiting    the upstream changes a fork of ours waits for: pull requests,
//              a release after a given tag, a commit reaching a branch
//              (`docs/FORKS.md` says why each one matters).
//
//   bun run upstream:status                       the report, as text
//   bun run upstream:status -- --markdown         as Markdown: the body of the
//                                                 issue the weekly workflow
//                                                 keeps (upstream-watch.yml)
//   bun run upstream:status -- --reviewed aivorelay
//                                                 record AIVORelay's current
//                                                 tip as reviewed
//
// Cost: two incremental `git fetch`es (both remotes share this history) and,
// when `gh` is available, one GitHub API call per watched item. It never runs
// on its own; the workflow runs it once a week.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const CONFIG_FILE = "docs/upstream-watch.json";

interface Remote {
  remote: string;
  url: string;
  branch: string;
}

interface Config {
  handy: Remote;
  aivorelay: Remote & { reviewed: string; reviewedOn: string };
  watch: {
    pulls: { repo: string; number: number; why: string }[];
    releasesAfter: { repo: string; tag: string; why: string }[];
    commitsOnBranch: {
      repo: string;
      branch: string;
      commit: string;
      why: string;
    }[];
  };
}

interface Commit {
  hash: string;
  date: string;
  subject: string;
}

const markdown = process.argv.includes("--markdown");
const reviewedIndex = process.argv.indexOf("--reviewed");
const config = JSON.parse(
  readFileSync(resolve(ROOT, CONFIG_FILE), "utf8"),
) as Config;

function git(args: string[], allowFailure = false): string {
  const result = spawnSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status === 0) return result.stdout.trim();
  if (allowFailure) return "";
  throw new Error(`git ${args.join(" ")}: ${result.stderr.trim()}`);
}

/** Fetch one branch of a remote, adding the remote first if this clone lacks it. */
function fetched({ remote, url, branch }: Remote): string {
  if (!git(["remote", "get-url", remote], true)) {
    git(["remote", "add", remote, url]);
  }
  git([
    "fetch",
    "--quiet",
    "--no-tags",
    remote,
    `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`,
  ]);
  return `${remote}/${branch}`;
}

function commits(range: string[]): Commit[] {
  const out = git([
    "log",
    "--no-merges",
    "--format=%H%x09%ad%x09%s",
    "--date=short",
    ...range,
  ]);
  if (!out) return [];
  return out.split("\n").map((line) => {
    const [hash = "", date = "", ...subject] = line.split("\t");
    return { hash, date, subject: subject.join("\t") };
  });
}

/** `owner/name` of a GitHub clone URL. */
const slugOf = (url: string): string =>
  url.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");

/**
 * A GitHub API GET through `gh`, or undefined when `gh` is missing or fails.
 * `jq` narrows the answer on gh's side: a compare of two far-apart branches
 * returns megabytes of commits and files when only its `status` is wanted.
 */
function gh(path: string, jq?: string): unknown {
  const args = ["api", path, ...(jq ? ["--jq", jq] : [])];
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) return undefined;
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    return result.stdout.trim() || undefined;
  }
}

if (reviewedIndex !== -1) {
  const which = process.argv[reviewedIndex + 1];
  if (which !== "aivorelay") {
    console.error("usage: --reviewed aivorelay");
    process.exit(2);
  }
  const tip = git(["rev-parse", fetched(config.aivorelay)]);
  config.aivorelay.reviewed = tip;
  config.aivorelay.reviewedOn = new Date().toISOString().slice(0, 10);
  writeFileSync(
    resolve(ROOT, CONFIG_FILE),
    `${JSON.stringify(config, null, 2)}\n`,
  );
  console.log(
    `AIVORelay reviewed up to ${tip.slice(0, 8)}; commit ${CONFIG_FILE}.`,
  );
  process.exit(0);
}

// --- what landed ------------------------------------------------------------

const handyRef = fetched(config.handy);
const handySlug = slugOf(config.handy.url);
const handyBase = git(["merge-base", "HEAD", handyRef]);
const handy = commits([`HEAD..${handyRef}`]);

const aivoRef = fetched(config.aivorelay);
const aivoSlug = slugOf(config.aivorelay.url);
const reviewed = config.aivorelay.reviewed;
const aivoKnown = git(["cat-file", "-t", reviewed], true) === "commit";
const aivo = aivoKnown
  ? commits([`${reviewed}..${aivoRef}`, `^${handyRef}`])
  : [];

// --- what a fork of ours waits for -------------------------------------------

interface Waiting {
  label: string;
  url: string;
  state: string;
  done: boolean;
  why: string;
}

const UNKNOWN = "unknown (gh unavailable)";
const waiting: Waiting[] = [];

for (const pull of config.watch.pulls) {
  const data = gh(`repos/${pull.repo}/pulls/${pull.number}`) as
    | { state: string; merged_at: string | null }
    | undefined;
  const state = !data
    ? UNKNOWN
    : data.merged_at
      ? `merged ${data.merged_at.slice(0, 10)}`
      : data.state;
  waiting.push({
    label: `${pull.repo}#${pull.number}`,
    url: `https://github.com/${pull.repo}/pull/${pull.number}`,
    state,
    done: Boolean(data?.merged_at),
    why: pull.why,
  });
}

for (const release of config.watch.releasesAfter) {
  const data = gh(`repos/${release.repo}/releases?per_page=10`) as
    | { tag_name: string }[]
    | undefined;
  // Newest first: everything listed before the known tag is newer than it.
  const known = data?.findIndex((item) => item.tag_name === release.tag) ?? -1;
  const newer = data ? (known === -1 ? data : data.slice(0, known)) : undefined;
  waiting.push({
    label: `${release.repo} release after ${release.tag}`,
    url: `https://github.com/${release.repo}/releases`,
    state: !newer
      ? UNKNOWN
      : newer.length
        ? newer.map((item) => item.tag_name).join(", ")
        : "none yet",
    done: Boolean(newer?.length),
    why: release.why,
  });
}

for (const watched of config.watch.commitsOnBranch) {
  // `ahead` or `identical`: the branch contains the commit.
  const status = gh(
    `repos/${watched.repo}/compare/${watched.commit}...${watched.branch}`,
    ".status",
  ) as string | undefined;
  const contained = status === "ahead" || status === "identical";
  waiting.push({
    label: `${watched.repo} ${watched.branch} has ${watched.commit.slice(0, 8)}`,
    url: `https://github.com/${watched.repo}/commits/${watched.branch}`,
    state: !status ? UNKNOWN : contained ? "yes" : "not yet",
    done: contained,
    why: watched.why,
  });
}

// --- the report -------------------------------------------------------------

const today = new Date().toISOString().slice(0, 10);
const handyCompare = `https://github.com/${handySlug}/compare/${handyBase.slice(0, 12)}...${config.handy.branch}`;
const aivoCompare = `https://github.com/${aivoSlug}/compare/${reviewed.slice(0, 12)}...${config.aivorelay.branch}`;
const aivoHead = aivoKnown
  ? `${aivo.length} of its own commits since the review of ${config.aivorelay.reviewedOn} (${reviewed.slice(0, 8)})`
  : `the reviewed commit ${reviewed.slice(0, 8)} is not in ${aivoRef}; set a new one with --reviewed aivorelay`;

function listed(items: Commit[], limit: number, link: (c: Commit) => string) {
  const shown = items.slice(0, limit).map(link);
  if (items.length > limit) shown.push(`… and ${items.length - limit} more`);
  return shown;
}

if (markdown) {
  const summary = [
    `Handy ${handy.length}`,
    `AIVORelay ${aivo.length}`,
    ...waiting.map((item) => `${item.label}: ${item.state}`),
  ].join(" · ");
  const lines = [
    `<!-- upstream-watch: ${summary} -->`,
    `Updated ${today} by \`bun run upstream:status\` (weekly, \`.github/workflows/upstream-watch.yml\`).`,
    "",
    `## Handy — ${handy.length} commit${handy.length === 1 ? "" : "s"} not reviewed`,
    "",
    ...listed(
      handy,
      50,
      (c) =>
        `- ${c.date} [\`${c.hash.slice(0, 8)}\`](https://github.com/${handySlug}/commit/${c.hash}) ${c.subject}`,
    ),
    "",
    `[Compare on GitHub](${handyCompare}). Review each one, port what improves FreeSpeech, add a ledger row, then \`git merge -s ours <last commit>\`.`,
    "",
    `## AIVORelay — ${aivoHead}`,
    "",
    ...listed(
      aivo,
      50,
      (c) =>
        `- ${c.date} [\`${c.hash.slice(0, 8)}\`](https://github.com/${aivoSlug}/commit/${c.hash}) ${c.subject}`,
    ),
    "",
    `[Compare on GitHub](${aivoCompare}). After a review: \`bun run upstream:status -- --reviewed aivorelay\` and commit \`${CONFIG_FILE}\`.`,
    "",
    "## Waiting on",
    "",
    ...waiting.map(
      (item) =>
        `- [${item.done ? "x" : " "}] [${item.label}](${item.url}): **${item.state}** — ${item.why}`,
    ),
  ];
  console.log(lines.join("\n"));
} else {
  const lines = [
    `Upstream status, ${today}`,
    "",
    `Handy (${handySlug} ${config.handy.branch}): ${handy.length} commit(s) not reviewed`,
    ...listed(
      handy,
      20,
      (c) => `  ${c.date} ${c.hash.slice(0, 8)} ${c.subject}`,
    ),
    `  ${handyCompare}`,
    "",
    `AIVORelay (${aivoSlug} ${config.aivorelay.branch}): ${aivoHead}`,
    ...listed(
      aivo,
      20,
      (c) => `  ${c.date} ${c.hash.slice(0, 8)} ${c.subject}`,
    ),
    `  ${aivoCompare}`,
    "",
    "Waiting on:",
    ...waiting.map(
      (item) =>
        `  ${item.done ? "✓" : "·"} ${item.label}: ${item.state} — ${item.why}`,
    ),
  ];
  console.log(lines.join("\n"));
}
