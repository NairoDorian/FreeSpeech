//! Portable mode support.
//!
//! When a file named `portable` exists next to the executable, all user data
//! (settings, models, recordings, database, logs) is stored in a `Data/`
//! directory alongside the executable instead of `%APPDATA%`.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::Manager;

use crate::app_identity::{
    LEGACY_DATA_DIR_NAMES, LEGACY_IDENTIFIERS, LEGACY_PORTABLE_MARKERS, PORTABLE_MARKER,
};

static PORTABLE_DATA_DIR: OnceLock<Option<PathBuf>> = OnceLock::new();
/// `HF_HOME` as it was before portable mode redirected it (`None`: unset).
static PREVIOUS_HF_HOME: OnceLock<Option<PathBuf>> = OnceLock::new();

/// Detect portable mode by looking for a `portable` marker file next to the exe.
/// Must be called once at startup before Tauri initializes.
pub fn init() {
    PORTABLE_DATA_DIR.get_or_init(|| {
        let exe_path = std::env::current_exe().ok()?;
        let exe_dir = exe_path.parent()?;

        let marker_path = exe_dir.join("portable");
        let data_dir = exe_dir.join("Data");

        let is_portable = if is_valid_portable_marker(&marker_path) {
            true
        } else if marker_path.exists() && data_dir.exists() {
            // Migration: v0.8.0 created an empty marker file. If we find an
            // empty/invalid marker alongside an existing Data/ dir, this is a
            // real portable install — upgrade the marker in place.
            eprintln!("[portable] upgrading legacy empty marker to magic string");
            let _ = std::fs::write(&marker_path, PORTABLE_MARKER);
            true
        } else {
            false
        };

        if is_portable {
            if !data_dir.exists() {
                std::fs::create_dir_all(&data_dir).ok()?;
            }
            let hf_home = hugging_face_home(&data_dir);
            let _ = PREVIOUS_HF_HOME.set(std::env::var_os("HF_HOME").map(PathBuf::from));
            // SAFETY: called once at startup, before any threads spawn; the
            // process is single-threaded at this point so set_var cannot race.
            unsafe { std::env::set_var("HF_HOME", &hf_home) };
            eprintln!("[portable] data dir: {}", data_dir.display());
            eprintln!("[portable] Hugging Face home: {}", hf_home.display());
            Some(data_dir)
        } else {
            None
        }
    });
}

/// Keep hf-hub downloads inside the portable data directory. hf-hub appends
/// its own `hub` component to `HF_HOME` for model snapshots and blobs.
fn hugging_face_home(data_dir: &Path) -> PathBuf {
    data_dir.join("huggingface")
}

/// The Hugging Face home configured before portable mode redirected it, when
/// one was set. A model downloaded before the redirect (into this folder, or
/// into hf-hub's default cache when it was unset) stays usable without copying
/// gigabytes or touching a cache other tools share (upstream a94b403, #2116).
pub fn previous_hf_home() -> Option<&'static PathBuf> {
    PREVIOUS_HF_HOME.get().and_then(|path| path.as_ref())
}

/// Returns `true` if running in portable mode.
pub fn is_portable() -> bool {
    PORTABLE_DATA_DIR.get().and_then(|v| v.as_ref()).is_some()
}

/// Get the portable data dir (if active). Does not require an AppHandle.
/// Returns `None` when not in portable mode.
pub fn data_dir() -> Option<&'static PathBuf> {
    PORTABLE_DATA_DIR.get().and_then(|v| v.as_ref())
}

/// Portable-aware replacement for `app.path().app_data_dir()`.
pub fn app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, tauri::Error> {
    if let Some(dir) = data_dir() {
        Ok(dir.clone())
    } else {
        app.path().app_data_dir()
    }
}

/// Portable-aware replacement for `app.path().app_log_dir()`.
pub fn app_log_dir(app: &tauri::AppHandle) -> Result<PathBuf, tauri::Error> {
    if let Some(dir) = data_dir() {
        Ok(dir.join("logs"))
    } else {
        app.path().app_log_dir()
    }
}

/// Resolve a relative path against the app data directory (portable-aware).
/// Replaces `app.path().resolve(path, BaseDirectory::AppData)`.
pub fn resolve_app_data(app: &tauri::AppHandle, relative: &str) -> Result<PathBuf, tauri::Error> {
    Ok(app_data_dir(app)?.join(relative))
}

