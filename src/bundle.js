import crypto from 'node:crypto';

// Many small files packed into one HTTP body, so a folder of 10k tiny files costs a
// handful of requests instead of 10k round trips (the main reason SFTP is slow on them).
// Wire format: repeated [u32 BE header length][header JSON][file bytes], ended by a zero length.

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

/** entries: [{ header: { path, mtime }, data: Buffer }] */
export function encodeBundle(entries) {
  const parts = [];
  for (const { header, data } of entries) {
    const head = Buffer.from(JSON.stringify({ ...header, size: data.length, sha256: sha256(data) }));
    const len = Buffer.alloc(4);
    len.writeUInt32BE(head.length);
    parts.push(len, head, data);
  }
  parts.push(Buffer.alloc(4));
  return Buffer.concat(parts);
}

export function decodeBundle(buf) {
  const entries = [];
  let off = 0;
  for (;;) {
    if (off + 4 > buf.length) throw new Error('truncated bundle');
    const headLen = buf.readUInt32BE(off);
    off += 4;
    if (headLen === 0) break;
    if (off + headLen > buf.length) throw new Error('truncated bundle header');
    const header = JSON.parse(buf.subarray(off, off + headLen).toString());
    off += headLen;
    if (!Number.isSafeInteger(header.size) || header.size < 0 || off + header.size > buf.length) {
      throw new Error('bad bundle entry size');
    }
    const data = buf.subarray(off, off + header.size);
    off += header.size;
    if (sha256(data) !== header.sha256) throw new Error(`bundle entry ${header.path} corrupted`);
    entries.push({ header, data });
  }
  if (off !== buf.length) throw new Error('trailing bytes after bundle');
  return entries;
}
