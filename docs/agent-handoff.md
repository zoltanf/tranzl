# Agent handoff: unified inference and multiplatform support

Updated: 2026-09-29. Code checkpoint: Stage C complete at `3259672` on `codex/unified-inference-evaluation` (Stage B was `b43d77b`). This handoff is committed after that checkpoint. Read this file, then the documents linked below, before changing code.

## User intent and working rules

The user wants one codebase supporting macOS ARM64, Windows x64, Linux x64 **and Linux ARM64**. They explicitly prioritized evaluating one inference runtime, adopting it if the gates passed, and only then proceeding with portability. They also welcome changes to internal build, test and release processes that make targeting multiple platforms easier.

- Do not use subagents unless the user directly requests them.
- Continue in reviewable stages, preserving the current Mac experience and user data.
- Never test against the normal writable user profile. Reuse explicitly selected existing model assets read-only; use temporary profiles and synthetic content.
- Do not treat build success or mocked tests as native inference certification.
- No framework rewrite, model change, sync feature, Windows ARM64 or Intel Mac scope is authorized by this project.
- Release 0.2.3 was separately requested and completed before integration. Stage B is development work, not a new release. Do not run the publishing script as a validation command.

## Read these documents in order

1. [Requirements and acceptance IDs](multiplatform-requirements.md): authoritative scope and gates.
2. [Implementation plan](multiplatform-plan.md): stage tracking and detailed work for C–F.
3. [Runtime evaluation and integration evidence](runtime-evaluation.md): adoption decision, measurements and limitations.
4. [README](../README.md): current source behavior and validation entry points.

The plan's “Starting point” and older dependency references describe the pre-migration baseline. The worker and `node-llama-cpp` no longer exist in current production code. Follow the A–F tracking table rather than reading historical phases as completed work.

## Git and release history

| Commit | Result |
| --- | --- |
| `836de43` | Requirements and plan: evaluate a unified runtime before portability |
| `b1ea1b3` | Released 0.2.3 with clipboard-manager image support, image translation/reasoning fixes and shared sanitized Markdown output |
| `da55759` | Stage A: isolated A/B evaluation, managed server prototype, lifecycle tests and adoption evidence |
| `b43d77b` | Stage B: production integration, verified resumable asset acquisition, removal of old worker/dependency, packaged validation |

Release: https://github.com/zoltanf/tranzl/releases/tag/v0.2.3 . Homebrew tap was updated and verified. Release ZIP SHA-256: `b5b67faa31c930fe7b9bc405aea90b62057239655a4c7f29ed4bf7aac3bc52c0`.

At handoff preparation, `origin/main` remained at `b1ea1b3`; the feature branch had been committed locally but had not yet been pushed. The handoff delivery includes a normal push of the feature branch and a remote-head verification. Check `git status --short --branch` and `git ls-remote` on resumption; use the feature branch, not `main`. No merge, PR, new tag or new release is part of this handoff. Package version remains 0.2.3 intentionally.

## Completed: Stage A — evaluation

Compared the old worker with a managed llama.cpp server using the same immutable Gemma model, context and synthetic prompts. Separate source and ad-hoc-signed evaluation applications used temporary profiles. Packaged baseline passed 14/14 cases; server candidate passed 17/17 including media. Tests cover translation, editing, reasoning, recall, isolation, counting, measured text context, near-limit compaction, cancellation and recovery.

On Apple M5 Pro / 64 GiB / macOS 26.7 (Darwin 25.6), Electron 44.4.5:

- Median warm generation: worker 71.27 vs server 70.81 tok/s.
- Median first token: 16.00 vs 17.04 ms.
- Peak summed text RSS: 5.64 vs 5.55 GiB.
- Fresh-process load: 8.02 vs 0.76 s. Hashing warmed filesystem caches, so this is **not disk-cold** performance.
- Native startup diagnostics confirmed 43/43 layers offloaded and Metal warmup. CPU model-buffer presence alone does not establish CPU inference.

Decision: adopt. Full sliding-window caching (`--swa-full`) resolved a first-token regression caused by compact cache restoration. See the evidence document for methodology, limitations and original JSON reports.

## Completed: Stage B — integrated runtime

