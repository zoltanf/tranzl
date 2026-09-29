const appRoot = process.env.TRANZL_APP_ROOT || require('node:path').resolve(__dirname, '..');
const appRequire = require('node:module').createRequire(require('node:path').join(appRoot, 'package.json'));
// Exercises the real native readers inside Electron worker threads.
const { app, clipboard, ClipboardItem, BrowserWindow } = require('electron');
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
// Best effort: Windows keeps this process's own profile files locked until it exits.
function cleanup() {
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); }
  catch (error) { console.warn(`Could not remove ${root} (${error.code}); it is a temporary test folder.`); }
}
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
    // Product routing: AAC through Chromium's decoder in a sandboxed hidden window,
    // Apple Lossless through Core Audio on macOS and explained elsewhere.
    const { parseFile } = appRequire('./src/chatStore'), { decodeToWav } = appRequire('./src/audioDecoder');
    const windows = BrowserWindow.getAllWindows().length, limit = 20 * 1024 * 1024;
    const monoPeak = wav => {
      assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
      const fmt = wav.indexOf('fmt ');
      assert.equal(wav.readUInt16LE(fmt + 10), 1); assert.equal(wav.readUInt32LE(fmt + 12), 16000); assert.equal(wav.readUInt16LE(fmt + 22), 16);
      let peak = 0; for (let i = wav.indexOf('data') + 8; i + 1 < wav.length; i += 2) peak = Math.max(peak, Math.abs(wav.readInt16LE(i)));
      return peak;
    };
    for (const codec of ['aac', 'alac']) {
      const source = path.join(__dirname, 'fixtures', `synthetic-${codec}.m4a`);
      if (codec === 'alac' && process.platform !== 'darwin') { await assert.rejects(parseFile(source), /Apple Lossless/); continue; }
      const audio = await parseFile(source);
      assert.equal(audio.format, 'wav'); assert.equal(audio.mime, 'audio/wav');
      assert.ok(monoPeak(Buffer.from(audio.data, 'base64')) > 1000, `${codec}: right channel must survive`);
    }
    const aac = fs.readFileSync(path.join(__dirname, 'fixtures', 'synthetic-aac.m4a'));
    assert.ok(monoPeak(await decodeToWav(aac, { maxBytes: limit })) > 1000, 'Chromium decodes AAC without Core Audio');
    assert.equal(await decodeToWav(Buffer.from('not audio'), { maxBytes: limit }), null);
    await assert.rejects(decodeToWav(aac, { maxBytes: 1000 }), /converted audio exceeds 20 MB/);
    await assert.rejects(decodeToWav(aac, { maxBytes: limit, timeoutMs: 1 }), /timed out/);
    assert.equal(BrowserWindow.getAllWindows().length, windows, 'decoder windows are destroyed');
    // Chromium printToPDF generates a real PDF for the worker's PDF.js path.
    const window = new BrowserWindow({ show: false });
    await window.loadURL('data:text/html,<h1>Reader verification 1234</h1>');
    fs.writeFileSync(path.join(root, 'test.pdf'), await window.webContents.printToPDF({})); window.destroy();
    assert.match((await read(path.join(root, 'test.pdf'))).content, /verification 1234/);
    console.log('PASS: Electron worker image, PDF, DOC, DOCX, XLS, XLSX and M4A readers.');
    cleanup(); app.exit(0);
  } catch (err) { console.error(err); cleanup(); app.exit(1); }
});
