const sourceEl = document.getElementById('source');
const outputEl = document.getElementById('output');
const langEl = document.getElementById('target-language');
const modelEl = document.getElementById('model-select');
const effortEl = document.getElementById('effort');
const effortLabelEl = document.getElementById('effort-label');
const statusEl = document.getElementById('status');
const statusbarBackendEl = document.getElementById('statusbar-backend');
const statusStatsEl = document.getElementById('status-stats');
const thinkingBoxEl = document.getElementById('thinking-box');
const thinkingToggleEl = document.getElementById('thinking-toggle');
const thinkingContentEl = document.getElementById('thinking-content');
const copyBtn = document.getElementById('copy-btn');
const clearBtn = document.getElementById('clear-btn');
const undoUnwrapBtn = document.getElementById('undo-unwrap-btn');
const styleEl = document.getElementById('style-select');
const noTranslateEl = document.getElementById('no-translate');
const customEditBtn = document.getElementById('custom-edit-btn');
const backendBtn = document.getElementById('backend-btn');
const backendLabelEl = document.getElementById('backend-label');
const themeEl = document.getElementById('theme-select');
const unwrapPasteEl = document.getElementById('unwrap-paste');

const overlayEl = document.getElementById('setup-overlay');
const choicesEl = document.getElementById('setup-choices');
const chooseLocalBtn = document.getElementById('choose-local');
const chooseLocalDescEl = document.getElementById('choose-local-desc');
const chooseLmStudioBtn = document.getElementById('choose-lmstudio');
const chooseOllamaBtn = document.getElementById('choose-ollama');
const setupProgressEl = document.getElementById('setup-progress');
const progressFillEl = document.getElementById('progress-fill');
const progressTextEl = document.getElementById('progress-text');
const setupErrorEl = document.getElementById('setup-error');
const setupCloseBtn = document.getElementById('setup-close');

const historyBtn = document.getElementById('history-btn');
const historyOverlayEl = document.getElementById('history-overlay');
const historySearchEl = document.getElementById('history-search');
const historyListEl = document.getElementById('history-list');
const historyClearBtn = document.getElementById('history-clear');
const historyCloseBtn = document.getElementById('history-close');

const promptOverlayEl = document.getElementById('prompt-overlay');
const promptInputEl = document.getElementById('custom-prompt-input');
const promptHistoryEl = document.getElementById('prompt-history');
const promptApplyBtn = document.getElementById('prompt-apply');
const promptCancelBtn = document.getElementById('prompt-cancel');

const DEBOUNCE_MS = 800;
const EFFORT_LEVELS = ['fast', 'balanced', 'thorough'];
const EFFORT_LABELS = ['Fast', 'Balanced', 'Thorough'];
const PROMPT_HISTORY_MAX = 100;
const BACKEND_NAMES = { local: 'Embedded', lmstudio: 'LM Studio', ollama: 'Ollama' };

let translationImage = null;
let imagePasteSeq = 0;
const translationImagesEl = document.getElementById('translation-images');
let debounceTimer = null;
let requestSeq = 0;
let lastRequestText = ''; // source text of the in-flight request, for history
let translating = false;
let setupInfo = null;
let modelLoadState = 'idle'; // embedded model: idle | loading | ready | error

let lastOkStatus = 'Ready';
function setStatus(text, kind = '') {
  statusEl.textContent = text;
  statusEl.className = `status ${kind}`;
  // Animate the brand gradient while the model is working
  document.body.classList.toggle('working', kind === 'busy');
  if (kind === 'ok') lastOkStatus = text;
}

// Shared with chat.js: show a message in the status bar, or clear an error
// by restoring the last idle text (only when no translation is in flight).
window.tranzlStatus = (text, kind) => {
  if (text || kind) return setStatus(text, kind);
  if (!translating) setStatus(lastOkStatus, 'ok');
};

