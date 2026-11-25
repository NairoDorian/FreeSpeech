# Giving ZER0 a voice: audio.cpp, and the road to FreeSpeech (2026-11-25)

> Written after a checkpoint of the speech-engine work outside this repository. **Nothing in ZER0 was changed by that work except this note and one pointer to it in `AGENTS.md`.** Every app-side step below is _to do when the user asks for it_.

## 1. Decisions (the user, 2026-11-25)

- **ZER0 becomes FreeSpeech.** There is no separate FreeSpeech app: ZER0 evolves, gains a voice (text-to-speech), and is renamed FreeSpeech later. The rename goes through `scripts/app-meta.ts` + `bun run meta:sync`, never by hand-editing names.
- **speech.cpp is retired.** It tried to merge transcribe.cpp and audio.cpp into one C++ engine (a fork of audio.cpp absorbing the transcribe.cpp fork). The checkpoint measured why that could not work for one person:
  - in two months audio.cpp moved 593 commits and the fork 132, while speech.cpp moved none;
  - both engines already embed cleanly through their own C APIs.
    The user deletes the `NairoDorian/speech.cpp` GitHub repository and the local `Unified_Audio.cpp` workspace.
- **ZER0 composes the engines in Rust.** Each engine is improved where it lives:

| Job                                                                                                           | Engine                        | Rust crate                                    | Improved in                                               |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------- | --------------------------------------------- | --------------------------------------------------------- |
| Speech-to-text, VAD gate, denoise, language ID, streaming                                                     | transcribe.cpp (the fork)     | `transcribe-cpp` (as today)                   | the fork: `C:/Users/Z/Downloads/PROJECTS/transcribe-fork` |
| **Text-to-speech, voice cloning**; later turn detection, wake words, enhancement, a second STT implementation | audio.cpp (0xShug0, upstream) | **`audiocpp`** from `NairoDorian/audiocpp-rs` | pull requests to audio.cpp                                |
| The "brain"                                                                                                   | llama.cpp                     | as today                                      | —                                                         |

## 2. The new crate: audiocpp-rs

- Local checkout: `C:/Users/Z/Downloads/PROJECTS/audiocpp-rs`. GitHub: `NairoDorian/audiocpp-rs` (being created).
- It contains:
  - `audiocpp-sys`: builds audio.cpp **v0.9.6** (its release lane, a pinned submodule) into one shared library with only the families enabled as features (`model-kokoro_tts`, `model-kitten_tts2`, …; 145 of them);
  - `audiocpp`: the safe API (`Registry`, `Model`, `Session`, `Request`, `TaskResult`, `Stream`).
- Verified there on Windows (CPU) on 2026-11-25: tiny_voca TTS, and a TTS → ASR round trip through SenseVoice. See its CHANGELOG.
- Read its `README.md`, `AGENTS.md` and `docs/coexistence.md` before linking it.

Usage shape:

```toml
audiocpp = { git = "https://github.com/NairoDorian/audiocpp-rs", rev = "<commit>", features = ["model-kokoro_tts"] }
```

```rust
let registry = audiocpp::Registry::new()?;
let model = audiocpp::Model::load(&registry, path, &Default::default(), &audiocpp::Options::new())?;
let mut tts = model.session(&audiocpp::Task::Tts, audiocpp::Mode::Offline, &audiocpp::Backend::cpu().threads(4), &audiocpp::Options::new())?;
let mut req = audiocpp::Request::new();
req.text("Hello")?.voice_id("af_heart")?;
let result = tts.run(&req)?;            // keep `tts` warm and reuse it
let audio = result.audio().unwrap();    // &[f32] + sample_rate + channels → rodio
```

## 3. Rules for the integration

- **One static ggml at most.** `audiocpp` is always a shared library (`audiocpp.dll`), which keeps its ggml private. `transcribe-cpp` may stay static. If llama.cpp ever moves in-process, it must be shared too: two static ggml copies collide at link time.
- **Bundle the library.** Copy `audiocpp.dll` (`libaudiocpp.so`, `libaudiocpp.dylib`) next to the executable in the Tauri bundle. `audiocpp-sys` exposes its folder as `DEP_AUDIOCPP_LIB_DIR` to the build script of any package that depends on it directly. On Windows, the default `openmp` feature also needs `vcomp140.dll`, which is in the VC++ redistributable.
- **Performance (docs/PERFORMANCE.md):**
  - TTS runs on its own worker thread, never on the audio thread.
  - The TTS `Session` stays warm between utterances.
  - Thread budgets are split between STT and TTS (both may run during a conversation).
  - Measure time to first audio, and prefer streaming TTS where a family supports it (`model.supports(&Task::Tts, Mode::Streaming)`).
  - State each new thread's cost in the commit.
- **Logging (docs/LOGGING.md):** route audio.cpp's lines through `audiocpp::logging::set_log_callback` into ZER0's log macros, tagged as audio.cpp.
- **Models:**
  - ZER0's model manager downloads TTS models like STT models, pinned by sha256: many audio.cpp specs track a branch, not a revision.
  - `model.options(OptionScope::Request)` lists every option a model declares (voices, speed, …), so settings UIs need no per-family code.
