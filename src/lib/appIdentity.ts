// GENERATED FILE — DO NOT EDIT.
//
// Source: `scripts/app-meta.ts` — run `bun run meta:sync` to regenerate.
//
// Do not hardcode the application's name, slug, identifier, repository or
// storage prefix anywhere else under `src/`. Import from here instead.

/** Product name, for anything the user sees. */
export const APP_NAME = "FreeSpeech";

/** Machine slug. Never shown to the user. */
export const APP_SLUG = "freespeech";

/** `localStorage` key prefix for view-only UI preferences. */
export const STORAGE_PREFIX = "freespeech.";

/** Former identities' machine slugs, newest first: basenames they wrote. */
export const LEGACY_SLUGS = ["zer0", "handy"] as const;

/** Bundle identifier — the OS-level application identity. */
export const APP_IDENTIFIER = "com.nairodorian.freespeech";

/** Repository URL, for links out of the app. */
export const REPO_URL = "https://github.com/NairoDorian/FreeSpeech";

/** Releases page — where an update or a portable installer link points. */
export const RELEASES_URL =
  "https://github.com/NairoDorian/FreeSpeech/releases/latest";

/**
 * The product-name folder leaf a platform may use (kept for the migration's
 * symmetry); the app-data folder itself is named after the identifier.
 */
export const DATA_DIR_NAME = "FreeSpeech";

/** Folder names former installs used, newest first; read by the migration. */
export const LEGACY_DATA_DIR_NAMES = ["ZER0", "Handy"] as const;

/** Bundle identifiers former releases used, newest first. */
export const LEGACY_IDENTIFIERS = [
  "com.nairodorian.zer0",
  "com.pais.handy",
] as const;

/** Prefix of every environment flag the backend reads. Shown in Settings. */
export const ENV_PREFIX = "FREESPEECH_";

/** Former environment-flag prefixes, still honoured by the backend. */
export const LEGACY_ENV_PREFIXES = ["ZER0_", "HANDY_"] as const;

/** Magic string in the `portable` marker beside the executable. */
export const PORTABLE_MARKER = "FreeSpeech Portable Mode";

/** The markers former releases wrote, newest first. */
export const LEGACY_PORTABLE_MARKERS = [
  "ZER0 Portable Mode",
  "Handy Portable Mode",
] as const;

/** Former `localStorage` prefixes, newest first, migrated on first read. */
export const LEGACY_STORAGE_PREFIXES = ["zer0.", "handy."] as const;

/**
 * File-name infix that marks a recording as a Multi-STT one.
 *
 * Mirrors `app_identity::multi_recording_file_name`: a history row records
 * the file name the recorder wrote, so the UI has to recognise the same shape
 * the backend produced.
 */
export const MULTI_RECORDING_INFIX = "-multi-";

/**
 * Whether a history row's WAV belongs to a Multi-STT recording.
 *
 * Every basename the app has written is accepted. History is a database of
 * recordings the user still has on disk, and rows written under a former name
 * point at `<former slug>-multi-…` files that were never moved — judging them
 * by the current basename alone would silently reclassify every one of them as
 * a plain transcription.
 */
export function isMultiRecordingFileName(fileName: string): boolean {
  return [APP_SLUG, ...LEGACY_SLUGS].some((slug) =>
    fileName.startsWith(slug + MULTI_RECORDING_INFIX),
  );
}

/**
 * Read a UI preference, falling back to the keys former releases wrote.
 *
 * A former value is re-written under the current prefix and every former key
 * removed, so the migration happens once per key per browser profile and never
 * runs again. Both the read and every write are guarded: `localStorage` throws
 * outright in a locked-down webview, and a preference is never worth a crash.
 *
 * @param key suffix after `STORAGE_PREFIX`, e.g. `"theme"` or `"sidebar.width"`
 */
export function readPref(key: string): string | null {
  try {
    const current = localStorage.getItem(STORAGE_PREFIX + key);
    if (current !== null) return current;
    for (const prefix of LEGACY_STORAGE_PREFIXES) {
      const former = localStorage.getItem(prefix + key);
      if (former === null) continue;
      localStorage.setItem(STORAGE_PREFIX + key, former);
      for (const old of LEGACY_STORAGE_PREFIXES) {
        localStorage.removeItem(old + key);
      }
      return former;
    }
    return null;
  } catch {
    return null;
  }
}

/** Write a UI preference, ignoring a storage that refuses to accept it. */
export function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + key, value);
  } catch {
    // A preference is a convenience; a webview with storage disabled still runs.
  }
}

/** Remove a UI preference, under the current and every former prefix. */
export function removePref(key: string): void {
  try {
    localStorage.removeItem(STORAGE_PREFIX + key);
    for (const prefix of LEGACY_STORAGE_PREFIXES) {
      localStorage.removeItem(prefix + key);
    }
  } catch {
    // See writePref.
  }
}