function setIdleStatus() {
  if (translating) return;
  if (document.body.classList.contains('local-backend')) {
    if (modelLoadState === 'loading') {
      setStatus(`Loading ${setupInfo.modelLabel}`, 'busy');
    } else if (modelLoadState === 'error') {
      setStatus('Model failed to load — see Model & Backend tab', 'error');
    } else {
      setStatus(`Ready · ${setupInfo.modelLabel}`, 'ok');
    }
  }
}

// ---- Ribbon tabs ----

const panesEl = document.querySelector('.panes');
const aboutViewEl = document.getElementById('about-view');

for (const tabBtn of document.querySelectorAll('.tab')) {
  tabBtn.addEventListener('click', () => {
    for (const other of document.querySelectorAll('.tab')) {
      other.classList.toggle('active', other === tabBtn);
    }
    for (const panel of document.querySelectorAll('.ribbon-panel')) {
      panel.classList.toggle('hidden', panel.id !== tabBtn.dataset.tab);
    }
    // About and Settings replace the editor panes; Chat replaces them with the chat view
    const isAbout = tabBtn.dataset.tab === 'tab-about';
    const isChat = tabBtn.dataset.tab === 'tab-chat';
    panesEl.classList.toggle('hidden', tabBtn.dataset.tab !== 'tab-translate');
    document.getElementById('chat-view').classList.toggle('hidden', !isChat);
    aboutViewEl.classList.toggle('hidden', !isAbout);
  });
}

// ---- Models (server backends) ----

// Prefer small local Google models (gemma), smallest parameter count first
function pickDefaultModel(models) {
  const stored = localStorage.getItem('tranzl.model');
  if (stored && models.includes(stored)) return stored;

  const sizeOf = (id) => {
    const m = id.match(/(\d+(?:\.\d+)?)\s*b/i);
    return m ? parseFloat(m[1]) : Infinity;
  };
  const bySize = (a, b) => sizeOf(a) - sizeOf(b);

  const google = models.filter((id) => /gemma|gemini/i.test(id)).sort(bySize);
  if (google.length) return google[0];

  return [...models].sort(bySize)[0];
}

async function loadModels() {
  const result = await window.tranzl.listModels();
  if (!result.ok) {
    modelEl.innerHTML = '<option value="">unavailable</option>';
    setStatus(result.error, 'error');
    return;
  }

  const selected = pickDefaultModel(result.models);
  modelEl.innerHTML = '';
  for (const id of result.models) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = id;
    opt.selected = id === selected;
    modelEl.appendChild(opt);
  }
  setStatus(`Ready · ${selected}`, 'ok');
}

// ---- Translation ----

window.tranzl.onTranslationEvent((event) => {
  // Ignore events from superseded requests
  if (event.requestId !== requestSeq) return;

  if (event.type === 'status') { setStatus(event.status, 'busy'); return; }
  if (event.type === 'chunk') {
    // The answer has started — fold the thinking drawer out of the way
    // (once per request; manual toggling afterwards is respected)
    if (thinkingContentEl.textContent && !thinkingAutoCollapsed) {
      thinkingAutoCollapsed = true;
      setThinkingCollapsed(true);
    }
    outputEl.value += event.delta;
    outputEl.scrollTop = outputEl.scrollHeight;
  } else if (event.type === 'thinking') {
    thinkingBoxEl.classList.remove('hidden');
    // Show thinking live while it streams, unless the user prefers it closed
    if (!thinkingAutoCollapsed && localStorage.getItem('tranzl.thinkingCollapsed') !== '1') {
      setThinkingCollapsed(false);
    }
    thinkingContentEl.textContent += event.delta;
    thinkingContentEl.scrollTop = thinkingContentEl.scrollHeight;
  } else if (event.type === 'done') {
    outputEl.value = event.translation;
    translating = false;
    setStatus(event.model ? `Ready · ${event.model}` : 'Ready', 'ok');
    statusStatsEl.textContent = formatStats(event.stats);
    recordSourceHistory(lastRequestText);
  } else if (event.type === 'error') {
    translating = false;
    setStatus(event.error, 'error');
  }
});

