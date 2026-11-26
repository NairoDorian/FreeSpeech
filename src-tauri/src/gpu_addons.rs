//! CUDA add-ons: the engine's `ggml-cuda` module for one NVIDIA architecture,
//! downloaded from this version's release and registered at startup.
//!
//! The installers carry the CPU and Vulkan backends (the engine is built with
//! `dynamic-backends`, so each backend is a module registered at startup).
//! CUDA is an add-on because its runtime (cudart + cuBLAS) is hundreds of MB
//! and every architecture compiled in grows the module: a person with an
//! NVIDIA card downloads the module for their card's compute capability, and
//! the runtime once — or not at all when a CUDA toolkit of the same major is
//! installed. `.github/workflows/gpu-backends.yml` publishes the packages and
//! an index, `<Name>-<version>-cuda-addons-<platform>.json`, naming each
//! package's size and SHA-256 and the engine commit the modules were built
//! from. A ggml module only works with the ggml core it was compiled against,
//! so a module from another engine commit is never registered.
//! docs/GPU_BACKENDS.md has the design.
//!
//! Layout under `<app data>/gpu-backends/`, one folder per package, each with
//! the `manifest.json` it was published with:
//!
//! - `cuda-sm86-60644e11/` — `ggml-cuda.dll`, one folder per engine commit
//! - `cuda-runtime-13.3.1/` — `cudart64_13.dll`, `cublas64_13.dll`, `cublasLt64_13.dll`
//!
//! A folder's name carries what makes it unique, so a new version installs
//! beside the one this process has loaded (Windows cannot replace a loaded
//! DLL). Removing an add-on deletes what is not loaded and marks the rest,
//! which the next start deletes before it registers anything.
//!
//! Cost: at startup, one `is_dir` when no add-on was ever installed. With one
//! installed, reading the manifests, loading the three runtime DLLs and the
//! module, which initialises the CUDA driver (about 0.1–0.3 s): what a CUDA
//! build pays in `init_backends_default` anyway. GPU detection (NVML) and the
//! index (one small HTTPS download, cached ten minutes) run only when the
//! Advanced page asks for the status.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock, PoisonError};
use std::time::{Duration, Instant};

use log::{info, warn};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use specta::Type;
use tauri::AppHandle;
use tauri_specta::Event;

use crate::app_identity;

const ROOT_DIR: &str = "gpu-backends";
const MANIFEST: &str = "manifest.json";
/// A folder holding this file is deleted at the next start (it was loaded
/// when the person removed it).
const REMOVE_MARKER: &str = ".remove";
/// Suffix of an install's download and staging folder, removed at startup if
/// an install was interrupted.
const PARTIAL: &str = ".partial";
const INDEX_TTL: Duration = Duration::from_secs(600);
const BACKEND_MODULE: &str = "cuda";
const BACKEND_RUNTIME: &str = "cuda-runtime";

/// The platform the add-ons are published for; `None` where there are none.
const PLATFORM: Option<&str> = if cfg!(all(windows, target_arch = "x86_64")) {
    Some("windows-x64")
} else {
    None
};

/// A package in the release's add-on index.
#[derive(Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct IndexAsset {
    asset: String,
    size: u64,
    sha256: String,
}

/// A module package in the release's add-on index.
#[derive(Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct IndexModule {
    compute_capability: String,
    asset: String,
    size: u64,
    sha256: String,
}

/// `<Name>-<version>-cuda-addons-<platform>.json`, published beside the packages.
#[derive(Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct AddonIndex {
    engine_commit: String,
    cuda_version: String,
    #[serde(default)]
    runtime: Option<IndexAsset>,
    #[serde(default)]
    modules: Vec<IndexModule>,
}

/// The `manifest.json` inside every package.
#[derive(Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct PackageManifest {
    backend: String,
    #[serde(default)]
    compute_capability: Option<String>,
    cuda_version: String,
    #[serde(default)]
    engine_commit: Option<String>,
    files: BTreeMap<String, String>,
}

impl PackageManifest {
    /// A module built from the engine commit this process runs.
    fn is_module_for(&self, engine: &str) -> bool {
        self.backend == BACKEND_MODULE
            && self
                .engine_commit
                .as_deref()
                .is_some_and(|commit| same_commit(commit, engine))
    }
}

#[derive(Debug, Clone)]
struct Installed {
    dir: PathBuf,
    manifest: PackageManifest,
}

/// An NVIDIA GPU as NVML reports it.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Type)]
pub struct NvidiaGpu {
    pub name: String,
    /// `8.6`
    pub compute_capability: String,
}

/// Where the CUDA backend running in this process came from.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "snake_case")]
pub enum CudaSource {
    /// Compiled into this build (a local CUDA build).
    Build,
    /// An installed add-on.
    Addon,
}

