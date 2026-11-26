//! GENERATED FILE — DO NOT EDIT.
//!
//! Source: `scripts/app-meta.ts` — run `bun run meta:sync` to regenerate.
//!
//! Do not add a literal of the project's identity anywhere else in this crate.
//! Import from here instead, so a rename stays a one-line change.

/// Product name, for anything the user sees: window titles, tray tooltip,
/// log lines, the about page.
pub const NAME: &str = "FreeSpeech";

/// Machine slug: the crate, the binary, `freespeech.exe`, the `package.json`
/// name. Never shown to the user.
pub const SLUG: &str = "freespeech";

/// Bundle identifier — the OS-level application identity.
pub const IDENTIFIER: &str = "com.nairodorian.freespeech";

/// Repository URL, for links out of the app.
pub const REPO_URL: &str = "https://github.com/NairoDorian/FreeSpeech";

/// Releases page — where an update or a portable installer link points.
pub const RELEASES_URL: &str = "https://github.com/NairoDorian/FreeSpeech/releases/latest";

/// Who this application says it is on outbound HTTP requests: model downloads,
/// GitHub API calls, LLM provider calls. `name/version` is the shape every one
/// of those services expects.
pub const USER_AGENT: &str = "FreeSpeech/0.10.0";

/// The product-name folder leaf a platform may use (kept for the migration's
/// symmetry). The app-data folder that holds models, history and settings is
/// named after `IDENTIFIER`, not this.
pub const DATA_DIR_NAME: &str = "FreeSpeech";

/// The bundle identifiers former releases used, newest first. The one-shot
/// app-data migration looks for an install under each, in this order; never
/// written.
pub const LEGACY_IDENTIFIERS: &[&str] = &["com.nairodorian.zer0", "com.pais.handy"];

/// The product-name folder leaves former releases may have used, newest first
/// (the migration's other spelling of each identity); never written.
pub const LEGACY_DATA_DIR_NAMES: &[&str] = &["ZER0", "Handy"];

/// Prefix of every environment flag this application reads.
pub const ENV_PREFIX: &str = "FREESPEECH_";

/// Former environment-flag prefixes, newest first. Every flag lookup falls back
/// to them in order and warns, so an existing shell profile or Nix wrapper
/// keeps working.
pub const LEGACY_ENV_PREFIXES: &[&str] = &["ZER0_", "HANDY_"];

/// Magic string written into the `portable` marker beside the executable.
pub const PORTABLE_MARKER: &str = "FreeSpeech Portable Mode";

/// The markers former releases wrote, newest first. Accepted on read, never
/// written unless an older empty marker is being upgraded.
pub const LEGACY_PORTABLE_MARKERS: &[&str] = &["ZER0 Portable Mode", "Handy Portable Mode"];

/// Base name of the WAV files a recording is written to before transcription.
pub const RECORDING_BASENAME: &str = "freespeech";

/// File name a single recording's WAV is saved under, in the recordings
/// directory.
///
/// A function rather than a `format!` at each call site so the shape of the
/// name lives in one place: the history row a transcription writes must name
/// the same file the recorder wrote.
pub fn recording_file_name(timestamp: i64) -> String {
    format!("{RECORDING_BASENAME}-{timestamp}.wav")
}

/// File name a Multi-STT recording's WAV is saved under. The `-multi` infix
/// keeps a parallel recording distinguishable from a plain one in the
/// recordings directory and in history.
pub fn multi_recording_file_name(timestamp: i64) -> String {
    format!("{RECORDING_BASENAME}-multi-{timestamp}.wav")
}