// e.g. "312 in · 74 out · 41.2 tok/s" ("~" marks chars/4 estimates)
function formatStats(stats) {
  if (!stats || stats.outputTokens == null) return '';
  const approx = stats.estimated ? '~' : '';
  const parts = [];
  if (stats.inputTokens != null) parts.push(`${approx}${stats.inputTokens} in`);
  parts.push(`${approx}${stats.outputTokens} out`);
  if (stats.tps) {
    parts.push(`${stats.tps >= 100 ? Math.round(stats.tps) : stats.tps.toFixed(1)} tok/s`);
  }
  return parts.join(' · ');
}

async function translate() {
  const text = sourceEl.value;
  if (!text.trim() && !translationImage) {
    stopTranslation();
    outputEl.value = '';
    return;
  }

  // Custom mode needs a prompt before it can run
  if (styleEl.value === 'custom' && !getCustomPrompt().trim()) {
    openPromptDialog({ revertOnCancel: true });
    return;
  }

  const seq = ++requestSeq;
  lastRequestText = text;
  outputEl.value = '';
  statusStatsEl.textContent = '';
  thinkingContentEl.textContent = '';
  thinkingBoxEl.classList.add('hidden');
  thinkingAutoCollapsed = false;
  translating = true;
  setStatus(
    modelLoadState === 'loading' ? `Loading ${setupInfo.modelLabel}` : 'Working · Esc stops',
    'busy'
  );

  try {
    const result = await window.tranzl.translate({
      text,
      images: translationImage ? [translationImage] : [],
      targetLanguage: langEl.value,
      requestId: seq,
      model: modelEl.value || undefined,
      effort: EFFORT_LEVELS[effortEl.value],
      style: styleEl.value,
      noTranslate: noTranslateEl.checked,
      customPrompt: styleEl.value === 'custom' ? getCustomPrompt() : undefined,
    });
    if (seq !== requestSeq) return;
    if (result.ok && typeof result.translation === 'string') {
      outputEl.value = result.translation; translating = false;
      setStatus(result.model ? `Ready · ${result.model}` : 'Ready', 'ok');
      statusStatsEl.textContent = formatStats(result.stats);
    } else if (!result.ok) {
      translating = false; setStatus(result.aborted ? 'Stopped' : result.error || 'Translation failed', result.aborted ? '' : 'error');
    }
  } catch (error) { if (seq === requestSeq) { translating = false; setStatus(error.message, 'error'); } }
}

function stopTranslation() {
  clearTimeout(debounceTimer); requestSeq++; translating = false;
  window.tranzl.cancelTranslate(); statusStatsEl.textContent = ''; setStatus('Ready', 'ok');
}
function renderTranslationImage() {
  translationImagesEl.replaceChildren();
  translationImagesEl.classList.toggle('hidden', !translationImage);
  if (!translationImage) return;
  const image = document.createElement('img'); image.src = `data:${translationImage.mime};base64,${translationImage.data}`; image.alt = 'Pasted image to translate'; window.attachmentPreview.enable(image);
  const info = document.createElement('span'); info.textContent = 'Image text will be read by the model';
  const remove = document.createElement('button'); remove.className = 'ghost'; remove.textContent = 'Remove image';
  remove.onclick = () => { imagePasteSeq++; translationImage = null; stopTranslation(); renderTranslationImage(); retranslateNow(); };
  translationImagesEl.append(image, info, remove);
}
async function pasteTranslationImage() {
  const pasteSeq = ++imagePasteSeq;
  const result = await window.tranzl.clipboardImage();
  if (pasteSeq !== imagePasteSeq) return true;
  if (result.error) { setStatus(result.error, 'error'); return true; }
  if (!result.file) return false;
  stopTranslation(); hideUnwrapUndo(); pendingPaste = false;
  translationImage = result.file; renderTranslationImage(); retranslateNow(); sourceEl.focus();
  return true;
}

function scheduleTranslate() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(translate, DEBOUNCE_MS);
}

