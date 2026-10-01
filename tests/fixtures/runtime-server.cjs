// Tiny authenticated HTTP child for lifecycle tests; never used by the app.
const http = require('node:http');
const fs = require('node:fs');
const args = process.argv.slice(3), arg = name => args[args.indexOf(name) + 1];
const key = args.includes('--api-key-file') ? fs.readFileSync(arg('--api-key-file'), 'utf8').trim() : undefined;
if (process.argv[2] === 'ignore-term') process.on('SIGTERM', () => {});
// gpu-fail: a GPU that cannot allocate, until started CPU-only. load-fail: a damaged model.
if (process.argv[2] === 'gpu-fail' && !args.includes('--gpu-layers')) { console.error('ggml_metal_device_init: failed to allocate Metal buffer of 4000000000 bytes (out of memory)'); process.exit(1); }
if (process.argv[2] === 'load-fail') { console.error('llama_model_load: error loading model: tensor data is corrupt'); process.exit(1); }
if (process.argv[2] === 'hang') { setInterval(() => {}, 1000); }
else http.createServer(async (req, res) => {
  if (process.env.TRANZL_FIXTURE_REQUESTS) fs.appendFileSync(process.env.TRANZL_FIXTURE_REQUESTS, req.url + '\n');
  if (req.headers.authorization !== `Bearer ${key}`) { res.writeHead(401).end(); return; }
  if (req.url === '/health') { res.end('{}'); return; }
  if (req.url === '/slots') {
    if (process.argv[2] === 'missing-slots') { res.writeHead(404).end(); return; }
    res.end(JSON.stringify([{ n_prompt_tokens: process.argv[2] === 'invalid-slots' ? 9000 : 14, n_ctx: 8192, is_processing: false }])); return;
  }
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  if (req.url.endsWith('/input_tokens')) { res.end(JSON.stringify({ input_tokens: 12 })); return; }
  const content = body.messages.at(-1).content;
  if (content === 'crash') { process.exit(2); }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: typeof content === 'string' ? content : 'media' } }] })}\n\n`);
  if (content === 'slow') {
    const timer = setTimeout(() => res.end('data: [DONE]\n\n'), 5000);
    res.on('close', () => clearTimeout(timer));
  } else res.end('data: [DONE]\n\n');
}).listen(Number(arg('--port')), '127.0.0.1', () => {
  // Like llama-server; 'quiet' never announces itself, so the runtime must not contact it.
  if (process.argv[2] !== 'quiet') console.error(`srv  llama_server: listening on http://127.0.0.1:${arg('--port')}`);
});