| File | Responsibility |
| --- | --- |
| `src/backends/local.js` | Lazy production facade; no Electron path lookup or embedded startup merely from selecting an external backend |
| `src/backends/embeddedBackend.js` | One runtime instance, model/status lifecycle, preload, chat, token counting and release |
| `src/backends/serverRuntime.js` | Owns one authenticated loopback child and serialized request queue; streaming, token counts, context telemetry, cancellation and cleanup |
| `src/backends/embeddedAssets.js` | Immutable model/projector/runtime identities, existing-cache verification, staged runtime extraction/replacement and lazy media acquisition |
| `src/backends/verifiedAssets.js` | SHA-256 verification with metadata-based memoization, resumable downloads, size/range validation and promotion after verification |
| `src/backends/runtime-manifest.json` | Per-target (`<os>-<arch>`) runtime pins: compute variants, archive URL/size/hash, archive format/root, executable, notices and companion-library hashes derived from the checksum-verified upstream archive (C1) |
| `src/main.js` | All embedded generation/compaction/counting routes use the facade; quit aborts work and waits for server cleanup |
| `scripts/evaluate-runtime.cjs` | Explicit-path, isolated real-model harness; worker baseline, direct server and integrated embedded modes |
| `scripts/package-evaluation.cjs` | Separate evaluation app identity/entry point; does not install or publish |

Removed `localWorker.js`, the old `multimodal.js`, `node-llama-cpp`, and old live tests that used the normal profile. Their functionality is replaced by the shared runtime, downloader and isolated harness. Preserve existing IPC semantics, data formats, model label, legacy model filename and cache directory.

Asset preparation occurs inside the runtime queue. Text starts without a projector. First media use prepares the projector, waits for the old server to exit and starts the media-capable server. Subsequent text reuses it. The server uses localhost only, a random per-process API key, one slot, no web UI and `--offline`. Raw runtime logs/prompts are not retained.

Downloader behavior: verify cached files, resume `.part` bytes, handle servers ignoring Range by restarting the partial file, reject wrong ranges/oversized results, preserve interrupted data, reject bad hashes and promote only verified bytes. Runtime extraction uses a staging directory and preserves/restores the prior installation on replacement failure. All listed companion libraries are verified, not just the small executable launcher.

## Validation completed at the code checkpoint

- Full `npm test`: 66/66 passed. One additional acquisition-shutdown test was then added; all 14 server tests passed, giving 67 current tests. A second full-suite run after that test-only addition was not needed/performed.
- `npm run test:electron`: passed from source and against product-package files/dependencies.
- Source integrated offline harness: 17/17 passed.
- Fresh runtime download into a temporary profile, archive/library verification and integrated real inference: 17/17 passed.
- Ad-hoc-signed integrated evaluation package outside the checkout, with non-loopback fetch forbidden: 17/17 passed.
- `npm run pack`: product app built; ad-hoc signature verified; about 377 MiB on disk.
- Product inventory and lockfile contain no old inference dependency. Production package contains no dev-only `undici`.
- `npm audit`: zero advisories after a compatible transitive `undici` patch update.
- `git diff --check`: passed; code checkpoint was clean after commit.

Tracked evidence is under `docs/runtime-evidence/2026-09-29/`: `worker.json`, `server.json`, `native-startup.json`, `integrated-download.json`, `integrated-packaged.json`, and `integration-inventory.json`. Reports were captured before their corresponding commits, so dirty-file lists are expected; source hashes identify the tested files.

Limits: packaged UI checks use a mocked model; real inference runs separately through the packaged production facade. Fresh acquisition fetched the small runtime and reused the verified model/projector. Full model download failures use small deterministic fixtures, not a second 4.6 GB download. No clean-machine installer/upgrade certification, Windows/Linux native checks, new real LM Studio/Ollama checks, low-memory validation or cross-platform GPU certification has been done.

## Remaining work — Stage C done; start with Stage D

### C: portable foundations (done on Mac ARM64)

