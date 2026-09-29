const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { verify, downloadVerified } = require('./verifiedAssets');
const manifest = require('./runtime-manifest.json');
const VERSION = manifest.version;
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
// Only natively validated targets are listed; others fail clearly (see Stage D).
// Immutable checksum-verified archives only, never user input. Windows 10+ ships
// bsdtar as System32\tar.exe, which also reads zip.
const tar = () => process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar';
const EXTRACTORS = {
  'tar.gz': (archive, dest, signal) => promisify(execFile)(tar(), ['-xzf', archive, '-C', dest], { signal, windowsHide: true }),
  zip: (archive, dest, signal) => promisify(execFile)(tar(), ['-xf', archive, '-C', dest], { signal, windowsHide: true }),
};
function runtimeFor(target = `${process.platform}-${process.arch}`) {
  const runtime = manifest.targets[target];
  if (!runtime) throw new Error(`Embedded inference is not available for ${target} yet. Use an external local backend.`);
  return runtime;
}
function paths(dir, target) {
  const runtime = runtimeFor(target);
  // The install directory name predates the manifest; keep it so existing runtimes are reused.
  return { runtime, binary: path.join(dir, `llama-${VERSION}`, runtime.executable), projector: path.join(dir, PROJECTOR.filename) };
}
async function prepare({ dir, modelPath, media, signal, onStatus = () => {} }) {
  const { runtime, binary, projector } = paths(dir);
  onStatus('Verifying embedded model…');
  if (!await verify(modelPath, MODEL, signal)) throw new Error('The embedded model is missing or failed verification. Download it again in Settings.');
  if (!await verifyRuntime(path.dirname(binary), runtime.files, signal)) {
    onStatus('Downloading verified inference runtime…');
    const archive = await downloadVerified(runtime, path.join(dir, `llama-${VERSION}.${runtime.archive.format}`), { signal });
    const staging = await fs.mkdtemp(path.join(dir, '.runtime-')); let preserveStaging = false;
    try {
      const extract = EXTRACTORS[runtime.archive.format];
      if (!extract) throw new Error(`Unsupported runtime archive format: ${runtime.archive.format}`);
      // Extract into a subfolder: some archives (Windows) have no top-level directory.
      const extracted = path.join(staging, 'extracted'); await fs.mkdir(extracted);
      await extract(archive, extracted, signal);
      const staged = path.join(extracted, runtime.archive.root), target = path.dirname(binary);
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
module.exports = { MODEL, PROJECTOR, VERSION, manifest, archiveFormats: Object.keys(EXTRACTORS), runtimeFor, paths, prepare, verifyRuntime, downloadModel: ({ dirPath, ...options }) => downloadVerified(MODEL, path.join(dirPath, MODEL.filename), options) };