function retranslateNow() {
  clearTimeout(debounceTimer);
  translate();
}

// "Don't translate" only makes sense combined with an editing style —
// with "Just translate" it would be a no-op, so it's disabled there.
// The target language is irrelevant while translation is off.
function syncStyleControls() {
  const editing = styleEl.value !== 'translate';
  noTranslateEl.disabled = !editing;
  if (!editing) noTranslateEl.checked = false;
  langEl.disabled = noTranslateEl.checked;
  customEditBtn.classList.toggle('hidden', styleEl.value !== 'custom');
}

// ---- Custom prompt dialog & history ----

// Custom prompts live in the encrypted store alongside the source history
function getCustomPrompt() {
  return secureStore.customPrompt || '';
}

function getPromptHistory() {
  return secureStore.promptHistory;
}

function pushPromptHistory(prompt) {
  const trimmed = prompt.trim();
  if (!trimmed) return;
  const history = secureStore.promptHistory.filter((p) => p !== trimmed);
  history.unshift(trimmed);
  secureStore.promptHistory = history.slice(0, PROMPT_HISTORY_MAX);
  persistSecureStore();
}

function renderPromptHistory() {
  promptHistoryEl.innerHTML = '';
  for (const prompt of getPromptHistory()) {
    const item = document.createElement('button');
    item.className = 'prompt-history-item';
    item.textContent = prompt;
    item.title = prompt;
    item.addEventListener('click', () => {
      promptInputEl.value = prompt;
      promptInputEl.focus();
    });
    promptHistoryEl.appendChild(item);
  }
}

let promptRevertStyle = null; // style to restore if the dialog is cancelled

function openPromptDialog({ revertOnCancel }) {
  promptRevertStyle = revertOnCancel ? 'translate' : null;
  promptInputEl.value = getCustomPrompt();
  renderPromptHistory();
  promptOverlayEl.classList.remove('hidden');
  promptInputEl.focus();
}

promptApplyBtn.addEventListener('click', () => {
  const prompt = promptInputEl.value.trim();
  if (!prompt) return;
  secureStore.customPrompt = prompt;
  pushPromptHistory(prompt); // also persists the store
  promptOverlayEl.classList.add('hidden');
  promptRevertStyle = null;
  retranslateNow();
});

promptCancelBtn.addEventListener('click', () => {
  promptOverlayEl.classList.add('hidden');
  // Cancelling before any prompt exists: fall back to a non-custom style
  if (promptRevertStyle && !getCustomPrompt().trim()) {
    styleEl.value = promptRevertStyle;
    localStorage.setItem('tranzl.style', styleEl.value);
    syncStyleControls();
  }
  promptRevertStyle = null;
});

promptInputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) promptApplyBtn.click();
  if (e.key === 'Escape') promptCancelBtn.click();
});

customEditBtn.addEventListener('click', () => openPromptDialog({ revertOnCancel: false }));

// ---- Input history (searchable, per-item delete, clear all) ----

const HISTORY_MAX = 200;

// Sensitive user content (source history, custom prompt + prompt history)
// lives encrypted on disk (OS-keychain key, via the main process); the
// renderer works against this in-memory copy loaded at startup
let secureStore = { sourceHistory: [], promptHistory: [], customPrompt: '' };

function persistSecureStore() {
  window.tranzl.saveHistory(secureStore);
}

function getSourceHistory() {
  return secureStore.sourceHistory;
}

function saveSourceHistory(list) {
  secureStore.sourceHistory = list.slice(0, HISTORY_MAX);
  persistSecureStore();
}

function readLegacyKey(key) {
  const value = localStorage.getItem(key);
  if (value !== null) localStorage.removeItem(key);
  return value;
}

