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
console.log(fs.readdirSync(out).filter(name => /\.(deb|pkg\.tar\.zst|AppImage|exe|zip)$/.test(name)).map(name => `${name} (${Math.round(fs.statSync(path.join(out, name)).size / 1048576)} MB)`).join('\n'));
