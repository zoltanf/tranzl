const path = require('path');
const { Worker } = require('worker_threads');
const { attachmentCapabilities, readAttachment } = require('./attachments');
const { createSecureStore, registerStore } = require('./secureStore');
function parseFile(filename) {
  // M4A needs Chromium's decoder, which only exists outside worker threads.
  if (path.extname(filename).toLowerCase() === '.m4a') return readAttachment(filename, { decodeAudio: require('./audioDecoder').decodeToWav });
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'attachmentWorker.js'), { workerData: filename, resourceLimits: { maxOldGenerationSizeMb: 384 } });
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('file processing timed out')); }, 30000);
    worker.once('message', result => { clearTimeout(timer); worker.terminate(); result.error ? reject(new Error(result.error)) : resolve(result.file); });
    worker.once('error', error => { clearTimeout(timer); reject(error); });
    worker.once('exit', code => { clearTimeout(timer); if (code) reject(new Error('file reader stopped')); });
  });
}

function registerChatStore({ ipcMain, app, safeStorage, dialog, shell }) {
  const store = createSecureStore({ file: () => path.join(app.getPath('userData'), 'chats.enc'), safeStorage, label: 'Chats',
    isValid: data => Boolean(data) && typeof data === 'object' && Array.isArray(data.sessions) });
  registerStore({ ipcMain, shell }, 'chat', store, {
    normalize: data => ({ sessions: [], ...(data && typeof data === 'object' ? data : {}) }),
    valid: data => Boolean(data) && Array.isArray(data.sessions),
  });
  ipcMain.handle('attachment-capabilities', () => attachmentCapabilities());
  ipcMain.handle('chat-attach', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Attach images, documents, spreadsheets or audio', properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Supported files', extensions: attachmentCapabilities().extensions }],
    });
    if (canceled) return { files: [], errors: [] };
    const files = [], errors = [];
    for (const filename of filePaths) {
      try {
        if (files.length >= attachmentCapabilities().maxFiles) throw new Error('attach up to 8 files at a time');
        files.push(await parseFile(filename));
      } catch (err) { errors.push(`${path.basename(filename)}: ${err.message}`); }
    }
    return { files, errors };
  });
}
module.exports = Object.assign(registerChatStore, { parseFile });
