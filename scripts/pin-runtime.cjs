// Maintainer tool: pins one upstream llama.cpp release archive in runtime-manifest.json.
// Downloads it through Tranzl's verified downloader, checked against GitHub's published
// SHA-256, and records the server, every shared library and the license with their hashes
// (and, on Linux, the minimum glibc the binaries require).
// Pinning is not validation: a target counts as supported only after its native checks pass.
//   node scripts/pin-runtime.cjs <target> [--check]   e.g. linux-x64; --check compares only
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { downloadVerified } = require('../src/backends/verifiedAssets');
const manifestFile = path.join(__dirname, '../src/backends/runtime-manifest.json');
const TARGETS = {
  'darwin-arm64': { asset: 'macos-arm64.tar.gz', compute: ['metal', 'cpu'] },
  'linux-x64': { asset: 'ubuntu-x64.tar.gz', compute: ['cpu'] },
  'linux-arm64': { asset: 'ubuntu-arm64.tar.gz', compute: ['cpu'] },
  'win32-x64': { asset: 'win-cpu-x64.zip', compute: ['cpu'] },
};
const [target, flag] = process.argv.slice(2);
if (!TARGETS[target]) throw new Error(`target must be one of ${Object.keys(TARGETS).join(', ')}`);

(async () => {
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')), version = manifest.version;
  const name = `llama-${version}-bin-${TARGETS[target].asset}`;
  const release = await (await fetch(`https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/${version}`)).json();
  const upstream = release.assets?.find(asset => asset.name === name);
  if (!upstream?.digest?.startsWith('sha256:')) throw new Error(`${name} has no published SHA-256 digest`);
  const archive = { url: upstream.browser_download_url, bytes: upstream.size, sha256: upstream.digest.slice(7) };
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tranzl-pin-'));
  try {
    await downloadVerified(archive, path.join(work, name));
    // bsdtar (macOS, Windows) reads both tar.gz and zip; run this on one of those.
    fs.mkdirSync(path.join(work, 'x'));
    execFileSync('tar', ['-xf', path.join(work, name), '-C', path.join(work, 'x')]);
    const top = fs.readdirSync(path.join(work, 'x'));
    const root = top.length === 1 && fs.statSync(path.join(work, 'x', top[0])).isDirectory() ? top[0] : '.';
    const dir = path.join(work, 'x', root), executable = target.startsWith('win32') ? 'llama-server.exe' : 'llama-server';
    const keep = file => file === executable || /^LICENSE/.test(file) || /\.(dll|dylib)$|\.so(\.\d+)*$/.test(file);
    const files = {};
    for (const file of fs.readdirSync(dir).filter(keep).sort()) files[file] = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, file))).digest('hex');
    if (!files[executable]) throw new Error(`${executable} not found at the archive root`);
    const format = name.endsWith('.zip') ? 'zip' : 'tar.gz';
    const [osName, arch] = target.split('-');
    // Linux binaries need at least the newest GLIBC_x.y symbol version they reference.
    const byVersion = (a, b) => a.split('.').map(Number).reduce((order, n, i) => order || n - (Number(b.split('.')[i]) || 0), 0) || a.split('.').length - b.split('.').length;
    const minGlibc = osName === 'linux' ? Object.keys(files).flatMap(file => [...fs.readFileSync(path.join(dir, file), 'latin1').matchAll(/GLIBC_(\d+(?:\.\d+)+)/g)].map(match => match[1])).sort(byVersion).at(-1) : undefined;
    const entry = { os: osName, arch, compute: TARGETS[target].compute, ...archive, archive: { format, root }, executable,
      ...(minGlibc && { minGlibc }), notices: Object.keys(files).filter(file => /^LICENSE/.test(file)), files };
    if (flag === '--check') {
      const same = JSON.stringify(entry) === JSON.stringify(manifest.targets[target]);
      console.log(`${target}: ${same ? 'matches the pinned entry' : 'DIFFERS from the pinned entry'}`);
      if (!same) process.exitCode = 1;
      return;
    }
    manifest.targets[target] = entry;
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
    console.log(`${target}: pinned ${name} (${Object.keys(files).length} files, root ${root})`);
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
