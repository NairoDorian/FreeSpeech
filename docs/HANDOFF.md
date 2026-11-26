# Handoff

Rewritten at the end of every session (AGENTS.md, "Working as an agent
here"); `bun run brief` prints it. The history is in git.

## State on 2026-11-26, `main` at `cf9321be3`

### Done in this session

- **CUDA as an add-on** (`14000bb7d`): installers stay CPU + Vulkan;
  `gpu-backends.yml` (called by `release.yml`) builds one `ggml-cuda` module
  per architecture (75 86 89 120), the cudart + cuBLAS runtime and an index;
  the Advanced page and a first-run onboarding step offer and install the
  right ones, and the next start registers them (`gpu_addons.rs`, `CudaAddon.tsx`,
  [GPU_BACKENDS.md](GPU_BACKENDS.md)).
- **NodeVibeCode habits**: `bun run ci:status [-- --wait]`, `bun run brief`,
  this file, and the "Working as an agent here" rules in AGENTS.md.
- **macOS compiles again** (`27578f114`): the overlay no longer uses
  `tauri-nspanel` (no Tauri 3 release); `objc2` sets level and Spaces.
- **Builds without the updater key ship installers** (`a671ea5ce`); releases
  still require the key (`FREESPEECH_REQUIRE_UPDATER_SIGNATURE`).
- **Ubuntu 22.04** builds with GCC 12 (the engine is C++23, `<expected>`),
  and the engine's Earshot AVX operators moved out of their classes so GCC 12
  compiles them (engine `9294084e`, pushed under the engine authority, pinned
  in `113ead482`); BUILD.md and CONTRIBUTING.md clone FreeSpeech, not S2B2S.
- **macOS**: `enigo::Key::F21`–`F24` gated off macOS (`699216f59`), the
  second compile error the panel fix uncovered.
- **CI on `0d9effd53`: six of seven builds green**, Apple Silicon macOS and
  Ubuntu 22.04 included, each uploading its installers. The macOS bundle step
  needed empty `APPLE_*` variables dropped by the tauri runner (Tauri imported
  an empty certificate). Intel macOS built and bundled too, then failed
  `build.yml`'s own `@rpath` audit, whose `grep` exits 1 on a static binary
  with no `@rpath` dependency; fixed in `cf9321be3` (awk instead).
- **CI on `cf9321be3`: all seven builds green** (run 45867130170), the first
  fully green main build: Windows x64 and ARM64, Ubuntu 22.04 and 24.04 (x64
  and ARM64), macOS Apple Silicon and Intel, each with its installers as
  workflow artifacts (30 days).

### Waiting on the owner

1. **The updater signing secret**, which only the owner can upload:
   `gh secret set TAURI_SIGNING_PRIVATE_KEY -R NairoDorian/FreeSpeech < <key file>`,
   where the key file is the one the tauri runner finds in `~/.tauri/` (its
   name is in AGENTS.md's Windows platform notes).
   Until then main builds have no update packages and a release stops at
   signing, by design.
2. **The first release** (`release.yml`, dispatched by hand). It now runs
   `gpu-backends.yml` too, which has never run: expect a fix or two (the CUDA
   13.3.1 network install on `windows-latest`, `ggml-cuda.dll` in
   `src-tauri/transcribe-libs/`, `gh release upload` on a draft release).
3. **A Mac** to check the overlay: it compiles on CI but is unverified; a click
   on it activates the app and the corner radius is not applied
   ([KNOWN_ISSUES.md](KNOWN_ISSUES.md)).
4. **An NVIDIA machine** to install the CUDA add-on once a release has
   published it (the code paths are unit-tested; the download and the
   registration have not run for real).

### Next, in order

- The macOS builds are ad-hoc signed and not notarized: first launch needs
  right-click → Open (README, "First launch"), until Apple secrets exist.
- CUDA add-on: Linux packages; sign the index with the updater key
  (`minisign-verify` is already in the graph).
- From NodeVibeCode, not taken yet: a rolling Dev pre-release from every green
  `main` (its `publish-lane.yml` pattern), and `cargo-deny`.
- tauri-specta PRs #293 and #294: when both merge, retire the fork
  ([FORKS.md](FORKS.md)).
- The Nix check stays red until bun2nix reads Bun's current lockfile.

### Verified, and how

- `gpu_addons` unit tests (9) on the CPU lane; clippy clean on Windows;
  `bindings.ts` regenerated from a debug build in portable mode.
- `tests/cuda-addon.spec.ts` (4 states of the panel) in Chromium, plus a
  screenshot of the offer.
- The gate on every commit; CI for `14000bb7d`: code quality, Playwright and
  the Rust tests green, Nix red (known), app builds cancelled by the next push.

### Traps found

- `check:identity` scans tracked files only: a gate run before `git add` of a
  new file passes, then the commit hook fails on it. Stage new files first.
- The Playwright mock copies `__TAURI_MOCK_IPC__` when it loads; a test's own
  answers go in `__TAURI_MOCK_REPLIES__`, read at call time.
- ggml loads a backend module with a plain `LoadLibraryW`, which never searches
  the module's own folder for its imports: dependencies must already be
  loaded (that is why the CUDA runtime is preloaded by full path).
- The Bash tool's heredocs drop a backslash (`\\|` became `|`, `\` plus newline
  vanished): write patch scripts with the Write tool.
- `../transcribe-fork` holds about 40 uncommitted files from another session
  (CMakeLists, `earshot.rs`, the sys `build.rs`, tests). Never discard them.
