// Embedded inference backend: runs Gemma 4 E4B fully inside the app via
// node-llama-cpp (Metal-accelerated on Apple Silicon). The model is downloaded
// once into the app's userData directory. Inference runs in a utilityProcess
// (see localWorker.js) so model loading never blocks the main process.
const fs = require('fs');
const path = require('path');
const { utilityProcess } = require('electron');

const MODEL_URI = 'hf:ggml-org/gemma-4-E4B-it-GGUF:Q4_0';
const MODEL_LABEL = 'Gemma 4 E4B (embedded)';
const DOWNLOAD_SIZE_TEXT = '~4.6 GB';

// node-llama-cpp is ESM-only, so it has to be loaded with a dynamic import
let modulePromise = null;
function loadModule() {
  if (!modulePromise) modulePromise = import('node-llama-cpp');
  return modulePromise;
}

function isReady(modelPath) {
  return Boolean(modelPath) && fs.existsSync(modelPath);
}

// Downloads (or resumes downloading) the model. Returns the local file path.
// Downloading is plain async network I/O, so it can stay in the main process.
async function download({ dirPath, onProgress }) {
  const { createModelDownloader } = await loadModule();
  const downloader = await createModelDownloader({
    modelUri: MODEL_URI,
    dirPath,
    showCliProgress: false,
    onProgress: ({ totalSize, downloadedSize }) => onProgress?.(downloadedSize, totalSize),
  });
  return downloader.download();
}

// ---- worker proxy ----

let worker = null;
let workerSeq = 0;
const pending = new Map();
let onStatus = null;
let lastStatus = { state: 'idle' };

function ensureWorker() {
  if (worker) return worker;

  worker = utilityProcess.fork(path.join(__dirname, 'localWorker.js'), [], {
    serviceName: 'tranzl-inference',
  });

  worker.on('message', (msg) => {
    if (msg.type === 'status') {
      lastStatus = msg;
      onStatus?.(msg);
      return;
    }
    const req = pending.get(msg.id);
    if (!req) return;
    if (msg.type === 'chunk') {
      req.onChunk?.(msg.delta);
      return;
    }
    if (msg.type === 'thought') {
      req.onThought?.(msg.delta);
      return;
    }
    if (msg.type === 'stats') { req.onStats?.(msg.stats); return; }
    pending.delete(msg.id);
    if (msg.type === 'counted') req.resolve(msg.tokens);
    else if (msg.type === 'done') req.resolve({ translation: msg.translation, stats: msg.stats });
    else if (msg.type === 'aborted') req.reject(new Error('aborted'));
    else req.reject(new Error(msg.error));
  });

  const currentWorker = worker;
  worker.on('exit', () => {
    if (worker !== currentWorker) return;
    worker = null;
    lastStatus = { state: 'error', error: 'inference process exited' };
    onStatus?.(lastStatus);
    for (const req of pending.values()) req.reject(new Error('inference process exited'));
    pending.clear();
  });

  return worker;
}

// Starts loading the model in the background; safe to call repeatedly.
// statusCallback receives {state:'loading'|'ready'|'error', error?}.
function preload(modelPath, statusCallback) {
  if (statusCallback) onStatus = statusCallback;
  ensureWorker().postMessage({ type: 'load', modelPath });
}

function modelState() {
  return lastStatus;
}

function translate({ modelPath, systemPrompt, text, history = [], reasoning = false, maxTokens, signal, onChunk, onThought, onStats }) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const id = ++workerSeq;
    const proc = ensureWorker();
    const onAbort = () => proc.postMessage({ type: 'abort', id });
    const settle = callback => value => {
      signal.removeEventListener('abort', onAbort);
      callback(value);
    };
    pending.set(id, { resolve: settle(resolve), reject: settle(reject), onChunk, onThought, onStats });
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      proc.postMessage({ type: 'translate', id, modelPath, systemPrompt, text, history, reasoning, maxTokens });
    } catch (error) {
      pending.delete(id);
      settle(reject)(error);
    }
  });
}

function countTokens({ modelPath, systemPrompt, messages, reasoning, signal }) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const id = ++workerSeq;
    pending.set(id, { resolve, reject });
    ensureWorker().postMessage({ type: 'count', id, modelPath, systemPrompt, messages, reasoning });
  }).then(tokens => { signal.throwIfAborted(); return tokens; });
}

async function release() {
  if (pending.size) throw new Error('Wait for the current embedded translation to finish, then retry your attachment.');
  if (!worker) return;
  const previous = worker; worker = null;
  lastStatus = { state: 'idle' };
  await new Promise(resolve => { previous.once('exit', resolve); previous.kill(); });
}

module.exports = {
  release,
  countTokens,
  MODEL_LABEL,
  DOWNLOAD_SIZE_TEXT,
  isReady,
  download,
  preload,
  modelState,
  translate,
};
