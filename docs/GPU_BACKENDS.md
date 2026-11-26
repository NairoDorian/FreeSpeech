# GPU backends: a light installer, CUDA as an add-on

The maintainer asked (2026-11-26) for CUDA and Vulkan releases without every
download carrying every CUDA architecture: a light install that detects the
machine and offers the GPU files it can use. This is how it works.

## Why it needs no new engine machinery

The engine is built with `dynamic-backends` on Windows x64 and Linux: every
ggml backend is a module (`ggml-cpu-<isa>.dll`, `ggml-vulkan.dll`,
`ggml-cuda.dll`) loaded at startup, not linked into the app.
`transcribe_cpp::init_backends_default()` (called by `init_transcribe_backend`
in `managers/transcription.rs`) registers the modules beside libtranscribe;
`transcribe_cpp::init_backends(dir)` registers the modules of another folder,
once per folder, before the first model load. A module is tied to the ggml core
of the engine commit it was built from (an op added upstream renumbers the
enum every backend switches on), and to nothing else.

So a release is split by what it costs:

| Part                          | Size                              | Who gets it                              |
| ----------------------------- | --------------------------------- | ---------------------------------------- |
| The installer                 | ~20 MB (Windows x64 `-setup.exe`) | everyone                                 |
| CPU modules, every ISA        | inside the installer              | everyone (the best one is picked)        |
| Vulkan module                 | inside the installer              | everyone; any recent GPU                 |
| Metal                         | inside the macOS build            | every Mac                                |
| CUDA module                   | one package per architecture      | NVIDIA owners who want CUDA              |
| CUDA runtime (cudart, cuBLAS) | one package, ~380 MB zipped       | once, unless a CUDA toolkit is installed |

The runtime is most of CUDA's weight and the same for every architecture, so it
is its own package: an app update brings a new module (it is tied to the engine
commit) but reuses the runtime already installed. NVIDIA's CUDA EULA lists
cudart and cuBLAS among the redistributable files.

## The packages: `.github/workflows/gpu-backends.yml`

`release.yml` calls it for every release (it also runs by hand, with or
without a release tag):

- **module**, one Windows job per compute capability (default `75 86 89 120`:
  RTX 20 / GTX 16, RTX 30, RTX 40, RTX 50; CUDA 13 dropped everything older
  than 7.5): the app built with `TRANSCRIBE_CUDA_ARCHITECTURES=<cc>`, so
  `ggml-cuda.dll` holds that architecture's machine code and its PTX, which a
  newer card's driver compiles on first load. Package:
  `<Name>-<version>-cuda13-sm<cc>-windows-x64.zip` with the DLL and a
  `manifest.json` (compute capability, CUDA version, app version and commit,
  **engine commit**, SHA-256 of the DLL).
- **runtime**: `cudart64_13.dll`, `cublasLt64_13.dll`, `cublas64_13.dll` from
  the same toolkit, with their SHA-256 in its manifest.
- **index**: `<Name>-<version>-cuda-addons-windows-x64.json` with the CUDA
  version, the engine commit, and each package's asset name, size and SHA-256.
  Published even when one architecture failed, listing what exists.

All of it is attached to the release (`gh release upload`), or kept as
workflow artifacts when no tag is given.

## The app side: `src-tauri/src/gpu_addons.rs`

The Advanced page shows a **CUDA acceleration** row (`CudaAddon.tsx`) only on a
machine with an NVIDIA GPU or an installed add-on:

1. **Detect** (`get_cuda_addon_status`, when the page opens): NVML lists the
   GPUs with their compute capability and the driver's CUDA version.
2. **Look up**: the index from the release of the app's own version
   (`<repo>/releases/download/v<version>/…`, one small download, cached ten
   minutes). No index (a 404) means nothing is published for this version;
   an index for another engine commit (a development build carrying a
   release's version) is refused.
3. **Offer**: the card's own module; else the newest one below it of the same
   major (its machine code runs natively); else the newest one below it (its
   PTX). With the size of the module, plus the runtime's when neither an
   installed runtime package nor a CUDA toolkit of the same major provides
   the three DLLs. A driver whose CUDA is older than the add-on's major is
   told to update.
4. **Install** (`install_cuda_addon`, progress as `CudaAddonEvent`): download
   with the Local LLM page's downloader, check the archive's SHA-256 against
   the index, unpack into a staging folder, check the manifest (backend,
   compute capability, engine commit) and every file's SHA-256, then move it
   to `<app data>/gpu-backends/cuda-sm<cc>-<engine>/` (and
   `cuda-runtime-<version>/`). Never into the install folder: a per-machine
   install is not writable.
5. **Register at the next start** (`register_installed`, right after
   `init_transcribe_backend`): unless CUDA is already compiled in, preload the
   runtime DLLs by full path (`LoadLibraryExW` with
   `LOAD_WITH_ALTERED_SEARCH_PATH`; ggml loads a module with a plain
   `LoadLibraryW`, whose dependency search never looks in the module's own
   folder, but a DLL already loaded under the same name is used wherever it
   came from), then `init_backends(<module folder>)`. A module that registers
   no CUDA device is reported on the page ("did not start") with the reason
   in the log; the run falls back as before (Vulkan, then CPU).
6. **Remove**: deletes what is not loaded; what is loaded gets a `.remove`
   marker and is deleted at the next start, before anything registers.

Folder names carry what makes a package unique (architecture and engine
commit, runtime version), so a new version installs beside the one this
process has loaded; installing a module removes the other modules that are not
loaded.

## What is not done

- **Linux packages.** Same recipe on `ubuntu-22.04` (GCC 12, see `build.yml`)
  with `libggml-cuda.so` and `libcudart.so.13` / `libcublas*`; the app side
  already names the Linux libraries (`runtime_dlls`) but `PLATFORM` is
  Windows-only until the workflow publishes them, and the preload would use
  `dlopen(RTLD_GLOBAL)`.
- **A signature.** Integrity rests on HTTPS and the SHA-256 published in the
  same release, like the installer download itself and the llama.cpp builds
  the Local LLM page installs. Signing the index with the updater key
  (`minisign-verify` is already in the dependency graph through the updater
  plugin) would make it authentic, not just intact.
- **ROCm/HIP** for AMD would be one more matrix of the same workflow.
- **An onboarding step**: the offer could also appear in first-run onboarding
  for an NVIDIA machine; today it is on the Advanced page.

## Costs

The installer does not grow. Each module job is one Windows runner (CUDA
toolkit install, an app build, one architecture's kernels); the jobs run in
parallel and only for a release or by hand, so the main build never waits on
CUDA. In the app: one `is_dir` at startup when no add-on was ever installed;
with one installed, loading the runtime and the module, which initialises the
CUDA driver (about 0.1–0.3 s), exactly what a CUDA build pays already. The
status (NVML plus the cached index) is read only when the Advanced page opens.