/// Why no add-on is offered.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "snake_case")]
pub enum CudaAddonUnavailable {
    /// No add-ons exist for this platform.
    Platform,
    /// NVML found no NVIDIA GPU.
    NoNvidiaGpu,
    /// This version's release has no add-ons (not published yet, or a
    /// development build).
    NotPublished,
    /// The published modules were built from another engine commit than
    /// this build (a development build carrying a release's version).
    OtherBuild,
    /// Every published module is newer than this GPU.
    NoPackageForGpu,
    /// The driver supports an older CUDA than the add-ons need.
    DriverTooOld,
    /// The index could not be downloaded.
    LookupFailed,
}

/// What installing the add-on would download.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Type)]
pub struct CudaAddonOffer {
    /// Compute capability the module is built for (`86`).
    pub arch: String,
    /// The GPU it was picked for.
    pub gpu: String,
    pub module_mb: u32,
    /// The runtime download that comes with it; 0 when one is already here.
    pub runtime_mb: u32,
    /// The installed CUDA toolkit whose runtime is used instead of a download
    /// (its version), when there is one.
    pub toolkit_runtime: Option<String>,
    pub cuda_version: String,
}

/// The Advanced page's view of the CUDA add-on.
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq, Eq, Type)]
pub struct CudaAddonStatus {
    /// Add-ons are published for this platform.
    pub supported: bool,
    pub gpus: Vec<NvidiaGpu>,
    /// The newest CUDA the driver supports (`13.5`).
    pub driver_cuda: Option<String>,
    /// CUDA is registered in this process, and from where.
    pub active: Option<CudaSource>,
    /// Compute capability of the installed module that fits this build.
    pub installed_arch: Option<String>,
    /// That module is not registered in this process yet: it takes a restart.
    pub restart_required: bool,
    /// That module was loaded at startup and registered no CUDA device (an
    /// old driver, a missing runtime): the log says why.
    pub load_failed: bool,
    /// Something was removed while loaded; the next start deletes it.
    pub removal_pending: bool,
    pub offer: Option<CudaAddonOffer>,
    pub unavailable: Option<CudaAddonUnavailable>,
    /// An install is running; its progress arrives as `CudaAddonEvent`.
    pub installing: bool,
}

/// Progress of one install, from the first download to done or error.
#[derive(Serialize, Deserialize, Debug, Clone, Type, tauri_specta::Event)]
pub struct CudaAddonEvent {
    /// `downloading`, `verifying`, `done`, `error`
    pub phase: String,
    /// `runtime` or `module`
    pub part: String,
    pub downloaded_bytes: f64,
    pub total_bytes: f64,
    pub message: Option<String>,
}

/// What `register_installed` did in this process.
#[derive(Debug, Clone, Default)]
struct Registered {
    source: Option<CudaSource>,
    module_dir: Option<PathBuf>,
    runtime_dir: Option<PathBuf>,
    /// A module that was loaded and registered no CUDA device.
    failed_dir: Option<PathBuf>,
}

static REGISTERED: OnceLock<Registered> = OnceLock::new();
static INSTALLING: AtomicBool = AtomicBool::new(false);
static INDEX: Mutex<Option<(Instant, Option<AddonIndex>)>> = Mutex::new(None);

fn root_dir(app: &AppHandle) -> Option<PathBuf> {
    crate::portable::app_data_dir(app)
        .ok()
        .map(|dir| dir.join(ROOT_DIR))
}

/// Register the installed add-on that fits this build. Call once, right after
/// `init_transcribe_backend` and before any model load or device listing:
/// the engine registers backends only then.
pub fn register_installed(app: &AppHandle) {
    if REGISTERED.get().is_none() {
        let _ = REGISTERED.set(register(app));
    }
}

fn register(app: &AppHandle) -> Registered {
    let mut out = Registered::default();
    if transcribe_cpp::backend_available(transcribe_cpp::Backend::Cuda) {
        out.source = Some(CudaSource::Build);
        return out;
    }
    let Some(root) = root_dir(app).filter(|root| root.is_dir()) else {
        return out;
    };
    remove_marked(&root);
    if PLATFORM.is_none() || crate::utils::is_windows_x64_emulated_on_arm64() {
        return out;
    }
    if !transcribe_cpp::allowed_backends().contains(transcribe_cpp::BackendMask::CUDA) {
        info!("CUDA add-on not registered: TRANSCRIBE_BACKENDS leaves CUDA out");
        return out;
    }
    let engine = transcribe_cpp::version_commit();
    let Some(module) = installed(&root)
        .into_iter()
        .find(|package| package.manifest.is_module_for(&engine))
    else {
        return out;
    };
    let runtime = runtime_for(&root, &module.manifest.cuda_version);
    if let Some((dir, major)) = &runtime {
        preload_runtime(dir, *major);
    } else {
        warn!(
            "CUDA add-on: no CUDA {} runtime found (none installed, no toolkit); \
             the module will only load if the runtime is on PATH",
            module.manifest.cuda_version
        );
    }
    match transcribe_cpp::init_backends(&module.dir) {
        Ok(()) if transcribe_cpp::backend_available(transcribe_cpp::Backend::Cuda) => {
            info!(
                "CUDA add-on registered from {} (sm_{})",
                module.dir.display(),
                module.manifest.compute_capability.as_deref().unwrap_or("?")
            );
            out.source = Some(CudaSource::Addon);
            out.module_dir = Some(module.dir);
            out.runtime_dir = runtime.map(|(dir, _)| dir);
        }
        Ok(()) => {
            warn!(
                "CUDA add-on in {} registered no CUDA device (no NVIDIA GPU, \
                 a driver older than CUDA {}, or a missing runtime)",
                module.dir.display(),
                module.manifest.cuda_version
            );
            out.failed_dir = Some(module.dir);
        }
        Err(e) => {
            warn!(
                "CUDA add-on in {} failed to load: {e}",
                module.dir.display()
            );
            out.failed_dir = Some(module.dir);
        }
    }
    out
}

