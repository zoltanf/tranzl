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
// Synthetic fixtures (generated once with macOS textutil) keep Word reading tests portable.
for (const format of ['doc', 'docx']) test(`reads ${format} text locally`, async () => {
  const result = await readAttachment(path.join(__dirname, 'fixtures', `synthetic.${format}`));
  assert.match(result.content, /Project notes/); assert.match(result.content, /The meeting is on Friday\./);
  assert.match(result.content, /Grüße aus Wien – “quoted” text\./); assert.match(result.content, /Privacy\s+Local/);
  assert.doesNotMatch(result.content, /\r/);
});
test('damaged legacy DOC fails clearly', async () => {
  await assert.rejects(fixture('broken.doc', 'not a Word document', () => {}), /could not read this \.doc file/);
});

for (const rows of [10000, 10001, 10002]) test(`spreadsheet row limit at ${rows} rows`, async () => {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(Array.from({ length: rows }, () => ['x'])), 'Rows');
  const check = fixture('rows.xlsx', XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }), file => assert.match(file.content, /Sheet: Rows/));
  if (rows > 10000) await assert.rejects(check, /exceeds 10,000 rows/);
  else await check;
});

const m4a = codec => path.join(__dirname, 'fixtures', `synthetic-${codec}.m4a`);
function assertMonoWav(file, name) {
  assert.equal(file.name, name); assert.equal(file.kind, 'audio');
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
}
// A tiny valid WAV standing in for Chromium's decoder output.
const fakeWav = Buffer.concat([Buffer.from('RIFF\0\0\0\0WAVE'), Buffer.alloc(32)]);
// Copy of a fixture whose header claims a different duration (models long or lying files).
async function withDeclaredSeconds(codec, seconds, run) {
  const bytes = await fs.readFile(m4a(codec)), body = bytes.indexOf('mvhd') + 4;
  bytes.writeUInt32BE(Math.round(seconds * bytes.readUInt32BE(body + 12)), body + 16);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tranzl-m4a-')), file = path.join(dir, `${codec}.m4a`);
  try { await fs.writeFile(file, bytes); await run(file); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
test('M4A headers report codec and declared duration', async () => {
  const { mp4Info } = require('../src/attachments');
  for (const [codec, fourcc] of [['aac', 'mp4a'], ['alac', 'alac']]) {
    const info = mp4Info(await fs.readFile(m4a(codec)));
    // AAC containers also count encoder priming/padding frames.
    assert.equal(info.codec, fourcc); assert.ok(info.seconds >= 0.2 && info.seconds < 0.5, `${codec}: ${info.seconds}`);
  }
  assert.deepEqual(mp4Info(Buffer.from('not audio')), {});
  assert.deepEqual(mp4Info(Buffer.from([0, 0, 0, 200, 0x6d, 0x6f, 0x6f, 0x76])), {}); // truncated box
});
test('AAC M4A uses the Chromium decoder on every platform', async () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const calls = [];
    const file = await readAttachment(m4a('aac'), { platform, decodeAudio: async (bytes, options) => { calls.push(options); return fakeWav; } });
    assert.equal(file.format, 'wav'); assert.deepEqual(Buffer.from(file.data, 'base64'), fakeWav);
    assert.deepEqual(calls, [{ maxBytes: 20 * 1024 * 1024 }]);
  }
});
test('Apple Lossless and undecodable M4A are explained off macOS', async () => {
  let called = false;
  const decodeAudio = async () => { called = true; return null; };
  await assert.rejects(readAttachment(m4a('alac'), { platform: 'linux', decodeAudio }), /Apple Lossless \(ALAC\) M4A is not supported on this platform; convert it to FLAC or WAV/);
  assert.equal(called, false, 'ALAC skips Chromium');
  await assert.rejects(readAttachment(m4a('aac'), { platform: 'win32', decodeAudio }), /could not decode M4A audio/);
});
test('M4A declaring more audio than fits the WAV limit is rejected before decoding', async () => {
  let called = false;
  await withDeclaredSeconds('aac', 700, async file => {
    await assert.rejects(readAttachment(file, { platform: 'linux', decodeAudio: async () => { called = true; return fakeWav; } }), /converted audio exceeds 20 MB/);
  });
  assert.equal(called, false);
  await assert.rejects(readAttachment(m4a('aac'), { platform: 'linux', decodeAudio: async () => Buffer.alloc(20 * 1024 * 1024 + 1) }), /converted audio exceeds 20 MB/);
  await assert.rejects(readAttachment(m4a('aac'), { platform: 'linux', decodeAudio: async () => Buffer.from('not a wav file') }), /did not produce valid audio/);
});

// macOS Core Audio adapter: Apple Lossless, and the fallback when Chromium cannot decode.
for (const codec of ['aac', 'alac']) test(`macOS converts ${codec} M4A locally to mono WAV and preserves the original`, { skip: process.platform !== 'darwin' }, async () => {
  const before = (await fs.readdir(os.tmpdir())).filter(name => name.startsWith('tranzl-audio-')).sort();
  const original = await fs.readFile(m4a(codec));
  assertMonoWav(await readAttachment(m4a(codec), { decodeAudio: async () => null }), `synthetic-${codec}.m4a`);
  assert.deepEqual(await fs.readFile(m4a(codec)), original);
  assert.deepEqual((await fs.readdir(os.tmpdir())).filter(name => name.startsWith('tranzl-audio-')).sort(), before);
});
test('invalid M4A fails clearly and removes conversion files', { skip: process.platform !== 'darwin' }, async () => {
  const before = (await fs.readdir(os.tmpdir())).filter(name => name.startsWith('tranzl-audio-')).sort();
  await assert.rejects(fixture('broken.m4a', 'not audio', () => {}), /could not decode M4A/);
  assert.deepEqual((await fs.readdir(os.tmpdir())).filter(name => name.startsWith('tranzl-audio-')).sort(), before);
});
test('compressed M4A with a misleading header cannot bypass the decoded audio size limit', { skip: process.platform !== 'darwin' }, async () => {
  const { createM4a } = require('./audio-fixture.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tranzl-m4a-limit-'));
  const before = (await fs.readdir(os.tmpdir())).filter(name => name.startsWith('tranzl-audio-')).sort();
  try {
    const source = createM4a(dir, 'aac', 660), bytes = await fs.readFile(source), body = bytes.indexOf('mvhd') + 4;
    bytes.writeUInt32BE(bytes.readUInt32BE(body + 12), body + 16); // claims one second
    await fs.writeFile(source, bytes);
    assert.ok(bytes.length < 20 * 1024 * 1024);
    await assert.rejects(readAttachment(source), /converted audio exceeds 20 MB/);
    assert.deepEqual((await fs.readdir(os.tmpdir())).filter(name => name.startsWith('tranzl-audio-')).sort(), before);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('attachment capabilities report platform limits', () => {
  const { attachmentCapabilities, EXTENSIONS } = require('../src/attachments');
  assert.deepEqual(attachmentCapabilities('darwin').unsupported, []);
  for (const platform of ['linux', 'win32']) assert.deepEqual(attachmentCapabilities(platform).unsupported, ['Apple Lossless (ALAC) M4A']);
  assert.ok(['doc', 'docx', 'm4a'].every(extension => attachmentCapabilities('linux').extensions.includes(extension)));
  assert.equal(attachmentCapabilities().extensions, EXTENSIONS);
});