- **Licences:** prefer families with their own text frontend. eSpeak-ng (GPL) stays out unless the user decides otherwise (`gpl-espeak`). Read each model card's weight licence before shipping it.
- **Option names come from the model.**
  - Session options carry a family prefix (`sense_asr.vad_model_path`).
  - audio.cpp silently ignores an unknown session key.
  - Always take names from `model.options(scope)`.
- **ASR families with VAD chunking** load Silero from a path relative to the working directory by default, which fails inside an app. If ZER0 ever runs audio.cpp ASR (phase F):
  - ship audio.cpp's `assets/framework/models/silero_vad/` (1.2 MB) and pass its absolute path, or use `audio_chunk_mode=fixed`;
  - feed 16 kHz to the VAD chunker.
- **CPU contention is costly.** With 8 OpenMP threads on a small model, one preempted thread stalls the rest. On 2026-11-25 the same tiny_voca sentence took 2–42 s while another process loaded the CPU. ZER0 runs STT, TTS and the UI together: give each engine its own thread budget, and measure under realistic load.

## 4. Plan (when the user asks)

| Phase                | Work                                                                                                                                                                                                                                                                                                               | Gate                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| A. Dependency        | Add `audiocpp` (git + rev) with one small TTS family. Bundle the DLL on Windows, then macOS and Linux.                                                                                                                                                                                                             | ZER0 builds and starts with the library in the bundle                 |
| B. First voice       | A `tts` module: load, synthesize, play through rodio. One user action that reads text aloud (e.g. the last transcription).                                                                                                                                                                                         | Measured time to first audio and RTF on CPU, Vulkan and CUDA          |
| C. Choose the voices | Measure the candidates with the protocol below: kokoro_tts, kitten_tts2, pocket_tts / pocket_tts_small, tiny_voca, supertonic, qwen3_tts and chatterbox / chatterbox_turbo (cloning), voxtral_tts, … Criteria: quality, RTF, time to first audio, round-trip WER through transcribe-cpp, languages, size, licence. | A short results table in `docs/`; the chosen features in `Cargo.toml` |
| D. Conversation      | Stream TTS output; barge-in (stop speaking when the user talks); the loop VAD → STT → LLM → TTS, which was S2B2S's goal. audio.cpp's `smart_turn` for end-of-turn and its wake-word families are options.                                                                                                          | Latency gates: end of speech → first audio                            |
| E. FreeSpeech        | The rename (`scripts/app-meta.ts`); Android after audio.cpp builds with the NDK (a PR upstream)                                                                                                                                                                                                                    | —                                                                     |
| F. Second STT engine | audio.cpp also runs parakeet, qwen3_asr, cohere, canary, gigaam, moonshine, nemotron, sense_asr, … Where both engines have a family, measure both; if audio.cpp wins somewhere, Multi-STT can use it as an extra engine.                                                                                           | A per-family comparison table                                         |

**Measurement protocol:**

- At least 3 runs; run 1 is the warm-up (reported, not averaged); report the mean of runs 2..N.
- Use the same machine, threads, backend and audio for every arm.
- Develop on CPU first, then confirm on CUDA, Vulkan (NVIDIA) and Vulkan (Intel).
- Use a multilingual subset (FLEURS) where the model is multilingual.

## 5. Open items found during the checkpoint

- **The fork, Windows build bug.** ggml's `GGML_CCACHE` hook wraps the resource compiler in sccache, which cannot run it, so the fork's version resource fails to build whenever sccache is on `PATH`. The fix is to set C/C++ compiler launchers instead (`audiocpp-sys/build.rs` shows how).
- **The fork, upstream commits.** _Corrected 2026-11-25:_ the fork already contains the official ggml 1.0.0 (#262), Parakeet phrase boosting (#221) and the Windows DLL lookup fix (#264). The handoff to the fork's agent is `transcribe-fork/docs/plans/2026-11-25-speechcpp-archive-handoff.md`.
- **audio.cpp fixes prepared** on `NairoDorian/audio.cpp` (working copy `../audiocpp-fork`; notes in its untracked `pr-notes/`). None is opened upstream yet. The first two are the section 3 VAD rules:
  - `framework-bundled-asset-path`: the default VAD is found beside `audiocpp.dll`, so default SenseVoice requests stop failing inside an app;
  - `silero-vad-offline-resample`: VAD chunking accepts 24, 44.1 and 48 kHz input;
  - `ggml-cpu-msvc-barrier`: `pause` and a bounded yield in ggml's thread-pool barrier with MSVC (benchmark pending).
- **audio.cpp pull-request candidates** (`audiocpp-rs/docs/upstream.md`):
  - install rules and a link manifest for its C API;
  - the Rust bindings;
  - an Android build lane;
  - UTF-8 paths on Windows (already proposed upstream by another contributor: #777).
- **The speech.cpp v7 history** (866 commits) survives only in `Unified_Audio.cpp/_archive/speech.cpp-v7-history.git` once the GitHub repository is deleted. Copy that folder elsewhere first if it should be kept. It holds work that could still feed audio.cpp PRs: Whisper, moonshine_streaming, canary_qwen, granite_nar and medasr engine ports, and a ggml patch stack.
