// Only called in response to an explicit paste action. Clipboard contents are
// normalized in memory and are never written to temporary plaintext files.
function readClipboardImage(clipboard) {
  let image = clipboard.readImage();
  if (image.isEmpty()) return { file: null };
  const original = image.getSize();
  if (original.width * original.height > 40000000) return { error: 'Clipboard image exceeds 40 megapixels.' };
  const scale = Math.min(1, 1600 / Math.max(original.width, original.height));
  if (scale < 1) image = image.resize({ width: Math.round(original.width * scale), height: Math.round(original.height * scale), quality: 'best' });
  const bytes = image.toPNG();
  if (bytes.length > 20 * 1024 * 1024) return { error: 'Clipboard image exceeds 20 MB.' };
  const { width, height } = image.getSize();
  return { file: { name: 'Pasted image.png', kind: 'image', mime: 'image/png', data: bytes.toString('base64'), size: bytes.length, width, height, content: '', summary: `${width} × ${height} · clipboard` } };
}
module.exports = { readClipboardImage };
