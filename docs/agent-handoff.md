# Agent handoff: unified inference and multiplatform support

Updated: 2026-09-29. Code checkpoint: `b43d77b` on `codex/unified-inference-evaluation`. This handoff is committed after that checkpoint. Read this file, then the documents linked below, before changing code.

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
| `src/backends/runtime-files-darwin-arm64.json` | Executable and companion-library hashes derived from the checksum-verified upstream archive |
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

## Remaining work — start with Stage C

### C: portable foundations (not started)

1. Generalize runtime manifests to record target OS/architecture, compute variant, immutable URL/hash, archive layout, executable, companion libraries and notices. Current runtime selection supports **only darwin-arm64** and extraction uses `/usr/bin/tar`. Unsupported platforms fail clearly; do not add untested target entries and claim support.
2. Replace Unix-only shared packaging/test orchestration with Node entry points. Keep OS signing/install adapters explicit and preserve existing Mac commands as aliases or document replacements. Pin clean dependency installation with `npm ci`; do not carry Mac `node_modules` to other targets.
3. Centralize secure persistence for history and Chat. Current checks use `safeStorage.isEncryptionAvailable()` alone. Reject Linux `basic_text`; expose memory-only operation; distinguish absent files from unreadable ciphertext; prevent defaults overwriting unreadable stores; preserve prior data on failed atomic writes. Test both stores, restart, delete, locked keyring and write failures.
4. Add an explicit safe test-profile selector **before application initialization**. The inference harness already isolates its own profile, but `src/main.js` still pins the normal app profile and has no such production-main test hook. Do not assume `TRANZL_APP_ROOT` changes userData; it only selects modules for harnesses.
5. Introduce capability reporting for attachments and remove Mac-only UI/shortcut assumptions. M4A uses `/usr/bin/afconvert`; legacy DOC uses `/usr/bin/textutil`. Decide on a portable converter and its distribution/license/limits, and explicitly decide whether legacy DOC is deferred. DOCX must remain supported.
6. Replace macOS-specific speech/audio test generation with portable synthetic fixtures; preserve decoded-size limits, timeouts and cleanup. Existing codec tests require normal native system access.
7. Run the Mac regression gates, update the plan/evidence and commit this stage before broadening target support.

### D: native target builds (pending C)

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
npm run evaluate:runtime -- --backend=embedded --model=/absolute/model.gguf --binary=/absolute/llama-server --projector=/absolute/projector.gguf --output=/absolute/report.json --extended --media --audio=/absolute/synthetic.wav --offline
```

Replace `--offline` with `--download-runtime` to exercise new runtime acquisition in the temporary profile. The current harness still requires an explicit existing `--binary` path as a reference, even in fresh-download mode. Invoke the separately packaged evaluation executable with the same arguments for packaged inference.

On the original machine, read-only reference assets are:

- Model: `/Users/zoltanf/Library/Application Support/tranzl/models/hf_ggml-org_gemma-4-E4B-it.Q4_0.gguf`
- Runtime: `/Users/zoltanf/Library/Application Support/tranzl/multimodal/llama-b11158/llama-server`
- Projector: `/Users/zoltanf/Library/Application Support/tranzl/multimodal/gemma-4-E4B-mmproj-Q8_0.gguf`
- Synthetic audio: repo-local ignored `out/runtime-evaluation/speech.wav` (says “The blue bicycle is beside the garden gate.”).
- Retained Stage A package: `/private/tmp/tranzl-runtime-evaluation/TranzlRuntimeEvaluation-darwin-arm64/TranzlRuntimeEvaluation.app`.
- Stage B package: `/private/tmp/tranzl-integrated-evaluation/TranzlRuntimeEvaluation-darwin-arm64/TranzlRuntimeEvaluation.app`.
- Verified upstream runtime archive/extraction: ignored `out/runtime-evaluation/verified-runtime/`.

These local paths and ignored/temp artifacts are **not delivered by Git** and may disappear. The tracked evidence and immutable identities are sufficient to rebuild; do not assume another machine has the assets. The old worker mode requires `TRANZL_APP_ROOT` pointing to a pre-migration package, or rebuilding that checkpoint in a separate checkout with its own locked dependencies. Do not restore old worker files into the integrated branch merely to rerun a baseline.

Model revision, hashes and archive identity are recorded in `embeddedAssets.js`, its library manifest and the evidence document. Runtime: b11158 / commit 3423f940e. Model revision: b8093469224f83f5c38f691eb906c380e9e63114. Preserve this tested combination until a separately validated change is needed.
