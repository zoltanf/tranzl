const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { createServerRuntime, readCompletion } = require('../src/backends/serverRuntime');
const signal = () => new AbortController().signal;
const event = value => `data: ${JSON.stringify(value)}\n\n`;

test('stream handles split UTF-8, thought deltas, usage and final unterminated event', async () => {
  const bytes = Buffer.from(event({ choices: [{ delta: { reasoning_content: 'Think' } }] }) + event({ choices: [{ delta: { content: 'Grüße' } }] }) + 'data: ' + JSON.stringify({ choices: [{ finish_reason: 'stop' }], usage: { completion_tokens: 2 } }));
  let text = '', thought = '';
  const result = await readCompletion(Readable.from([...bytes].map(byte => Buffer.from([byte]))), { signal: signal(), onChunk: chunk => text += chunk, onThought: chunk => thought += chunk });
  assert.equal(result.translation, 'Grüße'); assert.equal(text, 'Grüße'); assert.equal(thought, 'Think'); assert.equal(result.usage.completion_tokens, 2);
});
test('truncated, malformed and error streams cannot become successful answers', async () => {
  for (const content of [event({ choices: [{ delta: { content: 'partial' } }] }), 'data: broken\n', event({ error: { message: 'bad input' } })]) {
    await assert.rejects(readCompletion(Readable.from([Buffer.from(content)]), { signal: signal() }));
  }
});
test('cancellation from a callback stops later deltas and completion', async () => {
  const abort = new AbortController(); let calls = 0;
  const content = event({ choices: [{ delta: { content: 'one' } }] }) + event({ choices: [{ delta: { content: 'two' }, finish_reason: 'stop' }] });
  await assert.rejects(readCompletion(Readable.from([Buffer.from(content)]), { signal: abort.signal, onChunk: () => { calls++; abort.abort(); } }));
  assert.equal(calls, 1);
});

function fixture(t, mode = 'normal') {
  const children = [];
  const runtime = createServerRuntime({ binary: 'fixture', modelPath: 'fixture.gguf', projectorPath: 'fixture-projector.gguf', startupTimeoutMs: mode === 'hang' ? 150 : 5000, shutdownTimeoutMs: 150,
    spawnProcess: (_binary, args, options) => {
      const child = spawn(process.execPath, [path.join(__dirname, 'fixtures/runtime-server.cjs'), mode, ...args], options);
      children.push({ child, args }); return child;
    } });
  t.after(() => runtime.stop());
  return { runtime, children };
}
const options = content => ({ signal: signal(), systemPrompt: 'Test', messages: [{ role: 'user', content }], maxTokens: 32 });

