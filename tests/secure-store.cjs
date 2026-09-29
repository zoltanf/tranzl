const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { storageStatus, createSecureStore } = require('../src/secureStore');

// Synthetic stand-in for Electron safeStorage; `locked` models an unavailable keyring key.
function fakeSafeStorage({ available = true, backend = 'gnome_libsecret' } = {}) {
  const storage = { available, backend, locked: false,
    isEncryptionAvailable: () => storage.available,
    getSelectedStorageBackend: () => storage.backend,
    encryptString: text => Buffer.from('enc:' + text),
    decryptString(bytes) {
      const text = bytes.toString();
      if (storage.locked || !text.startsWith('enc:')) throw new Error('Error while decrypting the ciphertext');
      return text.slice(4);
    } };
  return storage;
}
function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tranzl-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
// Registers the real IPC handlers for both stores against a temporary profile.
function stores(dir, safeStorage) {
  const handlers = new Map();
  const electron = { ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, safeStorage, dialog: {},
    app: { setPath() {}, getPath: () => dir, whenReady: () => ({ then() {} }), on() {} } };
  const mainPath = path.resolve(__dirname, '../src/main.js'), realRequire = createRequire(mainPath);
  const context = vm.createContext({ require: name => name === 'electron' ? electron : realRequire(name), AbortController, AbortSignal, TextDecoder, Buffer, console, __dirname: path.dirname(mainPath) });
  vm.runInContext(fs.readFileSync(mainPath, 'utf8'), context);
  // Results cross a vm realm (like IPC); compare plain copies.
  const call = async (name, ...args) => JSON.parse(JSON.stringify(await handlers.get(name)({}, ...args)));
  return { call };
}

test('storage status rejects missing encryption and Linux basic_text only', () => {
  assert.equal(storageStatus(fakeSafeStorage({ available: false }), 'darwin').persistent, false);
  assert.equal(storageStatus(fakeSafeStorage({ backend: 'basic_text' }), 'linux').persistent, false);
  assert.equal(storageStatus(fakeSafeStorage({ backend: 'gnome_libsecret' }), 'linux').persistent, true);
  const mac = fakeSafeStorage(); mac.getSelectedStorageBackend = () => { throw new Error('Linux only'); };
  assert.equal(storageStatus(mac, 'darwin').persistent, true);
});

test('chat and history survive restart and deletion', async t => {
  const dir = tempDir(t), safeStorage = fakeSafeStorage();
  let app = stores(dir, safeStorage);
  assert.deepEqual(await app.call('chat-load'), { sessions: [], persistent: true });
  assert.deepEqual(await app.call('history-load'), { store: null, persistent: true });
  const sessions = [{ id: 'a', messages: [{ role: 'user', content: 'synthetic alpha' }] }, { id: 'b', messages: [] }];
  assert.deepEqual(await app.call('chat-save', { sessions, activeId: 'b' }), { ok: true });
  assert.deepEqual(await app.call('history-save', { sourceHistory: [{ text: 'synthetic source', ts: 1 }] }), { ok: true });
  app = stores(dir, safeStorage);
  assert.equal((await app.call('chat-load')).sessions.length, 2);
  assert.equal((await app.call('history-load')).store.sourceHistory[0].text, 'synthetic source');
  assert.deepEqual(await app.call('chat-save', { sessions: sessions.slice(0, 1), activeId: 'a' }), { ok: true });
  app = stores(dir, safeStorage);
  const reloaded = await app.call('chat-load');
  assert.deepEqual(reloaded.sessions.map(s => s.id), ['a']); assert.equal(reloaded.activeId, 'a');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['chats.enc', 'history.enc']);
});

test('legacy history array format still loads', async t => {
  const dir = tempDir(t), safeStorage = fakeSafeStorage();
  fs.writeFileSync(path.join(dir, 'history.enc'), safeStorage.encryptString(JSON.stringify([{ text: 'old', ts: 1 }])));
  assert.deepEqual((await stores(dir, safeStorage).call('history-load')).store, { sourceHistory: [{ text: 'old', ts: 1 }] });
});