1. **Done (C1).** `runtime-manifest.json` is keyed by target and records OS/architecture, compute variants, immutable URL/size/hash, archive format/root, executable, notices and companion libraries; tests check every listed target is complete and includes a CPU path. Only `darwin-arm64` is listed. Other targets fail with a clear message. Extraction goes through a per-format adapter; only `tar.gz` (via `/usr/bin/tar`) exists. Windows `.zip` and Linux entries are added in Stage D along with native validation. The install directory (`multimodal/llama-b11158/`) and cached archive name are unchanged, so existing runtimes are reused. Verified offline: the pinned archive was extracted into a temporary directory through the new path, all files were verified and the binary ran.
2. **Done (C2).** `npm run pack` now runs `scripts/pack.cjs`: a Node packager for the host OS/architecture only, with explicit per-OS icon and signing adapters (only macOS ad-hoc `codesign` exists; other OSes are built unsigned with a warning). `pack:evaluation` reuses it. The Mac package was checked against the previous CLI command. It has the same 1,685-file set and identical non-signed contents, apart from `package.json`, and the signature verifies. Packaged `test:electron` passed. `npm test`/`test:electron` were already portable entry points. Their macOS-tool fixtures are C6. `install-app` stays an explicitly Mac-only adapter. `scripts/release.sh` (build + publish + tap) is unchanged until Stage F separates build from publication. Clean installs use `npm ci` (README); CI enforcement is Stage F.
3. **Done (C3).** `src/secureStore.js` is the shared store for `history.enc` and `chats.enc`. `storageStatus()` requires `isEncryptionAvailable()` and rejects Linux `basic_text`. `load()` distinguishes a missing file (persistent, empty) from unreadable data (decrypt/parse/read failure). Unreadable data returns memory-only with an error and blocks every later save in that process, including a save before load. Saves write a `0600` temp file, fsync it and rename it. On failure they remove the temp file, keep the previous file and return an error. Fixed a real data-loss bug: an undecryptable `history.enc` used to be overwritten by defaults on the next history entry. The renderer now skips saves while not persistent. Chat stays usable in memory with the error shown, instead of becoming unusable. The history dialog shows a "Temporary history" label, and legacy localStorage migration waits until storage is persistent. Tests (`tests/secure-store.cjs`) drive the real IPC handlers of both stores. They cover restart, delete, legacy format, locked keyring, save-before-load, no encryption, `basic_text`, write/rename failure and unreadable non-ENOENT files. `chat-ui.cjs` checks that the UI is visibly temporary and does no saves. Follow-up (after C7): recovery actions. `load()` reports `canRetry`/`canReset`:
   - unreadable ciphertext or read error: both;
   - decrypted but damaged JSON: reset only;
   - no protected storage: retry only.

   `reset(data)` reloads first, refuses if the file is readable again or storage is unavailable, and renames the file to `<name>.unreadable-YYYYMMDD-HHMMSS[-n].enc` (local time, never overwriting an earlier backup). Only then does it save the current in-memory data. A failed rename changes nothing and keeps saves blocked. `registerStore()` gives both stores `<prefix>-load/-retry/-save/-reset/-reveal-backup` IPC. "Show old file" uses the main-side backup path only; the renderer never supplies a path. The UI (Chat sidebar and History dialog) shows Try again / Start fresh… / Show old file as applicable. Try again merges the saved data with work done while temporary, and legacy localStorage migration runs only once history is persistent. Tests: `secure-store.cjs` (store and IPC) and `chat-ui.cjs` (buttons, confirmations, merge, saves resuming). Verified in the real app over a local DevTools port, using a test profile with corrupt files. Start fresh kept both files byte-for-byte, wrote new `v10`-encrypted `0600` files, and a restart read them normally. Still not done: a real-keychain *lock* test (tests use a synthetic safeStorage), and Windows rename/ACL behavior (Stage D).
