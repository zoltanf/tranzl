// Decodes compressed audio with Chromium's built-in decoder in a disposable, sandboxed
// window with an in-memory session, producing 16 kHz mono 16-bit WAV. Main process only.
const { BrowserWindow } = require('electron');
const RATE = 16000;

// Runs in the hidden page. Returns PCM bytes, or a reason instead of throwing so
// the main process sees a stable result rather than a generic script error.
async function decodeInPage(base64, maxFrames, rate) {
  let decoded;
  try {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    decoded = await new OfflineAudioContext(1, 1, rate).decodeAudioData(bytes.buffer);
  } catch { return { reason: 'unsupported' }; }
  const frames = Math.ceil(decoded.duration * rate);
  if (frames > maxFrames) return { reason: 'too-large' };
  // A mono destination downmixes every channel, so no channel is dropped.
  const context = new OfflineAudioContext(1, Math.max(1, frames), rate);
  const source = context.createBufferSource(); source.buffer = decoded; source.connect(context.destination); source.start();
  const pcm = (await context.startRendering()).getChannelData(0), out = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(pcm[i] * 32767)));
  return { pcm: new Uint8Array(out.buffer) };
}

// Resolves to WAV bytes, or null when Chromium cannot decode the data.
async function decodeToWav(bytes, { maxBytes, timeoutMs = 20000 }) {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false, partition: 'tranzl-audio-decoder' } });
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  let timer;
  try {
    await win.loadURL('about:blank');
    const maxFrames = Math.floor((maxBytes - 44) / 2);
    const decoding = win.webContents.executeJavaScript(`(${decodeInPage})(${JSON.stringify(Buffer.from(bytes).toString('base64'))}, ${maxFrames}, ${RATE})`);
    decoding.catch(() => {}); // may reject after a timeout destroys the window
    const result = await Promise.race([decoding,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('M4A conversion timed out; attach a shorter clip')), timeoutMs); }),
      new Promise((_, reject) => win.webContents.once('render-process-gone', () => reject(new Error('the audio decoder stopped; the file may be damaged')))),
    ]);
    if (result.reason === 'too-large') throw new Error('converted audio exceeds 20 MB; attach a shorter clip');
    if (result.reason) return null;
    const pcm = Buffer.from(result.pcm.buffer, result.pcm.byteOffset, result.pcm.byteLength), header = Buffer.alloc(44);
    header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
    header.writeUInt32LE(RATE, 24); header.writeUInt32LE(RATE * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
    header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([header, pcm]);
  } finally {
    clearTimeout(timer);
    win.destroy();
  }
}
module.exports = { decodeToWav };