/// Every package folder under `root` with a readable manifest, skipping the
/// ones marked for removal.
fn installed(root: &Path) -> Vec<Installed> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut out: Vec<Installed> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|dir| dir.is_dir() && !dir.join(REMOVE_MARKER).exists())
        .filter_map(|dir| {
            let text = std::fs::read_to_string(dir.join(MANIFEST)).ok()?;
            let manifest = serde_json::from_str(&text).ok()?;
            Some(Installed { dir, manifest })
        })
        .collect();
    out.sort_by(|a, b| a.dir.cmp(&b.dir));
    out
}

/// Delete what an earlier run marked for removal and what an interrupted
/// install left behind. Nothing here is loaded yet.
fn remove_marked(root: &Path) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for path in entries.flatten().map(|entry| entry.path()) {
        let partial = path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with(PARTIAL));
        let result = if partial && path.is_file() {
            std::fs::remove_file(&path)
        } else if partial || path.join(REMOVE_MARKER).exists() {
            std::fs::remove_dir_all(&path)
        } else {
            continue;
        };
        match result {
            Ok(()) => info!("CUDA add-on: removed {}", path.display()),
            Err(e) => warn!("CUDA add-on: cannot remove {}: {e}", path.display()),
        }
    }
}

fn has_marked(root: &Path) -> bool {
    std::fs::read_dir(root).is_ok_and(|entries| {
        entries
            .flatten()
            .any(|entry| entry.path().join(REMOVE_MARKER).exists())
    })
}

/// The runtime libraries a module built with CUDA `major` imports, in load order.
fn runtime_dlls(major: u32) -> [String; 3] {
    if cfg!(windows) {
        [
            format!("cudart64_{major}.dll"),
            format!("cublasLt64_{major}.dll"),
            format!("cublas64_{major}.dll"),
        ]
    } else {
        [
            format!("libcudart.so.{major}"),
            format!("libcublasLt.so.{major}"),
            format!("libcublas.so.{major}"),
        ]
    }
}

/// `13.3.1` → `[13, 3, 1]`.
fn version_key(version: &str) -> Option<Vec<u32>> {
    version
        .trim()
        .split('.')
        .map(|part| part.parse().ok())
        .collect::<Option<Vec<u32>>>()
        .filter(|key| !key.is_empty())
}

/// Where a module built with CUDA `cuda_version` gets its runtime, and that
/// runtime's major: an installed runtime package of the same major at least
/// as new, else an installed CUDA toolkit of the same major (at least as new
/// when its version is known). `None` when neither has the three libraries.
fn runtime_for(root: &Path, cuda_version: &str) -> Option<(PathBuf, u32)> {
    let want = version_key(cuda_version)?;
    let major = *want.first()?;
    let names = runtime_dlls(major);
    let complete = |dir: &Path| names.iter().all(|name| dir.join(name).is_file());
    let mut packages: Vec<(Vec<u32>, PathBuf)> = installed(root)
        .into_iter()
        .filter(|package| package.manifest.backend == BACKEND_RUNTIME)
        .filter_map(|package| Some((version_key(&package.manifest.cuda_version)?, package.dir)))
        .filter(|(version, dir)| {
            version.first() == Some(&major) && *version >= want && complete(dir)
        })
        .collect();
    packages.sort_by(|a, b| b.0.cmp(&a.0));
    if let Some((_, dir)) = packages.into_iter().next() {
        return Some((dir, major));
    }
    let (dir, version) = toolkit_runtime(major)?;
    let new_enough = version
        .as_deref()
        .and_then(version_key)
        .is_none_or(|have| have.len() < 2 || have >= want);
    new_enough.then_some((dir, major))
}

/// An installed CUDA toolkit's runtime folder holding the three libraries of
/// `major`, and the toolkit's version when known.
fn toolkit_runtime(major: u32) -> Option<(PathBuf, Option<String>)> {
    let toolkit = crate::llama_releases::detect_cuda_toolkit()?;
    let dir = PathBuf::from(&toolkit.runtime_dir);
    runtime_dlls(major)
        .iter()
        .all(|name| dir.join(name).is_file())
        .then_some((dir, toolkit.version))
}

