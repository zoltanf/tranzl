const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const { EXTENSIONS } = require('./attachments');
function parseFile(filename) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'attachmentWorker.js'), { workerData: filename, resourceLimits: { maxOldGenerationSizeMb: 384 } });
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('file processing timed out')); }, 30000);
    worker.once('message', result => { clearTimeout(timer); worker.terminate(); result.error ? reject(new Error(result.error)) : resolve(result.file); });
    worker.once('error', error => { clearTimeout(timer); reject(error); });
    worker.once('exit', code => { clearTimeout(timer); if (code) reject(new Error('file reader stopped')); });
  });
}

module.exports = function registerChatStore({ ipcMain, app, safeStorage, dialog }) {
  const file = () => path.join(app.getPath('userData'), 'chats.enc');
  ipcMain.handle('chat-load', () => {
    if (!safeStorage.isEncryptionAvailable()) return { sessions: [], persistent: false };
    try {
      const data = JSON.parse(safeStorage.decryptString(fs.readFileSync(file())));
      return { ...data, persistent: true };
    } catch (err) {
      return { sessions: [], persistent: true, error: err.code === 'ENOENT' ? null : 'Saved chats could not be read. Your existing file has been preserved.' };
    }
  });
  ipcMain.handle('chat-save', (_event, data) => {
    try {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Local encryption is unavailable. Chats will only last until you close the app.');
      if (!data || !Array.isArray(data.sessions)) throw new Error('Invalid chat data');
      const temp = file() + '.tmp';
      fs.writeFileSync(temp, safeStorage.encryptString(JSON.stringify(data)), { mode: 0o600 });
      fs.renameSync(temp, file());
      return { ok: true };
    } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('chat-attach', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Attach images, documents, spreadsheets or audio', properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Supported files', extensions: EXTENSIONS }],
    });
    if (canceled) return { files: [], errors: [] };
    const files = [], errors = [];
    for (const filename of filePaths) {
      try {
        if (files.length >= 8) throw new Error('attach up to 8 files at a time');
        files.push(await parseFile(filename));
      } catch (err) { errors.push(`${path.basename(filename)}: ${err.message}`); }
    }
    return { files, errors };
  });
};
