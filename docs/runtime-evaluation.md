# Single inference runtime evaluation

Updated: 2026-09-29. **Decision: adopt the managed llama.cpp server for Stage B integration.** Stage A passed on the existing Mac target. Production still uses the released dual-runtime path until Stage B passes its own gates. This is not a Windows/Linux compatibility certification.

Requirements: [multiplatform-requirements.md](multiplatform-requirements.md). Sequence: [multiplatform-plan.md](multiplatform-plan.md).

## What was evaluated

The `serverRuntime.js` candidate owns one authenticated loopback server and a cancellable request queue. Text startup does not load the projector. First media use waits for the text process to exit before starting a media-capable process; subsequent text reuses it. No production renderer/IPC route has switched yet.

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
npm run evaluate:runtime -- --backend=worker --model=/absolute/model.gguf --output=/absolute/worker.json --extended
npm run evaluate:runtime -- --backend=server --model=/absolute/model.gguf --binary=/absolute/llama-server --projector=/absolute/projector.gguf --output=/absolute/server.json --extended --media --audio=/absolute/synthetic-speech.wav
npm run pack:evaluation -- /absolute/evaluation-output
```

The audio fixture says “The blue bicycle is beside the garden gate.” Use `--compact-cache` only to reproduce the slower initial cache configuration. `npm test` includes lifecycle tests requiring permission to bind loopback. macOS codec tests need normal native system access; the original 39/42 sandbox result was resolved to 42/42 outside the sandbox without fixture changes.

For packaged tests, invoke the evaluation executable directly with the same arguments from outside the checkout. `TRANZL_APP_ROOT` can select packaged modules for the existing UI/attachment checks. The evaluation app never opens the normal application or selects its persisted settings/profile.

## Stage B handoff and limits

Proceed with one shared embedded facade, lazy verified runtime/projector acquisition, pinned resumable model downloads, and existing-cache reuse. Preserve IPC and renderer behavior. Remove the worker and `node-llama-cpp` only after replacement downloader tests and integrated packaged Mac tests pass. Preserve this evidence as the rollback comparison.

Not certified here: Windows/Linux (including ARM64), CPU fallback on those systems, broad GPU/driver support, low-memory behavior, internet/offline acquisition failure paths, or integrated first-run/update behavior. These remain explicit Stage B–F gates. There is no unresolved measured Mac text regression requiring a product tradeoff; actual occupied-context reporting is retained.
