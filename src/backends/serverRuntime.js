// Managed inference process. Assets are prepared by an injected acquisition
// layer inside the queue; each instance owns one child and all request cleanup.
const { spawn } = require('node:child_process');
const net = require('node:net');
const crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { openAIMessages } = require('../chatProtocol');

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function readCompletion(body, { signal, onChunk = () => {}, onThought = () => {}, onProgress = () => {} }) {
  let buffer = '', translation = '', usage, timings, finished = false, firstTokenSeconds = null;
  const started = performance.now(), decoder = new TextDecoder();
  function line(raw) {
    signal.throwIfAborted();
    if (!raw.startsWith('data:')) return;
    const data = raw.slice(5).trim();
    if (data === '[DONE]') { finished = true; return; }
    const parsed = JSON.parse(data);
    if (parsed.error) throw new Error(parsed.error.message || 'Inference failed');
    usage = parsed.usage || usage; timings = parsed.timings || timings;
    const choice = parsed.choices?.[0], delta = choice?.delta;
    if (choice?.finish_reason) finished = true;
    if (delta?.content || delta?.reasoning_content) firstTokenSeconds ??= (performance.now() - started) / 1000;
    if (delta?.reasoning_content) onThought(delta.reasoning_content);
    signal.throwIfAborted();
    if (delta?.content) { translation += delta.content; onChunk(delta.content); }
    if (usage || timings) onProgress({ usage, timings, firstTokenSeconds });
  }
  for await (const chunk of body) {
    signal.throwIfAborted();
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n'); buffer = lines.pop(); lines.forEach(line);
  }
  buffer += decoder.decode(); if (buffer.trim()) line(buffer);
  signal.throwIfAborted();
  if (!finished) throw new Error('Inference stream ended before completion');
  return { translation, usage, timings, firstTokenSeconds };
}