/// Get the path to use with `tauri-plugin-store`.
/// Returns an absolute path in portable mode (so the store plugin writes to
/// the portable Data dir) or the original relative path otherwise.
pub fn store_path(relative: &str) -> PathBuf {
    if let Some(dir) = data_dir() {
        dir.join(relative)
    } else {
        PathBuf::from(relative)
    }
}

/// Move a former install's data and cache to where this version looks for
/// them.
///
/// Each rename changed the bundle identifier (`app_identity::LEGACY_IDENTIFIERS`,
/// newest first, then `app_identity::IDENTIFIER`), and Tauri derives the app
/// data, cache and log directories from it, so a rename alone would leave every
/// existing user with a fresh, empty profile: no transcription history, no
/// settings, no Recall vault, no llama.cpp install. (Catalog models live in the
/// shared Hugging Face cache, which no identifier names.)
///
/// This runs once at startup, before settings are read, and is deliberately
/// conservative ([`migrate_former_dir`] has the rules): a directory moves only
/// when the new one is still fresh, from the newest former identity that has
/// one, and an older one stays where it is as the backup it has become. After
/// the app-data directory moves, settings that stored an absolute path inside
/// it are pointed at the new one ([`rewrite_store_paths`]).
///
/// Never runs in portable mode, where all of this lives in `Data/` beside the
/// executable and the identifier is not involved.
pub fn migrate_legacy_app_data(app: &tauri::AppHandle) {
    if is_portable() {
        return;
    }

    let paths = app.path();
    let dirs: [(&str, Result<PathBuf, tauri::Error>); 2] = [
        ("app data", paths.app_data_dir()),
        ("cache", paths.app_cache_dir()),
    ];

    for (label, new_dir) in dirs {
        let Ok(new_dir) = new_dir else { continue };
        let from = match migrate_former_dir(&new_dir, &former_leaves()) {
            Migration::NotNeeded => continue,
            Migration::Moved(from) => {
                log::info!(
                    "migrated {label} directory: {} -> {}",
                    from.display(),
                    new_dir.display()
                );
                from
            }
            Migration::Merged { from, entries } => {
                log::info!(
                    "migrated {label} directory entries {entries:?}: {} -> {}",
                    from.display(),
                    new_dir.display()
                );
                from
            }
            Migration::Failed { from, error } => {
                log::warn!(
                    "could not migrate the {label} directory from {} to {}: {error}. \
                     History, settings and the rest stay where they are; move the \
                     directory by hand to keep them.",
                    from.display(),
                    new_dir.display()
                );
                continue;
            }
        };
        if label == "app data" {
            let store = new_dir.join(crate::settings::SETTINGS_STORE_PATH);
            match rewrite_store_paths(&store, &from, &new_dir) {
                Ok(0) => {}
                Ok(count) => log::info!(
                    "pointed {count} stored path(s) from {} at {}",
                    from.display(),
                    new_dir.display()
                ),
                Err(error) => log::warn!(
                    "could not update the paths in {}: {error}. A setting that \
                     named a folder inside {} still names it there.",
                    store.display(),
                    from.display()
                ),
            }
        }
    }
}

/// Every folder leaf a former identity used, newest identity first: its bundle
/// identifier, then its product-name folder (Tauri names the directories after
/// the identifier, but a platform may use the product name).
fn former_leaves() -> Vec<&'static str> {
    LEGACY_IDENTIFIERS
        .iter()
        .zip(LEGACY_DATA_DIR_NAMES)
        .flat_map(|(identifier, name)| [*identifier, *name])
        .collect()
}

/// What [`migrate_former_dir`] did.
#[derive(Debug, PartialEq, Eq)]
enum Migration {
    /// No former directory, or the new one is already in use.
    NotNeeded,
    /// The former directory became the new one.
    Moved(PathBuf),
    /// The new directory held only logs; the former one's other entries moved in.
    Merged {
        from: PathBuf,
        entries: Vec<String>,
    },
    Failed {
        from: PathBuf,
        error: String,
    },
}

