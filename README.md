# Tranzl

A private, on-device translator and text editor for Apple Silicon Macs, powered by a local LLM. Nothing you type ever leaves your machine.

- **Translate** between 20+ languages, auto-detecting the source — results stream in live as you type or paste
- **Edit while translating** (or without translating): proofread & correct, make professional, make casual, simplify — or write your own custom prompt (with history)
- **Chat** with saved conversations in a right-hand session list, streaming Markdown answers, thinking controls, and image, document, spreadsheet, and audio attachments. Search or delete individual sessions, or clear all chats.
- **Three interchangeable backends**: an embedded Gemma 4 E4B model (downloaded once, runs inside the app with Metal acceleration), [LM Studio](https://lmstudio.ai), or [Ollama](https://ollama.com)
- Thinking-trace viewer, token/speed stats, hard-line-break repair for PDF/email pastes, searchable encrypted input history, light/dark themes

## Install (Homebrew)

```bash
brew install --cask zoltanf/tranzl/tranzl
```

The app is ad-hoc signed (not notarized); the cask removes the macOS quarantine attribute after install so it can launch — only install if you trust this tap.

On first launch, choose a backend. "Embedded model" downloads Gemma 4 E4B (~4.6 GB) once into `~/Library/Application Support/tranzl/models/`.

Requirements: Apple Silicon Mac, ~8 GB free RAM for the embedded model.

## Run from source

```bash
npm install
npm start
```

Package and install to /Applications:

```bash
npm run install-app
```

Release a new version (maintainers — builds, zips, publishes a GitHub release, and updates the Homebrew tap):

```bash
npm version patch --no-git-tag-version && git commit -am "Bump version"
scripts/release.sh
```

## How it works

The renderer is a plain context-isolated Electron UI; all model access goes through the main process over IPC. The embedded backend runs [node-llama-cpp](https://node-llama-cpp.withcat.ai/) in a separate utility process so model loading and inference never block the UI; LM Studio and Ollama backends stream over their local HTTP APIs. A shared prompt builder makes all style presets behave identically across backends. Sensitive data (input history, custom prompts, chat sessions, drafts and attached file contents) is stored encrypted with a key held in the macOS Keychain.

## Chat

The sidebar includes a context-usage ring and latest-response statistics: input/output tokens, tokens per second, cached input when reported, and timing. Statistics are saved with each reply. A `~` marks estimates; unavailable capacity or cache counts remain explicitly unknown. The text-only embedded runtime reports actual occupied context during generation. Character-based live input/output estimates never drive the context ring. Server response totals are labeled as estimated request size rather than occupied context; estimates over capacity are explicitly marked. New chat and Clear all sessions are in the Chat toolbar.

When a request approaches the model's context window (about 75% of capacity, earlier when more response space is needed), Tranzl automatically compacts context before sending: older messages, oversized documents and attachments are summarized by the local model while the most recent exchanges stay intact. A progress bar with a percentage shows how much of the context has been summarized; the compacted working context is saved with the session and reused on the next turn, and a small "Context compacted" notice shows the token reduction. The full conversation with original attachments remains saved, so specific details can still be retrieved later. Summaries may omit details.

The Chat tab uses the backend and model selected in Settings. Each session keeps its own thinking effort, messages, draft and attachments. Paste a copied image directly into the Chat composer with ⌘V / Ctrl+V to attach it. In Translate, pasting an image into Source text (or clicking Paste) starts model-based text recognition and translation using the selected language and style; output stays plain text. Remove the image with its Remove image button or Clear. Enter sends; Shift+Enter adds a line; Stop or Escape cancels generation. Embedded Gemma supports thinking on/off; Balanced uses its default (on), while other backends use their model default. Unsupported server thinking options fall back to the model default.

Attach up to 8 files per message, 20 MB per file:

- **Images:** PNG, JPEG, WebP, with previews. Large images are resized to a 1,600-pixel longest edge before inference.
- **Documents:** PDF, DOC and DOCX. Word text and PDF page text are extracted locally; scanned PDF pages are rendered as images for the model. Document figures embedded alongside readable text and Word formatting are not preserved.
- **Spreadsheets:** CSV, TSV, XLS and XLSX. Excel sheets are labeled and converted to readable cell values; macros and formulas are never executed.
- **Audio:** WAV, MP3, FLAC and M4A files with playback controls. M4A (AAC or Apple Lossless) is converted locally on macOS to mono 16 kHz WAV; both the original file and converted audio must fit the 20 MB limit. Conversion uses a private temporary directory that is removed afterward. Audio inference currently uses the Embedded backend; replies are text. No microphone recording is required.
- **Text/code:** UTF-8 and UTF-16LE text, Markdown, JSON, source files and more.

Extraction runs in background workers. A file may contain up to 120,000 extracted characters, a PDF up to 100 pages including at most 4 scanned pages, and a sheet up to 10,000 rows. A conversation is limited to 200,000 text characters, 12 images/scanned pages, 2 audio clips and 40 MB of media. The model's context window may impose a smaller practical limit. Oversized files are rejected with an explanation rather than silently truncated.

The embedded image/audio path uses a pinned, checksum-verified llama.cpp runtime and Gemma projector, downloaded once to `~/Library/Application Support/tranzl/multimodal/` (about 545 MB total). It reuses the existing model file, unloads the text-only worker to avoid holding two model copies, and starts an authenticated server bound only to `127.0.0.1`. Subsequent embedded requests use that runtime until the app exits. Downloads require internet once; inference and file reading remain on-device. LM Studio and Ollama image input requires a vision-capable model in the selected server.

Attachment contents, resized images and audio bytes are encrypted with the session store. Original files are never changed. Markdown includes tables, lists, links, blockquotes and fenced code; model-generated HTML is sanitized and remote images are blocked.

Chats are saved separately in `~/Library/Application Support/tranzl/chats.enc`. When OS encryption is unavailable, the UI reports that chats are temporary. Deleting sessions removes their saved contents from this store.

Run the backend and Electron UI checks:

```bash
npm test
npm run test:electron
```

For an opt-in test against the installed Gemma model, run `node tests/multimodal-live.cjs` with Tranzl closed; it downloads missing multimodal components and tests synthetic image recognition and audio transcription.

The UI check uses a mocked model and temporary storage; it does not modify your saved chats.

## License

Tranzl is free software under the [GPL-3.0-or-later](LICENSE). The embedded Gemma 4 E4B model is downloaded separately and is subject to Google's [Gemma Terms of Use](https://ai.google.dev/gemma/terms) — it is not covered by the GPL.
