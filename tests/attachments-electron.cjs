const appRoot = process.env.TRANZL_APP_ROOT || require('node:path').resolve(__dirname, '..');
const appRequire = require('node:module').createRequire(require('node:path').join(appRoot, 'package.json'));
// Exercises the real native readers inside Electron worker threads.
const { app, nativeImage } = require('electron');
const { readClipboardImage } = appRequire('./src/clipboardImage');
const { Worker } = require('worker_threads');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const XLSX = appRequire('xlsx');
const { createCanvas } = appRequire('@napi-rs/canvas');
const { execFileSync } = require('child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tranzl-electron-readers-'));
app.setPath('userData', path.join(root, 'app'));
async function read(filename) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.resolve(appRoot, 'src/attachmentWorker.js'), { workerData: filename });
    worker.once('error', reject);
    worker.once('message', result => { worker.terminate(); result.error ? reject(new Error(result.error)) : resolve(result.file); });
  });
}
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  try {
    const canvas = createCanvas(30, 20); fs.writeFileSync(path.join(root, 'image.png'), canvas.toBuffer('image/png'));
    assert.equal((await read(path.join(root, 'image.png'))).kind, 'image');
    const pasted = readClipboardImage({ readImage: () => nativeImage.createFromBuffer(canvas.toBuffer('image/png')) });
    assert.equal(pasted.file.kind, 'image'); assert.equal(pasted.file.width, 30); assert.equal(pasted.file.height, 20);
    assert.equal(readClipboardImage({ readImage: () => nativeImage.createEmpty() }).file, null);
    const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Answer'], [42]]), 'Test');
    for (const type of ['xlsx', 'xls']) {
      const filename = path.join(root, `data.${type}`); XLSX.writeFile(book, filename);
      assert.match((await read(filename)).content, /42/);
    }
    const text = path.join(root, 'source.txt'); fs.writeFileSync(text, 'A useful test document.');
    for (const type of ['doc', 'docx']) {
      const filename = path.join(root, `data.${type}`); execFileSync('/usr/bin/textutil', ['-convert', type, '-output', filename, text]);
      assert.match((await read(filename)).content, /useful test document/);
    }
    // Chromium printToPDF generates a real PDF for the worker's PDF.js path.
    const { BrowserWindow } = require('electron');
    const window = new BrowserWindow({ show: false });
    await window.loadURL('data:text/html,<h1>Reader verification 1234</h1>');
    fs.writeFileSync(path.join(root, 'test.pdf'), await window.webContents.printToPDF({})); window.destroy();
    assert.match((await read(path.join(root, 'test.pdf'))).content, /verification 1234/);
    console.log('PASS: Electron worker image, PDF, DOC, DOCX, XLS and XLSX readers.');
    fs.rmSync(root, { recursive: true, force: true }); app.exit(0);
  } catch (err) { console.error(err); fs.rmSync(root, { recursive: true, force: true }); app.exit(1); }
});