4. **Done (C4).** `src/profile.js` `selectProfile()` runs at the top of `src/main.js`, before any other module loads. Without `TRANZL_TEST_PROFILE` it pins the normal `<appData>/tranzl` profile, as before. With it, the path must be absolute and must not equal, contain or lie inside the normal profile. Symlinks are resolved through the nearest existing ancestor before anything is created, and the comparison is case-insensitive except on Linux. A refused path exits with code 2. An accepted directory is created with mode `0700`. Unit tests are in `tests/profile.cjs`. Verified with the real source app: a test profile at a path with a space and a non-ASCII character received all Chromium state, `settings.json` and `chats.enc`. None of the 145 entries in the normal profile changed (name/mtime/size), and a path inside the normal profile was refused with nothing created. `TRANZL_APP_ROOT` still only selects harness modules. Gotcha: killing the `node_modules/.bin/electron` Node wrapper does not stop the Electron child, so signal the `Electron` process itself.
5. **Done (C5).** Capability reporting for attachments, plus removing Mac-only UI/shortcut assumptions. User decisions (2026-09-29):
   - **Legacy DOC:** use `word-extractor` (pure JS, MIT; deps saxes/ISC and yauzl/MIT) on every target, replacing `textutil`. **Done (C5a).** `getBody({ filterUnicode: false })` keeps curly quotes and dashes. On synthetic plain, Unicode, list, table and 300-paragraph documents, the text is identical to `textutil`, except that table rows stay on one tab-separated line. Damaged files give a clear "save as .docx" error. Word tests now use committed synthetic `tests/fixtures/synthetic.{doc,docx}` (generated once with `textutil`, checked to contain no author or user metadata), so they run on every OS.
   - **M4A:** use Electron's Chromium decoder for AAC on all targets. Keep `/usr/bin/afconvert` on macOS only for Apple Lossless (ALAC), which Chromium cannot decode (probe: AAC decoded and resampled to 16 kHz mono in a sandboxed hidden window; ALAC failed with `EncodingError`). Windows/Linux report ALAC M4A as unsupported before sending. **Done (C5b).** `src/audioDecoder.js` `decodeToWav()` runs `decodeAudioData` plus an `OfflineAudioContext` 16 kHz mono downmix in a hidden window (sandboxed, context-isolated, in-memory `tranzl-audio-decoder` partition, navigation and popups denied). The window is destroyed after each file. There is a 20 s timeout, and `render-process-gone` counts as a failure. The frame limit is checked in the page before rendering. The decoder returns `null` when Chromium cannot decode the data. `chatStore.parseFile()` sends `.m4a` to the main process, because worker threads have no Chromium. `attachments.js` `mp4Info()` reads the `stsd` codec and `mvhd` duration. A declared duration over the WAV limit is rejected before decoding. ALAC goes straight to `afconvert` on macOS. On macOS, `afconvert` is also the fallback for anything Chromium rejects. Elsewhere, ALAC and undecodable files get clear errors at attach time. Tests: portable routing, limit and header tests use committed synthetic `tests/fixtures/synthetic-{aac,alac}.m4a` with a fake decoder. `attachments-electron.cjs` exercises the real Chromium decoder, including right-channel preservation, garbage input, the in-page limit and window cleanup. The Core Audio tests remain macOS-only because that adapter is macOS-only; `tests/audio-fixture.cjs` (afconvert) is used only there. Ad hoc: 600 s of AAC decoded in 0.56 s to 19.2 MB. A 660 s file whose header claims 1 s was rejected by the in-page limit.
   - **Done (C5c).** `attachmentCapabilities(platform)` in `attachments.js` is the single source for extensions, limits and per-platform unsupported formats (currently only ALAC M4A off macOS). It feeds the attach dialog filter and an `attachment-capabilities` IPC, and the Attach button tooltip lists what is unsupported on this computer. Unsupported files are still rejected with a specific error at attach time, before sending. The preload exposes `platform`, so the Translate shortcut hint reads ⌘↩ on macOS and Ctrl+Enter elsewhere (both keys were already handled). "on your Mac"/"on this Mac" copy became "computer". The font stack gains `system-ui` for Linux desktops. Covered by `tests/attachments.cjs` and `chat-ui.cjs`. Menus, window chrome, native dialogs, scaling and CRLF behavior still need native checks in Stage D.