test('owns a server, authenticates, counts tokens and loads media lazily', async t => {
  const { runtime, children } = fixture(t);
  const result = await runtime.chat(options('hello'));
  assert.equal(result.translation, 'hello'); assert.equal(result.stats.contextTokens, 14); assert.equal(result.stats.contextEstimated, false);
  assert.ok(children[0].args.includes('--no-mmproj'));
  assert.equal(await runtime.countTokens(options('hello')), 12);
  await runtime.chat({ ...options('image'), messages: [{ role: 'user', content: 'image', media: [{ kind: 'image', mime: 'image/png', data: 'aGVsbG8=' }] }] });
  assert.equal(children.length, 2); assert.ok(children[0].child.exitCode !== null || children[0].child.signalCode !== null);
  assert.ok(children[1].args.includes('--mmproj'));
  await runtime.chat(options('text again')); assert.equal(children.length, 2);
  await runtime.stop(); assert.equal(runtime.state().pid, null);
});
test('queued cancellation settles promptly; active cancellation permits the next request', async t => {
  const { runtime, children } = fixture(t); await runtime.load();
  const active = new AbortController(), queued = new AbortController();
  const first = runtime.chat({ ...options('slow'), signal: active.signal, onChunk: () => active.abort() });
  const second = runtime.chat({ ...options('must not run'), signal: queued.signal }); queued.abort();
  await assert.rejects(second); await assert.rejects(first);
  assert.equal((await runtime.chat(options('after'))).translation, 'after');
  assert.equal(children.length, 1, 'confirmed idle server should retain the loaded model');
});
test('pre-aborted work never spawns and concurrent requests retain ownership', async t => {
  const { runtime, children } = fixture(t), abort = new AbortController(); abort.abort();
  await assert.rejects(runtime.chat({ ...options('skip'), signal: abort.signal })); assert.equal(children.length, 0);
  const results = await Promise.all(['first', 'second', 'third'].map(text => runtime.chat(options(text))));
  assert.deepEqual(results.map(result => result.translation), ['first', 'second', 'third']); assert.equal(children.length, 1);
});
test('startup timeout and startup cancellation clean up their child', async t => {
  const { runtime, children } = fixture(t, 'hang');
  await assert.rejects(runtime.load(), /aborted|timeout/i); assert.equal(runtime.state().pid, null);
  assert.equal(children.length, 1);
  const abort = new AbortController(), loading = runtime.load({ signal: abort.signal });
  const timer = setTimeout(() => abort.abort(), 40);
  await assert.rejects(loading); clearTimeout(timer); await runtime.stop();
  assert.equal(runtime.state().pid, null);
  assert.ok(children.every(({ child }) => child.exitCode !== null || child.signalCode !== null));
});
test('process crash rejects active request and next request starts a fresh child', async t => {
  const { runtime, children } = fixture(t);
  await assert.rejects(runtime.chat(options('crash')));
  assert.equal((await runtime.chat(options('recovered'))).translation, 'recovered');
  assert.equal(children.length, 2);
});
test('stop rejects queued work and prevents late chunks', async t => {
  const { runtime } = fixture(t); await runtime.load(); let chunks = 0;
  const first = runtime.chat({ ...options('slow'), onChunk: () => chunks++ });
  const second = runtime.chat(options('queued'));
  const settled = Promise.allSettled([first, second]);
  await runtime.stop();
  assert.ok((await settled).every(result => result.status === 'rejected')); assert.equal(chunks, 0);
  assert.equal(runtime.state().pid, null);
});
for (const mode of ['missing-slots', 'invalid-slots']) test(`${mode} never claims measured occupied context`, async t => {
  const { runtime } = fixture(t, mode);
  const result = await runtime.chat(options('hello'));
  assert.equal(result.stats.contextEstimated, true); assert.equal(result.stats.contextTokens, null);
});
test('a server ignoring SIGTERM is killed before stop resolves', async t => {
  const { runtime, children } = fixture(t, 'ignore-term'); await runtime.load(); await runtime.stop();
  // Windows has no catchable SIGTERM: kill() already terminates, so no escalation is needed.
  assert.equal(children[0].child.signalCode, process.platform === 'win32' ? 'SIGTERM' : 'SIGKILL'); assert.equal(runtime.state().pid, null);
});
test('missing executable fails without hanging or leaving a child', async () => {
  const runtime = createServerRuntime({ binary: path.join(__dirname, 'fixtures/does-not-exist'), modelPath: 'fixture.gguf' });
  await assert.rejects(runtime.load(), /ENOENT/); await runtime.stop(); assert.equal(runtime.state().pid, null);
});
test('shutdown cancels asset preparation and drains queued work without spawning', async () => {
  let entered;
  const preparing = new Promise(resolve => { entered = resolve; });
  let spawned = false;
  const runtime = createServerRuntime({
    binary: 'unused', modelPath: 'unused',
    prepareAssets: ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      entered();
    }),
    spawnProcess: () => { spawned = true; throw new Error('must not spawn'); },
  });
  const loading = runtime.load(), queued = runtime.chat(options('queued'));
  const results = Promise.allSettled([loading, queued]);
  await preparing; await runtime.stop();
  assert.ok((await results).every(result => result.status === 'rejected'));
  assert.equal(spawned, false); assert.equal(runtime.state().pid, null);
});
