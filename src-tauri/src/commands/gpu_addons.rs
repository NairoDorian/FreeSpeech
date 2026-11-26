//! Tauri commands for the CUDA add-on (see `gpu_addons.rs`).

use tauri::AppHandle;

use crate::gpu_addons::{self, CudaAddonStatus};

/// The GPU, the installed add-on and what an install would download.
/// `force` skips the ten-minute cache of the release's add-on index.
#[tauri::command]
#[specta::specta]
pub async fn get_cuda_addon_status(app: AppHandle, force: bool) -> CudaAddonStatus {
    gpu_addons::status(&app, force).await
}

/// Download, check and unpack the add-on for compute capability `arch` (and
/// the CUDA runtime when none is here). Progress arrives as `CudaAddonEvent`;
/// it runs to completion in the background, so the page can be left.
#[tauri::command]
#[specta::specta]
pub async fn install_cuda_addon(app: AppHandle, arch: String) -> Result<(), String> {
    if !gpu_addons::begin_install() {
        return Err("An install is already running".into());
    }
    tauri::async_runtime::spawn(async move {
        let _ = gpu_addons::install(app, arch).await;
    });
    Ok(())
}

/// Remove every add-on. Returns whether some of it was loaded and is only
/// deleted at the next start.
#[tauri::command]
#[specta::specta]
pub async fn remove_cuda_addon(app: AppHandle) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || gpu_addons::remove(&app))
        .await
        .map_err(|e| e.to_string())?
}