/// Move the newest former directory that exists beside `new_dir` into place.
///
/// - The former leaves are tried in order and the first directory found wins:
///   whoever ran the newer identity has their newest data there, and the older
///   ones are left alone as backups. A second move would land on the first.
/// - When `new_dir` does not exist, the former directory is renamed to it.
/// - When `new_dir` holds nothing but `logs`, it is still fresh: the log plugin
///   creates the log directory while the app is built, before this can run,
///   and on Windows (local data and cache) and Linux (app data) the log
///   directory is inside the directory being migrated. Every other entry of
///   the former directory then moves in one by one; its old logs stay behind.
/// - Anything else in `new_dir` means this identity is already in use, and
///   nothing is touched.
fn migrate_former_dir(new_dir: &Path, former_leaves: &[&str]) -> Migration {
    let (Some(parent), Some(new_leaf)) = (
        new_dir.parent(),
        new_dir.file_name().and_then(|name| name.to_str()),
    ) else {
        return Migration::NotNeeded;
    };
    let Some(from) = former_leaves
        .iter()
        .filter(|leaf| **leaf != new_leaf)
        .map(|leaf| parent.join(leaf))
        .find(|dir| dir.is_dir())
    else {
        return Migration::NotNeeded;
    };

    if !new_dir.exists() {
        return match std::fs::rename(&from, new_dir) {
            Ok(()) => Migration::Moved(from),
            Err(error) => Migration::Failed {
                from,
                error: error.to_string(),
            },
        };
    }
    if !holds_only_logs(new_dir) {
        return Migration::NotNeeded;
    }

    let entries = match std::fs::read_dir(&from) {
        Ok(entries) => entries,
        Err(error) => {
            return Migration::Failed {
                from,
                error: error.to_string(),
            };
        }
    };
    let mut moved = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let target = new_dir.join(&name);
        if name == "logs" || target.exists() {
            continue;
        }
        if let Err(error) = std::fs::rename(entry.path(), &target) {
            return Migration::Failed {
                from,
                error: format!("{}: {error}", name.to_string_lossy()),
            };
        }
        moved.push(name.to_string_lossy().into_owned());
    }
    if moved.is_empty() {
        Migration::NotNeeded
    } else {
        moved.sort();
        Migration::Merged {
            from,
            entries: moved,
        }
    }
}

/// Whether `dir` holds nothing but a `logs` folder, or nothing at all: what the
/// log plugin leaves in a directory this identity has never used.
fn holds_only_logs(dir: &Path) -> bool {
    std::fs::read_dir(dir)
        .map(|entries| entries.flatten().all(|entry| entry.file_name() == "logs"))
        .unwrap_or(false)
}

/// Point every string in the settings store that names a path inside `old_dir`
/// at the same path inside `new_dir`, and return how many were rewritten.
///
/// Settings store some folders as absolute paths (a llama.cpp install the app
/// downloaded, a Recall vault or output folder the user picked inside the app
/// data directory), and after the directory moves those would name a folder
/// that no longer exists. Only whole path prefixes are matched, so a string
/// that merely contains the old folder's name is left alone. A missing store
/// is not an error: there is nothing to rewrite.
fn rewrite_store_paths(store: &Path, old_dir: &Path, new_dir: &Path) -> std::io::Result<usize> {
    let text = match std::fs::read_to_string(store) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error),
    };
    let mut value: serde_json::Value =
        serde_json::from_str(&text).map_err(std::io::Error::other)?;
    let mut rewritten = 0;
    rewrite_paths_in(&mut value, old_dir, new_dir, &mut rewritten);
    if rewritten > 0 {
        let text = serde_json::to_string_pretty(&value).map_err(std::io::Error::other)?;
        std::fs::write(store, text)?;
    }
    Ok(rewritten)
}

fn rewrite_paths_in(
    value: &mut serde_json::Value,
    old_dir: &Path,
    new_dir: &Path,
    rewritten: &mut usize,
) {
    match value {
        serde_json::Value::String(text) => {
            if let Ok(rest) = Path::new(text.as_str()).strip_prefix(old_dir) {
                // `join("")` would append a separator to the folder itself.
                let moved = if rest.as_os_str().is_empty() {
                    new_dir.to_path_buf()
                } else {
                    new_dir.join(rest)
                };
                *text = moved.to_string_lossy().into_owned();
                *rewritten += 1;
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                rewrite_paths_in(item, old_dir, new_dir, rewritten);
            }
        }
        serde_json::Value::Object(map) => {
            for item in map.values_mut() {
                rewrite_paths_in(item, old_dir, new_dir, rewritten);
            }
        }
        _ => {}
    }
}

