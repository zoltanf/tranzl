# Windows and Linux implementation plan

Prepared: 2026-09-24. Status: implementation proposal, not a compatibility certification.

## Goal and scope

Ship Tranzl from one codebase on macOS Apple Silicon, Windows x64, and Linux x64, including working embedded inference, LM Studio, Ollama, translation, Chat, attachments, and local persistence. Preserve the current Mac experience and existing user data.

Start with Windows 11 x64 and Ubuntu 22.04/24.04 LTS x64 desktop sessions. Validate the dependency versions against these targets before committing to minimum supported versions. Windows ARM64, Linux ARM64, Intel Macs, other Linux distributions, Flatpak, Snap, and automatic updates are later projects. Do not imply that an Ubuntu test certifies all Linux distributions.

The main engineering effort is native dependency distribution and runtime validation, not a UI rewrite. An initial planning allowance is 5–10 developer days for usable builds on selected hardware, or 2–4 weeks for release automation, installers, and broader validation. Hardware access, signing setup, driver problems, or dependency changes can increase this. These are estimates, not delivery commitments.

## Starting point and implementation rules

The repository was inspected while Chat development was in progress. Reinspect the current tree before implementation; filenames and behavior below are a baseline, not instructions to overwrite subsequent work.

- `package.json`: Electron 33.x, Electron Packager 20.x, `node-llama-cpp` dependency range `^3`; installed inference library observed as 3.19.1. Packaging currently targets macOS ARM64 with ASAR disabled.
- `scripts/release.sh`: Mac build, `ditto` archive, GitHub release, and Homebrew tap update in one script.
- `src/main.js`: OS-derived application data path, local HTTP inference backends, theme/window integration, and encrypted translation history.
- `src/backends/local.js`: model downloader and Electron utility-process proxy.
- `src/backends/localWorker.js`: dynamically imports the inference library, loads the model with automatic hardware selection, creates a context capped at 8192 tokens, and serializes requests.
- `src/chatStore.js`: emerging encrypted Chat store and native attachment selection. Include this and any replacement store in the port.
- `src/renderer/`: portable web UI, already using both Control and Command for some shortcuts; remaining copy assumes a Mac.
- `tests/`: Chat tests are emerging. Read their coverage and harness before extending them.

Preserve unrelated edits and active work. Do not replace the renderer framework, model format, or IPC architecture as part of this port. Do not spawn subagents unless the user explicitly asks. Implement in reviewable stages; build and test artifacts before publication. Do not modify production user data for tests. Use an isolated test profile and an explicit, safe way to select it before application initialization.

## Decisions that reduce inference risk

1. Build each target on its own OS and architecture. Do not copy the Mac `node_modules` directory to Windows/Linux or assume changing Electron Packager's platform flag produces working native inference.
2. Keep ASAR disabled for the first working port. Preserve the inference package layout, optional native packages, companion shared libraries, and worker script in the artifact. ASAR optimization can follow only with explicit unpack rules and repeated inference tests.
3. Preserve utility-process isolation initially. Verify that the pinned inference/Electron combination works there on each target; an import succeeding in ordinary Node does not prove this. If isolation is incompatible on a target, investigate a supported separate-process design rather than moving heavy inference into the UI or silently blocking the main process.
4. Make CPU inference the correctness baseline. GPU acceleration is an additional tested capability. Ship the matching CPU runtime even when a GPU build works on the build machine.
5. Start with automatic hardware selection and expose a CPU recovery option. A detected GPU or a successful model load is not sufficient: generate and complete an actual response.
6. Keep LM Studio and Ollama independent of embedded initialization. A missing embedded binary must not prevent launching the app or using an external local backend.
7. Preserve the existing model and reasoning wrapper initially. Confirm the exact GGUF artifact and wrapper work with the pinned inference version before considering any upgrade or model change.