async function initSecureStore() {
  const { store } = await window.tranzl.loadHistory();
  if (store) {
    secureStore = {
      sourceHistory: Array.isArray(store.sourceHistory) ? store.sourceHistory : [],
      promptHistory: Array.isArray(store.promptHistory) ? store.promptHistory : [],
      customPrompt: typeof store.customPrompt === 'string' ? store.customPrompt : '',
    };
  }

  // One-time migration of old plaintext localStorage data
  let dirty = false;
  try {
    const oldHistory = JSON.parse(readLegacyKey('tranzl.sourceHistory') || 'null');
    if (Array.isArray(oldHistory) && oldHistory.length) {
      const known = new Set(secureStore.sourceHistory.map((e) => e.text));
      secureStore.sourceHistory = [
        ...secureStore.sourceHistory,
        ...oldHistory.filter((e) => e?.text && !known.has(e.text)),
      ]
        .sort((a, b) => (b.ts || 0) - (a.ts || 0))
        .slice(0, HISTORY_MAX);
      dirty = true;
    }
  } catch {
    // unreadable legacy data — just drop it
  }
  try {
    const oldPrompts = JSON.parse(readLegacyKey('tranzl.promptHistory') || 'null');
    if (Array.isArray(oldPrompts) && oldPrompts.length) {
      const known = new Set(secureStore.promptHistory);
      secureStore.promptHistory = [
        ...secureStore.promptHistory,
        ...oldPrompts.filter((p) => typeof p === 'string' && !known.has(p)),
      ].slice(0, PROMPT_HISTORY_MAX);
      dirty = true;
    }
  } catch {
    // unreadable legacy data — just drop it
  }
  const oldCustom = readLegacyKey('tranzl.customPrompt');
  if (oldCustom) {
    if (!secureStore.customPrompt) secureStore.customPrompt = oldCustom;
    dirty = true;
  }
  if (dirty) persistSecureStore();
}

// Called after each successful translation; deduped, newest first
function recordSourceHistory(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return;
  const list = getSourceHistory().filter((e) => e.text !== trimmed);
  list.unshift({ text: trimmed, ts: Date.now() });
  saveSourceHistory(list);
}

function resetHistoryClearBtn() {
  historyClearBtn.textContent = 'Clear all';
  historyClearBtn.dataset.armed = '';
}

function renderHistoryList() {
  const query = historySearchEl.value.trim().toLowerCase();
  const entries = getSourceHistory().filter(
    (e) => !query || e.text.toLowerCase().includes(query)
  );

  historyListEl.innerHTML = '';
  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = query ? 'No matches' : 'No history yet';
    historyListEl.appendChild(empty);
    return;
  }

  for (const entry of entries) {
    const row = document.createElement('div');
    row.className = 'history-item';

    const load = document.createElement('button');
    load.className = 'history-item-load';
    load.title = entry.text;
    const preview = document.createElement('div');
    preview.className = 'history-item-preview';
    preview.textContent = entry.text;
    const date = document.createElement('div');
    date.className = 'history-item-date';
    date.textContent = new Date(entry.ts).toLocaleString();
    load.append(preview, date);
    load.addEventListener('click', () => {
      imagePasteSeq++; translationImage = null; renderTranslationImage();
      hideUnwrapUndo();
      sourceEl.value = entry.text;
      historyOverlayEl.classList.add('hidden');
      retranslateNow();
    });

    const del = document.createElement('button');
    del.className = 'history-item-delete';
    del.textContent = '✕';
    del.title = 'Remove this entry';
    del.addEventListener('click', () => {
      saveSourceHistory(getSourceHistory().filter((e) => e.ts !== entry.ts || e.text !== entry.text));
      renderHistoryList();
    });

    row.append(load, del);
    historyListEl.appendChild(row);
  }
}

historyBtn.addEventListener('click', () => {
  historySearchEl.value = '';
  resetHistoryClearBtn();
  renderHistoryList();
  historyOverlayEl.classList.remove('hidden');
  historySearchEl.focus();
});

historySearchEl.addEventListener('input', renderHistoryList);

