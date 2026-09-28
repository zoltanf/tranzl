# Single inference runtime evaluation

Updated: 2026-09-28. Status: paused for the user-requested 0.2.3 release; source audit and test baseline recorded; prototype and real-model comparison pending. **No adoption decision yet.**

Requirements: [multiplatform-requirements.md](multiplatform-requirements.md). Execution order: [multiplatform-plan.md](multiplatform-plan.md).

## Baseline observed

- Git HEAD: `34771055d70220840253393f187fe0ea899b1524`, with existing uncommitted application/UI/test edits. Results describe that working tree, not a pristine commit.
- Host: macOS ARM64; Node `v26.9.0`; Electron `44.4.5`; installed `node-llama-cpp` `3.19.1`.
- `npm test`: 42 tests, 39 passed, 3 failed, 0 skipped. The failures are AAC conversion, ALAC conversion, and decoded M4A size-limit fixture setup. `/usr/bin/afconvert` rejects `aac`/`alac` during fixture creation, before the intended assertions. This is a pre-existing local baseline failure, not evidence that the candidate fails or that production conversion works.
- Follow-up release validation outside the execution sandbox: all 42 tests passed, including AAC, ALAC, and decoded-size-limit tests. The earlier failures were sandbox-specific codec availability, not fixture defects; no audio code or fixture changes were needed. Run codec-dependent checks with native system access.
- Electron UI and packaged checks are tracked in the 0.2.3 release notes. Real-model comparison, hardware performance, and other operating systems: not run for this evaluation.

## Source audit

| Concern | Existing text worker | Existing server path | Evaluation action |
| --- | --- | --- | --- |
| Entry points | `local.js` and `localWorker.js` | `multimodal.js`, routed from `main.js` | Introduce one backend contract behind a development-only selection mechanism. |
| Text after media | Worker is released | Later text already uses the running server | Reuse this path as prototype input, but validate from a cold text-only start. |
| Model acquisition | Uses `node-llama-cpp` downloader and an HF alias | Reuses downloaded GGUF | Pin the resolved model and replace downloader before removing dependency. |
| Request queue | Worker serializes generation/counting | Server has one slot; adapter has no equivalent explicit ownership queue | Define one cancellable app queue for both generation and counting. |
| Context | Actual sequence occupancy and live stats | Input count endpoint; final input-plus-output estimate | Verify pinned server APIs; never substitute estimated totals for actual occupancy. |
| Reasoning | Gemma wrapper emits thought segments | `enable_thinking` plus reasoning deltas | Test both modes with the exact pinned model/server/template. |
| Startup | Preloads text worker | Always requires projector and Mac ARM64 server | Separate core/text assets from optional media setup and validate lazy activation. |
| Lifecycle | Utility-process pending map | Shared startup promise, child process, polling | Audit cancellation ownership, queue cancellation, failure/retry, and shutdown races. |
| Distribution | Native Node package stack | Pinned `b11158` Mac ARM64 archive, `/usr/bin/tar` | Verify exact release asset inventory and replace hardcoded selection/extraction later. |

The existing server adapter is a prototype foundation, not yet a drop-in replacement. In particular, retaining `node-llama-cpp` solely for downloads would leave the native dependency problem unresolved.

## Experiment and evidence checklist

- [x] Inspect current entry points and native dependencies.
- [x] Run existing non-UI test baseline and record failures.
- [x] Diagnose baseline fixture failures and rerun affected tests: all pass outside the sandbox. Portable fixtures remain part of Stage C.
- [ ] Record exact OS/hardware, model revision/checksum, server checksum, backend, context, and current packaged baseline.
- [ ] Inspect APIs and command flags for the pinned server revision; do not assume latest upstream behavior applies.
- [ ] Build a development-only A/B harness using explicit model/cache/profile paths. Never read or mutate normal chat data.
- [ ] Run baseline and candidate sequentially with matching inputs: translation, editing, reasoning on/off, multi-turn recall, alternating sessions, compaction, image, audio, and text after media.
- [ ] Exercise cancellation at each lifecycle stage, server crash, malformed stream, startup timeout, missing/corrupt asset, and retry.
- [ ] Measure cold load, three or more warm runs, first token, generation rate, and peak process-tree memory; verify no simultaneous model copies.
- [ ] Record context statistics supported by the pinned server and any loss relative to the text worker.
- [ ] Run isolated Electron UI and packaged Mac smoke checks.
- [ ] Document adopt/fix/reject decision with requirement IDs, evidence, limitations, and any user-approved tradeoffs.

## Results template

For each run record: date; source revision and dirty-tree description; artifact hash; OS/CPU/RAM/GPU/driver; runtime/model hashes; context and reasoning settings; scenario; outcome; latency/rate/memory; and synthetic-only log location. Distinguish not-run from failed and passed.

| Gate | Status | Evidence / next action |
| --- | --- | --- |
| Existing test baseline | Passed | 42/42 pass outside sandbox; codec access explains original failures. |
| Functional parity | Not run | Build isolated A/B harness. |
| Cancellation and lifecycle | Not run | Add targeted adapter tests and real process checks. |
| Context/compaction parity | Not run | Inspect pinned server APIs and compare near-limit conversations. |
| Performance and memory | Not run | Run sequential comparisons on matching hardware/assets. |
| Packaged Mac behavior | Not run | Validate candidate outside checkout. |
| Adoption | Pending | All preceding gates and explicit tradeoff record required. |
