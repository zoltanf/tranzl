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
