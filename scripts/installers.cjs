// Builds installers for the host OS from the already packaged, tested app directory
// (dist/Tranzl-<platform>-<arch>, from scripts/pack.cjs). Builds only; never publishes.
// Usage: node scripts/installers.cjs [--arch=x64|arm64]
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const arch = (process.argv.find(arg => arg.startsWith('--arch=')) || `--arch=${process.arch}`).split('=')[1];
const prepackaged = path.join(root, 'dist', `Tranzl-${process.platform}-${arch}`);
if (!fs.existsSync(prepackaged)) throw new Error(`Package first (npm run pack): ${prepackaged} is missing`);
const targets = { linux: ['--linux', 'deb', 'pacman', 'AppImage'], win32: ['--win', 'nsis', 'zip'] }[process.platform];
if (!targets) throw new Error(`Installers for ${process.platform} are built by their own flow (macOS: scripts/release.sh ZIP)`);
// Tranzl's installers are not code-signed yet (documented); never let the builder try.
const env = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false', WIN_CSC_LINK: '', CSC_LINK: '' };
execFileSync(path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder'),
  ['--prepackaged', prepackaged, ...targets, `--${arch}`, '--publish', 'never', '--config', path.join(root, 'electron-builder.yml')],
  { stdio: 'inherit', cwd: root, env, shell: process.platform === 'win32' });
const out = path.join(root, 'dist', 'installers');
// electron-builder names Arch packages ".pacman"; give them the extension pacman users expect, by actual compression.
for (const name of fs.readdirSync(out).filter(n => n.endsWith('.pacman'))) {
  const head = Buffer.alloc(6); const fd = fs.openSync(path.join(out, name), 'r'); fs.readSync(fd, head, 0, 6, 0); fs.closeSync(fd);
  const ext = head.readUInt32LE(0) === 0xFD2FB528 ? 'pkg.tar.zst' : head.toString('hex').startsWith('fd377a585a00') ? 'pkg.tar.xz' : head[0] === 0x1f && head[1] === 0x8b ? 'pkg.tar.gz' : null;
  if (ext) fs.renameSync(path.join(out, name), path.join(out, name.replace(/\.pacman$/, `.${ext}`)));
}
console.log(fs.readdirSync(out).filter(name => /\.(deb|pkg\.tar\.(zst|xz|gz)|AppImage|exe|zip)$/.test(name)).map(name => `${name} (${Math.round(fs.statSync(path.join(out, name)).size / 1048576)} MB)`).join('\n'));
