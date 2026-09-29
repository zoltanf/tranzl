// Shared encrypted persistence for history and Chat. Data is only written when
// the OS provides real protection; otherwise it stays in memory for the session.
const fs = require('fs');

function storageStatus(safeStorage, platform = process.platform) {
  if (!safeStorage.isEncryptionAvailable()) return { persistent: false, reason: 'Local encryption is unavailable' };
  // Electron falls back to a hardcoded key on Linux without a secret service.
  if (platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') {
    return { persistent: false, reason: 'No desktop keyring is available to protect saved data' };
  }
  return { persistent: true };
}

function createSecureStore({ file, safeStorage, label, platform = process.platform, fsImpl = fs }) {
  // Set when an existing file could not be read; saving would destroy it, so writes are refused.
  let unreadable = null, loaded = false;
  function load() {
    loaded = true;
    const status = storageStatus(safeStorage, platform);
    if (!status.persistent) { unreadable = null; return { data: null, persistent: false, error: `${status.reason}. ${label} will only last until you close the app.` }; }
    try {
      const data = JSON.parse(safeStorage.decryptString(fsImpl.readFileSync(file())));
      unreadable = null;
      return { data, persistent: true };
    } catch (error) {
      if (error.code === 'ENOENT') { unreadable = null; return { data: null, persistent: true }; }
      unreadable = `Saved ${label.toLowerCase()} could not be read, so changes are kept only until you close the app. The existing file was not changed; restart Tranzl after unlocking your keyring to try again.`;
      return { data: null, persistent: false, error: unreadable };
    }
  }
  function save(data) {
    if (!loaded) load();
    const status = storageStatus(safeStorage, platform);
    if (!status.persistent) return { ok: false, error: `${status.reason}. ${label} will only last until you close the app.` };
    if (unreadable) return { ok: false, error: unreadable };
    const temp = file() + '.tmp';
    try {
      const fd = fsImpl.openSync(temp, 'w', 0o600);
      try { fsImpl.writeFileSync(fd, safeStorage.encryptString(JSON.stringify(data))); fsImpl.fsyncSync(fd); }
      finally { fsImpl.closeSync(fd); }
      fsImpl.renameSync(temp, file());
      return { ok: true };
    } catch (error) {
      try { fsImpl.unlinkSync(temp); } catch {}
      return { ok: false, error: `Could not save ${label.toLowerCase()}; the previous saved copy was kept. ${error.message}` };
    }
  }
  return { load, save };
}
module.exports = { storageStatus, createSecureStore };