6. **Done (C6).** Portable features no longer need macOS tools in tests. Word and M4A tests use committed synthetic fixtures (`tests/fixtures/synthetic.{doc,docx}`, `synthetic-{aac,alac}.m4a`). Decoded-size limits are covered three ways: a portable header precheck, the Chromium in-page limit, and the macOS Core Audio post-check. The decoder timeout and window cleanup are tested in Electron, and Core Audio temp-dir cleanup on macOS. `afconvert`/`tests/audio-fixture.cjs` remain only in the macOS-only Core Audio adapter tests. UI screenshots go to `os.tmpdir()` instead of `/tmp`, and the lifecycle fixture server is spawned via `process.execPath`. Speech clip: `tests/fixtures/speech.wav` is LJ Speech clip LJ028-0418 ("About that same time Pietro della Valle, an Italian, visited Babylon,"). It is public domain with no restrictions, per the dataset page, and committed unmodified: 22.05 kHz mono, 5.97 s, 257 KB. It was obtained by streaming only the first 15.9 MB of the original `data.keithito.com` archive; the Hugging Face mirror was avoided because it relabels the data as CC-BY-4.0. `tests/fixtures/speech.json` records source, license statement, SHA-256, transcript and expected words. The harness checks the clip against it, and a unit test guards it. The real model passed 17/17 on the Mac with this clip, transcribing it exactly apart from case and punctuation. It replaces the earlier macOS `say` clip (`out/runtime-evaluation/speech.wav`, never committed), so every platform and CI use the same input.
7. **Done (C7).** Mac regression gates at `3259672` (clean tree): `npm ci`, zero-advisory `npm audit`, 90/90 unit tests, and source plus product-package UI/attachment suites all passed. The Node-packaged app was signed and verified. The real model passed 17/17 from source and 17/17 from a packaged evaluation app outside the checkout, with non-loopback fetch forbidden. Performance matches Stage B within noise (packaged median 69.51 vs 70.14 tok/s; first token 17.7 vs 17.1 ms; peak 5.91 GiB both). Evidence: `docs/runtime-evidence/2026-09-29/stage-c-{source,packaged}.json`; summary in the runtime evaluation doc.

Stage C commits: `1b26314` C1 manifest, `8862232` C2 Node packaging, `1f24bb8` C3 secure storage, `157f74c` C4 test profile, `03d15a7` C5a DOC, `da32f13` C5b M4A, `3359412` C5c capabilities/UI copy, `3259672` C6 fixtures, plus this gate/doc commit.

### D: native target builds (next)

Build and test on Windows 11 x64 and Ubuntu 22.04/24.04 x64 and ARM64. Audit exact Electron, canvas, server/shared-library and attachment dependencies on each target. If upstream has no suitable Linux ARM64 binary, create a pinned native build in CI; never require end-user compilation. Native CPU generation, images/audio and attachment extraction must run from packages outside the checkout, offline after setup. Record hardware, versions, checksums and resource requirements. Hardware/runner availability remains to be established.

### E: recovery and acceleration (pending D)

Expose and test CPU selection/recovery. The server adapter has an internal `gpu: 'cpu'` option but the production facade uses automatic selection and has no validated automatic CPU fallback. Implement a bounded fresh-process retry for classified startup failures; never replay a partially streamed answer. Add actionable errors, effective-context/resource reporting and memory recovery. Validate Metal/CUDA/Vulkan only on actual claimed hardware; CPU CI cannot certify GPU operation.

### F: installers, CI and release (pending E)

Native per-target CI with locked installs and artifact inventories; Mac app/ZIP, Windows installer/ZIP, Linux x64/ARM64 AppImage/deb. Windows/Linux icons, signing configuration, Linux ABI/sandbox/FUSE dependencies, desktop integration and secure-store behavior still need work. Separate building from publishing; current `scripts/release.sh` combines Mac build, GitHub publication and Homebrew update. Clean-machine install/upgrade/uninstall checks and a truthful support matrix are release gates. Do not weaken Electron sandboxing to make a build launch.

## Catches and gotchas