/// Check if a marker file path contains the portable magic string.
/// Extracted for testability.
///
/// Every marker is accepted: the current one, and the one each former release
/// wrote. A marker this rejects silently sends a portable install back to
/// `%APPDATA%`, where the user's history and settings are not — so accepting
/// the old spellings is what lets an existing portable install survive a rename
/// with its `Data/` directory intact. Only the current marker is ever written.
fn is_valid_portable_marker(path: &std::path::Path) -> bool {
    std::fs::read_to_string(path)
        .map(|s| {
            let s = s.trim();
            std::iter::once(PORTABLE_MARKER)
                .chain(LEGACY_PORTABLE_MARKERS.iter().copied())
                .any(|marker| s.starts_with(marker))
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::temp_test_dir;
    use std::io::Write;

    /// A fresh temp dir per call — see `utils::temp_test_dir`.
    fn scratch() -> PathBuf {
        temp_test_dir("portable-test")
    }

    /// Write `contents` to `<dir>/portable` and report whether the reader
    /// accepts it.
    fn marker_accepts(contents: &str) -> bool {
        let dir = scratch();
        let marker = dir.join("portable");
        let mut file = std::fs::File::create(&marker).unwrap();
        write!(file, "{contents}").unwrap();
        let accepted = is_valid_portable_marker(&marker);
        std::fs::remove_dir_all(dir).unwrap();
        accepted
    }

    #[test]
    fn current_marker_enables_portable() {
        assert!(marker_accepts(PORTABLE_MARKER));
    }

    #[test]
    fn every_former_marker_still_enables_portable() {
        // A rename must not move an existing portable install's Data/ dir.
        assert!(LEGACY_PORTABLE_MARKERS.len() >= 2);
        for marker in LEGACY_PORTABLE_MARKERS {
            assert!(marker_accepts(marker), "{marker}");
        }
    }

    #[test]
    fn marker_with_surrounding_whitespace_enables_portable() {
        assert!(marker_accepts(&format!("  {PORTABLE_MARKER}\n")));
        assert!(marker_accepts(&format!(
            "\n{}  ",
            LEGACY_PORTABLE_MARKERS[0]
        )));
    }

    /// `parent/<leaf>` with one file named `marker` in it.
    fn profile(parent: &Path, leaf: &str, marker: &str) -> PathBuf {
        let dir = parent.join(leaf);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(marker), marker).unwrap();
        dir
    }

    #[test]
    fn former_leaves_put_the_newest_identity_first() {
        let leaves = former_leaves();
        assert_eq!(leaves.len(), 2 * LEGACY_IDENTIFIERS.len());
        assert_eq!(leaves[0], LEGACY_IDENTIFIERS[0]);
        assert_eq!(leaves[1], LEGACY_DATA_DIR_NAMES[0]);
        assert!(!leaves.contains(&crate::app_identity::IDENTIFIER));
    }

    #[test]
    fn the_newest_former_profile_moves_and_older_ones_stay() {
        let parent = scratch();
        let newer = profile(&parent, "former.newer", "newer.db");
        let older = profile(&parent, "former.older", "older.db");
        let new_dir = parent.join("current");

        let result = migrate_former_dir(&new_dir, &["former.newer", "former.older"]);

        assert_eq!(result, Migration::Moved(newer.clone()));
        assert!(new_dir.join("newer.db").is_file());
        assert!(!newer.exists());
        assert!(older.join("older.db").is_file(), "the backup stays");
        std::fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn an_older_identity_moves_when_it_is_the_only_one() {
        let parent = scratch();
        let older = profile(&parent, "former.older", "older.db");
        let new_dir = parent.join("current");

        let result = migrate_former_dir(&new_dir, &["former.newer", "former.older"]);

        assert_eq!(result, Migration::Moved(older));
        assert!(new_dir.join("older.db").is_file());
        std::fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn a_profile_already_in_use_is_left_alone() {
        let parent = scratch();
        let former = profile(&parent, "former", "old.db");
        let new_dir = profile(&parent, "current", "settings_store.json");

        let result = migrate_former_dir(&new_dir, &["former"]);

        assert_eq!(result, Migration::NotNeeded);
        assert!(former.join("old.db").is_file());
        assert!(!new_dir.join("old.db").exists());
        std::fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn a_directory_holding_only_logs_takes_the_former_entries() {
        // The log plugin creates `<new>/logs` before the migration runs.
        let parent = scratch();
        let former = profile(&parent, "former", "settings_store.json");
        std::fs::create_dir_all(former.join("EBWebView")).unwrap();
        std::fs::create_dir_all(former.join("logs")).unwrap();
        let new_dir = parent.join("current");
        std::fs::create_dir_all(new_dir.join("logs")).unwrap();

        let result = migrate_former_dir(&new_dir, &["former"]);

        assert_eq!(
            result,
            Migration::Merged {
                from: former.clone(),
                entries: vec!["EBWebView".into(), "settings_store.json".into()],
            }
        );
        assert!(new_dir.join("EBWebView").is_dir());
        assert!(new_dir.join("settings_store.json").is_file());
        assert!(former.join("logs").is_dir(), "old logs stay behind");
        std::fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn nothing_moves_without_a_former_profile() {
        let parent = scratch();
        let new_dir = parent.join("current");

        assert_eq!(
            migrate_former_dir(&new_dir, &["former"]),
            Migration::NotNeeded
        );
        assert!(!new_dir.exists());
        std::fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn stored_paths_inside_the_former_directory_follow_it() {
        let parent = scratch();
        let old_dir = parent.join("former");
        let new_dir = parent.join("current");
        std::fs::create_dir_all(&new_dir).unwrap();
        let inside = old_dir.join("llama_cpp").join("cuda-b1");
        let lookalike = format!("{}-other", old_dir.display());
        let store = new_dir.join("settings_store.json");
        let settings = serde_json::json!({
            "settings": {
                "llama": { "server_dir": inside, "port": 8080 },
                "recall": { "output_dir": old_dir },
                "note": lookalike,
                "language": "en",
            }
        });
        std::fs::write(&store, settings.to_string()).unwrap();

        assert_eq!(rewrite_store_paths(&store, &old_dir, &new_dir).unwrap(), 2);

        let after: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&store).unwrap()).unwrap();
        let expected = new_dir.join("llama_cpp").join("cuda-b1");
        assert_eq!(
            after["settings"]["llama"]["server_dir"],
            expected.to_string_lossy().as_ref()
        );
        assert_eq!(
            after["settings"]["recall"]["output_dir"],
            new_dir.to_string_lossy().as_ref()
        );
        assert_eq!(after["settings"]["note"], lookalike.as_str());
        assert_eq!(after["settings"]["llama"]["port"], 8080);
        std::fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn a_missing_store_has_nothing_to_rewrite() {
        let parent = scratch();
        let missing = parent.join("settings_store.json");
        assert_eq!(rewrite_store_paths(&missing, &parent, &parent).unwrap(), 0);
        std::fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn marker_with_a_trailing_line_still_enables_portable() {
        // The check is `starts_with`, so extra lines are tolerated. Pinned
        // because the NSIS template writes the marker through a different code
        // path than this module and the two must stay compatible.
        assert!(marker_accepts(&format!("{PORTABLE_MARKER}\n")));
    }

    #[test]
    fn empty_marker_does_not_enable_portable() {
        assert!(!marker_accepts(""));
    }

    #[test]
    fn unrelated_content_does_not_enable_portable() {
        assert!(!marker_accepts("some other content"));
        // A marker from a different application must not claim this install.
        assert!(!marker_accepts("OtherApp Portable Mode"));
    }

    #[test]
    fn missing_marker_file_does_not_enable_portable() {
        let dir = scratch();
        assert!(!is_valid_portable_marker(&dir.join("portable")));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn hugging_face_home_is_inside_portable_data() {
        let data_dir = Path::new("portable-root").join("Data");

        assert_eq!(hugging_face_home(&data_dir), data_dir.join("huggingface"));
    }
}
