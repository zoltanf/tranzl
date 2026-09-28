# Unified inference and multiplatform requirements

Updated: 2026-09-28. Status: agreed direction; implementation and validation pending.

## Objective and precedence

Evaluate and, if the acceptance gates pass, adopt one managed llama.cpp server runtime for all embedded text, image, and audio inference **before** starting the multiplatform rollout. Then deliver macOS ARM64, Windows x64, Linux x64, and Linux ARM64 from one codebase.

The user explicitly requested this ordering. This document defines requirements; [the implementation plan](multiplatform-plan.md) defines execution order; [the runtime evaluation](runtime-evaluation.md) records evidence and the adoption decision. Do not treat a planned capability as a verified one.

## Scope

- Preserve translation, editing presets, custom prompts, Chat, reasoning controls, attachments, context compaction, streaming, statistics, cancellation, and encrypted persistence.
- Preserve the current Apple Silicon experience, model cache, application identity, settings, and saved data.
- Keep LM Studio and Ollama independent of embedded runtime availability. Confirm their platform/architecture availability before documenting support.
- Initially validate Windows 11 x64 and Ubuntu 22.04/24.04 desktop on x64 and ARM64; confirm minimum OS versions against actual dependencies.
- Keep the renderer framework and context-isolated IPC architecture.
- Windows ARM64, Intel Macs, other Linux distributions, sync, automatic updates, model changes, and a UI rewrite are outside this project.

## Required behavior and acceptance criteria

| ID | Requirement | Acceptance evidence |
| --- | --- | --- |
| INF-01 | Use one managed inference runtime after adoption, with at most one loaded model instance. | Alternate text, image, audio, and text again; process inventory and memory measurements show no second model copy. |
| INF-02 | Preserve translation and multi-turn Chat behavior with the existing GGUF and reasoning on/off. | Synthetic translation, editing, conversational recall, separate-session isolation, and reasoning-stream cases complete on baseline and candidate. |
| INF-03 | Preserve incremental answers and separate thinking output. | Stream parser tests cover split UTF-8/SSE chunks, final unterminated lines, server errors, and completion; real requests visibly stream. |
| INF-04 | Serialize model work and preserve request ownership. | Concurrent Translate/Chat/compaction attempts cannot mix output, conversation state, or completion events. |
| INF-05 | Cancellation is terminal and allows a later request to succeed. | Cancel before start, while queued, loading, thinking, and generating; no late answer is saved, no pending promise remains, next request completes. |
| INF-06 | Handle runtime exit, failed startup, and shutdown predictably. | Detect spawn/exit errors, bound startup and shutdown waits, settle pending requests, terminate the owned child, and permit a bounded fresh-process retry. Never automatically replay a partially streamed answer. |
| INF-07 | Preserve reliable context measurement and compaction. | Validate template-aware input counts, effective context capacity, output allowance, and near-limit compaction. Distinguish evaluated input, cached tokens, occupied context, and estimates. Never label input-plus-output totals as actual occupied context. |
| INF-08 | Retain useful statistics with honest availability. | Record first-token latency, output tokens, rate, and context capacity where supported. Unknown values remain unknown. Loss of actual occupied-context reporting is an explicit adoption tradeoff, not a silent regression. |
| INF-09 | Provide CPU correctness and recovery before claiming acceleration. | Packaged CPU generation on each target; test Metal/CUDA/Vulkan separately on hardware claimed as supported. Classify failures where possible and bound fallback attempts. |
| INF-10 | Keep text-only setup independent of optional media assets. | Text can run with only the model and core runtime. Load/download the projector on media use; if a server restart is required, serialize it without loading two models or losing the request. |
| DIST-01 | Pin all runtime and model assets. | Manifest records OS, architecture, compute backend, revision, URL, checksum, archive layout, executable, companion libraries, and notices. Hash validation occurs before use. |
| DIST-02 | Preserve existing downloaded models and support reliable acquisition. | Recognize existing model paths, verify compatibility, resume/retry interrupted downloads safely, handle low disk space, and preserve valid assets on failure. |
| DIST-03 | Remove the old native dependency only after replacing all its uses. | Audit includes model downloading and token counting as well as generation; no runtime import or packaged native dependency on `node-llama-cpp` remains after migration. |
| SEC-01 | Keep inference local and private. | Bind only to loopback, use a per-process authentication token, exclude tokens/content from logs, block unintended remote media fetching, and infer offline after setup. |
| SEC-02 | Preserve secure persistence across platforms. | A shared storage capability check rejects Linux `basic_text`; unavailable keyrings produce visible temporary storage. Unreadable encrypted stores cannot be overwritten by defaults. Restart and failed-write tests preserve data. |
| PORT-01 | Build natively for all four targets. | Separate OS/architecture jobs install locked dependencies with `npm ci`; Linux ARM64 artifacts contain ARM64 binaries and are exercised on ARM64 hardware. End users need no compilers. |
| PORT-02 | Provide consistent attachment capability reporting. | Portable converters support advertised formats with existing size/time limits; unsupported formats are explained before submission. Decide explicitly whether legacy DOC is deferred; DOCX remains supported. |
| PORT-03 | Make shared build and test entry points portable. | Node-based orchestration avoids Unix-only commands; fixtures do not require macOS speech/audio tools. OS signing and installer operations remain explicit adapters. |
| PORT-04 | Ship usable installed artifacts. | Mac app/ZIP, Windows installer/ZIP, and Linux x64/ARM64 AppImage/deb pass clean-machine launch, inference, desktop integration, upgrade, and persistence checks. |
| QA-01 | Isolate validation from production data. | Test profile is selected before app initialization; synthetic prompts/files only; no writes to normal settings, chats, history, or caches. Explicit existing model files may be reused read-only. |
| QA-02 | Make performance decisions from comparable measurements. | Same machine/model/context/prompts, sequential baseline/candidate runs, at least three warm runs and a cold load; report median timings, peak memory, selected backend, versions, and raw results. |

## Adoption decision

Adoption requires passing functional, lifecycle, privacy, and context-compaction requirements on the existing Mac target, followed by a packaged Mac smoke test. Compare text performance before removing the existing backend. A repeatable regression greater than 20% in median first-token latency or generation rate, or 15% in peak memory, triggers investigation; these are proposed evaluation thresholds, not promised performance guarantees. Explain measurement limitations and agree any unresolved material behavior tradeoff with the user before switching the default.

If a gate fails, keep the existing default and fix or document the failure; do not move on to multiplatform packaging as though consolidation succeeded. A failed evaluation may justify retaining the dual-runtime design, but changing the user's requested sequence requires an explicit decision.

## Completion

Done means the single-runtime decision is documented, the adopted architecture passes its gates, all four target artifacts have recorded validation, requirements map to evidence, and installation/support documentation matches actual capabilities. Packaging success alone is not proof of inference or feature support. Missing hardware or credentials remain clearly identified release blockers.
