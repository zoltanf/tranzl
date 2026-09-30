// Launches the real app (or a packaged build: TRANZL_EXECUTABLE) with a throwaway profile and
// drives its page over a local DevTools port. Checks that IPC works from the app page, that the
// window cannot navigate away, optionally a real translation (TRANZL_SMOKE_MODEL=<model.gguf>),
// and that it quits cleanly: one SIGTERM on macOS/Linux, a normal close request on Windows.
// TRANZL_EXPECT_EMBEDDED=available|unavailable asserts how the embedded backend is reported.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFile, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const appRoot = process.env.TRANZL_APP_ROOT || path.resolve(__dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const within = (ms, what, promise) => Promise.race([promise, sleep(ms).then(() => { throw new Error(`Timed out after ${ms / 1000} s: ${what}`); })]);
// Keep tests off real OS keychains: macOS uses Chromium's mock keychain (no item, no access
// prompt); Linux uses the unprotected basic store, which Tranzl must refuse to persist with.
const KEYCHAIN_FLAGS = { darwin: ['--use-mock-keychain'], linux: ['--password-store=basic'] }[process.platform] || [];

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer().once('error', reject);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
});
async function connect(port) {
  for (const end = Date.now() + 60000; Date.now() < end; await sleep(250)) {
    try {
      const target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page' && t.url.endsWith('/renderer/index.html'));
      if (!target) continue;
      const ws = new WebSocket(target.webSocketDebuggerUrl);
      await within(10000, 'DevTools connection', new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; }));
      let id = 0; const pending = new Map();
      ws.onmessage = message => { const data = JSON.parse(message.data); pending.get(data.id)?.(data); pending.delete(data.id); };
      return {
        // A hung call (e.g. an OS keychain prompt nobody can answer) fails with its expression.
        async evaluate(expression, ms = 60000) {
          const reply = await within(ms, expression, new Promise(resolve => { const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })); }));
          if (reply.result?.exceptionDetails) throw new Error(reply.result.exceptionDetails.exception?.description || reply.result.exceptionDetails.text);
          return reply.result?.result?.value;
        },
        close: () => ws.close(),
      };
    } catch {}
  }
  throw new Error('The app page did not become available over DevTools');
}

test('the real app serves IPC to its page, cannot navigate away and quits cleanly', { timeout: 30 * 60000 }, async t => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tranzl-smoke-'));
  t.after(() => { try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch {} });
  const model = process.env.TRANZL_SMOKE_MODEL;
  if (model) fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ backend: 'local', localModelPath: model }));
  const port = await freePort();
  const flags = [`--remote-debugging-port=${port}`, '--remote-allow-origins=http://127.0.0.1', ...KEYCHAIN_FLAGS];
  const [command, args] = process.env.TRANZL_EXECUTABLE ? [process.env.TRANZL_EXECUTABLE, flags] : [require('electron'), [appRoot, ...flags]];
  const child = spawn(command, args, { env: { ...process.env, TRANZL_TEST_PROFILE: profile }, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const stderrClosed = new Promise(resolve => child.stderr.once('close', resolve));
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  let page;
  try {
    page = await connect(port);
    for (let i = 0; i < 100 && !(await page.evaluate(`document.readyState === 'complete' && !!window.tranzl`)); i++) await sleep(100);

    const setup = await page.evaluate('window.tranzl.getSetup()');
    assert.equal(typeof setup.modelLabel, 'string', 'IPC from the app page works');
    const chats = await page.evaluate('window.tranzl.chatLoad()');
    // With the basic store Electron reports encryption unavailable or basic_text; either way nothing may persist.
    if (process.platform === 'linux') { assert.equal(chats.persistent, false, 'the basic store is never used for saved data'); assert.match(chats.error, /only last until you close the app/); }
    else assert.equal(chats.persistent, true);
    if (process.env.TRANZL_EXPECT_EMBEDDED === 'unavailable') assert.match(setup.embeddedUnavailable || '', /needs glibc [\d.]+ or newer/);
    if (process.env.TRANZL_EXPECT_EMBEDDED === 'available') assert.equal(setup.embeddedUnavailable, null);

    const home = await page.evaluate('location.href');
    for (const url of ['https://example.com/', path.join(profile, 'dropped.html')]) {
      if (!url.startsWith('https:')) fs.writeFileSync(url, '<h1>dropped</h1>');
      await page.evaluate(`location.href = ${JSON.stringify(url.startsWith('https:') ? url : require('node:url').pathToFileURL(url).href)}; true`).catch(() => {});
      await sleep(1000);
      assert.equal(await page.evaluate('location.href'), home, `navigation to ${url} must be blocked`);
    }

    if (model) {
      const result = await page.evaluate(`window.tranzl.translate({ text: 'Good morning', targetLanguage: 'German', style: 'translate', effort: 'fast', requestId: 'smoke' })`, 20 * 60000);
      assert.equal(result.ok, true, result.error); assert.match(result.translation, /Guten Morgen/i);
    }

    page.close();
    if (process.platform === 'win32') execFile('taskkill', ['/PID', String(child.pid)]); // a close request, not /F
    else child.kill('SIGTERM');
    const result = await Promise.race([exited, sleep(30000).then(() => 'timeout')]);
    assert.deepEqual(result, { code: 0, signal: null }, `expected a clean exit\n${stderr.slice(-2000)}`);
    // A process the app left behind can hold its stderr pipe open and keep this test alive
    // forever. Name any such process, then release the pipe.
    if (await Promise.race([stderrClosed.then(() => false), sleep(3000).then(() => true)])) {
      let survivors = '(unavailable)';
      if (process.platform !== 'win32') try { survivors = execFileSync('ps', ['-eo', 'pid,ppid,etime,args'], { encoding: 'utf8' }).split('\n').filter(line => /electron|tranzl|dbus|crashpad|llama/i.test(line)).join('\n'); } catch {}
      console.warn(`stderr pipe still open 3 s after the app exited; possible leftover processes:\n${survivors}`);
    }
  } finally {
    child.stderr.destroy();
    page?.close();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});
