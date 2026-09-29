// Opt-in native startup checks. Only synthetic corrupt/missing assets are used.
// node scripts/check-runtime-failures.cjs /absolute/llama-server /absolute/model.gguf /absolute/report.json
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createServerRuntime } = require('../src/backends/serverRuntime');
const [binary, model, output] = process.argv.slice(2);
if (![binary, model, output].every(value => value && path.isAbsolute(value))) throw new Error('Provide absolute binary, model and report paths');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tranzl-native-errors-'));
const report = { date: new Date().toISOString(), cases: [] };
async function check(name, modelPath, cancel = false) {
  const abort = new AbortController();
  const runtime = createServerRuntime({ binary, modelPath, startupTimeoutMs: 10000,
    onStatus: status => { if (cancel && status.state === 'loading') abort.abort(); } });
  try { await assert.rejects(runtime.load({ signal: abort.signal })); await runtime.stop(); assert.equal(runtime.state().pid, null); report.cases.push({ name, passed: true }); }
  finally { await runtime.stop(); }
}
(async () => {
  try {
    await check('missing-model', path.join(temp, 'missing.gguf'));
    const corrupt = path.join(temp, 'corrupt.gguf'); fs.writeFileSync(corrupt, 'synthetic invalid model');
    await check('corrupt-model', corrupt);
    await check('cancel-during-native-startup', model, true);
    // Startup-only diagnostic run: no prompt is sent. Persist recognized
    // backend evidence, never the raw verbose stream.
    const runtime = createServerRuntime({ binary, modelPath: model, spawnProcess: (exe, args, options) => {
      const child = spawn(exe, [...args, '--verbose'], options);
      for (const stream of [child.stdout, child.stderr]) {
        let tail = '';
        stream.on('data', bytes => {
          const lines = (tail + bytes).split('\n'); tail = lines.pop().slice(-1024);
          for (const line of lines) {
            if (/ggml_metal_library_compile_pipeline/.test(line)) report.metalWarmupObserved = true;
            const match = line.match(/offloaded (\d+)\/(\d+) layers to GPU/);
            if (match) report.offloadedLayers = Number(match[1]);
          }
        });
      }
      return child;
    } });
    try { await runtime.load(); report.startupDiagnostics = runtime.state().diagnostics; }
    finally { await runtime.stop(); }
  } catch (error) { report.error = error.message; process.exitCode = 1; }
  finally { fs.rmSync(temp, { recursive: true, force: true }); fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); console.log(report); }
})();