for (const name of ['chats.enc', 'history.enc']) {
  const [load, save, data] = name === 'chats.enc' ? ['chat-load', 'chat-save', { sessions: [] }] : ['history-load', 'history-save', { sourceHistory: [] }];
  test(`${name}: unreadable ciphertext is reported and never overwritten`, async t => {
    const dir = tempDir(t), safeStorage = fakeSafeStorage(), file = path.join(dir, name);
    fs.writeFileSync(file, safeStorage.encryptString(JSON.stringify(name === 'chats.enc' ? { sessions: [{ id: 'keep' }] } : { customPrompt: 'keep' })));
    const original = fs.readFileSync(file);
    safeStorage.locked = true;
    let app = stores(dir, safeStorage);
    const loaded = await app.call(load);
    assert.equal(loaded.persistent, false); assert.match(loaded.error, /could not be read.*not changed/);
    assert.equal((await app.call(save, data)).ok, false);
    assert.deepEqual(fs.readFileSync(file), original);
    // Once the keyring unlocks, a restart reads the preserved data.
    safeStorage.locked = false; app = stores(dir, safeStorage);
    assert.equal((await app.call(load)).persistent, true);
  });
  test(`${name}: save before load cannot replace unreadable data`, async t => {
    const dir = tempDir(t), safeStorage = fakeSafeStorage(), file = path.join(dir, name);
    fs.writeFileSync(file, 'corrupt');
    assert.equal((await stores(dir, safeStorage).call(save, data)).ok, false);
    assert.equal(fs.readFileSync(file, 'utf8'), 'corrupt');
  });
  test(`${name}: unavailable keyring is memory-only`, async t => {
    const dir = tempDir(t), app = stores(dir, fakeSafeStorage({ available: false }));
    const loaded = await app.call(load);
    assert.equal(loaded.persistent, false); assert.match(loaded.error, /only last until you close the app/);
    assert.equal((await app.call(save, data)).ok, false);
    assert.deepEqual(fs.readdirSync(dir), []);
  });
}

test('Linux basic_text never writes a file', t => {
  const dir = tempDir(t);
  const store = createSecureStore({ file: () => path.join(dir, 'chats.enc'), safeStorage: fakeSafeStorage({ backend: 'basic_text' }), label: 'Chats', platform: 'linux' });
  assert.match(store.load().error, /No desktop keyring/);
  assert.equal(store.save({ sessions: [] }).ok, false);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('failed writes and renames keep the previous file and remove the temporary copy', t => {
  const dir = tempDir(t), safeStorage = fakeSafeStorage(), file = path.join(dir, 'chats.enc');
  const store = createSecureStore({ file: () => file, safeStorage, label: 'Chats', platform: 'linux' });
  assert.deepEqual(store.save({ sessions: ['first'] }), { ok: true });
  for (const failing of ['writeFileSync', 'renameSync']) {
    const fsImpl = { ...fs, [failing]: () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } };
    const broken = createSecureStore({ file: () => file, safeStorage, label: 'Chats', platform: 'linux', fsImpl });
    const result = broken.save({ sessions: ['second'] });
    assert.equal(result.ok, false); assert.match(result.error, /previous saved copy was kept.*disk full/);
    assert.deepEqual(JSON.parse(safeStorage.decryptString(fs.readFileSync(file))), { sessions: ['first'] });
    assert.deepEqual(fs.readdirSync(dir), ['chats.enc']);
  }
});

test('unreadable non-ENOENT read errors are treated as preserved data', t => {
  const dir = tempDir(t), file = path.join(dir, 'chats.enc');
  fs.mkdirSync(file); // EISDIR: exists but cannot be read
  const store = createSecureStore({ file: () => file, safeStorage: fakeSafeStorage(), label: 'Chats', platform: 'linux' });
  assert.equal(store.load().persistent, false);
  assert.equal(store.save({ sessions: [] }).ok, false);
  assert.ok(fs.statSync(file).isDirectory());
});
