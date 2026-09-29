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
  const revealed = [];
  const electron = { ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, safeStorage, dialog: {}, shell: { showItemInFolder: file => revealed.push(file) },
    app: { setPath() {}, getPath: () => dir, whenReady: () => ({ then() {} }), on() {} } };
  const mainPath = path.resolve(__dirname, '../src/main.js'), realRequire = createRequire(mainPath);
  const context = vm.createContext({ require: name => name === 'electron' ? electron : realRequire(name), AbortController, AbortSignal, TextDecoder, Buffer, console, __dirname: path.dirname(mainPath) });
  vm.runInContext(fs.readFileSync(mainPath, 'utf8'), context);
  // Results cross a vm realm (like IPC); compare plain copies.
  const call = async (name, ...args) => JSON.parse(JSON.stringify(await handlers.get(name)({}, ...args)));
  return { call, revealed };
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

const backups = dir => fs.readdirSync(dir).filter(name => name.includes('.unreadable-')).sort();
for (const name of ['chats.enc', 'history.enc']) {
  const prefix = name === 'chats.enc' ? 'chat' : 'history';
  const data = name === 'chats.enc' ? { sessions: [{ id: 'temporary' }] } : { sourceHistory: [{ text: 'temporary', ts: 2 }] };
  test(`${name}: Try again loads data once the keyring unlocks`, async t => {
    const dir = tempDir(t), safeStorage = fakeSafeStorage(), file = path.join(dir, name);
    fs.writeFileSync(file, safeStorage.encryptString(JSON.stringify(prefix === 'chat' ? { sessions: [{ id: 'saved' }] } : { customPrompt: 'saved' })));
    safeStorage.locked = true;
    const app = stores(dir, safeStorage);
    const locked = await app.call(`${prefix}-load`);
    assert.equal(locked.canRetry, true); assert.equal(locked.canReset, true);
    assert.equal((await app.call(`${prefix}-retry`)).persistent, false);
    safeStorage.locked = false;
    const unlocked = await app.call(`${prefix}-retry`);
    assert.equal(unlocked.persistent, true);
    assert.deepEqual(prefix === 'chat' ? unlocked.sessions : unlocked.store, prefix === 'chat' ? [{ id: 'saved' }] : { customPrompt: 'saved' });
    assert.deepEqual(await app.call(`${prefix}-save`, data), { ok: true });
  });
  test(`${name}: Start fresh keeps the unreadable file byte-for-byte and saves in its place`, async t => {
    const dir = tempDir(t), safeStorage = fakeSafeStorage(), file = path.join(dir, name);
    fs.writeFileSync(file, 'unreadable ciphertext');
    const app = stores(dir, safeStorage);
    await app.call(`${prefix}-load`);
    assert.deepEqual(await app.call(`${prefix}-reveal-backup`), { ok: false });
    const result = await app.call(`${prefix}-reset`, data);
    assert.equal(result.ok, true);
    assert.match(result.backup, new RegExp(`^${prefix === 'chat' ? 'chats' : 'history'}\\.unreadable-\\d{8}-\\d{6}\\.enc$`));
    assert.equal(fs.readFileSync(path.join(dir, result.backup), 'utf8'), 'unreadable ciphertext');
    assert.deepEqual(JSON.parse(safeStorage.decryptString(fs.readFileSync(file))), data);
    assert.deepEqual(await app.call(`${prefix}-reveal-backup`), { ok: true });
    assert.deepEqual(app.revealed, [path.join(dir, result.backup)]);
    // After restart, the new file is read normally and the old one is still there.
    assert.equal((await stores(dir, safeStorage).call(`${prefix}-load`)).persistent, true);
    assert.deepEqual(backups(dir), [result.backup]);
  });
  test(`${name}: Start fresh is refused while the file is readable or encryption is unavailable`, async t => {
    const dir = tempDir(t), safeStorage = fakeSafeStorage(), file = path.join(dir, name);
    fs.writeFileSync(file, safeStorage.encryptString(JSON.stringify(data)));
    const original = fs.readFileSync(file);
    const readable = await stores(dir, safeStorage).call(`${prefix}-reset`, data);
    assert.equal(readable.ok, false); assert.match(readable.error, /can be read again/);
    safeStorage.available = false;
    assert.equal((await stores(dir, safeStorage).call(`${prefix}-reset`, data)).ok, false);
    assert.deepEqual(fs.readFileSync(file), original); assert.deepEqual(backups(dir), []);
    assert.deepEqual(await stores(dir, safeStorage).call(`${prefix}-reset`, null), { ok: false, error: `Invalid ${prefix} data` });
  });
}

test('damaged contents offer only Start fresh; unavailable encryption offers only Try again', t => {
  const dir = tempDir(t), safeStorage = fakeSafeStorage(), file = path.join(dir, 'chats.enc');
  fs.writeFileSync(file, safeStorage.encryptString('{not json'));
  const damaged = createSecureStore({ file: () => file, safeStorage, label: 'Chats', platform: 'linux' }).load();
  assert.deepEqual([damaged.persistent, damaged.canRetry, damaged.canReset], [false, false, true]);
  assert.match(damaged.error, /The saved chats file is damaged/);
  const unavailable = createSecureStore({ file: () => file, safeStorage: fakeSafeStorage({ available: false }), label: 'Chats', platform: 'linux' }).load();
  assert.deepEqual([unavailable.canRetry, unavailable.canReset], [true, false]);
});

test('repeated Start fresh never overwrites an earlier backup', t => {
  const dir = tempDir(t), safeStorage = fakeSafeStorage(), file = path.join(dir, 'chats.enc');
  const now = () => new Date(2026, 8, 29, 18, 42, 10); // local time
  const names = [];
  for (const bytes of ['first', 'second', 'third']) {
    fs.writeFileSync(file, bytes);
    const store = createSecureStore({ file: () => file, safeStorage, label: 'Chats', platform: 'linux', now });
    store.load(); names.push(store.reset({ sessions: [] }).backup);
  }
  assert.deepEqual(names, ['chats.unreadable-20260929-184210.enc', 'chats.unreadable-20260929-184210-2.enc', 'chats.unreadable-20260929-184210-3.enc']);
  assert.deepEqual(names.map(name => fs.readFileSync(path.join(dir, name), 'utf8')), ['first', 'second', 'third']);
});

test('a failed rename during Start fresh changes nothing and keeps saving blocked', t => {
  const dir = tempDir(t), safeStorage = fakeSafeStorage(), file = path.join(dir, 'chats.enc');
  fs.writeFileSync(file, 'unreadable');
  const fsImpl = { ...fs, renameSync: () => { throw Object.assign(new Error('permission denied'), { code: 'EPERM' }); } };
  const store = createSecureStore({ file: () => file, safeStorage, label: 'Chats', platform: 'linux', fsImpl });
  store.load();
  const result = store.reset({ sessions: [] });
  assert.equal(result.ok, false); assert.match(result.error, /nothing was changed.*permission denied/);
  assert.equal(result.backup, undefined); assert.equal(store.backupPath(), null);
  assert.equal(store.save({ sessions: [] }).ok, false);
  assert.equal(fs.readFileSync(file, 'utf8'), 'unreadable'); assert.deepEqual(fs.readdirSync(dir), ['chats.enc']);
});
