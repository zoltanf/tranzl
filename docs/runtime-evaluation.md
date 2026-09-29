# Single inference runtime evaluation

Updated: 2026-09-29. **Decision: adopt the managed llama.cpp server for Stage B integration.** Stage A passed on the existing Mac target. Stage B integration has also passed the Mac gates on this branch; released version 0.2.3 remains unchanged. This is not a Windows/Linux compatibility certification.

Requirements: [multiplatform-requirements.md](multiplatform-requirements.md). Sequence: [multiplatform-plan.md](multiplatform-plan.md).

## What was evaluated

The `serverRuntime.js` candidate owns one authenticated loopback server and a cancellable request queue. Text startup does not load the projector. First media use waits for the text process to exit before starting a media-capable process; subsequent text reuses it. This describes the Stage A experiment; Stage B now routes all embedded renderer/IPC requests through that adapter.

The harness uses explicit, read-only model/runtime paths, synthetic prompts and attachments, and a temporary Electron profile. The separately signed `TranzlRuntimeEvaluation` app ran from `/private/tmp`, outside the checkout. It has its own entry point and bundle identity and was not installed or published.

Baseline: released source commit `b1ea1b3d9d97a8a09772991c7b8df92ab8d3fb37` (0.2.3), plus evaluation instrumentation and prototype changes. Per-file hashes and dirty-tree records are in the reports. The worker gained diagnostic status fields only; generation settings/logic did not change.

Host: macOS 26.7 / Darwin 25.6.0, Apple M5 Pro, 64 GiB RAM, ARM64; Electron 44.4.5, `node-llama-cpp` 3.19.1. The worker reports Metal with 43 GPU layers. A separate server startup-only diagnostic confirms 43/43 GPU layers and actual Metal warmup kernels. CPU model-buffer presence is not evidence that inference used CPU exclusively.

Assets:

| Asset | Identity |
| --- | --- |
| Model | `ggml-org/gemma-4-E4B-it-GGUF`, revision `b8093469224f83f5c38f691eb906c380e9e63114`, `gemma-4-E4B-it-Q4_0.gguf`, 4,590,807,392 bytes |
| Model SHA-256 | `a555b900214b477d8880e7832e0b8925e139b0159640036b09fe472b6f2097f2` |
| Projector SHA-256 | `197f49a93027f9843772bd24a6a9e0be2a32a788de5a3def330e9c585d86edd1` |
| Server | llama.cpp `b11158`, commit `3423f940e`, Mac ARM64 |
| Server executable SHA-256 | `41df13c126456f8e5fab2057c86a790067a85ea1dfd8fbc0071cc45fbba56262` |
| Evaluation app ZIP SHA-256 | `cb219396a03670048fbf9002aeb7f3ede5d12442c5c5ef5ffc9aff7d248ed50b` |

The pinned Hugging Face revision's LFS metadata matches the installed model and projector hashes. The existing model filename can therefore remain unchanged during downloader replacement.

## Evidence and results

Tracked reports: [packaged worker](runtime-evidence/2026-09-29/worker.json), [packaged candidate](runtime-evidence/2026-09-29/server.json), [native failure paths and backend verification](runtime-evidence/2026-09-29/native-startup.json). Reports contain synthetic output only. The ZIP remains in ignored `out/runtime-evaluation/`; it is not a product release artifact.

| Gate | Result |
| --- | --- |
| Regression suite | 55/55 passed: 42 existing tests plus 13 candidate lifecycle/protocol tests |
| Electron UI/attachments | Passed from source and against packaged files: clipboard, Markdown sanitization, Chat flows, image/PDF/Word/spreadsheet/M4A readers |
| Packaged worker | 14/14 scenarios passed |
| Packaged candidate | 17/17 scenarios passed, including image, audio, and text after media |
| Context and compaction | Template-aware input counts agree on the short fixture; both compacted a synthetic 10,455-token document into an 8,192-token window and retained the requested facts without changing the original transcript |
| Reasoning | Multi-step reasoning emitted separate thought streams; thinking-off did not. A trivial initial arithmetic prompt produced no thought on either backend, so thought presence is recorded rather than required for every prompt |
| Cancellation | Queueing/loading/generation covered by lifecycle tests; real packaged checks cancel during answer generation and thinking, then successfully generate again |
| Process failures | Crash recovery, missing executable, startup timeout, forced shutdown, missing/corrupt model and native startup cancellation passed |
| Privacy/isolation | Loopback binding and per-process authentication; explicit read-only assets; temporary profiles; one owned process at a time; no persistent raw runtime logs |

