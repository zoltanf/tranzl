const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, getEventListeners } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function harness() {
  const worker = new EventEmitter(), sent = [];
  worker.postMessage = message => sent.push(message);
  const context = { module: { exports: {} }, __dirname: path.resolve(__dirname, '../src/backends'),
    require: name => name === 'electron' ? { utilityProcess: { fork: () => worker } } : require(name) };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../src/backends/local.js'), 'utf8'), context);
  return { local: context.module.exports, worker, sent };
}
test('already cancelled embedded requests never reach the worker', async () => {
  const { local, sent } = harness();
  const abort = new AbortController(); abort.abort();
  await assert.rejects(local.translate({ signal: abort.signal }));
  assert.equal(sent.length, 0);
});
test('completed embedded requests remove cancellation listeners', async () => {
  const { local, worker, sent } = harness();
  const abort = new AbortController();
  const response = local.translate({ signal: abort.signal, text: 'Hello' });
  assert.equal(getEventListeners(abort.signal, 'abort').length, 1);
  worker.emit('message', { id: sent[0].id, type: 'done', translation: 'Hi' });
  assert.equal((await response).translation, 'Hi');
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
  abort.abort(); assert.equal(sent.length, 1);
});
