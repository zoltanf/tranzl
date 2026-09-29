// Tiny authenticated HTTP child for lifecycle tests; never used by the app.
const http = require('node:http');
const args = process.argv.slice(3), arg = name => args[args.indexOf(name) + 1];
if (process.argv[2] === 'ignore-term') process.on('SIGTERM', () => {});
if (process.argv[2] === 'hang') { setInterval(() => {}, 1000); }
else http.createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${arg('--api-key')}`) { res.writeHead(401).end(); return; }
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
}).listen(Number(arg('--port')), '127.0.0.1');