Same packaged app and model, sequential runs, 8,192 context, temperature 0.2, maximum 256 output tokens for the three warm prompt runs:

| Measurement | Worker | Candidate, full SWA cache |
| --- | ---: | ---: |
| Median reported generation rate | 71.27 tok/s | 70.81 tok/s |
| Median first-token latency | 16.00 ms | 17.04 ms |
| Peak summed RSS, text scenarios | 5.64 GiB | 5.55 GiB |
| Fresh-process load | 8.02 s | 0.76 s |

Rate is ~0.7% lower, first token ~6.5% slower, and text RSS ~1.7% lower: all within the evaluation thresholds. Rate counters differ slightly between runtimes; results are indicative, not a universal benchmark. RSS includes Electron and may double-count shared pages; it is not a dedicated GPU-memory measurement. Hashing assets before loading warms the filesystem cache, so fresh-process timing is **not** a disk-cold benchmark. Repeated identical prompts intentionally exercise cache reuse. Candidate media-inclusive RSS peaked around 5.86 GiB, not directly comparable to the worker-only text peak.

## Decisions from the experiment

1. **Use full sliding-window caching for the 8,192-token candidate context.** Default server SWA checkpoint restoration reprocessed five tokens on repeated prompts, producing ~39 ms first-token latency versus ~16 ms in the worker. `--swa-full` reduced that to one reprocessed token and ~17 ms. Memory remained below the measured worker baseline. Revalidate on lower-memory and other hardware before support claims; expose memory recovery in the portability phase.
2. **Use `/slots` for text occupancy.** In pinned `server_slot::to_json`, `n_prompt_tokens` reports the current token vector, including evaluated generated tokens. The measured final count is often one below prompt-plus-generated totals. Preserve this distinction and use validated counters for live/final text stats. Missing or invalid counters fall back to explicitly estimated/unknown values. Media-capable sessions retain the existing estimated behavior until separately validated.
3. **Verify idle state after cancellation.** A canceled HTTP stream does not by itself prove the server stopped generating. Poll the owned slot with a bounded timeout; retain the loaded model only if idle, otherwise terminate it before processing another request.
4. **Wait for process exit before recovery.** A socket error can precede the OS exit notification. Terminate and await the old child before permitting a new request to reuse an endpoint.
5. **Keep acquisition separate from inference.** Removing `node-llama-cpp` also requires replacing its downloader. This is Stage B work, not a completed result of the experiment.

