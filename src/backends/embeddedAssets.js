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
// Linux runtimes need at least the glibc they were built against (pin-runtime.cjs records it).
let systemGlibc;
const glibcVersion = () => (systemGlibc ??= (process.platform === 'linux' && process.report?.getReport?.().header?.glibcVersionRuntime) || null);
function atLeast(have, need) {
  const [a, b] = [have, need].map(version => version.split('.').map(Number));
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return true;
}
function unsupportedReason(runtime, glibc) {
  if (!runtime.minGlibc || (glibc && atLeast(glibc, runtime.minGlibc))) return null;
  return glibc
    ? `Embedded inference on this system needs glibc ${runtime.minGlibc} or newer (for example Ubuntu 24.04); this system has ${glibc}. Use LM Studio or Ollama instead.`
    : `Embedded inference needs a glibc-based Linux system (glibc ${runtime.minGlibc} or newer). Use LM Studio or Ollama instead.`;
}
function runtimeFor(target = `${process.platform}-${process.arch}`) {
  const runtime = manifest.targets[target];
  if (!runtime) throw new Error(`Embedded inference is not available for ${target} yet. Use an external local backend.`);
  if (target === `${process.platform}-${process.arch}`) {
    const reason = unsupportedReason(runtime, glibcVersion());
    if (reason) throw new Error(reason);
  }
  return runtime;
}
// Whether this system can run the embedded model: a pinned runtime for it, and enough memory.
function availability() {
  try { runtimeFor(); } catch (error) { return { available: false, reason: error.message }; }
  const policy = require('./resourcePolicy').resourcePolicy();
  return policy.available ? { available: true, contextSize: policy.contextSize, note: policy.note ?? null } : { available: false, reason: policy.reason };
}
function paths(dir, target) {
  const runtime = runtimeFor(target);
  // The install directory name predates the manifest; keep it so existing runtimes are reused.
  return { runtime, binary: path.join(dir, `llama-${VERSION}`, runtime.executable), projector: path.join(dir, PROJECTOR.filename) };
}
// Installs the pinned runtime for this system if it is missing or fails verification.
async function ensureRuntime({ dir, signal, onStatus = () => {} }) {
  const { runtime, binary } = paths(dir);
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
      // Some upstream archives (Windows) omit llama.cpp's own license; ship our pinned copy.
      for (const [name, sha256] of Object.entries(runtime.bundledNotices || {})) {
        const source = path.join(__dirname, 'llama.cpp-LICENSE');
        if (!await verify(source, { sha256 }, signal)) throw new Error(`Bundled notice ${name} failed verification.`);
        await fs.copyFile(source, path.join(staged, name));
      }
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
  return binary;
}
// Runs the installed server without a model, so a system whose libraries cannot load it is
// found out before the 4.6 GB model download rather than at first use.
async function probeRuntime(binary, { signal, timeoutMs = 20000, execFileImpl = execFile } = {}) {
  try {
    await promisify(execFileImpl)(binary, ['--version'], { signal, timeout: timeoutMs, maxBuffer: 1 << 20, windowsHide: true });
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    const output = `${error.stderr || ''}\n${error.stdout || ''}\n${error.message}`;
    const detail = /version `?(GLIBCXX|CXXABI|GLIBC)_[\d.]+'? not found/i.test(output) ? 'This system\'s C/C++ runtime libraries are older than the inference runtime needs (for example Ubuntu 24.04 or newer is required).'
      : /error while loading shared libraries|cannot open shared object|not found \(required by|The code execution cannot proceed|is not recognized|\.dll was not found|Library not loaded|image not found/i.test(output)
        || error.code === 3221225781 || error.code === -1073741515 ? 'A library the inference runtime needs is missing on this system.' // incl. dyld and STATUS_DLL_NOT_FOUND
      : error.code === 'ENOENT' ? 'The inference runtime executable is missing.'
      // SIGILL on Unix, STATUS_ILLEGAL_INSTRUCTION (0xC000001D) on Windows: the CPU lacks an instruction set the runtime needs.
      : error.signal === 'SIGILL' || error.code === 3221225501 || error.code === -1073741795 ? 'This computer\'s processor lacks instructions the inference runtime needs.'
      : error.killed || error.code === 'ETIMEDOUT' ? 'The inference runtime did not respond in time.'
      : `The inference runtime could not start (${error.code ?? error.signal ?? 'unknown error'}).`;
    throw new Error(`${detail} The embedded model cannot run here; use LM Studio or Ollama instead.`);
  }
}
// Compute devices the runtime sees, from `llama-server --list-devices` (model-free). llama.cpp
// offloads all layers to the first GPU device by default, so under Automatic a listed GPU means
// GPU inference; this avoids verbose server logs, which would also carry prompt text.
function parseDevices(output) {
  return [...output.matchAll(/^\s+([A-Za-z]+\d*):\s+(.+?)(?:\s+\(\d+ MiB.*\))?\s*$/gm)]
    .map(([, name, description]) => ({ name, description, gpu: !/^(CPU|BLAS)/i.test(name) }));
}
async function listDevices(binary, { signal, timeoutMs = 20000, execFileImpl = execFile } = {}) {
  try {
    const { stdout, stderr } = await promisify(execFileImpl)(binary, ['--list-devices'], { signal, timeout: timeoutMs, maxBuffer: 1 << 20, windowsHide: true });
    return parseDevices(`${stdout}\n${stderr}`);
  } catch { return null; } // unknown, never fatal
}
// Acquisition plus probe: what must succeed before offering the model download.
async function prepareRuntime(options) {
  const binary = await ensureRuntime(options);
  options.onStatus?.('Checking the inference runtime on this system…');
  await probeRuntime(binary, { signal: options.signal });
  return binary;
}
async function prepare({ dir, modelPath, media, signal, onStatus = () => {} }) {
  const { projector } = paths(dir);
  onStatus('Verifying embedded model…');
  if (!await verify(modelPath, MODEL, signal)) throw new Error('The embedded model is missing or failed verification. Download it again in Settings.');
  await ensureRuntime({ dir, signal, onStatus });
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
module.exports = { MODEL, PROJECTOR, VERSION, manifest, archiveFormats: Object.keys(EXTRACTORS), runtimeFor, unsupportedReason, availability, paths, ensureRuntime, probeRuntime, prepareRuntime, parseDevices, listDevices, prepare, verifyRuntime, downloadModel: ({ dirPath, ...options }) => downloadVerified(MODEL, path.join(dirPath, MODEL.filename), options) };