The upstream Electron guide documents platform-native packaging and special handling of native files. Its current version may differ from the installed package: consult installed types and version-matched implementation before using APIs. [Upstream Electron guide](https://node-llama-cpp.withcat.ai/guide/electron)

## Phase 0 — Establish a reproducible baseline

- Record commit, uncommitted work relevant to the port, OS/architecture, Electron version, Node build-tool version, resolved inference version, lockfile, and installed native package inventory.
- Run existing tests and a packaged Mac smoke test: translation, thinking on/off, multi-turn Chat, stop, attachment, session reload, and session deletion. Record pre-existing failures separately.
- Check the supported Electron release policy. Plan any necessary Electron upgrade as its own change and validate Mac first; do not combine untested runtime, inference, and packaging upgrades. Recheck install-script allowlists against the actual package manager and locked versions.
- Choose and document an explicit tested inference version, compatible Electron version, and Node build runtime. Use the lockfile and `npm ci` in clean builds; prevent an implicit major/minor inference upgrade during packaging.
- Record the exact downloaded model filename, repository/revision where resolvable, quantization, size, and checksum for the validated fixture. A model alias may resolve differently later. Keep the model separately downloaded, subject to its existing license.

Gate: reproducible Mac baseline, a documented version combination, and a known model fixture. If Gemma support is absent from the chosen library version, resolve that before porting further.

## Phase 1 — Prove packaged inference before installer work

Create minimal unpacked Windows and Linux artifacts using clean native builds and the existing packager. Add a development/test-only smoke runner that exercises the same utility worker and model-loading path as the product. Do not expose arbitrary execution through production IPC.

The runner must report import, worker startup, runtime selection, model load, context creation, first token, completed output, cancellation, and worker exit as distinct outcomes. Use synthetic prompts and an isolated profile. Capture selected compute backend, model/runtime versions, RAM/VRAM where available, and timing; exclude user prompts and file contents from diagnostics.

Run the artifact outside the checkout on a clean machine without Node, npm, Python, CMake, or developer compilers. Verify no path falls back to the source tree or package manager cache. Use a CPU-only VM for correctness and real GPU hardware for acceleration. Verify startup from paths containing spaces and non-ASCII characters.

Gate: the packaged app on both new targets generates a complete response with the intended GGUF using CPU, and still runs LM Studio/Ollama when embedded inference is unavailable. No end-user compilation is needed.

## Phase 2 — Harden embedded startup and recovery

Changes should be concentrated in `src/backends/local.js`, `localWorker.js`, and the status/settings surface.

- Make runtime selection explicit and diagnosable: Auto and CPU initially; add explicit CUDA/Vulkan overrides only where tested. Installed library types currently include `gpu` selection and `build: 'never'`; verify exact semantics in the pinned version. Disable unintended runtime compilation/download of native code in packaged builds while retaining the intended model download flow.
- Support a bounded fallback: automatic runtime initialization; on a classified GPU/native initialization failure, dispose resources and retry once in a fresh CPU worker. A native crash requires the parent to detect exit and create a fresh worker. Do not repeatedly restart a crashing worker or silently retry an already-streaming response.
- Distinguish missing binary, missing shared library/driver, unsupported CPU instruction set, corrupt/incompatible GGUF, insufficient memory, context allocation failure, and ordinary request errors where evidence permits. Give a useful next action, without claiming a diagnosis the error does not support.
- On memory failure, offer a smaller context or reduced GPU offload using supported APIs. Bound retries and record the effective context. Never silently discard conversation history to fit; explain limits and offer a new session or a smaller attachment.
- Add a startup/progress timeout and user cancellation path sized for CPU loading. Inactivity limits should be configurable for tests and generous in production. Ensure interrupted loading or a worker crash leaves no permanently pending requests.
- Ensure abort listeners are removed after completion, pre-aborted requests never start, queued requests can cancel, and worker shutdown settles all pending work. Keep Translate and Chat request ownership distinct.
- Keep request serialization and per-request history isolation. Test alternating translation and Chat sessions, reasoning changes, repeated cancellation, and a new request after recovery.
- Report whether CPU or GPU is being used. Explain slower CPU operation without promising a token rate or RAM minimum before measuring.

Gate: successful recovery from simulated initialization failure and worker exit, plus real CPU/GPU generation. Cancellation is terminal for the canceled request; a subsequent request succeeds.

## Phase 3 — Portable application behavior and persistence

- Preserve the existing `tranzl` data directory identity via Electron's OS-derived paths. Create required directories explicitly. Never write models/settings into the installed application directory.
- Centralize storage capability checks for both history and Chat. On Linux, explicitly reject `safeStorage.getSelectedStorageBackend() === 'basic_text'` as protected persistent storage; `isEncryptionAvailable()` alone is insufficient. Test a working desktop secret store, a locked/unavailable store, and no secret store. Show a visible memory-only state when secure persistence is unavailable; never silently substitute plaintext. [Electron safeStorage documentation](https://www.electronjs.org/docs/latest/api/safe-storage)
- Preserve unreadable ciphertext and distinguish missing files from decryption failures. Prevent automatic saving of an empty/default store over unreadable existing data. Retry when the keyring becomes available; any destructive reset must be explicit.
- Use serialized, atomic writes where practical, and test replacement behavior on Windows. A failed write or rename must preserve the previous file and surface the failure. Unix mode `0600` is not a substitute for Windows ACL semantics; rely on the user profile and OS encryption, and document the boundaries.
- Keep encryption keys local to the OS account. Copying encrypted files between machines is not a supported migration mechanism. Do not add sync/export as incidental scope.
- Preserve session settings, drafts, attachments, and deletion behavior implemented by Chat. Restart tests must verify their actual saved state, not just a successful save response.
- Replace Mac-only setup copy and shortcut labels. Validate native file dialogs, CRLF text, Unicode filenames, clipboard behavior, external links, light/dark themes, 125–200% scaling, and window restoration on changed displays.
- Preserve context isolation, disabled Node integration in the renderer, Markdown sanitization, and attachment validation. No platform workaround should weaken these boundaries.

Gate: both stores survive restart where encryption is available; unavailable storage is clearly reported; corrupt/locked stores are preserved; Mac data remains readable after upgrade.

## Phase 4 — Installers and repeatable builds

First retain Electron Packager for unpacked diagnostic artifacts. Once Phase 1 works, adopt a pinned installer tool such as Electron Builder if needed for Windows NSIS and Linux AppImage/deb outputs. Keep packaging-tool changes separate from inference changes. Preserve existing Mac commands as compatible aliases or document their replacement.

Suggested deliverables:

| Platform | First release artifacts | Required validation |
| --- | --- | --- |
| macOS ARM64 | Existing app/ZIP and Homebrew flow | Upgrade without losing model, settings, or encrypted history |
| Windows x64 | Per-user installer plus diagnostic ZIP | Fresh install, launch, upgrade, uninstall behavior, paths with spaces |
| Linux x64 | AppImage and Ubuntu deb | Desktop integration, declared runtime dependencies, secret-store access |

- Add Windows `.ico` and Linux PNG icons from existing branding.
- Replace Unix-only command chains in shared npm scripts with Node scripts or tool configuration. Keep Mac-specific install commands explicitly named.
- Use separate CI jobs with explicit OS/architecture runners. Never share `node_modules` between targets. Cache downloaded dependencies/models only with appropriate version, OS, architecture, and integrity keys.
- Include required optional `@node-llama-cpp` packages and their companion libraries. Inventory the packaged files; do not prune a CUDA companion or CPU fallback merely because CI has no GPU. Verify distribution size and licenses before deciding which acceleration modes to ship.
- Build Linux binaries on a compatible baseline; audit glibc/runtime requirements. Document AppImage/FUSE dependencies or a tested extraction fallback. Do not solve sandbox startup failures by globally using `--no-sandbox`.
- Record artifact checksums, dependency/native binary inventory, versions, and test evidence. Exclude profiles, downloaded model caches, test fixtures containing data, and development secrets from packages.
- Separate building from publication. Produce draft/candidate artifacts first; update the release script so it no longer assumes only a Mac ZIP exists. Preserve Homebrew updates after verified Mac publication. Public release and tap changes should follow the repository's authorized release workflow.
- Plan Windows signing separately, with credentials supplied through CI secrets. Unsigned builds can support testing, but do not claim they provide a warning-free installation experience. Never embed signing secrets in configuration.

Gate: installed artifacts work on clean machines without build tools or access to the source tree. Native inference works offline after the intentional model download. Updating does not erase user data.

## Validation matrix and evidence

Every checked result must identify the exact artifact checksum, OS version, CPU, RAM, GPU/driver if applicable, runtime backend actually selected, model checksum, context size, and outcome. Do not treat packaging success, a mock test, or model loading alone as proof of inference.

| Environment | Required evidence |
| --- | --- |
| Existing Apple Silicon Mac | Metal generation and all baseline flows without regression |
| Windows 11 x64, no usable GPU | Packaged CPU generation and working persistence |
| Ubuntu 22.04 and 24.04 x64 desktop | Packaged CPU generation, installer launch, keyring behavior |
| Windows x64 + supported NVIDIA GPU | Actual CUDA generation, cancellation, CPU recovery |
| Linux x64 + supported NVIDIA GPU | Actual CUDA generation, cancellation, CPU recovery |
| Windows/Linux + representative Vulkan GPU | Actual Vulkan generation per platform claimed as supported |
| Linux without an available secret store | Visible memory-only state and no unprotected sensitive files |

CPU-only CI cannot certify CUDA or Vulkan. If GPU hardware is unavailable, retain a documented release blocker for that support claim or scope the release to validated CPU/external-server operation. Do not present untested acceleration as verified.

Required test scenarios:

1. First run: download progress, interrupted download/resume, disk-full/write failure, corrupt model detection, and retry without replacing a valid model unnecessarily.
2. Offline startup after setup: generate with the packaged native runtime and cached model; no npm/build-tool access.
3. Translation: stream a short response, complete, stop, and run again; thinking on/off should match the model's supported modes.
4. Chat: ask the model to remember a synthetic value and retrieve it on a later turn; alternate sessions to detect leakage; attach a small text file with a known marker and ask about it.
5. History/context: long input near the effective context limit, large permitted attachment, explicit overflow handling, and no hang or silent data loss.
6. Request lifecycle: cancel during loading, queueing, thinking, and generation; switch views/backends; close during work; recover after worker exit. Verify no late response is assigned to another session.
7. Local servers: real LM Studio and Ollama responses, unavailable server, missing model, reasoning-option rejection/fallback, malformed/error stream, and cancellation. Mocks cover edge cases but do not replace a real-server smoke test on each target.
8. Storage: save/restart, delete one session/restart, clear all/restart, failed writes, unreadable ciphertext, and keyring unavailability. Use synthetic data only.
9. Installation: launch as a standard user; update over an existing test profile; uninstall/reinstall according to the documented data-retention policy.

Automate pure logic, storage failure paths, IPC lifecycle, and packaged CPU smoke tests. Keep real GPU/desktop tests as recorded manual or dedicated-hardware gates. Record cold load, first-token latency, output token rate, and peak memory; set performance expectations from those measurements rather than brittle universal timing assertions.

## Risk register

| Risk | Severity | Mitigation / release condition |
| --- | --- | --- |
| Wrong or missing native package/shared library | Critical | Native builds, artifact inventory, clean-machine packaged generation |
| GPU detection succeeds but initialization/generation crashes | High | Real hardware generation, bounded fresh-worker CPU fallback, no restart loop |
| CPU fallback absent or CPU instruction set unsupported | High | Ship/test CPU runtime and document minimum tested CPU; do not promise every x64 machine |
| Model/library/wrapper version mismatch | High | Locked tested versions and exact model fixture; validate reasoning as well as plain output |
| Too little RAM/VRAM or oversized context | High | Measured requirements, bounded allocation recovery, clear context/input limits |
| Linux weak storage fallback or keyring unavailable | High | Reject `basic_text`, visible memory-only mode, preserve unreadable files |
| Packaging test succeeds while worker inference fails | High | Exercise the real utility process from the installed artifact |
| Dependency upgrade breaks existing Mac functionality | High | Separate upgrade stage and Mac regression gate on every candidate |
| Linux ABI, sandbox, display-server, or AppImage issues | Medium–high | Explicit supported distro baseline and real desktop tests; no blanket sandbox disable |
| Windows file replacement or path assumptions lose saves | High | Atomic-write failure tests, standard-user and Unicode-path tests |
| CI has no GPU and produces misleading confidence | High | Separate build/CPU evidence from mandatory hardware acceleration evidence |
| Signing credentials or hardware access unavailable | Medium | Produce testable candidates, report the exact blocker, do not claim release readiness |

## Completion and handoff

Implementation is complete only when supported artifacts, tests, diagnostics, and documentation agree about what works. Provide:

- Cross-platform packaging commands and repeatable CI builds.
- Tested native dependency/model versions and artifact inventories.
- CPU recovery, actionable inference errors, and secure storage behavior.
- Passing existing tests plus targeted new lifecycle/storage tests.
- Completed artifact/hardware matrix with logs containing only synthetic data.
- Installation, hardware/driver requirements, data locations, and troubleshooting documentation.
- A concise list of remaining unsupported targets or blocked tests; never mark unexecuted tests as passing.

Recommended commit sequence: baseline/version decision; unpacked target builds and smoke runner; inference recovery; portable persistence/UI; installers/CI; documentation and release evidence. If a phase fails, keep its artifacts and diagnostics and fix that phase before broadening the scope. Roll back code/package changes independently; do not roll back or erase user profiles. Avoid data format migrations unless essential and separately tested.

## Reference material

- [node-llama-cpp Electron integration and packaging](https://node-llama-cpp.withcat.ai/guide/electron): upstream constraints; installed version documentation and types take precedence for API details.
- [node-llama-cpp getting started and compute backend overview](https://node-llama-cpp.withcat.ai/guide/): platform/runtime capability overview, not certification of this app's packages.
- [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage): OS-specific encryption semantics and Linux storage backend detection. Do not assume newer async APIs exist in Electron 33.
- Installed `node-llama-cpp` declarations in `dist/bindings/getLlama.d.ts` and model/context option declarations: verify runtime selection, disposal, GPU offload, and context options for the locked version.
