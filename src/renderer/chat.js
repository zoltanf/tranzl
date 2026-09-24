(() => {
  const el = id => document.getElementById(`chat-${id}`);
  let modelInfo = {}, infoSeq = 0, attaching = false;
  let sessions = [], activeId = null, running = null, ready = false, saveTimer;
  const current = () => sessions.find(s => s.id === activeId);
  const notice = text => { el('notice').textContent = text || ''; };
  // Errors stay in the chat view and also surface in the app-wide status bar.
  const fail = text => { notice(text); if (text) window.tranzlStatus?.(text.replace(/\n+/g, ' · '), 'error'); };
  const clearStatus = () => window.tranzlStatus?.('', '');
  const makeSession = () => ({ id: crypto.randomUUID(), title: 'New chat', updated: Date.now(), messages: [], draft: '', attachments: [], effort: 'balanced' });
  function persist(immediate = false) {
    clearTimeout(saveTimer);
    const save = async () => {
      if (!ready) return;
      try {
        const result = await window.tranzl.chatSave({ sessions, activeId });
        if (!result.ok) fail(result.error || 'Could not save chats.');
      } catch (err) { fail(`Could not save chats: ${err.message}`); }
    };
    if (immediate) save(); else saveTimer = setTimeout(save, 250);
  }
  function newChat() {
    if (!ready) return;
    const session = makeSession(); sessions.unshift(session); activeId = session.id;
    render(); persist(true); el('input').focus();
  }
  function renderSessions() {
    el('sessions').replaceChildren();
    const query = el('search').value.toLowerCase();
    el('count').textContent = sessions.length;
    for (const session of [...sessions].sort((a, b) => b.updated - a.updated)) {
      if (!`${session.title} ${session.messages.map(m => m.content).join(' ')}`.toLowerCase().includes(query)) continue;
      const row = document.createElement('div'); row.className = `chat-session${session.id === activeId ? ' selected' : ''}`;
      const open = document.createElement('button'); open.className = 'chat-session-open';
      open.setAttribute('aria-current', session.id === activeId ? 'true' : 'false');
      const title = document.createElement('strong'); title.textContent = session.title;
      const meta = document.createElement('span'); meta.textContent = `${session.messages.length} messages · ${new Date(session.updated).toLocaleDateString()}`;
      open.append(title, meta); open.onclick = () => { activeId = session.id; render(); persist(true); };
      const remove = document.createElement('button'); remove.className = 'chat-session-delete'; remove.textContent = '×'; remove.title = `Delete ${session.title}`; remove.setAttribute('aria-label', remove.title);
      remove.onclick = () => {
        if (!confirm(`Delete “${session.title}”? This cannot be undone.`)) return;
        if (running?.sessionId === session.id) { window.tranzl.chatStop(); running = null; }
        sessions = sessions.filter(s => s.id !== session.id);
        if (activeId === session.id) activeId = sessions[0]?.id;
        if (!sessions.length) { const fresh = makeSession(); sessions.push(fresh); activeId = fresh.id; }
        render(); persist(true);
      };
      row.append(open, remove); el('sessions').append(row);
    }
  }
  function markdown(text) {
    const fragment = DOMPurify.sanitize(marked.parse(text || '', { gfm: true, breaks: true }), {
      RETURN_DOM_FRAGMENT: true, FORBID_TAGS: ['img', 'style', 'form', 'video', 'audio', 'iframe'], FORBID_ATTR: ['style'],
    });
    for (const input of fragment.querySelectorAll('input')) {
      if (input.type !== 'checkbox') input.remove(); else input.disabled = true;
    }
    for (const link of fragment.querySelectorAll('a')) {
      if (!/^https:\/\//i.test(link.getAttribute('href') || '')) link.removeAttribute('href');
      else { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
    }
    return fragment;
  }
  const number = value => Number.isFinite(value) ? Math.round(value).toLocaleString() : '—';
  // Blend two hex colors; the context ring fades from accent toward red as the window fills.
  const mixColor = (from, to, t) => { const a = [1, 3, 5].map(i => parseInt(from.slice(i, i + 2), 16)), b = [1, 3, 5].map(i => parseInt(to.slice(i, i + 2), 16)); return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(', ')})`; };
  function responseStats(message) {
    // While a continuation is streaming into a bubble that already carries
    // stats from its capped turn, live telemetry wins over the saved stats.
    if (running && running.answer === message && running.continuing && running.stats) return running.stats;
    if (message?.stats) return message.stats;
    if (!message || running?.answer !== message) return null;
    if (running.stats) return running.stats;
    const outputTokens = Math.ceil((message.content.length + message.thinking.length) / 4);
    const seconds = (Date.now() - (running.firstTokenAt || Date.now())) / 1000;
    return { inputTokens: running.inputTokens, outputTokens, contextTokens: null,
      contextSize: running.contextSize, contextEstimated: true, estimated: true,
      tps: seconds > 0 && outputTokens > 1 ? outputTokens / seconds : null };
  }
  function renderStats() {
    const message = [...(current()?.messages || [])].reverse().find(m => m.role === 'assistant');
    const stats = responseStats(message);
    const approx = stats?.estimated ? '~' : '';
    const metric = value => Number.isFinite(value) ? approx + number(value) : '—';
    el('stat-input').textContent = metric(stats?.inputTokens);
    el('stat-input-label').textContent = stats?.inputLabel || 'Input tokens';
    el('stat-output').textContent = metric(stats?.outputTokens);
    el('stat-speed').textContent = Number.isFinite(stats?.tps) ? `${approx}${stats.tps.toFixed(1)} tok/s` : '—';
    el('stat-cache').textContent = Number.isFinite(stats?.cachedTokens) ? number(stats.cachedTokens) : 'Not reported';
    el('stat-cache').title = 'Prompt tokens reused from cache. Unavailable counts are not treated as zero.';
    el('stats-kind').textContent = running?.answer === message ? (stats?.estimated ? '· live estimate' : '· live') : stats?.estimated ? '· estimated' : '';
    el('stat-timing').textContent = [Number.isFinite(stats?.elapsedSeconds) ? `${stats.elapsedSeconds.toFixed(1)}s total` : '', Number.isFinite(stats?.firstTokenSeconds) ? `${stats.firstTokenSeconds.toFixed(2)}s to first token` : ''].filter(Boolean).join(' · ');
    const capacity = stats?.contextSize ?? (!message ? modelInfo.contextSize : null);
    const used = stats?.contextTokens;
    const known = Number.isFinite(used) && capacity > 0;
    const percent = known ? used / capacity * 100 : null;
    const overWindow = known && stats.contextEstimated && used > capacity;
    el('context-percent').textContent = known ? overWindow ? 'Over window (estimate)' : `${stats.contextEstimated ? '~' : ''}${Math.round(percent)}% ${stats.contextEstimated ? 'of window' : 'context'}` : 'Context';
    el('context-detail').textContent = known ? overWindow ? `~${number(used)} processed · ${number(capacity)} capacity` : `${stats.contextEstimated ? '~' : ''}${number(used)} / ${number(capacity)} tokens` : capacity > 0 ? `${number(capacity)} capacity · usage not reported` : Number.isFinite(used) ? `~${number(used)} tokens · capacity unknown` : 'Usage not yet available';
    const description = known ? `${el('context-percent').textContent}, ${el('context-detail').textContent}. ${stats.contextEstimated ? 'Input plus output tokens, not measured context occupancy. This includes extracted PDF/document text; the backend may shift or truncate context.' : 'Actual occupied model context.'}` : `${el('context-detail').textContent}. Live character-based token estimates do not measure the active context and exclude image/audio token costs.`;
    const canvas = el('context-ring'); canvas.setAttribute('aria-label', description); canvas.title = description;
    const ctx = canvas.getContext('2d'), css = getComputedStyle(document.documentElement);
    ctx.clearRect(0, 0, 104, 104); ctx.lineWidth = 9;
    ctx.strokeStyle = css.getPropertyValue('--border').trim(); ctx.beginPath(); ctx.arc(52, 52, 40, 0, Math.PI * 2); ctx.stroke();
    if (known && percent > 0) {
      // Accent up to half the window, then blend toward red, reaching it at 90%.
      const blend = Math.min(1, Math.max(0, (percent - 50) / 40));
      ctx.strokeStyle = mixColor(css.getPropertyValue('--accent').trim(), css.getPropertyValue('--error').trim(), blend);
      ctx.lineCap = 'round'; ctx.beginPath(); ctx.arc(52, 52, 40, -Math.PI / 2, -Math.PI / 2 + Math.min(100, percent) / 100 * Math.PI * 2); ctx.stroke();
    }
  }
  async function refreshModelInfo() {
    const seq = ++infoSeq;
    try { const info = await window.tranzl.chatModelInfo(document.getElementById('model-select').value); if (seq === infoSeq) { modelInfo = info; renderStats(); } } catch { if (seq === infoSeq) { modelInfo = {}; renderStats(); } }
  }
  // Streaming status line; during compaction it becomes a progress bar with a percentage.
  function buildStatus(message) {
    const node = document.createElement('div'); node.className = 'chat-muted chat-message-status';
    if (message.progress != null) {
      const pct = Math.round(Math.min(1, Math.max(0, message.progress)) * 100);
      const track = document.createElement('span'); track.className = 'chat-progress';
      const fill = document.createElement('span'); fill.className = 'chat-progress-fill';
      fill.style.width = `${pct}%`;
      track.append(fill);
      node.append(track, document.createTextNode(`${pct}% · ${message.status}`));
      node.title = 'Share of the oversized context summarized so far. The full conversation and original attachments remain saved.';
    } else if (message.capped) node.textContent = `Reached the ${number(message.capped)}-token output limit for this window.`;
    else node.textContent = message.status || '';
    return node;
  }
  function renderMessages() {
    const box = el('messages');
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    // Keep disclosure nodes stable while tokens stream so pointer-down/up
    // reach the same summary and expanded traces retain their scroll position.
    const thoughts = new Map([...box.querySelectorAll('details[data-message]')].map(d => [d.dataset.message, d]));
    const scroll = box.scrollTop;
    box.replaceChildren();
    const session = current();
    if (!session?.messages.length) {
      const empty = document.createElement('div'); empty.className = 'chat-empty';
      const heading = document.createElement('h2'); heading.textContent = 'What would you like to explore?';
      const description = document.createElement('p'); description.textContent = 'Ask a question, work through an idea, or bring a file into the conversation.';
      empty.append(heading, description); box.append(empty);
    }
    for (let index = 0; index < (session?.messages || []).length; index++) {
      const message = session.messages[index];
      const article = document.createElement('article'); article.className = `chat-message ${message.role}`; article.dataset.message = message.id;
      const header = document.createElement('div'); header.className = 'chat-message-header';
      const label = document.createElement('strong'); label.textContent = message.role === 'user' ? 'You' : (message.model || 'Assistant');
      const copy = document.createElement('button'); copy.className = 'ghost'; copy.textContent = 'Copy';
      copy.onclick = async () => { try { await navigator.clipboard.writeText(message.content); copy.textContent = 'Copied'; } catch { fail('Could not copy to clipboard.'); } };
      header.append(label, copy); article.append(header);
      if (message.thinking) {
        let details = thoughts.get(message.id);
        if (!details) {
          details = document.createElement('details'); details.dataset.message = message.id;
          const summary = document.createElement('summary'); summary.textContent = 'Thinking';
          const thought = document.createElement('div'); thought.className = 'chat-thought';
          details.append(summary, thought);
        }
        const thought = details.querySelector('.chat-thought');
        if (thought.textContent !== message.thinking) thought.textContent = message.thinking;
        article.append(details);
      }
      const content = document.createElement('div'); content.className = 'chat-markdown';
      if (message.role === 'assistant') content.append(markdown(message.content));
      else { content.classList.add('chat-user-text'); content.textContent = message.content; }
      article.append(content);
      for (const attachment of message.attachments || []) {
        const file = document.createElement('span'); file.className = 'chat-file'; file.textContent = `▤ ${attachment.name}`; file.title = attachment.summary || ''; article.append(file);
        appendPreview(article, attachment);
      }
      if (message.stats) {
        const metrics = document.createElement('div'); metrics.className = 'chat-response-stats';
        const stats = message.stats, prefix = stats.estimated ? '~' : '';
        metrics.textContent = `${prefix}${number(stats.inputTokens)} in · ${prefix}${number(stats.outputTokens)} out${Number.isFinite(stats.tps) ? ` · ${prefix}${stats.tps.toFixed(1)} tok/s` : ''}${Number.isFinite(stats.cachedTokens) ? ` · ${number(stats.cachedTokens)} cached` : ''}`;
        article.append(metrics);
      }
      if (message.status || message.capped) article.append(buildStatus(message));
      appendContinue(article, message, index === session.messages.length - 1);
      box.append(article);
    }
    box.scrollTop = atBottom ? box.scrollHeight : scroll;
    renderStats();
  }
  function updateStreamingMessage(message) {
    const box = el('messages');
    const article = [...box.children].find(node => node.dataset.message === message.id);
    if (!article) { renderMessages(); return; }
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    const content = article.querySelector('.chat-markdown');
    if (content.dataset.source !== message.content) {
      content.replaceChildren(markdown(message.content));
      content.dataset.source = message.content;
    }
    if (message.thinking) {
      let details = article.querySelector('details[data-message]');
      if (!details) {
        details = document.createElement('details'); details.dataset.message = message.id;
        const summary = document.createElement('summary'); summary.textContent = 'Thinking';
        const thought = document.createElement('div'); thought.className = 'chat-thought';
        details.append(summary, thought); content.before(details);
      }
      const thought = details.querySelector('.chat-thought');
      if (thought.textContent !== message.thinking) thought.textContent = message.thinking;
    }
    const status = article.querySelector('.chat-message-status');
    if (status) status.replaceWith(buildStatus(message));
    else if (message.capped) article.append(buildStatus(message));
    appendContinue(article, message);
    renderStats();
    if (atBottom) box.scrollTop = box.scrollHeight;
  }
  function appendPreview(container, file) {
    if (file.content && ['document', 'text'].includes(file.kind)) {
      const details = document.createElement('details'); details.className = 'chat-document-preview';
      const summary = document.createElement('summary'); summary.textContent = file.summary || 'Extracted text';
      const preview = document.createElement('pre'); preview.textContent = file.content; details.append(summary, preview); container.append(details);
    }
    for (const image of file.images || []) appendPreview(container, { ...image, kind: 'image' });
    if (file.kind === 'image' && /^image\/(jpeg|png|webp)$/.test(file.mime)) {
      const img = document.createElement('img'); img.className = 'chat-image-preview'; img.alt = file.name;
      img.src = `data:${file.mime};base64,${file.data}`; window.attachmentPreview.enable(img); container.append(img);
    } else if (file.kind === 'audio' && /^audio\/(wav|mpeg|flac)$/.test(file.mime)) {
      const audio = document.createElement('audio'); audio.controls = true; audio.preload = 'none';
      audio.className = 'chat-audio-preview'; audio.setAttribute('aria-label', file.name);
      audio.src = `data:${file.mime};base64,${file.data}`; container.append(audio);
    }
  }
  function renderAttachments() {
    el('attachments').replaceChildren();
    (current()?.attachments || []).forEach((file, index) => {
      const button = document.createElement('button'); button.className = 'ghost'; button.textContent = `${file.name} ×`; button.title = `Remove ${file.name}${file.summary ? ` · ${file.summary}` : ''}`;
      button.onclick = () => { current().attachments.splice(index, 1); renderAttachments(); controls(); persist(true); };
      const item = document.createElement('div'); item.className = 'chat-attachment-item';
      appendPreview(item, file); item.append(button); el('attachments').append(item);
    });
  }
  function controls() {
    document.body.classList.toggle('chat-working', !!running);
    el('send').disabled = !ready || attaching || !!running || !(el('input').value.trim() || current()?.attachments.length);
    el('stop').classList.toggle('hidden', !running);
    el('attach').disabled = !ready || attaching;
    el('attach').textContent = attaching ? 'Reading files…' : '＋ Attach files';
    el('input').disabled = !ready;
    el('new').disabled = !ready;
    el('clear').disabled = !ready;
    el('model').textContent = document.getElementById('model-select').value || 'Select a model in Settings';
  }
  function renderContextNotice() {
    const context = current()?.context;
    const node = el('compaction');
    node.textContent = context ? `Context compacted · ${context.estimated ? '~' : ''}${number(context.beforeTokens)} → ${context.estimated ? '~' : ''}${number(context.afterTokens)} tokens · originals saved` : '';
    node.title = context ? 'Older messages or attachments were summarized for the model. The full conversation and original attachments remain saved. Summaries may omit details.' : '';
  }
  function saveContext(context) {
    if (!running) return;
    const session = sessions.find(s => s.id === running.sessionId);
    if (!session) return;
    session.context = { ...context, throughId: running.userId };
    renderContextNotice(); persist(true);
  }
  function render() {
    const session = current(); el('title').textContent = session?.title || 'New chat';
    el('input').value = session?.draft || ''; el('effort').value = session?.effort || 'balanced';
    renderSessions(); renderMessages(); renderAttachments(); controls(); renderContextNotice();
  }
  const fileContent = message => message.content + (message.attachments || []).filter(f => f.content).map(f => `\n\n<attached-file name=${JSON.stringify(f.name)}>\n${f.content}\n</attached-file>`).join('');
  const fileMedia = message => (message.attachments || []).flatMap(f =>
    f.kind === 'image' || f.kind === 'audio' ? [{ name: f.name, kind: f.kind, mime: f.mime, format: f.format, data: f.data }] : (f.images || []).map(image => ({ name: `${f.name} — ${image.name}`, kind: 'image', mime: image.mime, data: image.data })));
  // Resume a reply that hit the output-token limit: the transcript is replayed
  // up to the truncated answer plus a synthetic instruction turn (kept out of
  // the visible history), and the continuation streams into the same bubble.
  async function continueAnswer(message) {
    if (!ready || running || attaching) return;
    const session = current();
    const index = session.messages.indexOf(message);
    if (index === -1 || index !== session.messages.length - 1 || !message.capped) return;
    const context = session.context;
    const boundary = context ? session.messages.findIndex(m => m.id === context.throughId) : -1;
    const recent = session.messages.slice(Math.max(boundary + 1, 0), index + 1).filter(m => m.content && m.status !== 'Failed');
    const messages = [...(boundary >= 0 ? context.messages : []), ...recent.map(m => ({ role: m.role, content: fileContent(m), media: fileMedia(m) })),
      { role: 'user', content: 'Continue exactly where you stopped. Do not repeat earlier output and do not comment; just continue.' }];
    message.capped = null; message.status = 'Generating…';
    const requestId = crypto.randomUUID();
    // IPC events and the invoke response can arrive in any order, so the
    // continuation is always rebuilt from the pre-continuation content
    // instead of appended to, keeping every delivery order idempotent.
    const contentBase = message.content;
    running = { requestId, sessionId: session.id, answer: message, continuing: true, contentBase, buffer: '' };
    notice(''); clearStatus(); renderMessages(); controls(); persist(true);
    el('messages').scrollTop = el('messages').scrollHeight;
    try {
      const result = await window.tranzl.chatSend({ requestId, messages, model: message.model, effort: session.effort });
      if (running?.requestId !== requestId) return;
      if (result.ok && typeof result.translation === 'string') message.content = contentBase + result.translation;
      if (result.model) message.model = result.model;
      if (result.stats) message.stats = result.stats;
      message.capped = result.outputCapped || null;
      if (result.ok) notice('');
      message.status = result.aborted ? 'Stopped' : result.ok ? '' : 'Failed';
      if (result.error) fail(result.error);
    } catch (err) { message.status = 'Failed'; fail(err.message); }
    finally {
      if (running?.requestId === requestId) running = null;
      renderMessages(); renderSessions(); controls(); persist(true);
    }
  }
  function appendContinue(article, message, isLast = true) {
    article.querySelector('.chat-continue')?.remove();
    if (!message.capped || message.role !== 'assistant' || !isLast) return;
    const row = document.createElement('div'); row.className = 'chat-continue';
    const button = document.createElement('button'); button.className = 'ghost';
    button.textContent = 'Continue'; button.disabled = !!running;
    button.title = `The reply reached the ${number(message.capped)}-token output limit for this window. Continue generating from where it stopped.`;
    button.onclick = () => continueAnswer(message);
    row.append(button); article.append(row);
  }
  async function send() {
    if (!ready || running || attaching) return;
    const session = current(), text = el('input').value.trim();
    if (!text && !session.attachments.length) return;
    const user = { id: crypto.randomUUID(), role: 'user', content: text || 'Please review the attached files.', attachments: session.attachments };
    const boundary = session.context ? session.messages.findIndex(m => m.id === session.context.throughId) : -1;
    const recent = session.messages.slice(boundary + 1).filter(m => m.content && m.status !== 'Failed');
    const messages = [...(boundary >= 0 ? session.context.messages : []), ...[...recent, user].map(m => ({ role: m.role, content: fileContent(m), media: fileMedia(m) }))];
    if (messages.reduce((n, m) => n + m.content.length, 0) > 200000) { fail('This conversation is too large. Start a new chat or remove attachments.'); return; }
    const media = messages.flatMap(m => m.media || []);
    if (media.filter(f => f.kind === 'image').length > 12 || media.filter(f => f.kind === 'audio').length > 2 || media.reduce((n, f) => n + f.data.length * 3 / 4, 0) > 40 * 1024 * 1024) {
      fail('A conversation supports up to 12 images/scanned pages, 2 audio clips and 40 MB of media. Start a new chat or remove attachments.'); return;
    }
    session.messages.push(user); session.attachments = []; session.draft = ''; session.updated = Date.now();
    if (session.title === 'New chat') session.title = (text || user.attachments[0].name).slice(0, 70);
    const answer = { id: crypto.randomUUID(), role: 'assistant', content: '', thinking: '', status: 'Generating…', model: document.getElementById('model-select').value };
    session.messages.push(answer);
    const requestId = crypto.randomUUID(); running = { requestId, sessionId: session.id, userId: user.id, answer, contextSize: modelInfo.contextSize, inputTokens: Math.ceil(messages.reduce((n, m) => n + m.content.length, 256) / 4) };
    notice(''); clearStatus(); render(); persist(true); el('messages').scrollTop = el('messages').scrollHeight;
    try {
      const result = await window.tranzl.chatSend({ requestId, messages, model: answer.model, effort: session.effort });
      if (running?.requestId !== requestId) return;
      if (result.ok && typeof result.translation === 'string') answer.content = result.translation;
      if (result.preparedContext) saveContext(result.preparedContext);
      if (result.model) answer.model = result.model;
      if (result.stats) answer.stats = result.stats;
      if (result.outputCapped) answer.capped = result.outputCapped;
      if (result.ok) { notice(''); answer.progress = null; clearStatus(); }
      if (result.error) fail(result.error);
      answer.status = result.aborted ? 'Stopped' : result.ok ? '' : 'Failed';
      if (result.aborted) clearStatus();
    } catch (err) { answer.status = 'Failed'; answer.progress = null; fail(err.message); }
    finally {
      if (running?.requestId === requestId) running = null;
      renderMessages(); renderSessions(); controls(); persist(true);
    }
  }
  window.tranzl.onChatEvent(event => {
    if (event.requestId !== running?.requestId) return;
    const answer = running.answer;
    if ((event.type === 'chunk' || event.type === 'thinking') && !running.firstTokenAt) running.firstTokenAt = Date.now();
    if (event.type === 'compacted' && !running?.continuing) saveContext(event.context);
    if (event.type === 'stats') running.stats = event.stats;
    if (event.type === 'status') {
      answer.status = event.status;
      answer.progress = event.progress ?? null;
      window.tranzlStatus?.(event.status, 'busy');
    }
    if (event.type === 'chunk') {
      if (running.continuing) { running.buffer += event.delta; answer.content = running.contentBase + running.buffer; }
      else answer.content += event.delta;
      answer.status = 'Generating…'; answer.progress = null; clearStatus();
    }
    if (event.type === 'thinking') { answer.thinking += event.delta; answer.progress = null; clearStatus(); }
    if (event.type === 'done') {
      answer.content = running.continuing ? running.contentBase + event.translation : event.translation;
      answer.model = event.model;
      answer.stats = event.stats;
      answer.capped = event.outputCapped || null;
      answer.status = '';
      answer.progress = null;
      clearStatus();
    }
    if (event.type === 'error') { answer.status = 'Failed'; answer.progress = null; fail(event.error); }
    if (activeId === running.sessionId) updateStreamingMessage(answer);
    persist();
  });
  el('send').onclick = send;
  el('stop').onclick = () => { window.tranzl.chatStop(); notice('Stopping…'); };
  el('input').addEventListener('paste', async event => {
    if (![...(event.clipboardData?.items || [])].some(item => item.type.startsWith('image/'))) return;
    event.preventDefault();
    if (!ready || attaching) return;
    const session = current();
    if (session.attachments.length >= 8) { fail('Attach up to 8 files per message.'); return; }
    attaching = true; controls();
    try {
      const result = await window.tranzl.clipboardImage();
      if (!sessions.includes(session)) return;
      if (result.error) { fail(result.error); return; }
      if (!result.file) { fail('No image found on the clipboard.'); return; }
      const mediaBytes = fileMedia({ attachments: session.attachments }).reduce((n, f) => n + f.data.length * 3 / 4, 0);
      if (mediaBytes + result.file.size > 40 * 1024 * 1024) { fail('Attachments exceed 40 MB of media.'); return; }
      session.attachments.push(result.file);
      if (current() === session) renderAttachments();
      notice(''); persist(true);
    } catch (error) { fail(error.message); }
    finally { attaching = false; controls(); }
  });
  el('input').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); send(); } };
  el('input').oninput = () => { if (current()) current().draft = el('input').value; controls(); persist(); };
  el('effort').onchange = () => { if (current()) current().effort = el('effort').value; persist(true); };
  el('new').onclick = newChat;
  el('search').oninput = renderSessions;
  el('attach').onclick = async () => {
    const session = current();
    attaching = true; controls();
    try {
      const result = await window.tranzl.chatAttach();
      if (!sessions.includes(session)) return;
      if (session.attachments.length + result.files.length > 8) { fail('Attach up to 8 files per message. Remove some files and try again.'); return; }
      const combined = [...session.attachments, ...result.files];
      if (combined.reduce((n, f) => n + (f.data?.length || 0) + (f.images || []).reduce((sum, i) => sum + i.data.length, 0), 0) * 3 / 4 > 40 * 1024 * 1024) {
        fail('Attachments exceed 40 MB of media. Choose fewer or smaller files.'); return;
      }
      session.attachments.push(...result.files);
      notice(result.errors.join('\n')); if (result.errors.length) fail(result.errors.join(' · ')); renderAttachments(); controls(); persist(true);
    } catch (err) { fail(err.message); }
    finally { attaching = false; controls(); }
  };
  el('clear').onclick = () => {
    if (!confirm('Delete all chat sessions and their attached file contents? This cannot be undone.')) return;
    window.tranzl.chatStop(); running = null; sessions = []; newChat();
  };
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && running && !el('view').classList.contains('hidden')) el('stop').click(); });
  new MutationObserver(() => { controls(); refreshModelInfo(); }).observe(document.getElementById('model-select'), { childList: true });
  document.getElementById('model-select').addEventListener('change', () => { controls(); refreshModelInfo(); });
  window.tranzl.onBackendStatus(refreshModelInfo);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', renderStats);
  window.addEventListener('beforeunload', () => persist(true));
  controls();
  window.tranzl.chatLoad().then(data => {
    if (data.error) { fail(data.error); return; }
    sessions = Array.isArray(data.sessions) ? data.sessions : [];
    for (const session of sessions) for (const message of session.messages) {
      if (message.status && !['Stopped', 'Failed', 'Interrupted'].includes(message.status)) message.status = 'Interrupted';
      message.progress = null;
    }
    activeId = sessions.some(s => s.id === data.activeId) ? data.activeId : sessions[0]?.id;
    ready = true;
    refreshModelInfo();
    if (!sessions.length) newChat(); else render();
    if (!data.persistent) {
      el('storage').textContent = 'Temporary chats · not saved to disk';
      notice('Local encryption is unavailable. Chats will only last until you close the app.');
    }
  }).catch(err => fail(`Could not load chats: ${err.message}`));
})();
