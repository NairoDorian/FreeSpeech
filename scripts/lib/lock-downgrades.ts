// scripts/lib/lock-downgrades.ts
//
// Finds dependencies that went backwards between two versions of a lockfile.
//
// This project only moves dependencies forward. A downgrade inside a lockfile
// diff undoes that without anyone deciding it, and it is easy to miss: on
// 2026-11-26 `cargo update -p tauri-specta`, run to move a git pin forward,
// also moved 21 Cargo.lock edges back (`windows-sys` 0.61.2 → 0.59 / 0.60 on
// crates whose range admits several, `iana-time-zone`'s `windows-core` 0.62.2
// → 0.58.0) while every package's own version stayed where it was. A
// Cargo.lock is therefore checked at two levels:
//
// - a crate whose newest locked version is lower than before, and
// - a package present in both files (same name, version and source) whose
//   dependency on a crate now resolves to a lower version.
//
// A bun.lock is checked at the first level, the newest version of each
// package. Versions that are not semver (a git commit, a workspace) are not
// compared, so moving a git pin forward never counts as a downgrade.
//
// Used by the pre-commit gate (`scripts/check-no-downgrade.ts`: HEAD against
// the working tree) and by `scripts/check-transcribe-deps.ts` (the lock before
// and after it moves a git pin).

export interface Downgrade {
  /** The package, or `parent version → dependency` for a dependency edge. */
  what: string;
  from: string;
  to: string;
}

const SEMVER = /^\d+\.\d+\.\d+/;

/** Semver precedence (a prerelease sorts below its release): -1, 0 or 1. */
const order = (a: string, b: string): number => Bun.semver.order(a, b);

/** The newest semver version per name. */
function newestByName(
  entries: Iterable<readonly [string, string]>,
): Map<string, string> {
  const newest = new Map<string, string>();
  for (const [name, version] of entries) {
    if (!SEMVER.test(version)) continue;
    const seen = newest.get(name);
    if (seen === undefined || order(version, seen) > 0)
      newest.set(name, version);
  }
  return newest;
}

function lowered(
  before: Map<string, string>,
  after: Map<string, string>,
  label: (name: string) => string = (name) => name,
): Downgrade[] {
  const found: Downgrade[] = [];
  for (const [name, from] of before) {
    const to = after.get(name);
    if (to !== undefined && order(to, from) < 0)
      found.push({ what: label(name), from, to });
  }
  return found;
}

interface CargoPackage {
  name: string;
  version: string;
  source: string;
  /** As written: `name`, `name version` or `name version (source)`. */
  dependencies: string[];
}

/** The `[[package]]` entries; `[[patch.unused]]` is not what the build uses. */
function cargoPackages(lock: string): CargoPackage[] {
  const packages: CargoPackage[] = [];
  for (const block of lock.split(/\r?\n(?=\[\[)/)) {
    if (!block.startsWith("[[package]]")) continue;
    const field = (key: string): string =>
      block.match(new RegExp(`^${key} = "([^"]*)"`, "m"))?.[1] ?? "";
    const list = block.match(/^dependencies = \[([^\]]*)\]/m)?.[1] ?? "";
    packages.push({
      name: field("name"),
      version: field("version"),
      source: field("source"),
      dependencies: [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? ""),
    });
  }
  return packages;
}

/**
 * The version each dependency of `pkg` resolves to. Cargo writes a bare name
 * when the lock holds one version of that crate, and `name version` when it
 * holds several, so a bare name is looked up in `versions`.
 */
function dependencyVersions(
  pkg: CargoPackage,
  versions: Map<string, string[]>,
): Map<string, string> {
  return newestByName(
    pkg.dependencies.flatMap((entry): [string, string][] => {
      const [name = "", stated] = entry.split(" ");
      const only = versions.get(name);
      const version = stated ?? (only?.length === 1 ? only[0] : undefined);
      return version === undefined ? [] : [[name, version]];
    }),
  );
}

export function cargoLockDowngrades(
  before: string,
  after: string,
): Downgrade[] {
  const old = cargoPackages(before);
  const now = cargoPackages(after);
  const found = lowered(
    newestByName(old.map((p) => [p.name, p.version] as const)),
    newestByName(now.map((p) => [p.name, p.version] as const)),
  );
  const versionsOf = (packages: CargoPackage[]): Map<string, string[]> => {
    const versions = new Map<string, string[]>();
    for (const p of packages)
      versions.set(p.name, [...(versions.get(p.name) ?? []), p.version]);
    return versions;
  };
  const oldVersions = versionsOf(old);
  const nowVersions = versionsOf(now);
  const key = (p: CargoPackage): string => `${p.name} ${p.version} ${p.source}`;
  const nowByKey = new Map(now.map((p) => [key(p), p]));
  for (const p of old) {
    const same = nowByKey.get(key(p));
    if (same === undefined) continue;
    found.push(
      ...lowered(
        dependencyVersions(p, oldVersions),
        dependencyVersions(same, nowVersions),
        (dep) => `${p.name} ${p.version} → ${dep}`,
      ),
    );
  }
  return found;
}

/** bun.lock is JSON with trailing commas; its packages map name → [spec, …]. */
function bunNewest(lock: string): Map<string, string> {
  const parsed = JSON.parse(lock.replace(/,(\s*[}\]])/g, "$1")) as {
    packages?: Record<string, unknown>;
  };
  const specs: [string, string][] = [];
  for (const entry of Object.values(parsed.packages ?? {})) {
    const spec: unknown = Array.isArray(entry) ? entry[0] : undefined;
    if (typeof spec !== "string") continue;
    // `name@version`, `@scope/name@version`: the version follows the last `@`.
    const at = spec.lastIndexOf("@");
    if (at > 0) specs.push([spec.slice(0, at), spec.slice(at + 1)]);
  }
  return newestByName(specs);
}

export function bunLockDowngrades(before: string, after: string): Downgrade[] {
  return lowered(bunNewest(before), bunNewest(after));
}

export function formatDowngrades(found: readonly Downgrade[]): string {
  return found.map((d) => `  ${d.what}: ${d.from} → ${d.to}`).join("\n");
}
