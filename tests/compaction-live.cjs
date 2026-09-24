// Opt-in: real local tokenizer, multimodal count and chunked PDF-size input.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const local = require('../src/backends/local');
const runtime = require('../src/backends/multimodal');
const { prepareContext } = require('../src/chatCompaction');
const { createCanvas } = require('@napi-rs/canvas');
const root = path.join(os.homedir(), 'Library/Application Support/tranzl');
const { localModelPath: modelPath } = JSON.parse(fs.readFileSync(path.join(root, 'settings.json')));
const signal = new AbortController().signal;
const systemPrompt = 'Answer the user accurately and briefly.';
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  try {
    const textCount = await local.countTokens({ modelPath, systemPrompt, messages: [{ role: 'user', content: 'Hello' }], reasoning: false, signal });
    assert.ok(textCount > 0 && textCount < 100);
    const common = { dir: path.join(root, 'multimodal'), modelPath, signal, releaseTextModel: local.release,
      systemPrompt, reasoning: false, onStatus: console.log, onChunk() {}, onThought() {} };
    const canvas = createCanvas(200, 150), ctx = canvas.getContext('2d'); ctx.fillStyle = 'blue'; ctx.fillRect(0, 0, 200, 150);
    const image = { kind: 'image', mime: 'image/png', data: canvas.toBuffer('image/png').toString('base64') };
    const mediaMessages = [{ role: 'user', content: 'Name this color.', media: [image] }];
    const mediaCount = await runtime.countTokens({ ...common, messages: mediaMessages });
    const mediaAnswer = await runtime.chat({ ...common, messages: mediaMessages, maxTokens: 64 });
    assert.equal(mediaCount, mediaAnswer.stats.inputTokens);
    assert.match(mediaAnswer.translation, /blue/i);
    console.log('Verified exact multimodal prompt count:', mediaCount);
    const source = 'The launch is on Friday. The budget is 120 euros. These facts must be preserved.\n'.repeat(600);
    const messages = [{ role: 'user', content: 'What day is the launch and what is the budget?\n\n<attached-file name="test.pdf">\n' + source + '\n</attached-file>' }];
    const prepared = await prepareContext({ messages, contextSize: 8192, effort: 'balanced', signal,
      onStatus: (status, progress) => console.log(progress != null ? `${status} ${Math.round(progress * 100)}%` : status),
      count: (items, prompt = systemPrompt) => runtime.countTokens({ ...common, messages: items, systemPrompt: prompt }),
      summarize: async (items, prompt, maxTokens) => (await runtime.chat({ ...common, messages: items, systemPrompt: prompt, maxTokens })).translation,
    });
    assert.ok(prepared.compaction.beforeTokens > 8192);
    assert.ok(prepared.compaction.afterTokens < 6000);
    const answer = await runtime.chat({ ...common, messages: prepared.messages, maxTokens: prepared.maxTokens });
    assert.match(answer.translation, /Friday/i); assert.match(answer.translation, /120/);
    console.log('PASS: exact text/media counts, oversized document compaction and factual answer.', prepared.compaction, answer.translation);
    runtime.stop(); await local.release(); app.exit(0);
  } catch (error) { console.error(error); runtime.stop(); await local.release().catch(() => {}); app.exit(1); }
});
