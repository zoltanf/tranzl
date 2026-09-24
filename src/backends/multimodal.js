// On-demand local llama.cpp server. Uses the existing Gemma GGUF plus a pinned
// vision/audio projector. Binds only to loopback with a per-process API key.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const { openAIMessages } = require('../chatProtocol');
const VERSION = 'b11158';
const RUNTIME_URL = `https://github.com/ggml-org/llama.cpp/releases/download/${VERSION}/llama-${VERSION}-bin-macos-arm64.tar.gz`;
const RUNTIME_SHA = 'baf0d6366819beab9c4b85304117c5ab2f8a078c1a144ac26153efab48b884b8';
const PROJECTOR_URL = 'https://huggingface.co/ggml-org/gemma-4-E4B-it-GGUF/resolve/b8093469224f83f5c38f691eb906c380e9e63114/mmproj-gemma-4-E4B-it-Q8_0.gguf';
const PROJECTOR_SHA = '197f49a93027f9843772bd24a6a9e0be2a32a788de5a3def330e9c585d86edd1';
let processHandle = null, endpoint = null, apiKey = null, starting = null;
async function download(url, destination, digest, signal, progress) {
  const temp = destination + '.part';
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Download failed (${response.status}); please try again.`);
  const file = await fs.promises.open(temp, 'w', 0o600);
  const hash = crypto.createHash('sha256'); let size = 0, lastUpdate = 0;
  const total = Number(response.headers.get('content-length'));
  try {
    for await (const chunk of response.body) {
      signal.throwIfAborted(); await file.writeFile(chunk); hash.update(chunk); size += chunk.length;
      if (Date.now() - lastUpdate > 500) { progress(`${Math.round(size / 1048576)} MB${total ? ` / ${Math.round(total / 1048576)} MB` : ''}`); lastUpdate = Date.now(); }
    }
    if (hash.digest('hex') !== digest) throw new Error('Downloaded component checksum did not match. Please retry.');
  } finally { await file.close(); }
  await fs.promises.rename(temp, destination);
}
async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer(); server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
}
function stop() { processHandle?.kill('SIGTERM'); processHandle = null; endpoint = null; }
async function ensure({ dir, modelPath, signal, onStatus, releaseTextModel }) {
  if (endpoint && processHandle) return;
  if (starting) return starting;
  starting = (async () => {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Embedded image/audio inference currently requires an Apple Silicon Mac.');
    if (!modelPath || !fs.existsSync(modelPath)) throw new Error('Download the embedded model in Settings first.');
    await fs.promises.mkdir(dir, { recursive: true });
    const binary = path.join(dir, `llama-${VERSION}`, 'llama-server');
    if (!fs.existsSync(binary)) {
      onStatus('Downloading local image/audio runtime (11 MB)…');
      const archive = path.join(dir, `llama-${VERSION}.tar.gz`);
      await download(RUNTIME_URL, archive, RUNTIME_SHA, signal, size => onStatus(`Downloading image/audio runtime: ${size}`));
      await promisify(execFile)('/usr/bin/tar', ['-xzf', archive, '-C', dir], { signal });
      await fs.promises.unlink(archive);
    }
    const projector = path.join(dir, 'gemma-4-E4B-mmproj-Q8_0.gguf');
    if (!fs.existsSync(projector)) {
      onStatus('Downloading Gemma image/audio component (534 MB, once)…');
      await download(PROJECTOR_URL, projector, PROJECTOR_SHA, signal, size => onStatus(`Downloading Gemma image/audio component: ${size}`));
    }
    signal.throwIfAborted();
    await releaseTextModel();
    onStatus('Loading Gemma with image and audio support…');
    const port = await freePort(); apiKey = crypto.randomBytes(32).toString('hex');
    let log = '', spawnError;
    const child = spawn(binary, ['--model', modelPath, '--mmproj', projector, '--host', '127.0.0.1', '--port', String(port), '--api-key', apiKey, '--ctx-size', '8192', '--parallel', '1', '--jinja', '--no-webui'], { stdio: ['ignore', 'pipe', 'pipe'] });
    processHandle = child;
    child.stdout.on('data', data => { log = (log + data).slice(-4000); });
    child.stderr.on('data', data => { log = (log + data).slice(-4000); });
    child.on('error', error => { spawnError = error; });
    child.on('exit', () => { if (processHandle === child) { processHandle = null; endpoint = null; } });
    const url = `http://127.0.0.1:${port}`;
    try {
      for (let i = 0; i < 240; i++) {
        signal.throwIfAborted();
        if (spawnError || child.exitCode != null || processHandle !== child) throw new Error(`Image/audio runtime could not start: ${spawnError?.message || log.slice(-1200)}`);
        try { const response = await fetch(`${url}/health`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(1000) }); if (response.ok) { endpoint = url; return; } } catch {}
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      throw new Error('Image/audio model loading timed out.');
    } catch (error) { stop(); throw error; }
  })();
  try { await starting; } finally { starting = null; }
}
async function chat(options) {
  await ensure(options);
  const { signal, systemPrompt, messages, reasoning, onChunk, onThought } = options;
  const t0 = Date.now(); let first = 0;
  const response = await fetch(`${endpoint}/v1/chat/completions`, { method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: 'gemma', messages: [{ role: 'system', content: systemPrompt }, ...openAIMessages(messages)], stream: true, stream_options: { include_usage: true }, temperature: 0.2, max_tokens: options.maxTokens ?? 4096, cache_prompt: true, chat_template_kwargs: { enable_thinking: reasoning } }),
  });
  if (!response.ok) throw new Error(`Image/audio request failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
  let buffer = '', translation = '', usage, timings;
  const decoder = new TextDecoder();
  function line(raw) {
    const data = raw.trim(); if (!data.startsWith('data:') || data.slice(5).trim() === '[DONE]') return;
    const parsed = JSON.parse(data.slice(5));
    if (parsed.error) throw new Error(parsed.error.message || JSON.stringify(parsed.error));
    usage = parsed.usage || usage; timings = parsed.timings || timings;
    const delta = parsed.choices?.[0]?.delta;
    if (delta?.content || delta?.reasoning_content) { if (!first) first = Date.now(); }
    if (delta?.content) { translation += delta.content; onChunk(delta.content); }
    if (delta?.reasoning_content) onThought(delta.reasoning_content);
  }
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true }); const lines = buffer.split('\n'); buffer = lines.pop(); lines.forEach(line);
  }
  buffer += decoder.decode(); if (buffer.trim()) line(buffer);
  const outputTokens = usage?.completion_tokens ?? null, inputTokens = usage?.prompt_tokens ?? null;
  return { translation, stats: { inputTokens, outputTokens, cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? timings?.cache_n ?? null,
    contextSize: 8192, contextTokens: inputTokens != null && outputTokens != null ? inputTokens + outputTokens : null, contextEstimated: true,
    tps: timings?.predicted_per_second ?? (outputTokens != null && first && Date.now() > first ? outputTokens / ((Date.now() - first) / 1000) : null),
    elapsedSeconds: (Date.now() - t0) / 1000, firstTokenSeconds: first ? (first - t0) / 1000 : null } };
}
async function countTokens(options) {
  await ensure(options);
  const response = await fetch(`${endpoint}/v1/chat/completions/input_tokens`, {
    method: 'POST', signal: options.signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: 'gemma', messages: [{ role: 'system', content: options.systemPrompt }, ...openAIMessages(options.messages)],
      chat_template_kwargs: { enable_thinking: options.reasoning } }),
  });
  if (!response.ok) throw new Error(`Could not measure context (${response.status}): ${(await response.text()).slice(0, 300)}`);
  const { input_tokens } = await response.json();
  if (!Number.isFinite(input_tokens)) throw new Error('Runtime did not return a valid context token count.');
  return input_tokens;
}
module.exports = { countTokens, chat, stop, isActive: () => Boolean(processHandle || starting), ensure, VERSION };