/// Load the runtime DLLs by full path so `ggml-cuda.dll`'s imports resolve to
/// them: Windows uses a module already loaded under the same name whatever
/// folder it came from, while its search for a DLL's dependencies starts at
/// the executable's folder, never at the DLL's own.
#[cfg(windows)]
fn preload_runtime(dir: &Path, major: u32) {
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::System::LibraryLoader::{LOAD_WITH_ALTERED_SEARCH_PATH, LoadLibraryExW};
    use windows::core::PCWSTR;

    for name in runtime_dlls(major) {
        let path = dir.join(&name);
        let wide: Vec<u16> = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        // SAFETY: `wide` is a NUL-terminated UTF-16 path that outlives the
        // call. The module is deliberately never freed: ggml-cuda resolves its
        // imports to it for the life of the process. LOAD_WITH_ALTERED_SEARCH_PATH
        // resolves the DLL's own imports (cuBLAS → cuBLASLt) from its folder.
        let loaded =
            unsafe { LoadLibraryExW(PCWSTR(wide.as_ptr()), None, LOAD_WITH_ALTERED_SEARCH_PATH) };
        if let Err(e) = loaded {
            warn!("CUDA add-on: cannot load {}: {e}", path.display());
        }
    }
}

/// No platform outside Windows x64 has published add-ons yet.
#[cfg(not(windows))]
fn preload_runtime(_dir: &Path, _major: u32) {}

/// Two spellings of one git commit: either is a prefix of the other, both at
/// least seven hex digits (the engine reports a short SHA, the index a full one).
fn same_commit(a: &str, b: &str) -> bool {
    let (a, b) = (a.trim().to_ascii_lowercase(), b.trim().to_ascii_lowercase());
    let sha = |s: &str| s.len() >= 7 && s.chars().all(|c| c.is_ascii_hexdigit());
    sha(&a) && sha(&b) && (a.starts_with(&b) || b.starts_with(&a))
}

/// The published module to install for a GPU of compute capability `gpu`
/// (`major * 10 + minor`): its own; else the newest below it of the same major,
/// whose machine code the card runs natively; else the newest below it, whose
/// PTX the driver compiles for the card when the module first loads. `None`
/// when every module is newer than the card.
fn pick_arch(available: &[u32], gpu: u32) -> Option<u32> {
    if available.contains(&gpu) {
        return Some(gpu);
    }
    let below = || available.iter().copied().filter(move |&arch| arch <= gpu);
    below()
        .filter(|&arch| arch / 10 == gpu / 10)
        .max()
        .or_else(|| below().max())
}

#[derive(Debug, Default)]
struct GpuScan {
    /// Each GPU with its compute capability as `major * 10 + minor`.
    gpus: Vec<(NvidiaGpu, u32)>,
    driver_cuda: Option<(u32, u32)>,
}

/// The NVIDIA GPUs and the driver's CUDA version, from NVML (shipped with
/// every NVIDIA driver; nothing is found without one).
fn scan_nvidia() -> GpuScan {
    let Ok(nvml) = nvml_wrapper::Nvml::init() else {
        return GpuScan::default();
    };
    let mut gpus = Vec::new();
    for index in 0..nvml.device_count().unwrap_or(0) {
        let Ok(device) = nvml.device_by_index(index) else {
            continue;
        };
        let Ok(cc) = device.cuda_compute_capability() else {
            continue;
        };
        let (major, minor) = (cc.major.max(0) as u32, cc.minor.max(0) as u32);
        gpus.push((
            NvidiaGpu {
                name: device.name().unwrap_or_default(),
                compute_capability: format!("{major}.{minor}"),
            },
            major * 10 + minor,
        ));
    }
    // NVML encodes 13.5 as 13050.
    let driver_cuda = nvml
        .sys_cuda_driver_version()
        .ok()
        .filter(|&version| version > 0)
        .map(|version| ((version / 1000) as u32, ((version % 1000) / 10) as u32));
    GpuScan { gpus, driver_cuda }
}

fn release_url(file: &str) -> String {
    format!(
        "{}/releases/download/v{}/{file}",
        app_identity::REPO_URL,
        env!("CARGO_PKG_VERSION")
    )
}

fn index_name(platform: &str) -> String {
    format!(
        "{}-{}-cuda-addons-{platform}.json",
        app_identity::NAME,
        env!("CARGO_PKG_VERSION")
    )
}

