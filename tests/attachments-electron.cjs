const appRoot = process.env.TRANZL_APP_ROOT || require('node:path').resolve(__dirname, '..');
const appRequire = require('node:module').createRequire(require('node:path').join(appRoot, 'package.json'));
// Exercises the real native readers inside Electron worker threads.
const { app, clipboard, ClipboardItem } = require('electron');
const { readClipboardImage } = appRequire('./src/clipboardImage');
const { Worker } = require('worker_threads');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const XLSX = appRequire('xlsx');
const { createCanvas } = appRequire('@napi-rs/canvas');
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
    assert.equal(typeof clipboard.read, 'function');
    const imageItem = new ClipboardItem({ 'image/png': new Blob([canvas.toBuffer('image/png')], { type: 'image/png' }) });
    const pasted = await readClipboardImage({ read: async () => [imageItem] });
    assert.equal(pasted.file.kind, 'image'); assert.equal(pasted.file.width, 30); assert.equal(pasted.file.height, 20);
    const applePNG = 'electron application/osclipboard;format="Apple PNG pasteboard type"';
    const nativeItem = new ClipboardItem({ [applePNG]: new Blob([canvas.toBuffer('image/png')]) });
    const nativePasted = await readClipboardImage({ read: async () => [nativeItem] });
    assert.equal(nativePasted.file.width, 30); assert.equal(nativePasted.file.height, 20);
    assert.equal((await readClipboardImage({ read: async () => [] })).file, null);
    assert.equal((await readClipboardImage({ read: async () => [new ClipboardItem({ 'text/plain': 'text only' })] })).file, null);
    await assert.rejects(readClipboardImage({ read: async () => { throw new Error('Clipboard unavailable'); } }), /Clipboard unavailable/);
    const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Answer'], [42]]), 'Test');
    for (const type of ['xlsx', 'xls']) {
      const filename = path.join(root, `data.${type}`); XLSX.writeFile(book, filename);
      assert.match((await read(filename)).content, /42/);
    }
    for (const type of ['doc', 'docx']) assert.match((await read(path.join(__dirname, 'fixtures', `synthetic.${type}`))).content, /The meeting is on Friday/);
    for (const codec of ['aac', 'alac']) {
      const source = require('./audio-fixture.cjs').createM4a(root, codec);
      const audio = await read(source);
      assert.equal(audio.name, `${codec}.m4a`);
      assert.equal(audio.format, 'wav'); assert.equal(audio.mime, 'audio/wav');
      assert.equal(Buffer.from(audio.data, 'base64').toString('ascii', 0, 4), 'RIFF');
    }
    // Chromium printToPDF generates a real PDF for the worker's PDF.js path.
    const { BrowserWindow } = require('electron');
    const window = new BrowserWindow({ show: false });
    await window.loadURL('data:text/html,<h1>Reader verification 1234</h1>');
    fs.writeFileSync(path.join(root, 'test.pdf'), await window.webContents.printToPDF({})); window.destroy();
    assert.match((await read(path.join(root, 'test.pdf'))).content, /verification 1234/);
    console.log('PASS: Electron worker image, PDF, DOC, DOCX, XLS, XLSX and M4A readers.');
    fs.rmSync(root, { recursive: true, force: true }); app.exit(0);
  } catch (err) { console.error(err); fs.rmSync(root, { recursive: true, force: true }); app.exit(1); }
});
