const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Hash results are remembered per process only for large files (the model and projector),
// where rehashing costs seconds. File timestamps can be coarse (milliseconds on Linux), so
// small files such as runtime libraries are always rehashed to catch same-size overwrites.
const MEMO_MIN_BYTES = 64 * 1024 * 1024;
const verified = new Map();
async function verify(file, asset, signal) {
  signal?.throwIfAborted();
  let stat;
  try { stat = await fs.promises.stat(file); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!stat.isFile() || (asset.bytes != null && stat.size !== asset.bytes)) return false;
  const signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${asset.sha256}`;
  const memo = stat.size >= MEMO_MIN_BYTES;
  if (memo && verified.get(file) === signature) return true;
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) { signal?.throwIfAborted(); hash.update(chunk); }
  signal?.throwIfAborted();
  if (hash.digest('hex') !== asset.sha256) return false;
  if (memo) verified.set(file, signature);
  return true;
}

async function downloadVerified(asset, destination, { signal, onProgress = () => {}, fetchImpl = fetch } = {}) {
  signal?.throwIfAborted();
  if (await verify(destination, asset, signal)) return destination;
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  const partial = destination + '.part';
  let offset = 0;
  try { offset = (await fs.promises.stat(partial)).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (offset && await verify(partial, asset, signal)) { await fs.promises.rename(partial, destination); return destination; }
  if (asset.bytes != null && offset >= asset.bytes) { await fs.promises.unlink(partial); offset = 0; }
  const response = await fetchImpl(asset.url, { signal, headers: offset ? { Range: `bytes=${offset}-` } : {} });
  if (!response.ok || ![200, 206].includes(response.status)) {
    await response.body?.cancel(); throw new Error(`Asset download failed (HTTP ${response.status}); retry to resume.`);
  }
  let append = false;
  if (response.status === 206) {
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
    if (!range || Number(range[1]) !== offset || Number(range[2]) < offset || Number(range[2]) >= Number(range[3]) || (asset.bytes != null && Number(range[3]) !== asset.bytes)) {
      await response.body?.cancel(); throw new Error('Invalid download resume response; the existing partial file was preserved.');
    }
    append = offset > 0;
  }
  // A server ignoring Range sends 200: safely restart only the partial file.
  if (!append) offset = 0;
  const handle = await fs.promises.open(partial, append ? 'a' : 'w', 0o600);
  let downloaded = offset;
  try {
    for await (const chunk of response.body) {
      signal?.throwIfAborted();
      if (asset.bytes != null && downloaded + chunk.length > asset.bytes) throw new Error('Downloaded asset exceeds its expected size.');
      let written = 0;
      while (written < chunk.length) {
        const { bytesWritten } = await handle.write(chunk, written, chunk.length - written);
        if (!bytesWritten) throw new Error('Could not write downloaded asset.');
        written += bytesWritten;
      }
      downloaded += chunk.length; onProgress(downloaded, asset.bytes ?? Number(response.headers.get('content-length')) + offset);
    }
    await handle.sync();
  } finally { await handle.close(); }
  signal?.throwIfAborted();
  if (asset.bytes != null && downloaded < asset.bytes) throw new Error('Asset download ended early; retry to resume.');
  if (!await verify(partial, asset, signal)) {
    await fs.promises.unlink(partial);
    throw new Error('Downloaded asset checksum did not match. The previous file was preserved; retry the download.');
  }
  await fs.promises.rename(partial, destination);
  return destination;
}
module.exports = { verify, downloadVerified };
