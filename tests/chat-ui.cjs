const appRoot = process.env.TRANZL_APP_ROOT || require('node:path').resolve(__dirname, '..');
const appRequire = require('node:module').createRequire(require('node:path').join(appRoot, 'package.json'));
// Run with: node_modules/.bin/electron tests/chat-ui.cjs
const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert/strict');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tranzl-ui-test-'));
app.setPath('userData', temp);
let saved = { sessions: [] }, lastRequest, lastTranslation, translationSender, holdResponse = false, releaseResponse, fileText = 'The launch is Friday.', cappedReply = false;
const reply = '# Local answers\n\nHere is **bold** and *italic* text.\n\n| Item | Result |\n| --- | --- |\n| Privacy | Local |\n\n```js\nconsole.log("hello");\n```\n\n> A quoted passage\n\n- First item\n- Second item\n\n<script>window.injected = true</script><img src=x onerror="window.injected=true">[unsafe](javascript:alert(1))';
const stats = { inputTokens: 1024, outputTokens: 256, cachedTokens: 768, tps: 42.5, contextTokens: 1280, contextSize: 8192, contextEstimated: true, elapsedSeconds: 6.2 };
const { createCanvas } = appRequire('@napi-rs/canvas');
const imageData = createCanvas(40, 30).toBuffer('image/png').toString('base64');
const audioBytes = Buffer.alloc(364); audioBytes.write('RIFF'); audioBytes.writeUInt32LE(356, 4); audioBytes.write('WAVEfmt ', 8); audioBytes.writeUInt32LE(16, 16); audioBytes.writeUInt16LE(1, 20); audioBytes.writeUInt16LE(1, 22); audioBytes.writeUInt32LE(16000, 24); audioBytes.writeUInt32LE(32000, 28); audioBytes.writeUInt16LE(2, 32); audioBytes.writeUInt16LE(16, 34); audioBytes.write('data', 36); audioBytes.writeUInt32LE(320, 40);
const handlers = {
  'clipboard-image': () => ({ file: { name: 'Pasted image.png', kind: 'image', mime: 'image/png', data: imageData, size: 100 } }),
  'cancel-translate': () => ({ ok: true }),
  'translate': (event, options) => { lastTranslation = options; translationSender = event.sender; return { ok: true, translation: 'Translated image text', model: options.model, stats }; },
  'chat-model-info': () => ({ contextSize: 8192 }),
  'get-setup': () => ({ backend: 'lmstudio', theme: 'dark', modelReady: false, modelLabel: 'Test model' }),
  'list-models': () => ({ ok: true, models: ['Local test model'] }),
  'history-load': () => ({ store: null, persistent: true }), 'history-save': () => ({ ok: true }),
  'chat-load': () => ({ ...saved, persistent: true }),
  'chat-save': (_e, data) => { saved = structuredClone(data); return { ok: true }; },
  'chat-attach': () => ({ files: [{ name: 'notes.md', content: fileText, size: 21 }, { name: 'image.png', kind: 'image', mime: 'image/png', data: imageData }, { name: 'voice.wav', kind: 'audio', mime: 'audio/wav', format: 'wav', data: audioBytes.toString('base64') }], errors: [] }),
  'chat-stop': () => {},
  'chat-send': async (event, options) => {
    lastRequest = options;
    const continuation = String(options.messages.at(-1)?.content || '').includes('Continue exactly where you stopped');
    const text = continuation ? ' And it continued.' : reply;
    const capped = cappedReply ? { outputCapped: 2048, stats: { ...stats, outputTokens: 2048 } } : {};
    if (holdResponse) {
      event.sender.send('chat-event', { requestId: options.requestId, type: 'chunk', delta: 'Reading the document…' });
      await new Promise(resolve => { releaseResponse = resolve; });
      return { ok: true, translation: text, model: options.model, stats, ...capped };
    }
    event.sender.send('chat-event', { requestId: options.requestId, type: 'thinking', delta: 'Considering your question…' });
    event.sender.send('chat-event', { requestId: options.requestId, type: 'chunk', delta: text });
    event.sender.send('chat-event', { requestId: options.requestId, type: 'done', translation: text, model: options.model, stats: capped.stats || stats, outputCapped: capped.outputCapped });
    return { ok: true, translation: text, model: options.model, stats: capped.stats || stats, ...capped };
  },
};
for (const [key, value] of Object.entries(handlers)) ipcMain.handle(key, value);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1100, height: 800, show: false, webPreferences: { preload: path.resolve(appRoot, 'src/preload.js'), contextIsolation: true, nodeIntegration: false } });
  const errors = [];
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => { if (level >= 3) errors.push(`${message} (${sourceId}:${line})`); });
  const run = code => win.webContents.executeJavaScript(code);
  async function waitFor(code) {
    for (let i = 0; i < 100; i++) { if (await run(code)) return; await new Promise(r => setTimeout(r, 20)); }
    throw new Error(`Timed out: ${code}`);
  }
  try {
    await win.loadFile(path.resolve(appRoot, 'src/renderer/index.html'));
    await waitFor(`!document.getElementById('chat-input').disabled`);
    assert.equal(await run(`document.querySelector('#tab-chat #chat-new') !== null && document.querySelector('#tab-chat #chat-clear') !== null`), true);
    await run(`document.querySelector('[data-tab="tab-chat"]').click(); document.getElementById('chat-attach').click()`);
    await waitFor(`document.querySelectorAll('#chat-attachments button').length === 3`);
    await waitFor(`document.querySelector('#chat-attachments img').naturalWidth === 40`);
    assert.equal(await run(`!!document.querySelector('#chat-attachments audio[controls]')`), true);
    await run(`document.querySelector('#chat-attachments img').click()`);
    assert.equal(await run(`document.querySelector('.attachment-preview-dialog').open`), true);
    await run(`document.querySelector('.attachment-preview-toolbar button').click()`);
    assert.equal(await run(`document.querySelector('.attachment-preview-viewport').classList.contains('actual-size')`), true);
    await run(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    assert.equal(await run(`document.querySelector('.attachment-preview-dialog').open`), false);
    await waitFor(`document.activeElement === document.querySelector('#chat-attachments img')`);
    assert.equal(await run(`document.getElementById('chat-new').offsetHeight === document.getElementById('chat-clear').offsetHeight && document.getElementById('chat-new').offsetHeight === document.getElementById('chat-effort').offsetHeight`), true);

    await run(`document.getElementById('chat-input').value='Summarize my file'; document.getElementById('chat-input').dispatchEvent(new Event('input')); document.getElementById('chat-send').click()`);
    await waitFor(`document.querySelectorAll('.chat-markdown table').length === 1 && document.getElementById('chat-stop').classList.contains('hidden')`);
    assert.equal(await run(`document.getElementById('chat-stat-speed').textContent`), '42.5 tok/s');
    assert.equal(await run(`document.getElementById('chat-context-percent').textContent`), '~16% of window');
    assert.equal(await run(`document.getElementById('chat-stat-cache').textContent`), '768');
    await run(`document.getElementById('chat-input').focus()`);
    assert.equal(await run(`getComputedStyle(document.getElementById('chat-input')).outlineStyle`), 'none');
    assert.match(lastRequest.messages[0].content, /The launch is Friday/);
    assert.equal(lastRequest.messages[0].media.length, 2);
    assert.equal(lastRequest.messages[0].media[0].data, imageData);
    assert.equal(await run(`!!document.querySelector('.chat-markdown pre code')`), true);
    assert.equal(await run(`!!document.querySelector('.chat-markdown script, .chat-markdown img, .chat-markdown a[href^="javascript:"]') || !!window.injected`), false);
    await run(`document.getElementById('chat-input').value='What day?'; document.getElementById('chat-input').dispatchEvent(new Event('input')); document.getElementById('chat-send').click()`);
    await waitFor(`document.querySelectorAll('.chat-message').length === 4 && document.getElementById('chat-stop').classList.contains('hidden')`);
    assert.equal(lastRequest.messages.length, 3);
    assert.equal(lastRequest.messages[0].media.length, 2);
    await run(`document.getElementById('chat-new').click(); document.getElementById('chat-input').value='A saved draft'; document.getElementById('chat-input').dispatchEvent(new Event('input'))`);
    await waitFor(`document.querySelectorAll('.chat-session').length === 2`);
    await new Promise(r => setTimeout(r, 350));
    win.webContents.reload(); await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
    await waitFor(`document.getElementById('chat-input').value === 'A saved draft'`);
    await run(`document.querySelector('[data-tab="tab-chat"]').click(); [...document.querySelectorAll('.chat-session-open')].find(b=>b.textContent.includes('Summarize')).click()`);
    await waitFor(`document.querySelectorAll('.chat-message').length === 4`);
    assert.equal(await run(`document.getElementById('chat-stat-speed').textContent`), '42.5 tok/s');
    await new Promise(r => setTimeout(r, 100));
    fs.writeFileSync('/tmp/tranzl-chat-ui.png', (await win.webContents.capturePage()).toPNG());
    win.setSize(720, 480); nativeTheme.themeSource = 'dark';
    await new Promise(r => setTimeout(r, 100));
    assert.equal(await run(`document.documentElement.scrollWidth <= innerWidth && document.getElementById('chat-input').getBoundingClientRect().bottom < innerHeight && document.getElementById('chat-messages').clientHeight > 0`), true);
    fs.writeFileSync('/tmp/tranzl-chat-compact.png', (await win.webContents.capturePage()).toPNG());
    await run(`window.confirm = () => true; document.querySelector('.chat-session.selected .chat-session-delete').click()`);
    assert.equal(await run(`document.querySelectorAll('.chat-session').length`), 1);
    await run(`document.getElementById('chat-clear').click()`);
    await waitFor(`document.querySelectorAll('.chat-message').length === 0`);
    assert.equal(saved.sessions.length, 1); assert.equal(saved.sessions[0].title, 'New chat');
    // Clipboard image paste in Chat attaches without changing the typed message.
    await run(`document.getElementById('chat-input').value='Discuss this'; document.getElementById('chat-input').dispatchEvent(new Event('input')); var pasteTestData = new DataTransfer(); pasteTestData.items.add(new File(['image'], 'paste.png', { type: 'image/png' })); document.getElementById('chat-input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: pasteTestData, bubbles: true, cancelable: true }));`);
    await waitFor(`document.querySelectorAll('#chat-attachments img').length === 1`);
    assert.equal(await run(`document.getElementById('chat-input').value`), 'Discuss this');
    await run(`document.getElementById('chat-send').click()`);
    await waitFor(`document.querySelectorAll('.chat-message').length === 2 && document.getElementById('chat-stop').classList.contains('hidden')`);
    assert.equal(lastRequest.messages[0].media[0].name, 'Pasted image.png');
    // The same paste in Translate triggers OCR/translation with image-only input.
    await run(`document.querySelector('[data-tab="tab-translate"]').click(); var pasteTestData = new DataTransfer(); pasteTestData.items.add(new File(['image'], 'paste.png', { type: 'image/png' })); document.getElementById('source').dispatchEvent(new ClipboardEvent('paste', { clipboardData: pasteTestData, bubbles: true, cancelable: true }));`);
    await waitFor(`document.getElementById('output').value === 'Translated image text'`);
    assert.equal(lastTranslation.text, ''); assert.equal(lastTranslation.images.length, 1);
    await run(`document.querySelector('#translation-images img').click()`);
    assert.equal(await run(`document.querySelector('.attachment-preview-dialog').open`), true);
    await run(`document.querySelector('.attachment-preview-dialog').close()`);

    await run(`document.getElementById('target-language').value='German'; document.getElementById('target-language').dispatchEvent(new Event('change'))`);
    await waitFor(`document.getElementById('output').value === 'Translated image text'`);
    assert.equal(lastTranslation.targetLanguage, 'German'); assert.equal(lastTranslation.images.length, 1);
    const oldId = lastTranslation.requestId;
    await run(`document.getElementById('clear-btn').click()`);
    translationSender.send('translation-event', { requestId: oldId, type: 'chunk', delta: 'STALE' });
    await new Promise(r => setTimeout(r, 30));
    assert.equal(await run(`document.getElementById('output').value`), '');
    assert.equal(await run(`document.querySelectorAll('#translation-images img').length`), 0);
    await run(`var pasteTestData = new DataTransfer(); pasteTestData.setData('text/plain', 'Normal text'); document.getElementById('source').dispatchEvent(new ClipboardEvent('paste', { clipboardData: pasteTestData, bubbles: true })); document.getElementById('source').value='Normal text'; document.getElementById('source').dispatchEvent(new Event('input'));`);
    await waitFor(`document.getElementById('output').value === 'Translated image text'`);
    assert.equal(lastTranslation.text, 'Normal text'); assert.equal(lastTranslation.images.length, 0);
    // A long PDF's character estimate must not masquerade as occupied context.
    fileText = 'PDF extracted text '.repeat(2500); holdResponse = true;
    await run(`document.querySelector('[data-tab="tab-chat"]').click(); document.getElementById('chat-new').click(); document.getElementById('chat-attach').click()`);
    await waitFor(`document.querySelectorAll('#chat-attachments button').length === 3`);
    await run(`document.getElementById('chat-input').value='Summarize the PDF'; document.getElementById('chat-input').dispatchEvent(new Event('input')); document.getElementById('chat-send').click()`);
    await waitFor(`!document.getElementById('chat-stop').classList.contains('hidden')`);
    assert.equal(await run(`document.body.classList.contains('chat-working')`), true);
    // The brand gradient animates even with macOS Reduce Motion enabled.
    assert.equal(await run(`getComputedStyle(document.querySelector('.brand')).animationName`), 'brand-flow');
    assert.equal(await run(`document.getElementById('chat-context-percent').textContent`), 'Context');
    assert.match(await run(`document.getElementById('chat-context-detail').textContent`), /usage not reported/);
    win.webContents.send('chat-event', { requestId: lastRequest.requestId, type: 'stats', stats: { inputTokens: 9000, outputTokens: 400, contextTokens: 6000, contextSize: 8192, contextEstimated: false, inputLabel: 'Evaluated input', tps: 60 } });
    await waitFor(`document.getElementById('chat-context-percent').textContent === '73% context'`);
    // At 73% the ring stroke is part-way through its accent-to-red blend.
    assert.equal(await run(`document.getElementById('chat-context-ring').getContext('2d').strokeStyle`), await run(`(() => {
      const css = getComputedStyle(document.documentElement);
      const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
      const a = hex(css.getPropertyValue('--accent').trim()), b = hex(css.getPropertyValue('--error').trim()), t = (6000 / 8192 * 100 - 50) / 40;
      return '#' + a.map((v, i) => Math.round(v + (b[i] - v) * t).toString(16).padStart(2, '0')).join('');
    })()`));
    assert.equal(await run(`document.getElementById('chat-stat-input').textContent`), '9,000');
    assert.equal(await run(`document.getElementById('chat-stats-kind').textContent`), '· live');
    // Compaction streams incremental progress as a bar in the message status line.
    win.webContents.send('chat-event', { requestId: lastRequest.requestId, type: 'status', status: 'Compacting context · reading part 1…', progress: 0.2 });
    await waitFor(`!!document.querySelector('.chat-progress-fill')`);
    assert.match(await run(`document.querySelector('.chat-message-status').textContent`), /20% · Compacting context/);
    assert.equal(await run(`document.querySelector('.chat-progress-fill').style.width`), '20%');
    win.webContents.send('chat-event', { requestId: lastRequest.requestId, type: 'status', status: 'Compacting context · reading part 2…', progress: 0.65 });
    await waitFor(`document.querySelector('.chat-progress-fill').style.width === '65%'`);
    assert.equal(await run(`document.getElementById('status').textContent.includes('Compacting')`), true);
    // The bar disappears once generation resumes.
    win.webContents.send('chat-event', { requestId: lastRequest.requestId, type: 'chunk', delta: 'Back to generating' });
    await waitFor(`!document.querySelector('.chat-progress-fill')`);
    // A token arriving between mouse-down and mouse-up must not eat the click.
    win.setSize(1100, 800); win.show(); win.focus();
    const thinkingEvent = { requestId: lastRequest.requestId, type: 'thinking', delta: 'First thought. ' };
    win.webContents.send('chat-event', thinkingEvent);
    await waitFor(`!!document.querySelector('details[data-message] summary')`);
    await run(`document.querySelector('details[data-message] summary').scrollIntoView({ block: 'center' })`);
    const point = await run(`(() => { const r = document.querySelector('details[data-message] summary').getBoundingClientRect(); return { x: Math.round(r.x + 20), y: Math.round(r.y + r.height / 2) }; })()`);
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    win.webContents.send('chat-event', { ...thinkingEvent, delta: 'Second thought. ' });
    await waitFor(`document.querySelector('.chat-thought').textContent.includes('Second thought')`);
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
    await waitFor(`document.querySelector('details[data-message]').open`);
    win.webContents.send('chat-event', { ...thinkingEvent, delta: 'Third thought.' });
    await waitFor(`document.querySelector('.chat-thought').textContent.includes('Third thought')`);
    assert.equal(await run(`document.querySelector('details[data-message]').open`), true);

    win.webContents.send('chat-event', { requestId: lastRequest.requestId, type: 'compacted', context: {
      messages: [{ role: 'user', content: 'Compact memory: the launch is Friday.' }], beforeTokens: 13000, afterTokens: 3000, contextSize: 8192, at: Date.now()
    } });
    await waitFor(`document.getElementById('chat-compaction').textContent.includes('13,000')`);
    releaseResponse();
    await waitFor(`document.getElementById('chat-stop').classList.contains('hidden')`);
    assert.equal(await run(`document.body.classList.contains('chat-working')`), false);
    assert.ok(saved.sessions.find(s => s.context)?.messages.some(m => m.attachments?.some(f => f.content.length > 40000)));
    holdResponse = false;
    await win.reload(); await waitFor(`!document.getElementById('chat-input').disabled`);
    await run(`document.querySelector('[data-tab="tab-chat"]').click(); document.getElementById('chat-input').value='What day again?'; document.getElementById('chat-input').dispatchEvent(new Event('input')); document.getElementById('chat-send').click()`);
    await waitFor(`document.getElementById('chat-stop').classList.contains('hidden')`);
    assert.equal(lastRequest.messages[0].content, 'Compact memory: the launch is Friday.');
    assert.equal(lastRequest.messages.at(-1).content, 'What day again?');
    assert.ok(lastRequest.messages.every(m => m.content.length < 40000));

    // Output-limit detection: a capped reply shows a notice and a Continue
    // button; continuing streams into the same bubble without a visible
    // user turn, and the button disappears once the reply completes.
    cappedReply = true;
    await run(`document.querySelector('[data-tab="tab-chat"]').click(); document.getElementById('chat-new').click(); document.getElementById('chat-input').value='Write a long story'; document.getElementById('chat-input').dispatchEvent(new Event('input')); document.getElementById('chat-send').click()`);
    await waitFor(`document.querySelectorAll('.chat-message').length === 2 && document.getElementById('chat-stop').classList.contains('hidden')`);
    await waitFor(`!!document.querySelector('.chat-continue button')`);
    assert.match(await run(`document.querySelector('.chat-message-status').textContent`), /2,048-token output limit/);
    assert.equal(await run(`document.querySelector('.chat-continue button').disabled`), false);
    // Live context stats keep updating during a continuation, even though the
    // bubble already carries stats from the capped turn.
    holdResponse = true; cappedReply = false;
    await run(`document.querySelector('.chat-continue button').click()`);
    await waitFor(`document.getElementById('chat-stop') && !document.getElementById('chat-stop').classList.contains('hidden')`);
    win.webContents.send('chat-event', { requestId: lastRequest.requestId, type: 'stats', stats: { inputTokens: 7777, outputTokens: 12, tps: 55, contextTokens: 7789, contextSize: 8192, contextEstimated: false, inputLabel: 'Evaluated input' } });
    await waitFor(`document.getElementById('chat-stat-input').textContent === '7,777'`);
    assert.equal(await run(`document.getElementById('chat-context-percent').textContent`), '95% context');
    releaseResponse(); holdResponse = false;
    await waitFor(`!document.querySelector('.chat-continue')`);
    await waitFor(`document.getElementById('chat-stat-input').textContent === '1,024'`);
    assert.match(await run(`[...document.querySelectorAll('.chat-message')].at(-1).querySelector('.chat-markdown').textContent`), /And it continued/);
    assert.equal(lastRequest.messages.at(-2).role, 'assistant');
    assert.match(await run(`[...document.querySelectorAll('.chat-message')].at(-1).querySelector('.chat-markdown').textContent`), /And it continued/);
    assert.equal(lastRequest.messages.at(-2).role, 'assistant');
    assert.match(lastRequest.messages.at(-1).content, /Continue exactly where you stopped/);
    assert.equal(lastRequest.messages.filter(m => m.role === 'user').length, 2);
    assert.ok(saved.sessions.find(s => s.messages.some(m => m.capped === null || m.capped == null)));

    assert.deepEqual(errors, []);
    console.log('PASS: chat UI, attachments, Markdown sanitization, multi-turn context, drafts, reload, delete and clear. Screenshot: /tmp/tranzl-chat-ui.png');
    app.exit(0);
  } catch (err) { console.error(err); console.error(errors); console.error(await run(`document.getElementById('chat-view').innerHTML`)); app.exit(1); }
}).finally(() => {});
app.on('will-quit', () => fs.rmSync(temp, { recursive: true, force: true }));
