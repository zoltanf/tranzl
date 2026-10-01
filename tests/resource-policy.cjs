const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resourcePolicy, FULL_CONTEXT, REDUCED_CONTEXT } = require('../src/backends/resourcePolicy');
const GIB = 2 ** 30;

test('CPU-class memory tiers: unavailable below 12 GB class, reduced context for 12 GB class, full from 16 GB class', () => {
  for (const platform of ['linux', 'win32']) {
    const at = gib => resourcePolicy({ totalMemoryBytes: gib * GIB, platform });
    assert.equal(at(8).available, false); assert.match(at(8).reason, /at least 12 GB.*it has 8 GB.*LM Studio or Ollama/);
    assert.equal(at(10.9).available, false);
    assert.deepEqual([at(11.6).available, at(11.6).contextSize], [true, REDUCED_CONTEXT]); // a "12 GB" machine
    assert.match(at(11.6).note, /12 GB of memory.*4,096 tokens instead of 8,192/);
    assert.deepEqual([at(14.9).contextSize, at(15.6).contextSize, at(64).contextSize], [REDUCED_CONTEXT, FULL_CONTEXT, FULL_CONTEXT]); // a "16 GB" machine reports ~15.6
    assert.equal(at(15.6).note, undefined);
  }
});
test('macOS keeps the validated full context regardless of memory', () => {
  const policy = resourcePolicy({ totalMemoryBytes: 8 * GIB, platform: 'darwin' });
  assert.deepEqual([policy.available, policy.contextSize, policy.note], [true, FULL_CONTEXT, undefined]);
});
test('the evaluation override applies the CPU-class rules on any platform', () => {
  process.env.TRANZL_EVALUATION_TOTAL_MEMORY_GIB = '12';
  try { assert.equal(resourcePolicy().contextSize, REDUCED_CONTEXT); assert.equal(resourcePolicy({ platform: 'darwin' }).contextSize, FULL_CONTEXT); }
  finally { delete process.env.TRANZL_EVALUATION_TOTAL_MEMORY_GIB; }
  assert.equal(resourcePolicy({ platform: 'linux', totalMemoryBytes: 32 * GIB }).contextSize, FULL_CONTEXT);
});
test('availability combines the runtime gate with the memory policy', () => {
  const { availability, runtimeFor } = require('../src/backends/embeddedAssets');
  let runtimeReason = null; try { runtimeFor(); } catch (error) { runtimeReason = error.message; }
  const at = gib => { process.env.TRANZL_EVALUATION_TOTAL_MEMORY_GIB = String(gib); try { return availability(); } finally { delete process.env.TRANZL_EVALUATION_TOTAL_MEMORY_GIB; } };
  if (runtimeReason) {
    // No pinned runtime can run here (e.g. Ubuntu 22.04 ARM64): that reason wins, whatever the memory.
    for (const gib of [8, 12, 64]) assert.equal(at(gib).reason, runtimeReason);
    return;
  }
  const low = at(8); assert.equal(low.available, false); assert.match(low.reason, /at least 12 GB/);
  const mid = at(12); assert.deepEqual([mid.available, mid.contextSize], [true, REDUCED_CONTEXT]); assert.match(mid.note, /smaller context/);
  const full = at(32); assert.deepEqual([full.available, full.contextSize, full.note], [true, FULL_CONTEXT, null]);
});
test('the embedded backend takes its context size from the policy', async () => {
  const { createEmbeddedBackend } = require('../src/backends/embeddedBackend');
  const seen = [];
  process.env.TRANZL_EVALUATION_TOTAL_MEMORY_GIB = '12';
  try {
    const backend = createEmbeddedBackend({ dir: '/tmp/x', assetManager: { paths: () => ({ binary: 'b', projector: 'p' }), prepare: async () => {} },
      makeRuntime: options => { seen.push(options.contextSize); return { load: async () => {}, state: () => ({ ready: true }), stop: async () => {} }; } });
    await backend.preload('/tmp/model.gguf');
  } finally { delete process.env.TRANZL_EVALUATION_TOTAL_MEMORY_GIB; }
  assert.deepEqual(seen, [REDUCED_CONTEXT]);
});

test('the embedded backend reads the compute mode whenever it creates a runtime', async () => {
  const { createEmbeddedBackend } = require('../src/backends/embeddedBackend');
  let compute = 'auto'; const seen = [];
  const backend = createEmbeddedBackend({ dir: '/tmp/x', contextSize: 8192, getCompute: () => compute, assetManager: { paths: () => ({ binary: 'b', projector: 'p' }), prepare: async () => {} },
    makeRuntime: options => { seen.push(options.gpu); return { load: async () => {}, state: () => ({ ready: true }), stop: async () => {} }; } });
  await backend.preload('/tmp/model.gguf');
  compute = 'cpu'; await backend.preload('/tmp/model.gguf'); // same runtime: unchanged until released
  await backend.release(); await backend.preload('/tmp/model.gguf');
  assert.deepEqual(seen, ['auto', 'cpu']);
});
