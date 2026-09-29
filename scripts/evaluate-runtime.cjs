// Explicit, isolated A/B runner. Run once per backend in separate Electron
// processes so the two model copies are never held simultaneously.
// electron scripts/evaluate-runtime.cjs --backend=worker|server --model=/...gguf
//   --binary=/.../llama-server --projector=/...gguf --output=/...json [--media]
const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const appRoot = process.env.TRANZL_APP_ROOT || path.resolve(__dirname, '..');
const appRequire = require('node:module').createRequire(path.join(appRoot, 'package.json'));
const { createServerRuntime } = appRequire('./src/backends/serverRuntime');
const args = Object.fromEntries(process.argv.slice(1).filter(arg => arg.startsWith('--')).map(arg => { const i = arg.indexOf('='); return i < 0 ? [arg.slice(2), true] : [arg.slice(2, i), arg.slice(i + 1)]; }));
for (const key of ['backend', 'model', 'output']) if (!args[key]) throw new Error(`Missing --${key}`);
if (!['worker', 'server', 'embedded'].includes(args.backend)) throw new Error('backend must be worker, server or embedded');
if (args.backend === 'worker' && !fs.existsSync(path.join(appRoot, 'src/backends/localWorker.js'))) throw new Error('The worker is retired. Set TRANZL_APP_ROOT to the saved pre-migration evaluation package to compare that baseline.');
for (const key of ['model', ...(args.backend !== 'worker' ? ['binary'] : []), ...(args.media ? ['projector'] : [])]) {
  if (typeof args[key] !== 'string' || !path.isAbsolute(args[key]) || !fs.statSync(args[key]).isFile()) throw new Error(`--${key} must be an absolute existing file path`);
}
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tranzl-evaluation-'));
app.setPath('userData', profile);
if (args.offline) {
  const originalFetch = global.fetch;
  global.fetch = (url, options) => {
    if (new URL(url).hostname !== '127.0.0.1') throw new Error('Evaluation forbids non-loopback network access');
    return originalFetch(url, options);
  };
}
app.on('window-all-closed', () => {});
const report = { date: new Date().toISOString(), backend: args.backend, platform: process.platform, arch: process.arch,
  os: os.release(), cpu: os.cpus()[0]?.model, ramBytes: os.totalmem(), electron: process.versions.electron,
  node: process.versions.node, contextSize: 8192, cases: [], memoryMethod: 'Peak summed RSS of harness and descendants sampled every 250 ms; shared pages may be counted twice; includes Electron overhead.' };
