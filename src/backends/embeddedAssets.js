const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { verify, downloadVerified } = require('./verifiedAssets');
const runtimeManifest = require('./runtime-files-darwin-arm64.json');
const VERSION = 'b11158';
const REVISION = 'b8093469224f83f5c38f691eb906c380e9e63114';
const MODEL = {
  // Keep the legacy downloader filename so existing settings/cache still work.
  filename: 'hf_ggml-org_gemma-4-E4B-it.Q4_0.gguf', bytes: 4590807392,
  url: `https://huggingface.co/ggml-org/gemma-4-E4B-it-GGUF/resolve/${REVISION}/gemma-4-E4B-it-Q4_0.gguf`,
  sha256: 'a555b900214b477d8880e7832e0b8925e139b0159640036b09fe472b6f2097f2',
};
const PROJECTOR = { filename: 'gemma-4-E4B-mmproj-Q8_0.gguf', bytes: 559874816,
  url: `https://huggingface.co/ggml-org/gemma-4-E4B-it-GGUF/resolve/${REVISION}/mmproj-gemma-4-E4B-it-Q8_0.gguf`,
  sha256: '197f49a93027f9843772bd24a6a9e0be2a32a788de5a3def330e9c585d86edd1' };
// Additional native targets are intentionally gated on Stage D validation.
const RUNTIMES = { 'darwin-arm64': {
  bytes: 11190982,
  url: `https://github.com/ggml-org/llama.cpp/releases/download/${VERSION}/llama-${VERSION}-bin-macos-arm64.tar.gz`,
  sha256: 'baf0d6366819beab9c4b85304117c5ab2f8a078c1a144ac26153efab48b884b8',
  files: runtimeManifest.files,
} };
function paths(dir) {
  const runtime = RUNTIMES[`${process.platform}-${process.arch}`];
  if (!runtime) throw new Error('Embedded inference is not packaged for this platform yet. Use an external local backend.');
  return { runtime, binary: path.join(dir, `llama-${VERSION}`, 'llama-server'), projector: path.join(dir, PROJECTOR.filename) };
}
async function prepare({ dir, modelPath, media, signal, onStatus = () => {} }) {
  const { runtime, binary, projector } = paths(dir);
  onStatus('Verifying embedded model…');
  if (!await verify(modelPath, MODEL, signal)) throw new Error('The embedded model is missing or failed verification. Download it again in Settings.');
  if (!await verifyRuntime(path.dirname(binary), runtime.files, signal)) {
    onStatus('Downloading verified inference runtime…');
    const archive = await downloadVerified(runtime, path.join(dir, `llama-${VERSION}.tar.gz`), { signal });
    const staging = await fs.mkdtemp(path.join(dir, '.runtime-')); let preserveStaging = false;
    try {
      // This is an immutable checksum-verified archive, never user input.
      await promisify(execFile)('/usr/bin/tar', ['-xzf', archive, '-C', staging], { signal });
      const staged = path.join(staging, `llama-${VERSION}`), target = path.dirname(binary);
      if (!await verifyRuntime(staged, runtime.files, signal)) throw new Error('Extracted runtime failed verification.');
      const backup = path.join(staging, 'previous'); let backedUp = false;
      try { await fs.rename(target, backup); backedUp = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      try { await fs.rename(staged, target); }
      catch (error) {
        if (backedUp) {
          try { await fs.rename(backup, target); }
          catch { preserveStaging = true; throw new Error(`Runtime installation failed. The previous runtime is preserved in ${backup}.`); }
        }
        throw error;
      }
    } finally { if (!preserveStaging) await fs.rm(staging, { recursive: true, force: true }); }
  }
  if (media) {
    onStatus('Preparing image/audio support…');
    let lastProgress = 0;
    await downloadVerified(PROJECTOR, projector, { signal, onProgress: (done, total) => {
      if (Date.now() - lastProgress < 250 && done !== total) return;
      lastProgress = Date.now();
      onStatus(`Downloading image/audio component: ${Math.round(done / 1048576)} / ${Math.round(total / 1048576)} MB`);
    } });
  }
}
async function verifyRuntime(dir, files, signal) {
  for (const [name, sha256] of Object.entries(files)) {
    if (!await verify(path.join(dir, name), { sha256 }, signal)) return false;
  }
  return true;
}
module.exports = { MODEL, PROJECTOR, VERSION, paths, prepare, verifyRuntime, downloadModel: ({ dirPath, ...options }) => downloadVerified(MODEL, path.join(dirPath, MODEL.filename), options) };
