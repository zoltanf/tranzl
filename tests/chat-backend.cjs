const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createRequire } = require('node:module');
const mainPath = path.resolve(__dirname, '../src/main.js');
function harness(backend, fetch) {
  const handlers = new Map(), events = [], calls = [];
  const electron = { ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    app: { setPath() {}, getPath: () => '/tmp', whenReady: () => ({ then() {} }), on() {} } };
  const local = { modelState: () => ({ contextSize: 8192 }), countTokens: async () => 100, MODEL_LABEL: 'test model', translate: async options => { calls.push(options); options.onChunk('Hello'); return { translation: 'Hello' }; } };
  const realRequire = createRequire(mainPath);
  const context = vm.createContext({ require: name => name === 'electron' ? electron : name === './backends/local' ? local : realRequire(name), AbortController, AbortSignal, TextDecoder, fetch, Buffer, console, __dirname: path.dirname(mainPath) });
  vm.runInContext(fs.readFileSync(mainPath, 'utf8') + `\nsettings = { backend: ${JSON.stringify(backend)} };`, context);
  const event = { sender: { isDestroyed: () => false, send: (channel, data) => events.push({ channel, ...data }) } };
  return { handlers, event, events, calls, setBackend: backend => vm.runInContext(`settings.backend = ${JSON.stringify(backend)}`, context) };
}
const messages = [{ role: 'user', content: 'My name is Sam' }, { role: 'assistant', content: 'Hello Sam' }, { role: 'user', content: 'What is my name?' }];
test('embedded chat restores turns and keeps translation requests independent', async () => {
  const h = harness('local');
  await h.handlers.get('chat-send')(h.event, { messages, requestId: 'chat', effort: 'thorough' });
  assert.equal(h.calls[0].history.length, 2); assert.equal(h.calls[0].reasoning, true);
  assert.match(h.calls[0].systemPrompt, /helpful local assistant/);
  assert.ok(h.events.every(e => e.channel === 'chat-event'));
  await h.handlers.get('translate')(h.event, { text: 'Hi', targetLanguage: 'German' });
  assert.equal(h.calls[1].history.length, 0); assert.match(h.calls[1].systemPrompt, /translation and text-editing/);
});
for (const backend of ['ollama', 'lmstudio']) test(`${backend}: history, thinking and final unterminated stream line`, async () => {
  let body;
  const h = harness(backend, async (_url, options) => {
    if (!options?.body) return Response.json({ models: [] });
    body = JSON.parse(options.body);
    const line = backend === 'ollama' ? JSON.stringify({ message: { content: 'Sam', thinking: 'Recall' }, done: true }) : 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'Sam', reasoning_content: 'Recall' } }] });
    return new Response(line);
  });
  const result = await h.handlers.get('chat-send')(h.event, { messages, model: 'test', effort: 'thorough' });
  assert.equal(result.translation, 'Sam'); assert.deepEqual(body.messages.slice(1), messages);
  assert.ok(h.events.some(e => e.type === 'thinking' && e.delta === 'Recall'));
});
test('oversized chat is rejected before inference', async () => {
  const h = harness('local');
  const result = await h.handlers.get('chat-send')(h.event, { messages: [{ role: 'user', content: 'x'.repeat(200001) }] });
  assert.equal(result.ok, false); assert.equal(h.calls.length, 0);
});
test('chat store round trip, removal and unavailable encryption', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tranzl-store-test-'));
  const handlers = new Map(); let available = true;
  require('../src/chatStore')({ ipcMain: { handle: (key, value) => handlers.set(key, value) }, app: { getPath: () => dir }, safeStorage: {
    isEncryptionAvailable: () => available, encryptString: s => Buffer.from(s), decryptString: b => b.toString(),
  } });
  try {
    const save = handlers.get('chat-save'), load = handlers.get('chat-load');
    assert.equal(save(null, { sessions: [{ id: 'one', messages }], activeId: 'one' }).ok, true);
    assert.equal(load().sessions[0].id, 'one');
    save(null, { sessions: [] }); assert.equal(load().sessions.length, 0);
    available = false; assert.equal(save(null, { sessions: [] }).ok, false); assert.equal(load().persistent, false);
  } finally { fs.rmSync(dir, { recursive: true }); }
});
test('stopping chat aborts chat without cancelling translation', async () => {
  const requests = [];
  const h = harness('lmstudio', (_url, options) => !options?.body ? Promise.resolve(Response.json({ models: [] })) : new Promise((_resolve, reject) => {
    requests.push(options);
    options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }));
  const translation = h.handlers.get('translate')(h.event, { text: 'Hello', model: 'test', targetLanguage: 'German' });
  const chat = h.handlers.get('chat-send')(h.event, { messages, model: 'test' });
  h.handlers.get('chat-stop')();
  assert.equal((await chat).aborted, true);
  assert.equal(requests[0].signal.aborted, false);
  h.handlers.get('cancel-translate')(); assert.equal((await translation).aborted, true);
});
test('attachments reject oversized and binary files without including their contents', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tranzl-files-test-'));
  const paths = ['notes.md', 'large.txt', 'binary.txt'].map(name => path.join(dir, name));
  fs.writeFileSync(paths[0], 'Hello file'); fs.writeFileSync(paths[1], 'x'.repeat(20 * 1024 * 1024 + 1)); fs.writeFileSync(paths[2], Buffer.from([0, 255]));
  const handlers = new Map();
  require('../src/chatStore')({ ipcMain: { handle: (key, value) => handlers.set(key, value) }, dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: paths }) } });
  try {
    const result = await handlers.get('chat-attach')();
    assert.equal(result.files.length, 1); assert.equal(result.files[0].content, 'Hello file'); assert.equal(result.errors.length, 2);
  } finally { fs.rmSync(dir, { recursive: true }); }
});
for (const backend of ['ollama', 'lmstudio']) test(`${backend}: reports tokens, cache and loaded context capacity`, async () => {
  const h = harness(backend, async (url, options) => {
    if (url.endsWith('/api/ps')) return Response.json({ models: [{ name: 'test', context_length: 8192 }] });
    if (url.endsWith('/api/v1/models')) return Response.json({ models: [{ key: 'test', max_context_length: 131072, loaded_instances: [{ id: 'test', config: { context_length: 8192 } }] }] });
    if (backend === 'lmstudio') assert.equal(JSON.parse(options.body).stream_options.include_usage, true);
    return new Response(backend === 'ollama' ? JSON.stringify({ message: { content: 'answer' }, done: true, prompt_eval_count: 100, eval_count: 20, prompt_eval_cached_count: 75, eval_duration: 1e9 }) : 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'answer' } }], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 75 } } }));
  });
  const result = await h.handlers.get('chat-send')(h.event, { messages, model: 'test' });
  assert.equal(result.stats.inputTokens, 100); assert.equal(result.stats.outputTokens, 20);
  assert.equal(result.stats.cachedTokens, 75); assert.equal(result.stats.contextSize, 8192);
  assert.equal(result.stats.contextTokens, 120); assert.equal(result.stats.contextEstimated, true);
  assert.deepEqual(h.events.find(e => e.type === 'done').stats, result.stats);
});
test('missing model telemetry stays unknown instead of claiming theoretical capacity', async () => {
  const h = harness('lmstudio', async () => Response.json({ models: [{ key: 'test', max_context_length: 131072, loaded_instances: [] }] }));
  const info = await h.handlers.get('chat-model-info')(h.event, 'test'); assert.equal(info.contextSize, null);
});
test('translation accepts clipboard images with empty text and preserves OCR/target instructions', async () => {
  let body;
  const h = harness('lmstudio', async (_url, options) => { body = JSON.parse(options.body); return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Good morning' } }] })); });
  const result = await h.handlers.get('translate')(h.event, { text: '', targetLanguage: 'English', model: 'vision', images: [{ kind: 'image', mime: 'image/png', data: 'aGVsbG8=' }] });
  assert.equal(result.translation, 'Good morning');
  assert.match(body.messages[0].content, /into English/); assert.match(body.messages[0].content, /Read all legible text/);
  assert.equal(body.messages[1].content[1].type, 'image_url');
});
test('translation rejects audio attachments', async () => {
  const h = harness('local');
  const result = await h.handlers.get('translate')(h.event, { text: '', images: [{ kind: 'audio', format: 'wav', data: 'aGVsbG8=' }] });
  assert.equal(result.ok, false); assert.match(result.error, /image attachments only/);
});

test('a backend change during preparation does not reroute an in-flight chat', async () => {
  let resolveInfo;
  const h = harness('ollama', async (url, options) => {
    if (url.endsWith('/api/ps')) return new Promise(resolve => { resolveInfo = resolve; });
    assert.ok(url.endsWith('/api/chat'));
    return new Response(JSON.stringify({ message: { content: 'Original backend' }, done: true }));
  });
  const result = h.handlers.get('chat-send')(h.event, { messages, model: 'test' });
  h.setBackend('local');
  resolveInfo(Response.json({ models: [] }));
  assert.equal((await result).translation, 'Original backend');
  assert.equal(h.calls.length, 0);
});
test('LM Studio streaming errors fail the request instead of saving an empty success', async () => {
  const h = harness('lmstudio', async (_url, options) => options?.body
    ? new Response('data: ' + JSON.stringify({ error: { message: 'Context window exceeded' } }))
    : Response.json({ models: [] }));
  const result = await h.handlers.get('chat-send')(h.event, { messages, model: 'test' });
  assert.equal(result.ok, false);
  assert.match(result.error, /Context window exceeded/);
  assert.equal(h.events.some(event => event.type === 'done'), false);
});
