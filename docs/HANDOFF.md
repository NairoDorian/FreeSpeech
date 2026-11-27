# Handoff

Rewritten at the end of every session (AGENTS.md, "Working as an agent
here"); `bun run brief` prints it. The history is in git.

## State on 2026-11-27

**FreeSpeech v0.10.0 is released**
(<https://github.com/NairoDorian/FreeSpeech/releases/tag/v0.10.0>): installers
and signed update packages for Windows x64 and ARM64, Ubuntu 22.04 and 24.04
(x64 and ARM64) and macOS (Apple Silicon and Intel), `latest.json`, and the
CUDA add-on (modules for sm_75, sm_86, sm_89, sm_120, the CUDA 13.3.1 runtime
and the index, rebuilt for engine `17a02066`, the engine the release shipped).

### Done in the last sessions

- The rename to FreeSpeech and the move to `NairoDorian/FreeSpeech` `main`.
- CUDA as a per-architecture add-on (`gpu_addons.rs`, `CudaAddon.tsx`, the
  onboarding step, `gpu-backends.yml`, [GPU_BACKENDS.md](GPU_BACKENDS.md)).
- Every platform builds on CI (the macOS overlay without `tauri-nspanel`,
  F21–F24 gated off macOS, GCC 12 on Ubuntu 22.04 with engine fix `9294084e`,
  empty `APPLE_*` variables dropped, the `@rpath` audit, installers without a
  key).
- `TAURI_SIGNING_PRIVATE_KEY` set (2026-11-26); a release signature verified
  against the updater key (key id `97D9DE5BD85CCABA`).
- NodeVibeCode habits: `bun run ci:status`, `bun run brief`, this file, the
  "Working as an agent here" rules.

### Waiting on the owner

1. **A Mac** to try the overlay: it compiles and bundles on CI but has not run
   on a Mac; a click on it activates the app and its corner radius is not
   applied ([KNOWN_ISSUES.md](KNOWN_ISSUES.md)). The macOS builds are ad-hoc
   signed and not notarized (first launch: right-click → Open).
2. **The release notes** of v0.10.0 are GitHub's generated ones; edit them on
   the release page if wanted.

### Next

- The next release: dispatch `release.yml`, check the draft (`gh release
view`), publish. CUDA add-ons come with it; `gpu-backends.yml` with
  `release-tag` rebuilds them for an existing tag.
- Clicking through the CUDA add-on's own install on the page: verified by a
  script doing what `install_package` does, not by the page itself (see
  Traps).
- CUDA add-on for Linux, a signature on the add-on index, ROCm
  ([GPU_BACKENDS.md](GPU_BACKENDS.md), "What is not done").
- From NodeVibeCode, not taken yet: a rolling Dev pre-release from every green
  `main`, and `cargo-deny`.
- tauri-specta PRs #293 and #294: when both merge, retire the fork.
- The Nix check stays red until bun2nix reads Bun's current lockfile.

### Verified, and how

- The published v0.10.0 Windows x64 app, unpacked with 7-Zip in portable mode
  on the maintainer's RTX 4070 Laptop GPU: CPU + two Vulkan devices out of the
  box; with the release's sm_89 module and runtime placed and checked as the
  app installs them, `CUDA add-on registered … (sm_89)`, a `kind=cuda` device,
  and `jfk.wav` transcribed identically on CUDA (74 ms) and CPU (1,186 ms).
- The updater in that app read the published `latest.json` and found no newer
  version.
- `FreeSpeech_0.10.0_x64-setup.exe.sig` verified (Ed25519 over BLAKE2b-512)
  against `plugins.updater.pubkey`.

### Traps found

- **CI used to build the remote's newest engine**, not the committed pin (the
  tauri runner moved it): the installers and the CUDA modules then disagreed.
  Fixed (`a73a173b5`); move the pin in a commit.
- **The release build's WebView2 ignores `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`**
  (its browser process runs only Tauri's own arguments), so the CDP recipe
  works for dev builds only. The maintainer's Chrome may also hold a debugging
  port (9333 seen): pick a free one and accept only `tauri://` targets.
- **windows-latest is Visual Studio 2026**: CUDA 13.3's `cudafe++` crashes on
  it, so CUDA jobs use `windows-2022`.
- `check:identity` scans tracked files only: stage new files before trusting a
  green gate.
- `../transcribe-fork` holds another session's uncommitted work and moves fast
  (six engine commits landed during one release). Never discard that work;
  read `git log origin/main` before pinning.