- `/slots` on pinned b11158 supplies measured text occupancy. It is often input-plus-output minus one, reflecting evaluated tokens. Do not replace it with request token totals. Missing/invalid telemetry is estimated/unknown. Media-capable sessions retain estimated context accounting, including text after media until restart.
- Canceling the HTTP fetch does not prove inference stopped. The adapter waits up to 1.5 s for the slot to become idle, otherwise terminates the child. A socket failure may arrive before the OS exit event; await process exit before reuse/restart.
- Cancellation settles the caller promptly while queue-owned cleanup finishes. Shutdown must drain the queue, including acquisition, before quitting. Lifecycle tests cover forced SIGKILL and acquisition cancellation.
- Full SWA cache is deliberate for performance at 8192 tokens. Revalidate memory on lower-resource hardware; current 64 GiB machine does not prove an 8 GiB system works.
- SHA verification reads the whole model once per changed file; metadata memoization avoids repeat hashing within the process. Keep those reads out of claimed disk-cold benchmark numbers.
- The remote model filename is `gemma-4-E4B-it-Q4_0.gguf`; the preserved local filename is `hf_ggml-org_gemma-4-E4B-it.Q4_0.gguf`. Do not normalize away the difference and force users to redownload.
- Runtime dylib aliases matter. Checking only `llama-server` misses broken/corrupt companion libraries. Carry platform-specific DLL/SO layouts and notices into future manifests.
- Download acquisition currently relies on the facade queue and main-process download guard; do not introduce concurrent writers to the same destination without coordination. Windows rename/locked-file semantics still require native testing.
- A Stage A string replacement corrupted `scripts.pack` because JavaScript replacement text interprets dollar-apostrophe specially. Stage B fixed it with a literal assignment and ran the actual command. Avoid regex/string-replacement construction of quoted shell scripts; Node build orchestration is preferable.
- The product packager emitted a warning about absent `.icon` format while using the committed `.icns`; packaging and signature verification succeeded. Review branding on each new platform.
- Tests that launch Electron, bind loopback or use macOS codecs may fail in the restricted agent sandbox. Use the approved normal-access execution path; do not weaken application behavior or rewrite valid fixtures merely to satisfy sandbox restrictions.
- `npm audit` includes development dependencies because Electron is a devDependency but ships in the app. Recheck on each release; recorded zero advisories is a dated result.
- The plan is not proof of feature support. Only Mac ARM64 has passed A/B. Keep Windows/Linux including ARM64 explicitly unvalidated until their gates run.

## Useful commands and local assets

Use absolute asset/output paths. These commands do not publish or install:

```sh
npm ci
npm test
npm run test:electron
npm run pack
TRANZL_APP_ROOT="$PWD/dist/Tranzl-darwin-arm64/Tranzl.app/Contents/Resources/app" npm run test:electron
npm run pack:evaluation -- /absolute/evaluation-output
npm run evaluate:runtime -- --backend=embedded --model=/absolute/model.gguf --binary=/absolute/llama-server --projector=/absolute/projector.gguf --output=/absolute/report.json --extended --media --audio="$PWD/tests/fixtures/speech.wav" --offline
```

Replace `--offline` with `--download-runtime` to exercise new runtime acquisition in the temporary profile. The current harness still requires an explicit existing `--binary` path as a reference, even in fresh-download mode. Invoke the separately packaged evaluation executable with the same arguments for packaged inference.

On the original machine, read-only reference assets are:

- Model: `/Users/zoltanf/Library/Application Support/tranzl/models/hf_ggml-org_gemma-4-E4B-it.Q4_0.gguf`
- Runtime: `/Users/zoltanf/Library/Application Support/tranzl/multimodal/llama-b11158/llama-server`
- Projector: `/Users/zoltanf/Library/Application Support/tranzl/multimodal/gemma-4-E4B-mmproj-Q8_0.gguf`
- Speech audio: committed public-domain `tests/fixtures/speech.wav` with sidecar `speech.json`. Stage A/B evidence used an earlier macOS `say` clip, the ignored `out/runtime-evaluation/speech.wav`.
- Retained Stage A package: `/private/tmp/tranzl-runtime-evaluation/TranzlRuntimeEvaluation-darwin-arm64/TranzlRuntimeEvaluation.app`.
- Stage B package: `/private/tmp/tranzl-integrated-evaluation/TranzlRuntimeEvaluation-darwin-arm64/TranzlRuntimeEvaluation.app`.
- Verified upstream runtime archive/extraction: ignored `out/runtime-evaluation/verified-runtime/`.

These local paths and ignored/temp artifacts are **not delivered by Git** and may disappear. The tracked evidence and immutable identities are sufficient to rebuild; do not assume another machine has the assets. The old worker mode requires `TRANZL_APP_ROOT` pointing to a pre-migration package, or rebuilding that checkpoint in a separate checkout with its own locked dependencies. Do not restore old worker files into the integrated branch merely to rerun a baseline.

Model revision, hashes and archive identity are recorded in `embeddedAssets.js`, its library manifest and the evidence document. Runtime: b11158 / commit 3423f940e. Model revision: b8093469224f83f5c38f691eb906c380e9e63114. Preserve this tested combination until a separately validated change is needed.