function createServerRuntime({ binary, modelPath, projectorPath, contextSize = 8192,
  gpu = 'auto', swaFullCache = true, startupTimeoutMs = 120000, shutdownTimeoutMs = 3000,
  spawnProcess = spawn, onStatus = () => {}, prepareAssets = async () => {} }) {
  let child = null, endpoint = null, key = null, mediaLoaded = false;
  let exited = null, processAbort = null, queue = Promise.resolve(), stopping = null;
  let diagnostics = {};
  const jobs = new Set();
  const headers = () => ({ Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' });

  async function terminate() {
    const current = child;
    if (!current) return;
    endpoint = null;
    processAbort.abort(new Error('Inference process stopped'));
    current.kill('SIGTERM');
    let timer;
    const stopped = await Promise.race([exited.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), shutdownTimeoutMs); })]);
    clearTimeout(timer);
    if (!stopped) {
      current.kill('SIGKILL');
      try { await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Inference process did not exit')), shutdownTimeoutMs); })]); }
      finally { clearTimeout(timer); }
    }
  }

  async function ensure(signal, media = false, report = () => {}) {
    signal.throwIfAborted();
    if (child && endpoint && (!media || mediaLoaded)) return;
    if (media && !projectorPath) throw new Error('A projector is required for image/audio inference');
    await prepareAssets({ signal, media, onStatus: report });
    if (child) await terminate();
    signal.throwIfAborted();
    const port = await freePort();
    signal.throwIfAborted();
    key = crypto.randomBytes(32).toString('hex');
    const args = ['--model', modelPath, '--host', '127.0.0.1', '--port', String(port),
      '--api-key', key, '--ctx-size', String(contextSize), '--parallel', '1', '--jinja',
      '--no-webui', '--offline', '--no-context-shift', '--reasoning-format', 'deepseek'];
    if (media) args.push('--mmproj', projectorPath);
    else args.push('--no-mmproj');
    if (gpu === 'cpu') args.push('--gpu-layers', '0', '--no-mmproj-offload');
    if (swaFullCache) args.push('--swa-full');
    processAbort = new AbortController();
    const ownerAbort = processAbort;
    const current = spawnProcess(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child = current; mediaLoaded = media;
    // Retain only recognized compute counters, never raw runtime logs/prompts.
    diagnostics = { requestedGpu: gpu, swaFullCache };
    for (const stream of [current.stdout, current.stderr]) {
      let tail = '';
      stream?.on('data', chunk => {
        const lines = (tail + chunk.toString()).split('\n'); tail = lines.pop().slice(-1024);
        for (const line of lines) {
          const layers = line.match(/offloaded (\d+)\/(\d+) layers to GPU/);
          if (layers) { diagnostics.offloadedLayers = Number(layers[1]); diagnostics.totalLayers = Number(layers[2]); }
          const backend = line.match(/\b(Metal\d*|CUDA\d*|Vulkan\d*|CPU)(?:_Mapped)?\s+model buffer size/);
          if (backend) diagnostics.modelBufferBackends = [...new Set([...(diagnostics.modelBufferBackends || []), backend[1]])];
        }
      });
    }
    exited = new Promise(resolve => {
      const finish = error => {
        ownerAbort.abort(error || new Error('Inference process exited'));
        if (child === current) { child = null; endpoint = null; mediaLoaded = false; }
        resolve();
      };
      current.once('error', finish); current.once('exit', () => finish());
    });
    const startup = AbortSignal.any([signal, ownerAbort.signal, AbortSignal.timeout(startupTimeoutMs)]);
    const url = `http://127.0.0.1:${port}`;
    onStatus({ state: 'loading', media, pid: current.pid });
    report(media ? 'Loading image/audio model…' : 'Loading embedded model…');
    try {
      for (;;) {
        startup.throwIfAborted();
        try {
          const response = await fetch(`${url}/health`, { headers: headers(), signal: AbortSignal.any([startup, AbortSignal.timeout(1000)]) });
          if (response.ok) { await response.body?.cancel(); startup.throwIfAborted(); endpoint = url; break; }
          await response.body?.cancel();
        } catch { startup.throwIfAborted(); }
        await delay(50, undefined, { signal: startup });
      }
      onStatus({ state: 'ready', media, pid: current.pid });
    } catch (error) { await terminate(); throw error; }
  }

  function enqueue(signal, run) {
    if (stopping) return Promise.reject(new Error('Inference is stopping'));
    const abort = new AbortController();
    const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
    if (combined.aborted) return Promise.reject(combined.reason);
    const job = { abort }; jobs.add(job);
    return new Promise((resolve, reject) => {
      const cancelled = () => reject(combined.reason);
      combined.addEventListener('abort', cancelled, { once: true });
      const execute = async () => {
        let started = false;
        try { combined.throwIfAborted(); started = true; resolve(await run(combined)); }
        catch (error) {
          // A closed socket can precede the OS exit event. Do not let the next
          // request reuse that endpoint or a server still generating after abort.
          if (started) {
            try { if (!combined.aborted || !await waitForIdle()) await terminate(); }
            catch (shutdownError) { reject(shutdownError); return; }
          }
          reject(error);
        }
        finally { combined.removeEventListener('abort', cancelled); jobs.delete(job); }
      };
      queue = queue.then(execute, execute);
    });
  }

  const mediaRequired = options => options.messages?.some(message => message.media?.length);
  function payload(options) {
    return { model: 'gemma', messages: [{ role: 'system', content: options.systemPrompt }, ...openAIMessages(options.messages)],
      chat_template_kwargs: { enable_thinking: Boolean(options.reasoning) } };
  }
  async function post(route, body, signal) {
    const response = await fetch(`${endpoint}${route}`, { method: 'POST', headers: headers(), body: JSON.stringify(body), signal });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Inference request failed (HTTP ${response.status})`); }
    return response;
  }
  async function waitForIdle() {
    // Aborting fetch closes the generation connection. Keep the loaded model
    // only after the server confirms its single slot is idle; otherwise restart.
    if (!child || !endpoint || processAbort.signal.aborted) return false;
    const signal = AbortSignal.any([processAbort.signal, AbortSignal.timeout(1500)]);
    try {
      for (;;) {
        const response = await fetch(`${endpoint}/slots`, { headers: headers(), signal });
        if (!response.ok) { await response.body?.cancel(); return false; }
        const slots = await response.json();
        if (slots.length === 1 && slots[0].is_processing === false) return true;
        await delay(25, undefined, { signal });
      }
    } catch { return false; }
  }
  async function contextState(signal) {
    // b11158 server_slot::to_json exposes the resident prompt token vector,
    // including evaluated generated tokens. Read only numeric counters. Media
    // token accounting needs separate validation, so retain estimates there.
    if (mediaLoaded) return null;
    try {
      const response = await fetch(`${endpoint}/slots`, { headers: headers(), signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]) });
      if (!response.ok) { await response.body?.cancel(); return null; }
      const slots = await response.json(), slot = slots.length === 1 ? slots[0] : null;
      if (!slot || !Number.isSafeInteger(slot.n_prompt_tokens) || !Number.isSafeInteger(slot.n_ctx) || slot.n_ctx <= 0 || slot.n_prompt_tokens < 0 || slot.n_prompt_tokens > slot.n_ctx) return null;
      return { contextTokens: slot.n_prompt_tokens, contextSize: slot.n_ctx, contextEstimated: false, processing: slot.is_processing === true };
    } catch { return null; }
  }
  function statistics({ usage, timings }, occupied, started, firstTokenSeconds) {
    const inputTokens = usage?.prompt_tokens ?? (Number.isFinite(timings?.prompt_n) && Number.isFinite(timings?.cache_n) ? timings.prompt_n + timings.cache_n : null);
    const outputTokens = usage?.completion_tokens ?? timings?.predicted_n ?? null;
    return { inputTokens, outputTokens, inputLabel: 'Prompt tokens',
      cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? timings?.cache_n ?? null,
      contextSize, contextTokens: inputTokens != null && outputTokens != null ? inputTokens + outputTokens : null,
      contextEstimated: true, tps: timings?.predicted_per_second ?? null, firstTokenSeconds,
      elapsedSeconds: (performance.now() - started) / 1000,
      ...(occupied ? { contextTokens: occupied.contextTokens, contextSize: occupied.contextSize, contextEstimated: false } : {}) };
  }
  return {
    load: ({ signal, media = false, onStatus } = {}) => enqueue(signal, active => ensure(active, media, onStatus)),
    countTokens: options => enqueue(options.signal, async active => {
      await ensure(active, mediaRequired(options), options.onStatus);
      const signal = AbortSignal.any([active, processAbort.signal]);
      const response = await post('/v1/chat/completions/input_tokens', payload(options), signal);
      const { input_tokens } = await response.json();
      signal.throwIfAborted();
      if (!Number.isSafeInteger(input_tokens) || input_tokens < 0) throw new Error('Runtime returned an invalid token count');
      return input_tokens;
    }),
    chat: options => enqueue(options.signal, async active => {
      await ensure(active, mediaRequired(options), options.onStatus);
      const signal = AbortSignal.any([active, processAbort.signal]), started = performance.now();
      const response = await post('/v1/chat/completions', { ...payload(options), stream: true,
        stream_options: { include_usage: true }, temperature: 0.2, max_tokens: options.maxTokens ?? 4096,
        cache_prompt: true, timings_per_token: true }, signal);
      const headerSeconds = (performance.now() - started) / 1000;
      let polling = null, progress = null;
      const timer = options.onStats ? setInterval(() => {
        if (polling || !progress) return;
        polling = contextState(signal).then(state => {
          if (!signal.aborted) options.onStats(statistics(progress, state?.processing ? state : null, started,
            progress.firstTokenSeconds == null ? null : headerSeconds + progress.firstTokenSeconds));
        }).catch(() => {}).finally(() => { polling = null; });
      }, 250) : null;
      let result;
      try { result = await readCompletion(response.body, { ...options, signal, onProgress: value => { progress = value; } }); }
      finally { clearInterval(timer); await polling; }
      const occupied = await contextState(signal);
      signal.throwIfAborted();
      const stats = statistics(result, occupied, started, result.firstTokenSeconds == null ? null : headerSeconds + result.firstTokenSeconds);
      options.onStats?.(stats);
      return { translation: result.translation, stats, timings: result.timings };
    }),
    stop() {
      if (stopping) return stopping;
      for (const job of jobs) job.abort.abort(new Error('Inference stopped'));
      stopping = (async () => { await queue; await terminate(); })().finally(() => { stopping = null; });
      return stopping;
    },
    state: () => ({ pid: child?.pid ?? null, ready: Boolean(endpoint), mediaLoaded, diagnostics: { ...diagnostics } }),
  };
}
module.exports = { createServerRuntime, readCompletion };
