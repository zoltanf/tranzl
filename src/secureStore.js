// Shared encrypted persistence for history and Chat. Data is only written when
// the OS provides real protection; otherwise it stays in memory for the session.
const fs = require('fs');
const path = require('path');

function storageStatus(safeStorage, platform = process.platform) {
  if (!safeStorage.isEncryptionAvailable()) return { persistent: false, reason: 'Local encryption is unavailable' };
  // Electron falls back to a hardcoded key on Linux without a secret service.
  if (platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') {
    return { persistent: false, reason: 'No desktop keyring is available to protect saved data' };
  }
  return { persistent: true };
}

// isValid checks the decrypted shape; anything else is treated as damaged, never as empty data.
function createSecureStore({ file, safeStorage, label, isValid = () => true, platform = process.platform, fsImpl = fs, now = () => new Date() }) {
  // Set when an existing file could not be read. Saving would destroy it, so writes are refused
  // until a later load succeeds or the user explicitly sets the file aside with reset().
  let unreadable = null, loaded = false, backup = null;
  const name = label.toLowerCase();
  const temporary = reason => ({ data: null, persistent: false, error: `${reason}. ${label} will only last until you close the app.`, canRetry: true, canReset: false });
  function load() {
    loaded = true; unreadable = null;
    const status = storageStatus(safeStorage, platform);
    if (!status.persistent) return temporary(status.reason);
    let text;
    try { text = safeStorage.decryptString(fsImpl.readFileSync(file())); }
    catch (error) {
      if (error.code === 'ENOENT') return { data: null, persistent: true };
      // A locked or changed keyring looks the same as a damaged file here, so offer both.
      unreadable = `Saved ${name} could not be read, so changes are kept only until you close the app. The file was not changed. Unlock your keyring and choose Try again, or choose Start fresh to set the file aside.`;
      return { data: null, persistent: false, error: unreadable, canRetry: true, canReset: true };
    }
    try { const data = JSON.parse(text); if (isValid(data)) return { data, persistent: true }; } catch {}
    {
      unreadable = `The saved ${name} file is damaged, so changes are kept only until you close the app. The file was not changed. Choose Start fresh to set it aside.`;
      return { data: null, persistent: false, error: unreadable, canRetry: false, canReset: true };
    }
  }
  function save(data) {
    if (!loaded) load();
    const status = storageStatus(safeStorage, platform);
    if (!status.persistent) return { ok: false, error: `${status.reason}. ${label} will only last until you close the app.` };
    if (unreadable) return { ok: false, error: unreadable };
    try { fsImpl.renameSync(stage(data), file()); return { ok: true }; }
    catch (error) {
      try { fsImpl.unlinkSync(file() + '.tmp'); } catch {}
      return { ok: false, error: `Could not save ${name}; the previous saved copy was kept. ${error.message}` };
    }
  }
  // Writes encrypted data to <file>.tmp (fsync'd) and returns its path for the caller to move into place.
  function stage(data) {
    const temp = file() + '.tmp';
    try {
      const fd = fsImpl.openSync(temp, 'w', 0o600);
      try { fsImpl.writeFileSync(fd, safeStorage.encryptString(JSON.stringify(data))); fsImpl.fsyncSync(fd); }
      finally { fsImpl.closeSync(fd); }
      return temp;
    } catch (error) { try { fsImpl.unlinkSync(temp); } catch {} throw error; }
  }
  // Explicit user action: sets an unreadable file aside (never deleting it) and saves data in its
  // place. The replacement is written first, so any failure leaves the original where it was.
  function reset(data) {
    const current = load();
    if (current.persistent) return { ok: false, error: `Saved ${name} can be read again. Choose Try again.` };
    if (!unreadable) return { ok: false, error: current.error };
    const target = file(), ext = path.extname(target), stem = ext ? target.slice(0, -ext.length) : target;
    // Local time, so the name matches when the user chose Start fresh.
    const d = now(), pad = n => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    let aside = `${stem}.unreadable-${stamp}${ext}`;
    for (let n = 2; fsImpl.existsSync(aside); n++) aside = `${stem}.unreadable-${stamp}-${n}${ext}`;
    let staged;
    try { staged = stage(data); }
    catch (error) { return { ok: false, error: `Could not start fresh, so nothing was changed. ${error.message}` }; }
    try { fsImpl.renameSync(target, aside); }
    catch (error) {
      try { fsImpl.unlinkSync(staged); } catch {}
      return { ok: false, error: `Could not set the unreadable file aside, so nothing was changed. ${error.message}` };
    }
    try { fsImpl.renameSync(staged, target); }
    catch (error) {
      try { fsImpl.unlinkSync(staged); } catch {}
      try { fsImpl.renameSync(aside, target); }
      catch { backup = aside; return { ok: false, backup: path.basename(aside), error: `Could not start fresh. The unreadable file is kept as ${path.basename(aside)}. ${error.message}` }; }
      return { ok: false, error: `Could not start fresh, so nothing was changed. ${error.message}` };
    }
    unreadable = null; backup = aside;
    return { ok: true, backup: path.basename(aside) };
  }
  return { load, save, reset, backupPath: () => backup };
}

// One IPC surface per store: <prefix>-load/-retry/-save/-reset/-reveal-backup.
function registerStore({ ipcMain, shell }, prefix, store, { normalize, valid }) {
  const load = () => { const { data, ...state } = store.load(); return { ...normalize(data), ...state }; };
  const invalid = { ok: false, error: `Invalid ${prefix} data` };
  ipcMain.handle(`${prefix}-load`, load);
  ipcMain.handle(`${prefix}-retry`, load);
  ipcMain.handle(`${prefix}-save`, (_event, data) => valid(data) ? store.save(data) : invalid);
  ipcMain.handle(`${prefix}-reset`, (_event, data) => valid(data) ? store.reset(data) : invalid);
  ipcMain.handle(`${prefix}-reveal-backup`, () => {
    const file = store.backupPath();
    if (file) shell.showItemInFolder(file);
    return { ok: Boolean(file) };
  });
}
module.exports = { storageStatus, createSecureStore, registerStore };