/// This version's add-on index, `None` when the release has none (a 404).
/// Cached for ten minutes; a failed lookup is not cached.
async fn fetch_index(force: bool) -> Result<Option<AddonIndex>, String> {
    let Some(platform) = PLATFORM else {
        return Ok(None);
    };
    if !force
        && let Some((at, index)) = INDEX
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
        && at.elapsed() < INDEX_TTL
    {
        return Ok(index.clone());
    }
    let response = crate::llama_releases::client()?
        .get(release_url(&index_name(platform)))
        .send()
        .await
        .map_err(|e| format!("Cannot reach the release: {e}"))?;
    let index = if response.status() == reqwest::StatusCode::NOT_FOUND {
        None
    } else {
        let response = response
            .error_for_status()
            .map_err(|e| format!("Cannot download the add-on index: {e}"))?;
        Some(
            response
                .json::<AddonIndex>()
                .await
                .map_err(|e| format!("Unreadable add-on index: {e}"))?,
        )
    };
    *INDEX.lock().unwrap_or_else(PoisonError::into_inner) = Some((Instant::now(), index.clone()));
    Ok(index)
}

fn megabytes(bytes: u64) -> u32 {
    u32::try_from(bytes.div_ceil(1024 * 1024)).unwrap_or(u32::MAX)
}

/// The add-on's state for the Advanced page: the GPU, what is installed and
/// running, and what an install would download.
pub async fn status(app: &AppHandle, force: bool) -> CudaAddonStatus {
    let registered = REGISTERED.get().cloned().unwrap_or_default();
    let mut status = CudaAddonStatus {
        supported: PLATFORM.is_some(),
        active: registered.source,
        installing: INSTALLING.load(Ordering::Acquire),
        ..Default::default()
    };
    if PLATFORM.is_none() {
        status.unavailable = Some(CudaAddonUnavailable::Platform);
        return status;
    }

    let root = root_dir(app);
    let local = {
        let root = root.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let packages = root.as_deref().map(installed).unwrap_or_default();
            let pending = root.as_deref().is_some_and(has_marked);
            (scan_nvidia(), packages, pending)
        })
        .await
    };
    let (scan, packages, pending) = match local {
        Ok(local) => local,
        Err(e) => {
            warn!("CUDA add-on status failed: {e}");
            return status;
        }
    };
    status.gpus = scan.gpus.iter().map(|(gpu, _)| gpu.clone()).collect();
    status.driver_cuda = scan
        .driver_cuda
        .map(|(major, minor)| format!("{major}.{minor}"));
    status.removal_pending = pending;

    let engine = transcribe_cpp::version_commit();
    if let Some(module) = packages
        .iter()
        .find(|package| package.manifest.is_module_for(&engine))
    {
        status.installed_arch = module.manifest.compute_capability.clone();
        status.load_failed = registered.failed_dir.as_deref() == Some(module.dir.as_path());
        status.restart_required = !status.load_failed
            && registered.source != Some(CudaSource::Build)
            && registered.module_dir.as_deref() != Some(module.dir.as_path());
        return status;
    }
    if status.active.is_some() {
        return status;
    }
    if scan.gpus.is_empty() {
        status.unavailable = Some(CudaAddonUnavailable::NoNvidiaGpu);
        return status;
    }

    let index = match fetch_index(force).await {
        Ok(Some(index)) => index,
        Ok(None) => {
            status.unavailable = Some(CudaAddonUnavailable::NotPublished);
            return status;
        }
        Err(e) => {
            warn!("CUDA add-on lookup failed: {e}");
            status.unavailable = Some(CudaAddonUnavailable::LookupFailed);
            return status;
        }
    };
    if !same_commit(&index.engine_commit, &engine) {
        status.unavailable = Some(CudaAddonUnavailable::OtherBuild);
        return status;
    }
    let cuda_major = version_key(&index.cuda_version).and_then(|key| key.first().copied());
    if let (Some((driver, _)), Some(needed)) = (scan.driver_cuda, cuda_major)
        && driver < needed
    {
        status.unavailable = Some(CudaAddonUnavailable::DriverTooOld);
        return status;
    }

    let available: Vec<u32> = index
        .modules
        .iter()
        .filter_map(|module| module.compute_capability.parse().ok())
        .collect();
    let mut by_capability = scan.gpus.clone();
    by_capability.sort_by_key(|gpu| std::cmp::Reverse(gpu.1));
    let Some((gpu, module)) = by_capability.iter().find_map(|(gpu, cc)| {
        let arch = pick_arch(&available, *cc)?.to_string();
        let module = index
            .modules
            .iter()
            .find(|module| module.compute_capability == arch)?;
        Some((gpu.name.clone(), module.clone()))
    }) else {
        status.unavailable = Some(CudaAddonUnavailable::NoPackageForGpu);
        return status;
    };

    let runtime = {
        let cuda_version = index.cuda_version.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let installed = root
                .as_deref()
                .and_then(|root| runtime_for(root, &cuda_version));
            let toolkit = installed
                .as_ref()
                .and_then(|(dir, major)| {
                    let (toolkit_dir, version) = toolkit_runtime(*major)?;
                    (toolkit_dir == *dir).then_some(version)
                })
                .map(|version| version.unwrap_or_default());
            (installed.is_some(), toolkit)
        })
        .await
        .unwrap_or((false, None))
    };
    let (has_runtime, toolkit_runtime) = runtime;
    status.offer = Some(CudaAddonOffer {
        arch: module.compute_capability.clone(),
        gpu,
        module_mb: megabytes(module.size),
        runtime_mb: match (&index.runtime, has_runtime) {
            (Some(runtime), false) => megabytes(runtime.size),
            _ => 0,
        },
        toolkit_runtime,
        cuda_version: index.cuda_version.clone(),
    });
    status
}

