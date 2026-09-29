const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { verify, downloadVerified } = require('../src/backends/verifiedAssets');
const bytes = Buffer.from('abcdef');
const asset = { url: 'https://example.invalid/fixture', bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
async function fixture(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tranzl-asset-test-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return path.join(dir, 'asset'); }
test('verified asset is reused offline and later file changes invalidate verification', async t => {
  const dest = await fixture(t); await fs.writeFile(dest, bytes);
  await downloadVerified(asset, dest, { fetchImpl: () => { throw new Error('network should not be used'); } });
  await fs.writeFile(dest, 'badbad'); assert.equal(await verify(dest, asset), false);
});
test('a valid partial download resumes at the correct offset', async t => {
  const dest = await fixture(t); await fs.writeFile(dest + '.part', bytes.subarray(0, 2));
  await downloadVerified(asset, dest, { fetchImpl: async (_url, options) => { assert.equal(options.headers.Range, 'bytes=2-'); return new Response(bytes.subarray(2), { status: 206, headers: { 'content-range': 'bytes 2-5/6' } }); } });
  assert.deepEqual(await fs.readFile(dest), bytes);
});
test('a server ignoring Range safely restarts the partial file', async t => {
  const dest = await fixture(t); await fs.writeFile(dest + '.part', 'ab');
  await downloadVerified(asset, dest, { fetchImpl: async () => new Response(bytes) });
  assert.deepEqual(await fs.readFile(dest), bytes);
});
test('wrong resume range preserves the partial file', async t => {
  const dest = await fixture(t); await fs.writeFile(dest + '.part', 'ab');
  await assert.rejects(downloadVerified(asset, dest, { fetchImpl: async () => new Response('cdef', { status: 206, headers: { 'content-range': 'bytes 1-4/6' } }) }), /resume/);
  assert.equal(await fs.readFile(dest + '.part', 'utf8'), 'ab');
});
test('checksum mismatch preserves the previous destination and removes bad partial data', async t => {
  const dest = await fixture(t); await fs.writeFile(dest, 'previous');
  await assert.rejects(downloadVerified(asset, dest, { fetchImpl: async () => new Response('badbad') }), /checksum/);
  assert.equal(await fs.readFile(dest, 'utf8'), 'previous'); await assert.rejects(fs.stat(dest + '.part'), { code: 'ENOENT' });
});
test('interrupted transfer retains bytes that can be resumed', async t => {
  const dest = await fixture(t), abort = new AbortController(); let pulls = 0;
  const stream = new ReadableStream({ pull(controller) { if (pulls++ === 0) controller.enqueue(bytes.subarray(0, 2)); else controller.enqueue(bytes.subarray(2)); } });
  await assert.rejects(downloadVerified(asset, dest, { signal: abort.signal, onProgress: () => abort.abort(), fetchImpl: async () => new Response(stream) }));
  assert.equal(await fs.readFile(dest + '.part', 'utf8'), 'ab');
  await downloadVerified(asset, dest, { fetchImpl: async () => new Response(bytes.subarray(2), { status: 206, headers: { 'content-range': 'bytes 2-5/6' } }) });
  assert.deepEqual(await fs.readFile(dest), bytes);
});
test('complete partial file is verified and promoted without downloading again', async t => {
  const dest = await fixture(t); await fs.writeFile(dest + '.part', bytes);
  await downloadVerified(asset, dest, { fetchImpl: () => { throw new Error('unexpected network'); } });
  assert.deepEqual(await fs.readFile(dest), bytes);
});
test('failed final rename retains the verified partial and prior directory contents', async t => {
  const dest = await fixture(t); await fs.mkdir(dest); await fs.writeFile(path.join(dest, 'keep'), 'prior');
  await assert.rejects(downloadVerified(asset, dest, { fetchImpl: async () => new Response(bytes) }));
  assert.equal(await fs.readFile(path.join(dest, 'keep'), 'utf8'), 'prior'); assert.equal(await verify(dest + '.part', asset), true);
});
test('short successful response preserves partial bytes for retry', async t => {
  const dest = await fixture(t);
  await assert.rejects(downloadVerified(asset, dest, { fetchImpl: async () => new Response('ab') }), /ended early/);
  assert.equal(await fs.readFile(dest + '.part', 'utf8'), 'ab');
  await assert.rejects(fs.stat(dest), { code: 'ENOENT' });
});
test('runtime verification rejects missing and corrupt companion libraries', async t => {
  const { verifyRuntime } = require('../src/backends/embeddedAssets');
  const dest = await fixture(t), dir = path.dirname(dest);
  const files = { server: asset.sha256, library: asset.sha256 };
  await fs.writeFile(path.join(dir, 'server'), bytes);
  assert.equal(await verifyRuntime(dir, files), false);
  await fs.writeFile(path.join(dir, 'library'), bytes);
  assert.equal(await verifyRuntime(dir, files), true);
  await fs.writeFile(path.join(dir, 'library'), 'badbad');
  assert.equal(await verifyRuntime(dir, files), false);
});
test('runtime manifest pins every listed target completely', () => {
  const { manifest, archiveFormats } = require('../src/backends/embeddedAssets');
  assert.ok(Object.keys(manifest.targets).length);
  for (const [target, runtime] of Object.entries(manifest.targets)) {
    assert.equal(target, `${runtime.os}-${runtime.arch}`);
    assert.ok(runtime.compute.includes('cpu'), `${target} must ship a CPU path`);
    assert.match(runtime.url, new RegExp(`^https://.+/${manifest.version}/`));
    assert.ok(Number.isInteger(runtime.bytes) && runtime.bytes > 0);
    assert.match(runtime.sha256, /^[0-9a-f]{64}$/);
    assert.ok(archiveFormats.includes(runtime.archive.format)); assert.ok(runtime.archive.root);
    for (const name of [runtime.executable, ...runtime.notices]) assert.ok(runtime.files[name], `${target} must verify ${name}`);
    for (const sha256 of Object.values(runtime.files)) assert.match(sha256, /^[0-9a-f]{64}$/);
  }
});
test('runtime selection keeps the existing install path and rejects unvalidated targets', () => {
  const { paths } = require('../src/backends/embeddedAssets');
  assert.equal(paths('/data', 'darwin-arm64').binary, path.join('/data', 'llama-b11158', 'llama-server'));
  for (const target of ['linux-x64', 'linux-arm64', 'win32-x64']) assert.throws(() => paths('/data', target), new RegExp(`not available for ${target}`));
});
