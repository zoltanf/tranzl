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
  const { availability } = require('../src/backends/embeddedAssets');
  process.env.TRANZL_EVALUATION_TOTAL_MEMORY_GIB = '8';
  try { const low = availability(); assert.equal(low.available, false); assert.match(low.reason, /at least 12 GB/); }
  finally { delete process.env.TRANZL_EVALUATION_TOTAL_MEMORY_GIB; }
  process.env.TRANZL_EVALUATION_TOTAL_MEMORY_GIB = '12';
  try { const mid = availability(); assert.deepEqual([mid.available, mid.contextSize], [true, REDUCED_CONTEXT]); assert.match(mid.note, /smaller context/); }
  finally { delete process.env.TRANZL_EVALUATION_TOTAL_MEMORY_GIB; }
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
