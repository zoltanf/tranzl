const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { selectProfile } = require('../src/profile');

function setup(t) {
  const appData = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tranzl-appdata-')));
  t.after(() => fs.rmSync(appData, { recursive: true, force: true }));
  const normal = path.join(appData, 'tranzl'); fs.mkdirSync(normal);
  const app = { paths: {}, getPath: () => appData, setPath(name, value) { this.paths[name] = value; } };
  return { appData, normal, app };
}
test('without a test profile the normal profile is pinned', t => {
  const { normal, app } = setup(t);
  assert.deepEqual(selectProfile(app, {}), { dir: normal, test: false });
  assert.equal(app.paths.userData, normal);
});
test('a separate absolute test profile is created privately and selected', t => {
  const { appData, app } = setup(t);
  const dir = path.join(appData, 'profiles', 'run 1 ü');
  assert.deepEqual(selectProfile(app, { TRANZL_TEST_PROFILE: dir }), { dir, test: true });
  assert.equal(app.paths.userData, dir);
  if (process.platform !== 'win32') assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
});
test('test profiles overlapping the normal profile are refused before any write', t => {
  const { appData, normal, app } = setup(t);
  const link = path.join(appData, 'link'); fs.symlinkSync(normal, link, 'dir');
  const refused = ['relative/profile', normal, path.join(normal, 'nested'), appData, path.join(link, 'sub')];
  if (process.platform === 'darwin') refused.push(normal.toUpperCase().replace(appData.toUpperCase(), appData));
  for (const dir of refused) {
    assert.throws(() => selectProfile(app, { TRANZL_TEST_PROFILE: dir }), /absolute path|separate from the normal/, dir);
  }
  assert.equal(app.paths.userData, undefined);
  assert.deepEqual(fs.readdirSync(normal), []);
});