// Clearing everything takes two clicks to avoid accidents
historyClearBtn.addEventListener('click', () => {
  if (historyClearBtn.dataset.armed === '1') {
    saveSourceHistory([]);
    resetHistoryClearBtn();
    renderHistoryList();
  } else {
    historyClearBtn.textContent = 'Really clear all?';
    historyClearBtn.dataset.armed = '1';
  }
});

historyCloseBtn.addEventListener('click', () => {
  historyOverlayEl.classList.add('hidden');
});

// ---- Control events ----

// ---- Hard-wrap repair on paste ----

const { detectHardWrap, unwrapHardWrap } = window.tranzlUnwrap;
let unwrapOriginal = null; // pre-fix text, for the undo button

function hideUnwrapUndo() {
  unwrapOriginal = null;
  undoUnwrapBtn.classList.add('hidden');
}

undoUnwrapBtn.addEventListener('click', () => {
  if (unwrapOriginal !== null) sourceEl.value = unwrapOriginal;
  hideUnwrapUndo();
  retranslateNow();
});

// 'paste' fires before the text lands in the textarea; the 'input' event
// that follows carries the final content, so the flag routes that one
// input event through the unwrap path instead of the plain debounce
let pendingPaste = false;

sourceEl.addEventListener('paste', event => {
  if ([...(event.clipboardData?.items || [])].some(item => item.type.startsWith('image/'))) {
    event.preventDefault(); pendingPaste = false;
    pasteTranslationImage().catch(error => setStatus(error.message, 'error'));
    return;
  }
  pendingPaste = true;
});

// Fix hard-wrapped line breaks (PDF/email copies) in the box itself, then
// translate right away. Shared by the paste event and the Paste button.
function processPaste() {
  const text = sourceEl.value;
  if (unwrapPasteEl.checked && detectHardWrap(text)) {
    unwrapOriginal = text;
    sourceEl.value = unwrapHardWrap(text); // doesn't re-fire 'input'
    undoUnwrapBtn.classList.remove('hidden');
  }
  translate();
}

sourceEl.addEventListener('input', () => {
  hideUnwrapUndo();

  if (pendingPaste) {
    // Translate quickly instead of waiting for the full debounce
    pendingPaste = false;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(processPaste, 100);
    return;
  }

  scheduleTranslate();
});

langEl.addEventListener('change', () => {
  localStorage.setItem('tranzl.lang', langEl.value);
  retranslateNow();
});

modelEl.addEventListener('change', () => {
  localStorage.setItem('tranzl.model', modelEl.value);
  retranslateNow();
});

effortEl.addEventListener('input', () => {
  effortLabelEl.textContent = EFFORT_LABELS[effortEl.value];
  localStorage.setItem('tranzl.effort', effortEl.value);
});

effortEl.addEventListener('change', retranslateNow);

styleEl.addEventListener('change', () => {
  localStorage.setItem('tranzl.style', styleEl.value);
  syncStyleControls();
  if (styleEl.value === 'custom') {
    openPromptDialog({ revertOnCancel: true });
    return;
  }
  retranslateNow();
});

noTranslateEl.addEventListener('change', () => {
  localStorage.setItem('tranzl.noTranslate', noTranslateEl.checked ? '1' : '0');
  syncStyleControls();
  retranslateNow();
});

// ⌘/Ctrl+Enter skips the debounce and re-runs immediately (also the way
// to retry after an error without editing the text)
sourceEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    retranslateNow();
  }
});

// Esc stops a running generation (e.g. when the model gets stuck in a
// repetition loop); the partial output stays in the result pane.
// Dialogs handle their own Esc, so it only fires when none is open.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!historyOverlayEl.classList.contains('hidden')) {
    historyOverlayEl.classList.add('hidden');
    return;
  }
  if (!promptOverlayEl.classList.contains('hidden')) return;
  if (!overlayEl.classList.contains('hidden')) return;
  if (!translating) return;
  clearTimeout(debounceTimer);
  requestSeq++; // any late events from the aborted request are ignored
  translating = false;
  window.tranzl.cancelTranslate();
  setStatus('Stopped', '');
});