Pinned implementation references: [server source](https://github.com/ggml-org/llama.cpp/blob/b11158/tools/server/server-context.cpp), [server API documentation](https://github.com/ggml-org/llama.cpp/blob/b11158/tools/server/README.md). Follow this revision, not the latest API by assumption.

## Reproducing the evaluation

Provide explicit absolute asset paths. Run the backends sequentially:

```sh
TRANZL_APP_ROOT=/absolute/pre-migration-evaluation-app/Contents/Resources/app npm run evaluate:runtime -- --backend=worker --model=/absolute/model.gguf --output=/absolute/worker.json --extended
npm run evaluate:runtime -- --backend=server --model=/absolute/model.gguf --binary=/absolute/llama-server --projector=/absolute/projector.gguf --output=/absolute/server.json --extended --media --audio=/absolute/synthetic-speech.wav
npm run pack:evaluation -- /absolute/evaluation-output
```

The audio fixture says “The blue bicycle is beside the garden gate.” Use `--compact-cache` only to reproduce the slower initial cache configuration. `npm test` includes lifecycle tests requiring permission to bind loopback. macOS codec tests need normal native system access; the original 39/42 sandbox result was resolved to 42/42 outside the sandbox without fixture changes.

For packaged tests, invoke the evaluation executable directly with the same arguments from outside the checkout. `TRANZL_APP_ROOT` can select packaged modules for the existing UI/attachment checks. The evaluation app never opens the normal application or selects its persisted settings/profile.

## Stage B integration results

Stage B is complete on macOS ARM64. The production code now uses one lazy embedded facade for translation, Chat, context compaction and token counting. Media installation remains lazy, and application quit drains the owned server. The utility worker, old multimodal manager and `node-llama-cpp` are removed. Existing model names, cache paths and persisted data formats are unchanged.

The replacement downloader pins immutable URLs, expected sizes and SHA-256 hashes. It resumes partial downloads, validates range responses, preserves interrupted bytes and existing destinations on failure, and verifies before atomic promotion. Runtime installation verifies every listed companion library as well as the executable, stages extraction and rolls back a failed replacement. The immutable archive manifest is checked in beside the backend. Valid cached assets are reused offline; the server itself runs with `--offline`.

| Integration check | Result |
| --- | --- |
| Automated tests | 66/66 full suite passed; added shutdown-during-acquisition regression then passed all 14 server tests (67 total current tests) |
| Source and product-package UI/attachments | Both passed |
| Fresh runtime acquisition | Download, archive checksum, extraction, library verification and all 17 real-model cases passed in a temporary profile |
| Offline signed evaluation package | 17/17 real-model cases passed with non-loopback fetch forbidden |
| Product package | `npm run pack` succeeded; ad-hoc signature verified; ~377 MiB on disk |
| Dependency inventory | No `node-llama-cpp` in lockfile or product package; no dev-only `undici` in product package |
| Dependency audit | Zero advisories after a compatible `undici` patch update |

Evidence: [fresh acquisition](runtime-evidence/2026-09-29/integrated-download.json), [offline packaged integration](runtime-evidence/2026-09-29/integrated-packaged.json), [additional source inventory](runtime-evidence/2026-09-29/integration-inventory.json). The reports retain per-file source hashes because they were recorded before the integration commit. They contain synthetic prompts only. The previous worker comparison is reproducible using the retained Stage A evaluation package; the removed live-test scripts are replaced by the explicit-path isolated harness.

The production package command had malformed ignore quoting introduced during Stage A; it is corrected and the real command was exercised. The released 0.2.3 artifact predates that change. Neither validation package was installed or published.

After Stage B, still unvalidated: native Windows/Linux builds (including ARM64), CPU fallback there, broad GPU/driver support, low-memory behavior, clean-machine installation/upgrades, and full first-run UI acquisition on those targets. Downloader failure paths use deterministic small fixtures; the real acquisition check fetched the runtime and reused the already verified 4.6 GB model and projector. No full model re-download was needed. Mac packaged UI tests use a mocked backend; real inference runs separately through the packaged production facade. These checks do not certify an installer or a new public release.

## Stage C Mac regression results

Stage C (portable foundations) changed runtime selection, packaging, secure storage, profile selection and attachment conversion without changing the inference runtime. It was re-checked on the same Apple M5 Pro / 64 GiB / macOS 26.7 machine at `3259672`, with a clean working tree.

| Check | Result |
| --- | --- |
| Clean install | `npm ci` from the lockfile; `npm audit` zero advisories |
| Automated tests | 90/90 unit tests; source and product-package UI/attachment suites passed (including the real Chromium M4A decoder) |
| Product package | Node packager (`npm run pack`) built and ad-hoc signed; signature verified; ~377 MiB; contains `word-extractor` and new modules; no `node-llama-cpp` |
| Real model, source | 17/17 cases, offline, temporary profile, read-only model/runtime/projector |
| Real model, packaged | 17/17 cases from a separate evaluation package outside the checkout, non-loopback fetch forbidden |

| Metric (packaged) | Stage B (`da55759`) | Stage C (`3259672`) |
| --- | --- | --- |
| Median warm generation | 70.14 tok/s | 69.51 tok/s |
| Median warm first token | 17.1 ms | 17.7 ms |
| Peak summed RSS (text / all) | 5.59 / 5.91 GiB | 5.58 / 5.91 GiB |
| Cold load (warm filesystem cache) | 3.57 s | 3.76 s |

The differences are within run-to-run noise and far below the investigation thresholds. Evidence: [source](runtime-evidence/2026-09-29/stage-c-source.json), [packaged](runtime-evidence/2026-09-29/stage-c-packaged.json). Only Mac ARM64 is validated; Windows and Linux (x64 and ARM64) remain Stage D.