/// Claim the single install slot. The command claims it before spawning the
/// install, so a status read right after the click already says `installing`.
pub fn begin_install() -> bool {
    !INSTALLING.swap(true, Ordering::AcqRel)
}

fn emit(app: &AppHandle, phase: &str, part: &str, done: f64, total: f64, message: Option<String>) {
    let _ = CudaAddonEvent {
        phase: phase.into(),
        part: part.into(),
        downloaded_bytes: done,
        total_bytes: total,
        message,
    }
    .emit(app);
}

/// Download, check and unpack the module for `arch` (and the runtime when
/// none is here), after [`begin_install`] claimed the slot. It takes effect
/// at the next start.
pub async fn install(app: AppHandle, arch: String) -> Result<(), String> {
    let result = install_inner(&app, &arch).await;
    INSTALLING.store(false, Ordering::Release);
    match &result {
        Ok(()) => {
            info!("CUDA add-on sm_{arch} installed; it is registered at the next start");
            emit(&app, "done", "module", 1.0, 1.0, None);
        }
        Err(e) => {
            warn!("CUDA add-on install failed: {e}");
            emit(&app, "error", "module", 0.0, 0.0, Some(e.clone()));
        }
    }
    result
}

async fn install_inner(app: &AppHandle, arch: &str) -> Result<(), String> {
    if PLATFORM.is_none() {
        return Err("CUDA add-ons are not published for this platform".into());
    }
    let index = fetch_index(false)
        .await?
        .ok_or("No CUDA add-on is published for this version")?;
    let engine = transcribe_cpp::version_commit();
    if !same_commit(&index.engine_commit, &engine) {
        return Err(format!(
            "The published add-ons were built for engine {}, this build runs {engine}",
            index.engine_commit
        ));
    }
    let module = index
        .modules
        .iter()
        .find(|module| module.compute_capability == arch)
        .cloned()
        .ok_or_else(|| format!("No CUDA add-on for sm_{arch} in this release"))?;
    let root = root_dir(app).ok_or("No app data folder")?;
    let cuda_version = index.cuda_version.clone();

    let needs_runtime = {
        let (root, cuda_version) = (root.clone(), cuda_version.clone());
        tauri::async_runtime::spawn_blocking(move || runtime_for(&root, &cuda_version).is_none())
            .await
            .map_err(|e| e.to_string())?
    };
    if needs_runtime {
        let runtime = index
            .runtime
            .clone()
            .ok_or("The release has no CUDA runtime package")?;
        let expect = cuda_version.clone();
        install_package(
            app,
            &root,
            "runtime",
            &runtime,
            &format!("cuda-runtime-{cuda_version}"),
            move |manifest| manifest.backend == BACKEND_RUNTIME && manifest.cuda_version == expect,
        )
        .await?;
    }

    let short = index.engine_commit.get(..8).unwrap_or(&index.engine_commit);
    let folder = format!("cuda-sm{arch}-{short}");
    let (want_arch, want_engine) = (arch.to_string(), engine.clone());
    install_package(
        app,
        &root,
        "module",
        &IndexAsset {
            asset: module.asset,
            size: module.size,
            sha256: module.sha256,
        },
        &folder,
        move |manifest| {
            manifest.is_module_for(&want_engine)
                && manifest.compute_capability.as_deref() == Some(want_arch.as_str())
        },
    )
    .await?;

    // The new module supersedes every other one that is not loaded here.
    let keep = root.join(&folder);
    let loaded = REGISTERED.get().and_then(|r| r.module_dir.clone());
    tauri::async_runtime::spawn_blocking(move || {
        for package in installed(&root) {
            if package.manifest.backend == BACKEND_MODULE
                && package.dir != keep
                && Some(&package.dir) != loaded.as_ref()
                && let Err(e) = std::fs::remove_dir_all(&package.dir)
            {
                warn!("CUDA add-on: cannot remove {}: {e}", package.dir.display());
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// A plain file name, so a release asset can never point outside the folder.
fn is_plain_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// Download `asset`, check it against the index, unpack it into a staging
/// folder, check every file against the package's manifest and `accept`, then
/// move it into `root/folder`. A package already there is kept.
async fn install_package(
    app: &AppHandle,
    root: &Path,
    part: &str,
    asset: &IndexAsset,
    folder: &str,
    accept: impl Fn(&PackageManifest) -> bool + Send + 'static,
) -> Result<(), String> {
    if !is_plain_name(&asset.asset) {
        return Err(format!("Refusing the asset name {:?}", asset.asset));
    }
    let dest = root.join(folder);
    if dest.join(MANIFEST).is_file() {
        // Already here. Removed earlier in this session while loaded: its
        // files were checked when it was installed, so keep them.
        let marker = dest.join(REMOVE_MARKER);
        if marker.exists() {
            std::fs::remove_file(&marker)
                .map_err(|e| format!("Cannot restore {}: {e}", dest.display()))?;
        }
        return Ok(());
    }
    std::fs::create_dir_all(root).map_err(|e| format!("Cannot create {}: {e}", root.display()))?;
    let archive = root.join(format!("{folder}.zip{PARTIAL}"));
    let progress = |phase: &str, done: f64, total: f64, _: Option<String>, _: Option<String>| {
        emit(app, phase, part, done, total, None);
    };
    crate::llama_releases::download_with_progress(
        &release_url(&asset.asset),
        &archive,
        asset.size as f64,
        &progress,
    )
    .await
    .inspect_err(|_| {
        let _ = std::fs::remove_file(&archive);
    })?;
    emit(app, "verifying", part, 0.0, 0.0, None);

    let staging = root.join(format!("{folder}{PARTIAL}"));
    let expected = asset.sha256.clone();
    let unpacked = {
        let (archive, staging, dest) = (archive.clone(), staging.clone(), dest.clone());
        tauri::async_runtime::spawn_blocking(move || {
            let actual = sha256_file(&archive)?;
            if !actual.eq_ignore_ascii_case(expected.trim()) {
                return Err(format!(
                    "Checksum mismatch for {} (expected {expected}, got {actual})",
                    archive.display()
                ));
            }
            if staging.exists() {
                std::fs::remove_dir_all(&staging).map_err(|e| e.to_string())?;
            }
            crate::llama_releases::unzip_flat(&archive, &staging)?;
            let manifest: PackageManifest = serde_json::from_str(
                &std::fs::read_to_string(staging.join(MANIFEST))
                    .map_err(|e| format!("The package has no manifest: {e}"))?,
            )
            .map_err(|e| format!("Unreadable package manifest: {e}"))?;
            if !accept(&manifest) {
                return Err("The package does not match this build".into());
            }
            for (name, sha) in &manifest.files {
                if !is_plain_name(name) {
                    return Err(format!("Refusing the file name {name:?}"));
                }
                let actual = sha256_file(&staging.join(name))?;
                if !actual.eq_ignore_ascii_case(sha.trim()) {
                    return Err(format!("Checksum mismatch for {name}"));
                }
            }
            if dest.exists() {
                std::fs::remove_dir_all(&dest).map_err(|e| {
                    format!(
                        "Cannot replace {} (restart and try again): {e}",
                        dest.display()
                    )
                })?;
            }
            std::fs::rename(&staging, &dest)
                .map_err(|e| format!("Cannot move the package into place: {e}"))
        })
        .await
        .map_err(|e| e.to_string())
        .and_then(|result| result)
    };
    let _ = std::fs::remove_file(&archive);
    if unpacked.is_err() && staging.exists() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    unpacked
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file =
        std::fs::File::open(path).map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 16];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

/// Remove every add-on. What this process has loaded is marked and deleted at
/// the next start; returns whether anything waits for that.
pub fn remove(app: &AppHandle) -> Result<bool, String> {
    if INSTALLING.load(Ordering::Acquire) {
        return Err("An install is running".into());
    }
    let Some(root) = root_dir(app).filter(|root| root.is_dir()) else {
        return Ok(false);
    };
    let registered = REGISTERED.get().cloned().unwrap_or_default();
    let loaded = [registered.module_dir, registered.runtime_dir];
    let mut pending = false;
    let entries = std::fs::read_dir(&root).map_err(|e| e.to_string())?;
    for dir in entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
    {
        let in_use = loaded.iter().flatten().any(|path| *path == dir);
        if !in_use && std::fs::remove_dir_all(&dir).is_ok() {
            continue;
        }
        std::fs::write(dir.join(REMOVE_MARKER), b"")
            .map_err(|e| format!("Cannot mark {} for removal: {e}", dir.display()))?;
        pending = true;
    }
    Ok(pending)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_gpu_gets_its_own_module_first() {
        assert_eq!(pick_arch(&[75, 86, 89, 120], 86), Some(86));
        assert_eq!(pick_arch(&[75, 86, 89, 120], 120), Some(120));
    }

    #[test]
    fn a_missing_arch_falls_back_to_the_same_major_then_ptx() {
        // An RTX 3050 laptop (8.7) runs the 8.6 machine code natively.
        assert_eq!(pick_arch(&[75, 86, 120], 87), Some(86));
        // An RTX 4090 (8.9) with no 8.9 package: same major beats PTX.
        assert_eq!(pick_arch(&[75, 86, 120], 89), Some(86));
        // An RTX 5090 (12.0) with no Blackwell package: 8.9's PTX is JIT-compiled.
        assert_eq!(pick_arch(&[75, 86, 89], 120), Some(89));
    }

    #[test]
    fn a_card_older_than_every_module_gets_none() {
        // A GTX 1080 (6.1): CUDA 13 dropped Pascal.
        assert_eq!(pick_arch(&[75, 86, 89, 120], 61), None);
        assert_eq!(pick_arch(&[], 86), None);
    }

    #[test]
    fn commits_match_across_short_and_full_spellings() {
        let full = "60644e110908b042b5731d3e3d61ee23cf4c9021";
        assert!(same_commit(full, "60644e11"));
        assert!(same_commit("60644E11", full));
        assert!(!same_commit(full, "a0729fa5"));
        assert!(!same_commit(full, "unknown"));
        assert!(!same_commit(full, "6064"));
    }

    #[test]
    fn versions_compare_numerically() {
        assert!(version_key("13.10").unwrap() > version_key("13.9.1").unwrap());
        assert_eq!(version_key("13.3.1"), Some(vec![13, 3, 1]));
        assert_eq!(version_key(""), None);
        assert_eq!(version_key("13.x"), None);
    }

    #[test]
    fn asset_names_cannot_leave_the_folder() {
        assert!(is_plain_name("App-0.10.0-cuda13-sm86-windows-x64.zip"));
        assert!(is_plain_name("cublasLt64_13.dll"));
        assert!(!is_plain_name("../evil.dll"));
        assert!(!is_plain_name("sub/dir.dll"));
        assert!(!is_plain_name(r"C:\evil.dll"));
        assert!(!is_plain_name(".."));
        assert!(!is_plain_name(""));
    }

    #[test]
    fn the_index_parses_as_the_workflow_writes_it() {
        let index: AddonIndex = serde_json::from_str(
            r#"{
              "appVersion": "0.10.0",
              "engineCommit": "60644e110908b042b5731d3e3d61ee23cf4c9021",
              "platform": "windows-x64",
              "cudaVersion": "13.3.1",
              "runtime": {"asset": "App-0.10.0-cuda13-runtime-windows-x64.zip", "size": 400000000, "sha256": "ab"},
              "modules": [
                {"computeCapability": "86", "asset": "App-0.10.0-cuda13-sm86-windows-x64.zip", "size": 50000000, "sha256": "cd"}
              ]
            }"#,
        )
        .unwrap();
        assert_eq!(index.cuda_version, "13.3.1");
        assert_eq!(index.modules[0].compute_capability, "86");
        assert_eq!(megabytes(index.runtime.unwrap().size), 382);
    }

    #[test]
    fn a_module_manifest_names_its_engine() {
        let manifest: PackageManifest = serde_json::from_str(
            r#"{
              "backend": "cuda",
              "module": "ggml-cuda.dll",
              "computeCapability": "86",
              "cudaVersion": "13.3.1",
              "appVersion": "0.10.0",
              "appCommit": "91a17a10c",
              "engineCommit": "60644e110908b042b5731d3e3d61ee23cf4c9021",
              "files": {"ggml-cuda.dll": "00"}
            }"#,
        )
        .unwrap();
        assert!(manifest.is_module_for("60644e11"));
        assert!(!manifest.is_module_for("a0729fa5"));
    }

    #[test]
    fn a_runtime_package_is_found_by_major_and_version() {
        let root = std::env::temp_dir().join(format!("cuda-addon-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let dir = root.join("cuda-runtime-13.3.1");
        std::fs::create_dir_all(&dir).unwrap();
        for name in runtime_dlls(13) {
            std::fs::write(dir.join(name), b"").unwrap();
        }
        std::fs::write(
            dir.join(MANIFEST),
            r#"{"backend": "cuda-runtime", "cudaVersion": "13.3.1", "files": {}}"#,
        )
        .unwrap();
        assert_eq!(
            runtime_for(&root, "13.3.1").map(|(d, _)| d),
            Some(dir.clone())
        );
        assert_eq!(
            runtime_for(&root, "13.2").map(|(d, _)| d),
            Some(dir.clone())
        );
        // A module built with a newer CUDA needs a newer runtime than this one;
        // only a toolkit could still provide it, and its folder is never this one.
        assert_ne!(
            runtime_for(&root, "13.4").map(|(d, _)| d),
            Some(dir.clone())
        );
        // Marked for removal: no longer offered.
        std::fs::write(dir.join(REMOVE_MARKER), b"").unwrap();
        assert_ne!(
            runtime_for(&root, "13.3.1").map(|(d, _)| d),
            Some(dir.clone())
        );
        remove_marked(&root);
        assert!(!dir.exists());
        let _ = std::fs::remove_dir_all(&root);
    }
}
