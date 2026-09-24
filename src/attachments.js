// Document parsing runs in a disposable worker, not on Electron's UI thread.
const fs = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_TEXT = 120000;
const EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'pdf', 'doc', 'docx', 'csv', 'tsv', 'xls', 'xlsx', 'wav', 'mp3', 'flac', 'txt', 'md', 'json', 'js', 'ts', 'jsx', 'tsx', 'py', 'html', 'css', 'xml', 'yaml', 'yml', 'log', 'sql', 'sh', 'rs', 'swift', 'c', 'h', 'cpp', 'java', 'go', 'toml', 'ini'];
function boundedText(content) {
  if (content.length > MAX_TEXT) throw new Error('extracted text exceeds 120,000 characters; attach a smaller section');
  if (!content.trim()) throw new Error('no readable text found');
  return content;
}
async function readAttachment(filename) {
  const stat = await fs.stat(filename);
  if (!stat.isFile()) throw new Error('not a regular file');
  if (stat.size > MAX_BYTES) throw new Error('maximum file size is 20 MB');
  const extension = path.extname(filename).slice(1).toLowerCase();
  if (!EXTENSIONS.includes(extension)) throw new Error('unsupported file type');
  const bytes = await fs.readFile(filename);
  if (bytes.length > MAX_BYTES) throw new Error('maximum file size is 20 MB');
  const file = { name: path.basename(filename), size: bytes.length, kind: 'document', content: '' };
  if (['png', 'jpg', 'jpeg', 'webp'].includes(extension)) {
    const { loadImage, createCanvas } = require('@napi-rs/canvas');
    const image = await loadImage(bytes);
    if (image.width * image.height > 40000000) throw new Error('image exceeds 40 megapixels');
    const scale = Math.min(1, 1600 / Math.max(image.width, image.height));
    const canvas = createCanvas(Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)));
    const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return { ...file, kind: 'image', mime: 'image/jpeg', data: canvas.toBuffer('image/jpeg', 90).toString('base64'), width: canvas.width, height: canvas.height, summary: `${canvas.width} × ${canvas.height}` };
  }
  if (['wav', 'mp3', 'flac'].includes(extension)) {
    const valid = extension === 'wav' ? bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE' : extension === 'flac' ? bytes.toString('ascii', 0, 4) === 'fLaC' : bytes.toString('ascii', 0, 3) === 'ID3' || (bytes[0] === 255 && (bytes[1] & 224) === 224);
    if (!valid) throw new Error(`not a valid ${extension.toUpperCase()} audio file`);
    return { ...file, kind: 'audio', format: extension, mime: { wav: 'audio/wav', mp3: 'audio/mpeg', flac: 'audio/flac' }[extension], data: bytes.toString('base64'), summary: `${extension.toUpperCase()} audio` };
  }
  if (extension === 'pdf') {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: true });
    let pdf;
    try {
      pdf = await task.promise;
      if (pdf.numPages > 100) throw new Error('PDF exceeds 100 pages; attach a smaller section');
      const parts = [], images = [];
      let length = 0;
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const items = (await page.getTextContent()).items;
        let text = '', previous = null;
        for (const item of items) {
          if (typeof item.str !== 'string') continue;
          if (previous && !/\s$/.test(text) && !/^\s/.test(item.str)) {
            const fontSize = Math.abs(previous.transform[0]);
            if (Math.abs(item.transform[5] - previous.transform[5]) > Math.max(2, fontSize * 0.5)) text += '\n';
            else if (item.transform[4] - (previous.transform[4] + previous.width) > Math.max(1, fontSize * 0.15)) text += ' ';
          }
          text += item.str + (item.hasEOL ? '\n' : ''); previous = item;
        }
        if (text.trim()) {
          parts.push(`Page ${i}\n${text}`); length += text.length;
          if (length > MAX_TEXT) throw new Error('PDF text exceeds 120,000 characters; attach a smaller section');
        } else {
          if (images.length >= 4) throw new Error('PDF has more than 4 scanned pages; attach a smaller section');
          const { createCanvas } = require('@napi-rs/canvas');
          const base = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: Math.min(2, 1600 / Math.max(base.width, base.height)) });
          const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
          await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
          images.push({ name: `Page ${i}`, mime: 'image/jpeg', data: canvas.toBuffer('image/jpeg', 90).toString('base64') });
          parts.push(`Page ${i}: scanned page supplied as an image.`);
        }
        page.cleanup();
      }
      return { ...file, content: boundedText(parts.join('\n\n')), images, summary: `${pdf.numPages} pages · ${images.length ? `${images.length} scanned` : 'text extracted'}` };
    } catch (err) {
      if (err.name === 'PasswordException') throw new Error('password-protected PDF; attach an unlocked copy');
      throw err;
    } finally { await task.destroy(); }
  }
  if (extension === 'docx') {
    const result = await require('mammoth').extractRawText({ buffer: bytes });
    file.content = boundedText(result.value); file.summary = 'Word text extracted';
  } else if (extension === 'doc') {
    if (process.platform !== 'darwin') throw new Error('legacy .doc reading requires macOS; save as .docx');
    const { stdout } = await promisify(execFile)('/usr/bin/textutil', ['-format', 'doc', '-convert', 'txt', '-stdout', filename], { timeout: 20000, maxBuffer: MAX_TEXT * 4 });
    file.content = boundedText(stdout); file.summary = 'Word text extracted';
  } else if (['xls', 'xlsx'].includes(extension)) {
    const XLSX = require('xlsx');
    const book = XLSX.read(bytes, { type: 'buffer', cellDates: true, cellFormula: false, bookVBA: false, sheetRows: 10001 });
    const parts = []; let length = 0;
    for (const name of book.SheetNames) {
      const sheet = book.Sheets[name];
      const range = sheet['!fullref'] || sheet['!ref'];
      if (range && XLSX.utils.decode_range(range).e.r >= 10000) throw new Error(`sheet “${name}” exceeds 10,000 rows; export a smaller range`);
      const content = `Sheet: ${name}\n${XLSX.utils.sheet_to_csv(sheet, { blankrows: false })}`;
      length += content.length;
      if (length > MAX_TEXT) throw new Error('spreadsheet text exceeds 120,000 characters; export a smaller range');
      parts.push(content);
    }
    file.content = boundedText(parts.join('\n\n')); file.summary = `${book.SheetNames.length} sheets · cell values extracted`;
  } else {
    let content;
    if (bytes[0] === 255 && bytes[1] === 254) content = new TextDecoder('utf-16le', { fatal: true }).decode(bytes);
    else content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (content.includes('\0')) throw new Error('not a supported text encoding');
    file.content = boundedText(content); file.kind = 'text'; file.summary = ['csv', 'tsv'].includes(extension) ? 'Tabular text' : 'Text';
  }
  return file;
}
module.exports = { readAttachment, EXTENSIONS, MAX_BYTES, MAX_TEXT };
