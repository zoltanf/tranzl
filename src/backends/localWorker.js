// Runs inside an Electron utilityProcess so that model loading and inference
// never block the main process (which would freeze the whole app).
// Protocol (parent -> worker):
//   {type:'load', modelPath}
//   {type:'translate', id, modelPath, systemPrompt, text, reasoning}
//   {type:'abort', id}
// (worker -> parent):
//   {type:'status', state:'loading'|'ready'|'error', error?}
//   {type:'chunk', id, delta} / {type:'done', id, translation}
//   {type:'aborted', id} / {type:'error', id, error}

const post = (msg) => process.parentPort.postMessage(msg);

// node-llama-cpp is ESM-only, so it has to be loaded with a dynamic import
let modulePromise = null;
function loadModule() {
  if (!modulePromise) modulePromise = import('node-llama-cpp');
  return modulePromise;
}

let enginePromise = null;
let queue = Promise.resolve();
const aborts = new Map();

function loadEngine(modelPath) {
  if (!enginePromise) {
    post({ type: 'status', state: 'loading' });
    enginePromise = (async () => {
      const { getLlama } = await loadModule();
      const llama = await getLlama();
      const model = await llama.loadModel({ modelPath });
      const context = await model.createContext({ contextSize: { max: 8192 } });
      return { model, sequence: context.getSequence(), session: null, sessionReasoning: null };
    })();
    enginePromise.then(
      (engine) => post({ type: 'status', state: 'ready', contextSize: engine.sequence.contextSize }),
      (err) => {
        post({ type: 'status', state: 'error', error: err.message });
        enginePromise = null; // allow retrying after a failed load
      }
    );
  }
  return enginePromise;
}

// Gemma 4 has a built-in on/off thinking mode, controlled through the chat
// wrapper. Sessions are cheap; the expensive model/context is reused, so when
// the requested reasoning mode changes we just rebuild the session on the
// same sequence. For non-Gemma-4 models the auto-detected wrapper is kept
// and the reasoning flag has no effect.
async function getSession(engine, reasoning) {
  if (engine.session && engine.sessionReasoning === reasoning) return engine.session;

  const { LlamaChatSession, Gemma4ChatWrapper } = await loadModule();
  engine.session?.dispose();
  let session = new LlamaChatSession({ contextSequence: engine.sequence });
  if (session.chatWrapper instanceof Gemma4ChatWrapper && session.chatWrapper.reasoning !== reasoning) {
    session.dispose();
    session = new LlamaChatSession({
      contextSequence: engine.sequence,
      chatWrapper: new Gemma4ChatWrapper({ reasoning }),
    });
  }
  engine.session = session;
  engine.sessionReasoning = reasoning;
  return session;
}

// One prompt at a time; thought segments (when reasoning is on) are excluded
// from onTextChunk and the returned text by the library.
function handleTranslate({ id, modelPath, systemPrompt, text, history = [], reasoning, maxTokens }) {
  const abort = new AbortController();
  aborts.set(id, abort);

  const run = async () => {
    try {
      const engine = await loadEngine(modelPath);
      abort.signal.throwIfAborted();
      const session = await getSession(engine, reasoning);
      // Restore only this conversation; translations supply an empty history.
      session.setChatHistory([{ type: 'system', text: systemPrompt }, ...history.map(m =>
        m.role === 'user' ? { type: 'user', text: m.content } : { type: 'model', response: [m.content] }
      )]);
      const before = engine.sequence.tokenMeter.getState();
      const t0 = Date.now();
      let tFirst = 0, lastStats = 0;
      const liveStats = () => {
        const meter = engine.sequence.tokenMeter.getState();
        const outputTokens = meter.usedOutputTokens - before.usedOutputTokens;
        const seconds = (Date.now() - (tFirst || t0)) / 1000;
        return { inputTokens: meter.usedInputTokens - before.usedInputTokens, inputLabel: 'Evaluated input', outputTokens,
          contextTokens: engine.sequence.nextTokenIndex, contextSize: engine.sequence.contextSize,
          contextEstimated: false, cachedTokens: null, tps: seconds > 0 ? outputTokens / seconds : null };
      };
      const translation = await session.prompt(text, {
        temperature: 0.2,
        maxTokens,
        signal: abort.signal,
        // Thought segments (reasoning mode) stream separately from the answer
        onResponseChunk: (chunk) => {
          if (!chunk.text) return;
          if (!tFirst) tFirst = Date.now();
          if (Date.now() - lastStats >= 250) { post({ type: 'stats', id, stats: liveStats() }); lastStats = Date.now(); }
          if (chunk.type === 'segment' && chunk.segmentType === 'thought') {
            post({ type: 'thought', id, delta: chunk.text });
          } else {
            post({ type: 'chunk', id, delta: chunk.text });
          }
        },
      });
      const after = engine.sequence.tokenMeter.getState();
      const outputTokens = after.usedOutputTokens - before.usedOutputTokens;
      // Generation rate measured from the first token, excluding prompt eval
      const genSeconds = (Date.now() - (tFirst || t0)) / 1000;
      post({
        type: 'done',
        id,
        translation,
        stats: {
          inputTokens: after.usedInputTokens - before.usedInputTokens,
          inputLabel: 'Evaluated input',
          contextTokens: engine.sequence.nextTokenIndex,
          contextSize: engine.sequence.contextSize,
          contextEstimated: false,
          cachedTokens: null,
          elapsedSeconds: (Date.now() - t0) / 1000,
          firstTokenSeconds: tFirst ? (tFirst - t0) / 1000 : null,
          outputTokens,
          tps: genSeconds > 0 ? outputTokens / genSeconds : null,
        },
      });
    } catch (err) {
      if (abort.signal.aborted) post({ type: 'aborted', id });
      else post({ type: 'error', id, error: err.message });
    } finally {
      aborts.delete(id);
    }
  };
  queue = queue.then(run, run);
}

process.parentPort.on('message', (event) => {
  const msg = event.data;
  if (msg.type === 'load') loadEngine(msg.modelPath);
  else if (msg.type === 'count') {
    const run = async () => {
      try {
        const engine = await loadEngine(msg.modelPath);
        const session = await getSession(engine, msg.reasoning);
        const chatHistory = [{ type: 'system', text: msg.systemPrompt }, ...msg.messages.map(m =>
          m.role === 'user' ? { type: 'user', text: m.content } : { type: 'model', response: [m.content] }
        ), { type: 'model', response: [] }];
        const { contextText } = session.chatWrapper.generateContextState({ chatHistory });
        post({ type: 'counted', id: msg.id, tokens: contextText.tokenize(engine.model.tokenizer).length });
      } catch (err) { post({ type: 'error', id: msg.id, error: err.message }); }
    };
    queue = queue.then(run, run);
  }
  else if (msg.type === 'translate') handleTranslate(msg);
  else if (msg.type === 'abort') aborts.get(msg.id)?.abort();
});
