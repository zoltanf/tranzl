// Packages Tranzl natively for the host OS/architecture. Builds only: never installs or publishes.
// Each target must be built on its own OS and architecture with a clean `npm ci`.
const { packager } = require('@electron/packager');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const IGNORE = [/^\/dist(?:\/|$)/, /^\/out(?:\/|$)/, /^\/docs(?:\/|$)/, /^\/tests(?:\/|$)/, /^\/build(?:\/|$)/, /^\/scripts(?:\/|$)/];
// Explicit per-OS adapters. Targets without one are left unsigned (Stage F).
const ICONS = { darwin: 'build/icon.icns' };
const SIGNERS = {
  darwin(dir, name) {
    const app = path.join(dir, `${name}.app`);
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
    execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  },
};

async function pack({ name = 'Tranzl', appBundleId = 'com.tranzl.app', out = path.join(root, 'dist'), afterCopy = [] } = {}) {
  const icon = ICONS[process.platform];
  const paths = await packager({ dir: root, out, name, appBundleId, platform: process.platform, arch: process.arch,
    asar: false, overwrite: true, ignore: IGNORE, afterCopy, ...(icon && { icon: path.join(root, icon) }) });
  const sign = SIGNERS[process.platform];
  for (const dir of paths) sign ? sign(dir, name) : console.warn(`No signing adapter for ${process.platform}; ${dir} is unsigned.`);
  return paths;
}

if (require.main === module) {
  pack().then(paths => console.log(paths.join('\n'))).catch(error => { console.error(error); process.exitCode = 1; });
}
module.exports = { pack, root };
