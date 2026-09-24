const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { readAttachment } = require('../src/attachments');
const { validateMessages, openAIMessages, ollamaMessages } = require('../src/chatProtocol');
const XLSX = require('xlsx');
const { createCanvas } = require('@napi-rs/canvas');
async function fixture(name, content, run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tranzl-attachment-'));
  const file = path.join(dir, name);
  try { await fs.writeFile(file, content); await run(await readAttachment(file)); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
}
test('reads CSV including quoted values and unicode', async () => {
  await fixture('data.csv', 'Name,Amount\n"Fekete, Zoltán",42\n', f => { assert.match(f.content, /Zoltán/); assert.match(f.content, /42/); });
});
for (const type of ['xlsx', 'xls']) test(`reads all sheets from ${type}`, async () => {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Item', 'Qty'], ['Apples', 17]]), 'Stock');
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Total'], [42]]), 'Totals');
  await fixture(`book.${type}`, XLSX.write(book, { type: 'buffer', bookType: type === 'xls' ? 'biff8' : 'xlsx' }), f => {
    assert.match(f.content, /Sheet: Stock/); assert.match(f.content, /Apples,17/); assert.match(f.content, /Sheet: Totals/); assert.match(f.content, /42/);
  });
});
test('image is decoded, resized and encoded for local inference', async () => {
  const canvas = createCanvas(2000, 1000); canvas.getContext('2d').fillRect(0, 0, 2000, 1000);
  await fixture('picture.png', canvas.toBuffer('image/png'), f => { assert.equal(f.kind, 'image'); assert.equal(f.width, 1600); assert.equal(f.height, 800); assert.equal(f.mime, 'image/jpeg'); });
});
test('audio keeps its bytes and format', async () => {
  const bytes = Buffer.alloc(44); bytes.write('RIFF'); bytes.write('WAVE', 8);
  await fixture('sample.wav', bytes, f => { assert.equal(f.kind, 'audio'); assert.equal(f.format, 'wav'); assert.deepEqual(Buffer.from(f.data, 'base64'), bytes); });
});
test('multimodal payloads preserve user turns and map images to both APIs', () => {
  const messages = [{ role: 'user', content: 'Read this', media: [{ kind: 'image', mime: 'image/png', data: 'aGVsbG8=' }] }];
  validateMessages(messages);
  assert.equal(openAIMessages(messages)[0].content[1].image_url.url, 'data:image/png;base64,aGVsbG8=');
  assert.deepEqual(ollamaMessages(messages)[0].images, ['aGVsbG8=']);
  messages[0].media = [{ kind: 'audio', format: 'wav', data: 'aGVsbG8=' }];
  validateMessages(messages);
  assert.equal(openAIMessages(messages)[0].content[1].type, 'input_audio');
  assert.throws(() => ollamaMessages(messages), /Embedded/);
});
test('rejects unsupported media and unsafe remote attachment payloads', () => {
  assert.throws(() => validateMessages([{ role: 'user', content: 'test', media: [{ kind: 'image', mime: 'image/svg+xml', data: 'aGVsbG8=' }] }]), /Unsupported/);
  assert.throws(() => validateMessages([{ role: 'user', content: 'test', media: [{ kind: 'image', mime: 'image/png', data: 'https://example.com' }] }]), /Invalid media/);
});
// Minimal PDF generated here so the tests do not depend on a document tool.
function pdf(content) {
  const stream = content;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let body = '%PDF-1.4\n', offsets = [0];
  objects.forEach((o, i) => { offsets.push(body.length); body += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const start = body.length;
  body += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return body;
}
test('PDF text is extracted with page labels', async () => {
  await fixture('text.pdf', pdf('BT /F1 12 Tf 20 150 Td (Revenue is 123 dollars) Tj ET'), f => { assert.match(f.content, /Revenue is 123/); assert.match(f.content, /Page 1/); assert.equal(f.images.length, 0); });
});
test('PDF without text becomes an image for model reading', async () => {
  await fixture('scan.pdf', pdf('1 0 0 rg 20 20 100 100 re f'), f => { assert.equal(f.images.length, 1); assert.equal(f.images[0].mime, 'image/jpeg'); assert.match(f.content, /scanned/); });
});
for (const format of ['doc', 'docx']) test(`reads ${format} text locally`, { skip: process.platform !== 'darwin' }, async () => {
  const { execFileSync } = require('node:child_process');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tranzl-word-'));
  try {
    const source = path.join(dir, 'source.txt'), target = path.join(dir, `document.${format}`);
    await fs.writeFile(source, 'Project notes\nThe meeting is on Friday.');
    execFileSync('/usr/bin/textutil', ['-convert', format, '-output', target, source]);
    const result = await readAttachment(target);
    assert.match(result.content, /Project notes/); assert.match(result.content, /Friday/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

for (const rows of [10000, 10001, 10002]) test(`spreadsheet row limit at ${rows} rows`, async () => {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(Array.from({ length: rows }, () => ['x'])), 'Rows');
  const check = fixture('rows.xlsx', XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }), file => assert.match(file.content, /Sheet: Rows/));
  if (rows > 10000) await assert.rejects(check, /exceeds 10,000 rows/);
  else await check;
});

for (const codec of ['aac', 'alac']) test(`M4A ${codec} converts locally to mono WAV and preserves the original`, { skip: process.platform !== 'darwin' }, async () => {
  const { createM4a } = require('./audio-fixture.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tranzl-m4a-test-'));
  const before = (await fs.readdir(os.tmpdir())).filter(name => name.startsWith('tranzl-audio-')).sort();
  try {
    const source = createM4a(dir, codec), original = await fs.readFile(source);
    const file = await readAttachment(source);
    assert.equal(file.name, `${codec}.m4a`); assert.equal(file.kind, 'audio');
    assert.equal(file.format, 'wav'); assert.equal(file.mime, 'audio/wav');
    const wav = Buffer.from(file.data, 'base64');
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    const fmt = wav.indexOf('fmt ');
    assert.equal(wav.readUInt16LE(fmt + 8), 1);
    assert.equal(wav.readUInt16LE(fmt + 10), 1);
    assert.equal(wav.readUInt32LE(fmt + 12), 16000);
    assert.equal(wav.readUInt16LE(fmt + 22), 16);
    const data = wav.indexOf('data') + 8;
    let peak = 0;
    for (let i = data; i + 1 < wav.length; i += 2) peak = Math.max(peak, Math.abs(wav.readInt16LE(i)));
    assert.ok(peak > 1000, 'the right audio channel must survive mono conversion');
    validateMessages([{ role: 'user', content: 'Transcribe', media: [file] }]);
    assert.equal(openAIMessages([{ role: 'user', content: 'Transcribe', media: [file] }])[0].content.at(-1).input_audio.format, 'wav');
    assert.deepEqual(await fs.readFile(source), original);
    assert.deepEqual((await fs.readdir(os.tmpdir())).filter(name => name.startsWith('tranzl-audio-')).sort(), before);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('invalid M4A fails clearly and removes conversion files', { skip: process.platform !== 'darwin' }, async () => {
  const before = (await fs.readdir(os.tmpdir())).filter(name => name.startsWith('tranzl-audio-')).sort();
  await assert.rejects(fixture('broken.m4a', 'not audio', () => {}), /could not decode M4A/);
  assert.deepEqual((await fs.readdir(os.tmpdir())).filter(name => name.startsWith('tranzl-audio-')).sort(), before);
});
test('compressed M4A cannot bypass the decoded audio size limit', { skip: process.platform !== 'darwin' }, async () => {
  const { createM4a } = require('./audio-fixture.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tranzl-m4a-limit-'));
  const before = (await fs.readdir(os.tmpdir())).filter(name => name.startsWith('tranzl-audio-')).sort();
  try {
    const source = createM4a(dir, 'aac', 660);
    assert.ok((await fs.stat(source)).size < 20 * 1024 * 1024);
    await assert.rejects(readAttachment(source), /converted audio exceeds 20 MB/);
    assert.deepEqual((await fs.readdir(os.tmpdir())).filter(name => name.startsWith('tranzl-audio-')).sort(), before);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
