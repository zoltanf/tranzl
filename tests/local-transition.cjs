// Opt-in test of releasing the text worker, image inference and cancellation.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert/strict');
const local = require('../src/backends/local');
const runtime = require('../src/backends/multimodal');
const { createCanvas } = require('@napi-rs/canvas');
const root = path.join(os.homedir(), 'Library/Application Support/tranzl');
const { localModelPath: modelPath } = JSON.parse(fs.readFileSync(path.join(root, 'settings.json')));
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('text model load timed out')), 120000);
      local.preload(modelPath, status => { if (status.state === 'ready') { clearTimeout(timeout); resolve(); } else if (status.state === 'error') { clearTimeout(timeout); reject(new Error(status.error)); } });
    });
    const measured = [];
    await local.translate({ modelPath, systemPrompt: 'Answer briefly.', text: 'Write a short sentence about reading a PDF.', signal: new AbortController().signal, onStats: stats => measured.push(stats) });
    assert.ok(measured.length > 0);
    assert.ok(measured.every(s => s.contextEstimated === false && s.contextTokens > 0 && s.contextTokens <= s.contextSize));
    const canvas = createCanvas(200, 150), ctx = canvas.getContext('2d'); ctx.fillStyle = '#0000ff'; ctx.fillRect(0, 0, 200, 150);
    const common = { dir: path.join(root, 'multimodal'), modelPath, releaseTextModel: local.release, systemPrompt: 'Answer briefly.', reasoning: false, onStatus: console.log, onThought: () => {}, onChunk: () => {} };
    const result = await runtime.chat({ ...common, signal: new AbortController().signal, messages: [{ role: 'user', content: 'Name the color in this image.', media: [{ kind: 'image', mime: 'image/png', data: canvas.toBuffer('image/png').toString('base64') }] }] });
    assert.match(result.translation, /blue/i); assert.equal(local.modelState().state, 'idle');
    const abort = new AbortController();
    await assert.rejects(runtime.chat({ ...common, signal: abort.signal, messages: [{ role: 'user', content: 'Write a very long story about a rabbit.' }], onChunk: () => abort.abort() }));
    const next = await runtime.chat({ ...common, signal: new AbortController().signal, messages: [{ role: 'user', content: 'What is two plus two? Answer with the number only.' }] });
    assert.match(next.translation, /4/);
    console.log('PASS: embedded text-worker handoff, image inference, stop and recovery.'); runtime.stop(); app.exit(0);
  } catch (err) { console.error(err); runtime.stop(); await local.release().catch(() => {}); app.exit(1); }
});
