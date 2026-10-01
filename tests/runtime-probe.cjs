const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { probeRuntime } = require('../src/backends/embeddedAssets');

// Fake runtimes: Node scripts standing in for llama-server --version on various systems.
function fake(t, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tranzl-probe-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'server.js'); fs.writeFileSync(script, body);
  return { binary: process.execPath, execFileImpl: (_bin, args, options, callback) => require('node:child_process').execFile(process.execPath, [script, ...args], options, callback) };
}
test('a runtime that starts passes the probe', async t => {
  const { binary, execFileImpl } = fake(t, `console.error('version: 11158 (3423f940e)'); process.exit(0);`);
  await probeRuntime(binary, { execFileImpl });
});
test('too old system libraries are explained before any model download', async t => {
  const { binary, execFileImpl } = fake(t, `console.error("./llama-server: /lib/aarch64-linux-gnu/libstdc++.so.6: version \`GLIBCXX_3.4.32' not found (required by ./libllama-server-impl.so)"); process.exit(127);`);
  await assert.rejects(probeRuntime(binary, { execFileImpl }), /C\/C\+\+ runtime libraries are older.*cannot run here; use LM Studio or Ollama/);
});
test('a missing shared library and a crash are explained distinctly', async t => {
  const missing = fake(t, `console.error('llama-server: error while loading shared libraries: libgomp.so.1: cannot open shared object file'); process.exit(127);`);
  await assert.rejects(probeRuntime(missing.binary, { execFileImpl: missing.execFileImpl }), /library the inference runtime needs is missing/);
  const crash = fake(t, `process.exit(139);`);
  await assert.rejects(probeRuntime(crash.binary, { execFileImpl: crash.execFileImpl }), /could not start \(139\)/);
  await assert.rejects(probeRuntime(path.join(os.tmpdir(), 'tranzl-no-such-binary')), /executable is missing/);
});
test('a hanging runtime is bounded by the timeout', async t => {
  const { binary, execFileImpl } = fake(t, `setInterval(() => {}, 1000);`);
  await assert.rejects(probeRuntime(binary, { execFileImpl, timeoutMs: 500 }), /did not respond in time/);
});
test('an illegal-instruction crash is reported as an unsupported processor', async t => {
  const { binary, execFileImpl } = fake(t, `process.kill(process.pid, 'SIGILL');`);
  if (process.platform === 'win32') return; // signals differ; the Windows status code path is covered by the constant
  await assert.rejects(probeRuntime(binary, { execFileImpl }), /processor lacks instructions/);
});
test('Windows loader status codes are classified without a real crash', async () => {
  const failing = code => (_bin, _args, _options, callback) => callback(Object.assign(new Error('spawn failed'), { code, stdout: '', stderr: '' }));
  await assert.rejects(probeRuntime('fake.exe', { execFileImpl: failing(3221225501) }), /processor lacks instructions/);
  await assert.rejects(probeRuntime('fake.exe', { execFileImpl: failing(3221225781) }), /library the inference runtime needs is missing/);
});
test('device listing identifies GPU devices and tolerates failure', async t => {
  const { parseDevices, listDevices } = require('../src/backends/embeddedAssets');
  const mac = parseDevices('0.00.005 I srv  llama_server: initializing ...\nAvailable devices:\n  MTL0: Apple M5 Pro (53084 MiB, 53083 MiB free)\n  BLAS: Accelerate (0 MiB, 0 MiB free)\n');
  assert.deepEqual(mac, [{ name: 'MTL0', description: 'Apple M5 Pro', gpu: true }, { name: 'BLAS', description: 'Accelerate', gpu: false }]);
  assert.deepEqual(parseDevices('Available devices:\n  CPU: AMD EPYC (0 MiB, 0 MiB free)\n').map(d => d.gpu), [false]);
  assert.deepEqual(parseDevices('Available devices:\n  CUDA0: NVIDIA RTX 4070 (12282 MiB, 11000 MiB free)\n  Vulkan0: Intel Arc (8000 MiB, 7000 MiB free)\n').map(d => [d.name, d.gpu]), [['CUDA0', true], ['Vulkan0', true]]);
  const { binary, execFileImpl } = fake(t, `process.exit(3);`);
  assert.equal(await listDevices(binary, { execFileImpl }), null);
});