// The drawer auto-collapses once per request when the answer starts
// streaming; manual toggling stores the user's standing preference
let thinkingAutoCollapsed = false;

function setThinkingCollapsed(collapsed) {
  thinkingBoxEl.classList.toggle('collapsed', collapsed);
  thinkingToggleEl.textContent = collapsed ? 'Thinking ▸' : 'Thinking ▾';
}

thinkingToggleEl.addEventListener('click', () => {
  const collapsed = !thinkingBoxEl.classList.contains('collapsed');
  setThinkingCollapsed(collapsed);
  localStorage.setItem('tranzl.thinkingCollapsed', collapsed ? '1' : '0');
});

if (localStorage.getItem('tranzl.thinkingCollapsed') === '1') {
  setThinkingCollapsed(true);
}

// Theme is stored and applied in the main process (nativeTheme), which
// drives the prefers-color-scheme media query this page's CSS keys off
themeEl.addEventListener('change', () => {
  window.tranzl.setTheme(themeEl.value);
});

unwrapPasteEl.addEventListener('change', () => {
  localStorage.setItem('tranzl.unwrapPaste', unwrapPasteEl.checked ? '1' : '0');
});

const pasteBtn = document.getElementById('paste-btn');

pasteBtn.addEventListener('click', async () => {
  try { if (await pasteTranslationImage()) return; } catch (error) { setStatus(error.message, 'error'); return; }
  const text = await navigator.clipboard.readText().catch(() => '');
  if (!text) return;
  clearTimeout(debounceTimer);
  hideUnwrapUndo();
  sourceEl.value = text;
  processPaste();
  sourceEl.focus();
});

clearBtn.addEventListener('click', () => {
  imagePasteSeq++; translationImage = null; renderTranslationImage(); stopTranslation();
  sourceEl.value = '';
  outputEl.value = '';
  hideUnwrapUndo();
  sourceEl.focus();
});

copyBtn.addEventListener('click', async () => {
  if (!outputEl.value) return;
  await navigator.clipboard.writeText(outputEl.value);
  copyBtn.textContent = 'Copied!';
  setTimeout(() => (copyBtn.textContent = 'Copy'), 1200);
});

// ---- Backend setup (first run + "Change…" button) ----

