const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createEmbeddedBackend } = require('../src/backends/embeddedBackend');
function harness() {
  const calls = []; let instances = 0;
  const backend = createEmbeddedBackend({ dir: '/isolated',
    assetManager: { paths: () => ({ binary: 'server', projector: 'projector' }), prepare: async options => calls.push({ prepare: options }), downloadModel: async () => 'model' },
    makeRuntime: options => {
      instances++;
      return {
        load: async request => { await options.prepareAssets(request); options.onStatus({ state: 'ready' }); },
        chat: async request => { request.signal?.throwIfAborted(); calls.push(request); return { translation: 'answer' }; },
        countTokens: async request => { calls.push(request); return 12; }, stop: async () => calls.push('stop'), state: () => ({ ready: true }),
      };
    } });
  return { backend, calls, instances: () => instances };
}
test('embedded facade stays lazy and shares one runtime for text, media and token counts', async () => {
  const h = harness(); assert.equal(h.instances(), 0); assert.equal(h.backend.modelState().state, 'idle');
  const messages = [{ role: 'user', content: 'hello', media: [{ kind: 'image' }] }], signal = new AbortController().signal;
  await h.backend.chat({ modelPath: 'model', messages, signal });
  assert.equal(await h.backend.countTokens({ modelPath: 'model', messages, signal }), 12);
  await h.backend.translate({ modelPath: 'model', text: 'text', history: [], signal });
  assert.equal(h.instances(), 1); assert.equal(h.calls[0].messages, messages); assert.equal(h.calls[0].signal, signal);
  assert.deepEqual(h.calls[2].messages, [{ role: 'user', content: 'text' }]);
});
test('preload reports status and release disposes before another model is selected', async () => {
  const h = harness(), statuses = [];
  await h.backend.preload('model', status => statuses.push(status.state));
  assert.deepEqual(statuses, ['loading', 'ready']);
  await assert.rejects(h.backend.chat({ modelPath: 'other', messages: [] }), /Restart/);
  assert.equal(h.instances(), 1); await h.backend.release(); assert.equal(h.backend.modelState().state, 'idle');
  await h.backend.chat({ modelPath: 'other', messages: [] }); assert.equal(h.instances(), 2); assert.ok(h.calls.includes('stop'));
});
test('background preload failures are visible and do not create unhandled rejections', async () => {
  const backend = createEmbeddedBackend({ dir: '/isolated', assetManager: { paths: () => { throw new Error('runtime missing'); } } });
  const statuses = []; await backend.preload('model', status => statuses.push(status));
  assert.equal(statuses.at(-1).state, 'error'); assert.match(statuses.at(-1).error, /runtime missing/);
});
