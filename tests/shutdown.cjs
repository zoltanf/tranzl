// Launches the real app with a throwaway profile and checks that one SIGTERM
// (how CI and service managers stop processes) exits cleanly instead of lingering.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const appRoot = process.env.TRANZL_APP_ROOT || path.resolve(__dirname, '..');

test('one SIGTERM quits the app cleanly', { skip: process.platform === 'win32' && 'Windows has no SIGTERM' }, async t => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tranzl-shutdown-'));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  const child = spawn(require('electron'), [appRoot], { env: { ...process.env, TRANZL_TEST_PROFILE: profile }, stdio: ['ignore', 'ignore', 'pipe'] });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  try {
    await new Promise((resolve, reject) => {
      let output = '';
      child.stderr.on('data', chunk => { output += chunk; if (output.includes('test profile')) resolve(); });
      child.once('exit', () => reject(new Error(`app exited before starting: ${output}`)));
    });
    await new Promise(resolve => setTimeout(resolve, 3000)); // let the window and IPC come up
    child.kill('SIGTERM');
    const result = await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve('timeout'), 10000))]);
    assert.deepEqual(result, { code: 0, signal: null }, 'expected a graceful exit, not a lingering or killed process');
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
});