let engine, memoryTimer, peakRssKiB = 0, lastResult = null;
async function digest(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function sampleMemory() {
  if (process.platform === 'win32') return; // Native Windows sampler is a later portability task.
  try {
    const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8' }).trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
    const owned = new Set([process.pid]); let changed;
    do { changed = false; for (const [pid, parent] of rows) if (owned.has(parent) && !owned.has(pid)) { owned.add(pid); changed = true; } } while (changed);
    peakRssKiB = Math.max(peakRssKiB, rows.reduce((sum, [pid, , rss]) => sum + (owned.has(pid) ? rss : 0), 0));
  } catch { report.memoryUnavailable = true; }
}
async function check(name, run) {
  const started = performance.now(); lastResult = null;
  try { const details = await run(); report.cases.push({ name, passed: true, seconds: (performance.now() - started) / 1000, ...details }); console.log(`PASS ${name}`); }
  catch (error) { report.cases.push({ name, passed: false, seconds: (performance.now() - started) / 1000, error: error.message, observation: lastResult }); console.error(`FAIL ${name}: ${error.message}`); }
}
const defaultSystem = 'Answer accurately and briefly. Follow the requested format.';
async function ask(messages, extra = {}) {
  let text = '', thought = ''; const liveStats = [];
  const options = { messages, systemPrompt: defaultSystem, reasoning: false, maxTokens: 256,
    signal: AbortSignal.timeout(90000), onChunk: delta => text += delta, onThought: delta => thought += delta,
    onStats: stats => liveStats.push(stats), ...extra };
  const result = await engine.chat(options);
  assert.equal(text, result.translation, 'stream and final output must agree');
  lastResult = { ...result, thought, output: result.translation, liveStats };
  return lastResult;
}
const user = content => [{ role: 'user', content }];
app.whenReady().then(async () => {
  try {
    if (fs.existsSync(path.join(appRoot, 'evaluation-source.json'))) Object.assign(report, JSON.parse(fs.readFileSync(path.join(appRoot, 'evaluation-source.json'))));
    else {
      report.commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: appRoot, encoding: 'utf8' }).trim();
      report.dirtyFiles = execFileSync('git', ['status', '--porcelain'], { cwd: appRoot, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    }
    report.packaged = app.isPackaged;
    report.sourceHashes = {};
    report.sourceHashes['scripts/evaluate-runtime.cjs'] = await digest(__filename);
    for (const file of ['src/backends/serverRuntime.js', 'src/backends/localWorker.js', 'src/backends/local.js', 'src/backends/embeddedBackend.js', 'src/backends/embeddedAssets.js', 'src/backends/verifiedAssets.js']) {
      if (fs.existsSync(path.join(appRoot, file))) report.sourceHashes[file] = await digest(path.join(appRoot, file));
    }
    report.modelSha256 = await digest(args.model);
    if (args.binary) report.binarySha256 = await digest(args.binary);
    if (args.projector) report.projectorSha256 = await digest(args.projector);
    if (args.backend === 'embedded') {
      const local = appRequire('./src/backends/local');
      const assets = appRequire('./src/backends/embeddedAssets'), dir = path.join(profile, 'multimodal');
      fs.mkdirSync(dir, { recursive: true });
      if (!args['download-runtime']) fs.symlinkSync(path.dirname(args.binary), path.dirname(assets.paths(dir).binary), 'dir');
      if (args.projector) fs.symlinkSync(args.projector, assets.paths(dir).projector);
      engine = {
        load: async () => { await local.preload(args.model, status => { report.runtimeStatus = status; }); if (local.modelState().state !== 'ready') throw new Error(local.modelState().error || 'Preload failed'); },
        chat: options => local.chat({ ...options, modelPath: args.model }),
        countTokens: options => local.countTokens({ ...options, modelPath: args.model }), stop: local.release,
      };
    } else if (args.backend === 'worker') {
      const local = appRequire('./src/backends/local');
      engine = {
        load: () => new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Worker load timeout')), 120000);
          local.preload(args.model, status => { if (status.state === 'ready' || status.state === 'error') { clearTimeout(timer); report.runtimeStatus = status; status.state === 'ready' ? resolve() : reject(new Error(status.error)); } });
        }),
        chat: options => local.translate({ ...options, modelPath: args.model, history: options.messages.slice(0, -1), text: options.messages.at(-1).content }),
        countTokens: options => local.countTokens({ ...options, modelPath: args.model }), stop: local.release,
      };
    } else engine = createServerRuntime({ binary: args.binary, modelPath: args.model, projectorPath: args.projector,
      swaFullCache: !args['compact-cache'],
      onStatus: status => console.log(`Runtime ${status.state} (${status.media ? 'media' : 'text'})`) });
    memoryTimer = setInterval(sampleMemory, 250); sampleMemory();
    const started = performance.now(); await engine.load(); report.coldLoadSeconds = (performance.now() - started) / 1000;
    report.runtimeState = engine.state?.();
    await check('translation', async () => { const result = await ask(user('Translate into German: The blue bicycle is beside the garden gate. Output only the translation.')); assert.match(result.output, /Fahrrad/i); return result; });
    await check('editing', async () => { const result = await ask(user('Correct the grammar, output only the corrected sentence: She have three book.')); assert.match(result.output, /She has three books/i); return result; });
    for (let run = 1; run <= 3; run++) await check(`warm-${run}`, () => ask(user('Explain in about 100 words why leaves change color in autumn.')));
    await check('reasoning-on', async () => { const result = await ask(user('A shop sold 120 tickets. Adult tickets cost 15 euros and child tickets cost 9 euros. Total revenue was 1476 euros. Work out how many adult tickets were sold. Give the number as your final answer.'), { reasoning: true, maxTokens: 1024 }); assert.match(result.output, /66/); return { ...result, thoughtPresent: Boolean(result.thought.trim()) }; });
    await check('reasoning-off', async () => { const result = await ask(user('What is 17 times 19? Give the number.')); assert.match(result.output, /323/); assert.equal(result.thought, ''); return result; });
    await check('conversation-recall', async () => { const result = await ask([{ role: 'user', content: 'Remember my project code: ORCHID-729.' }, { role: 'assistant', content: 'I will remember ORCHID-729.' }, { role: 'user', content: 'What is my project code? Answer only the code.' }]); assert.match(result.output, /ORCHID-729/); return result; });
    await check('session-isolation', async () => { const result = await ask(user('What project code did I tell you? Say UNKNOWN if none is in this conversation.')); assert.doesNotMatch(result.output, /ORCHID-729/); assert.match(result.output, /UNKNOWN/i); return result; });
    await check('count-input', async () => { const tokens = await engine.countTokens({ messages: user('Hello world'), systemPrompt: defaultSystem, reasoning: false, signal: AbortSignal.timeout(10000) }); assert.ok(tokens > 0 && tokens < 100); return { tokens }; });
    await check('occupied-context', async () => {
      const result = await ask(user('Explain in about 100 words why the ocean looks blue.'));
      assert.equal(result.stats.contextEstimated, false); assert.ok(result.stats.contextTokens > 0 && result.stats.contextTokens <= result.stats.contextSize);
      assert.ok(result.liveStats.some(stats => stats.contextEstimated === false && stats.contextTokens > 0 && stats.outputTokens > 0));
      return result;
    });
    await check('cancel-and-recover', async () => {
      const abort = new AbortController(); let chunks = 0;
      await assert.rejects(engine.chat({ messages: user('Write a very long story about a rabbit.'), systemPrompt: defaultSystem, signal: abort.signal, maxTokens: 512, reasoning: false, onThought: () => {}, onChunk: () => { chunks++; abort.abort(); } }));
      assert.ok(chunks > 0);
      const result = await ask(user('What is 2 plus 2? Give only the number.')); assert.match(result.output, /4/); return result;
    });
    await check('cancel-during-thinking', async () => {
      const abort = new AbortController(); let thoughts = 0;
      const timeout = setTimeout(() => abort.abort(), 30000);
      try {
        await assert.rejects(engine.chat({ messages: user('A shop sold 120 tickets. Adult tickets cost 15 euros, child tickets 9 euros, and revenue was 1476 euros. How many adults bought tickets?'), systemPrompt: defaultSystem,
          signal: abort.signal, maxTokens: 1024, reasoning: true, onChunk: () => {}, onThought: () => { thoughts++; abort.abort(); } }));
        assert.ok(thoughts > 0);
      } finally { clearTimeout(timeout); }
      const result = await ask(user('What is 2 plus 2? Give only the number.')); assert.match(result.output, /4/); return result;
    });
    if (args.extended) await check('near-limit-compaction', async () => {
      const { prepareContext } = appRequire('./src/chatCompaction');
      const messages = user('<attached-file name="synthetic.txt">\n' + ('Project ORCHID-729 launches on Friday. The owner is Ada. Budget is 420 euros.\n'.repeat(400)) + '\n</attached-file>\nWhat is the project code, owner, launch day, and budget?');
      const original = JSON.stringify(messages), signal = AbortSignal.timeout(240000);
      const prepared = await prepareContext({ messages, contextSize: 8192, effort: 'fast', signal,
        count: (items, system) => engine.countTokens({ messages: items, systemPrompt: system || defaultSystem, reasoning: false, signal }),
        summarize: async (items, system, maxTokens) => (await ask(items, { systemPrompt: system, maxTokens, signal })).translation });
      assert.ok(prepared.compaction); assert.equal(JSON.stringify(messages), original);
      const result = await ask(prepared.messages, { signal });
      for (const value of [/ORCHID-729/, /Ada/, /Friday/, /420/]) assert.match(result.output, value);
      return { ...result, compaction: prepared.compaction };
    });
    sampleMemory(); report.textPeakRssKiB = peakRssKiB;
    if (args.media && args.backend !== 'worker') {
      await check('image-after-text', async () => {
        const { createCanvas } = appRequire('@napi-rs/canvas'); const canvas = createCanvas(200, 150), ctx = canvas.getContext('2d');
        ctx.fillStyle = '#0000ff'; ctx.fillRect(0, 0, 200, 150);
        const result = await ask([{ role: 'user', content: 'Name the color of this image. Answer with one word.', media: [{ kind: 'image', mime: 'image/png', data: canvas.toBuffer('image/png').toString('base64') }] }]);
        assert.match(result.output, /blue/i); return result;
      });
      await check('text-after-media', async () => { const result = await ask(user('Translate into German: Good morning.')); assert.match(result.output, /Guten Morgen/i); return result; });
      if (args.audio) await check('audio-transcription', async () => {
        const bytes = fs.readFileSync(args.audio);
        assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
        const result = await ask([{ role: 'user', content: 'Transcribe the spoken words. Output only the transcript.', media: [{ kind: 'audio', format: 'wav', mime: 'audio/wav', data: bytes.toString('base64') }] }], { reasoning: true, maxTokens: 512 });
        assert.match(result.output, /blue bicycle/i); assert.match(result.output, /garden gate/i); return result;
      });
    }
  } catch (error) { report.fatal = error.message; console.error(error); }
  finally {
    clearInterval(memoryTimer); sampleMemory(); report.peakRssKiB = peakRssKiB || null;
    try { await engine?.stop(); } catch (error) { report.shutdownError = error.message; }
    fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
    fs.writeFileSync(args.output, JSON.stringify(report, null, 2) + '\n');
    fs.rmSync(profile, { recursive: true, force: true });
    app.exit(report.fatal || report.shutdownError || report.cases.some(result => !result.passed) ? 1 : 0);
  }
});