function formatGB(bytes) {
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function applyBackend(backend) {
  document.body.classList.toggle('local-backend', backend === 'local');
  backendLabelEl.textContent = BACKEND_NAMES[backend] ?? '—';
  statusbarBackendEl.textContent =
    backend === 'local' ? `Embedded · ${setupInfo.modelLabel.replace(' (embedded)', '')}` : BACKEND_NAMES[backend];
  if (backend === 'local') {
    modelEl.innerHTML = `<option selected>${setupInfo.modelLabel}</option>`;
    setIdleStatus();
  } else {
    loadModels();
  }
}

function setChoicesDisabled(disabled) {
  for (const btn of [chooseLocalBtn, chooseLmStudioBtn, chooseOllamaBtn]) {
    btn.disabled = disabled;
  }
}

function showOverlay({ cancellable }) {
  choicesEl.classList.remove('hidden');
  setupProgressEl.classList.add('hidden');
  setupErrorEl.classList.add('hidden');
  setupCloseBtn.classList.toggle('hidden', !cancellable);
  setChoicesDisabled(false);
  overlayEl.classList.remove('hidden');
}

function showDownloadProgress() {
  choicesEl.classList.add('hidden');
  setupErrorEl.classList.add('hidden');
  setupCloseBtn.classList.add('hidden');
  setupProgressEl.classList.remove('hidden');
  progressFillEl.style.width = '0%';
  progressTextEl.textContent = 'Starting download…';
  overlayEl.classList.remove('hidden');
}

async function startModelDownload() {
  showDownloadProgress();
  setStatus('Downloading model', 'busy');
  await window.tranzl.downloadModel();
}

window.tranzl.onSetupEvent((event) => {
  if (event.type === 'progress') {
    const pct = event.total ? Math.round((event.downloaded / event.total) * 100) : 0;
    progressFillEl.style.width = `${pct}%`;
    progressTextEl.textContent =
      `Downloading ${setupInfo.modelLabel} — ${formatGB(event.downloaded)} of ${formatGB(event.total)} (${pct}%)`;
  } else if (event.type === 'done') {
    overlayEl.classList.add('hidden');
    modelLoadState = 'loading';
    applyBackend('local');
  } else if (event.type === 'error') {
    setupProgressEl.classList.add('hidden');
    choicesEl.classList.remove('hidden');
    setupErrorEl.textContent = `Download failed: ${event.error} — choose "Embedded model" to retry; the download resumes where it stopped.`;
    setupErrorEl.classList.remove('hidden');
    setupCloseBtn.classList.remove('hidden');
    setStatus('Model download failed', 'error');
  }
});

// Load progress of the embedded model (runs in a background process)
window.tranzl.onBackendStatus((status) => {
  modelLoadState = status.state;
  if (status.state === 'error' && status.error) {
    setStatus(`Model failed to load: ${status.error}`, 'error');
    return;
  }
  setIdleStatus();
});

chooseLocalBtn.addEventListener('click', async () => {
  setChoicesDisabled(true);
  await window.tranzl.chooseBackend('local');
  const setup = await window.tranzl.getSetup();
  if (setup.modelReady) {
    overlayEl.classList.add('hidden');
    modelLoadState = setup.modelState;
    applyBackend('local');
  } else {
    startModelDownload();
  }
});

// Server-based backends (LM Studio, Ollama) need no setup beyond the choice
for (const [btn, backend] of [
  [chooseLmStudioBtn, 'lmstudio'],
  [chooseOllamaBtn, 'ollama'],
]) {
  btn.addEventListener('click', async () => {
    setChoicesDisabled(true);
    await window.tranzl.chooseBackend(backend);
    overlayEl.classList.add('hidden');
    applyBackend(backend);
  });
}

setupCloseBtn.addEventListener('click', () => {
  overlayEl.classList.add('hidden');
});

backendBtn.addEventListener('click', () => {
  showOverlay({ cancellable: true });
});

// ---- Restore persisted settings & start ----

const storedLang = localStorage.getItem('tranzl.lang');
if (storedLang) {
  const match = [...langEl.options].find((o) => o.value === storedLang || o.text === storedLang);
  if (match) match.selected = true;
}
const storedEffort = localStorage.getItem('tranzl.effort');
if (storedEffort !== null && EFFORT_LEVELS[storedEffort]) {
  effortEl.value = storedEffort;
  effortLabelEl.textContent = EFFORT_LABELS[storedEffort];
}
const storedStyle = localStorage.getItem('tranzl.style');
if (storedStyle && [...styleEl.options].some((o) => o.value === storedStyle)) {
  styleEl.value = storedStyle;
}
noTranslateEl.checked =
  styleEl.value !== 'translate' && localStorage.getItem('tranzl.noTranslate') === '1';
// Paste line-break fixing is on unless explicitly turned off
unwrapPasteEl.checked = localStorage.getItem('tranzl.unwrapPaste') !== '0';
syncStyleControls();

async function init() {
  initSecureStore();
  setupInfo = await window.tranzl.getSetup();
  modelLoadState = setupInfo.modelState;
  themeEl.value = setupInfo.theme ?? 'system';
  chooseLocalDescEl.textContent =
    `Downloads ${setupInfo.modelLabel.replace(' (embedded)', '')} (${setupInfo.downloadSize}) once and runs fully inside Tranzl. No other apps needed.`;

  if (!setupInfo.backend) {
    // First run: ask the user how translations should run
    setStatus('Waiting for setup…');
    showOverlay({ cancellable: false });
  } else if (setupInfo.backend === 'local' && !setupInfo.modelReady) {
    // Chosen before, but the download never finished — resume it
    startModelDownload();
  } else {
    applyBackend(setupInfo.backend);
  }
}

init();
