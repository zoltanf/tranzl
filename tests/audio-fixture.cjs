const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
function createM4a(dir, codec = 'aac', seconds = 0.2) {
  const channels = 2, rate = 16000;
  const bytes = Buffer.alloc(44 + Math.round(rate * seconds) * channels * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * channels * 2, 28);
  bytes.writeUInt16LE(channels * 2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  // Put the signal only in the right channel to catch accidental channel dropping.
  if (seconds <= 1) for (let frame = 0; frame < Math.round(rate * seconds); frame++) bytes.writeInt16LE(Math.round(12000 * Math.sin(2 * Math.PI * 440 * frame / rate)), 44 + frame * 4 + 2);
  const source = path.join(dir, 'source.wav'), target = path.join(dir, `${codec}.m4a`);
  fs.writeFileSync(source, bytes);
  execFileSync('/usr/bin/afconvert', ['-f', 'm4af', '-d', codec, source, target]);
  return target;
}
module.exports = { createM4a };
