# Tranzl

A private, on-device translator and text editor for Apple Silicon Macs, powered by a local LLM. Nothing you type ever leaves your machine.

- **Translate** between 20+ languages, auto-detecting the source — results stream in live as you type or paste
- **Edit while translating** (or without translating): proofread & correct, make professional, make casual, simplify — or write your own custom prompt (with history)
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

The renderer is a plain context-isolated Electron UI; all model access goes through the main process over IPC. The embedded backend runs [node-llama-cpp](https://node-llama-cpp.withcat.ai/) in a separate utility process so model loading and inference never block the UI; LM Studio and Ollama backends stream over their local HTTP APIs. A shared prompt builder makes all style presets behave identically across backends. Sensitive data (input history, custom prompts) is stored encrypted with a key held in the macOS Keychain.

## License

Tranzl is free software under the [GPL-3.0-or-later](LICENSE). The embedded Gemma 4 E4B model is downloaded separately and is subject to Google's [Gemma Terms of Use](https://ai.google.dev/gemma/terms) — it is not covered by the GPL.
