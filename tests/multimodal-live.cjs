// Opt-in real Gemma test. Downloads pinned runtime/projector once, reuses the
// installed model, and sends only synthetic image/audio fixtures locally.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createCanvas } = require('@napi-rs/canvas');
const runtime = require('../src/backends/multimodal');
const { readAttachment } = require('../src/attachments');
const root = path.join(os.homedir(), 'Library/Application Support/tranzl');
const settings = JSON.parse(fs.readFileSync(path.join(root, 'settings.json')));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tranzl-live-'));
const abort = new AbortController();
process.on('SIGINT', () => { abort.abort(); runtime.stop(); });
async function ask(messages, reasoning = false) {
  const result = await runtime.chat({ dir: path.join(root, 'multimodal'), modelPath: settings.localModelPath,
    releaseTextModel: async () => {}, systemPrompt: 'Answer the user accurately and briefly.', messages, reasoning,
    signal: abort.signal, onStatus: console.log, onChunk: chunk => process.stdout.write(chunk), onThought: () => {},
  });
  console.log('\nStats:', result.stats); return result;
}
(async () => {
  const canvas = createCanvas(500, 300), ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 500, 300); ctx.fillStyle = '#ed1c24'; ctx.fillRect(100, 50, 300, 200);
  const image = canvas.toBuffer('image/png').toString('base64');
  const result = await ask([{ role: 'user', content: 'What color is the large rectangle in this image? Answer with the color only.', media: [{ kind: 'image', mime: 'image/png', data: image }] }]);
  assert.match(result.translation, /red/i);
  execFileSync('/usr/bin/say', ['-o', path.join(temp, 'voice.aiff'), 'The blue bicycle is beside the garden gate.']);
  execFileSync('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', path.join(temp, 'voice.aiff'), path.join(temp, 'voice.wav')]);
  const audio = await readAttachment(path.join(temp, 'voice.wav'));
  const heard = await ask([{ role: 'user', content: 'Transcribe the words spoken in this audio. Output only the transcript.', media: [audio] }], true);
  assert.match(heard.translation, /blue bicycle/i); assert.match(heard.translation, /garden gate/i);
  execFileSync('/usr/bin/afconvert', ['-f', 'm4af', '-d', 'aac', path.join(temp, 'voice.aiff'), path.join(temp, 'voice.m4a')]);
  const m4a = await readAttachment(path.join(temp, 'voice.m4a'));
  const converted = await ask([{ role: 'user', content: 'Transcribe the words spoken in this audio. Output only the transcript.', media: [m4a] }], true);
  assert.match(converted.translation, /blue bicycle/i); assert.match(converted.translation, /garden gate/i);
  console.log('PASS: real embedded Gemma image recognition, WAV and M4A transcription.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { runtime.stop(); fs.rmSync(temp, { recursive: true, force: true }); });
