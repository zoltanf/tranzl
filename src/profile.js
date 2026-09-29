// Selects the data directory before app initialization. TRANZL_TEST_PROFILE isolates
// validation runs: it must be an absolute path that neither is, contains, nor lies inside
// the normal profile, so a test launch can never read or write real user data.
const fs = require('fs');
const path = require('path');

// Resolves symlinks through the nearest existing ancestor, so the check holds before creation.
function real(dir) {
  const rest = [];
  for (let current = path.resolve(dir); ; current = path.dirname(current)) {
    try { return path.join(fs.realpathSync.native(current), ...rest); }
    catch { if (path.dirname(current) === current) return path.resolve(dir); rest.unshift(path.basename(current)); }
  }
}
const within = (parent, child) => { const rel = path.relative(parent, child); return !rel.startsWith('..') && !path.isAbsolute(rel); };

function selectProfile(app, env = process.env) {
  // Pinned so settings and the downloaded model survive rebranding/packaging.
  const normal = path.join(app.getPath('appData'), 'tranzl');
  const requested = env.TRANZL_TEST_PROFILE;
  if (!requested) { app.setPath('userData', normal); return { dir: normal, test: false }; }
  if (!path.isAbsolute(requested)) throw new Error('TRANZL_TEST_PROFILE must be an absolute path.');
  const [a, b] = [real(normal), real(requested)];
  // Case-insensitive volumes (default on macOS/Windows) must not alias the normal profile.
  const [x, y] = process.platform === 'linux' ? [a, b] : [a.toLowerCase(), b.toLowerCase()];
  if (within(x, y) || within(y, x)) throw new Error('TRANZL_TEST_PROFILE must be separate from the normal Tranzl profile.');
  fs.mkdirSync(requested, { recursive: true, mode: 0o700 });
  app.setPath('userData', path.resolve(requested));
  return { dir: path.resolve(requested), test: true };
}
module.exports = { selectProfile };
