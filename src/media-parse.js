/**
 * Byte-level helpers for media upload (Phase 5c) — none of this needs a
 * decoder: Workers has no `Image`/canvas, so dimensions are read straight
 * out of each format's header instead of rendering the file.
 */

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Lowercased, path-stripped, safe-charset filename — keeps the extension, collapses everything else to `-`. */
export function sanitizeFilename(name) {
  const base = String(name || 'upload').split(/[/\\]/).pop().toLowerCase();
  const cleaned = base
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/-\./g, '.') // "weird??.jpg" shouldn't end up as "weird-.jpg"
    .replace(/^[.-]+|[.-]+$/g, '');
  return cleaned.slice(0, 120) || 'upload';
}

function readUint16BE(view, offset) {
  return view.getUint16(offset, false);
}

function readUint32BE(view, offset) {
  return view.getUint32(offset, false);
}

function detectPng(view) {
  // 8-byte signature, then a 4-byte length + "IHDR" before width/height — a
  // fixed offset, since IHDR is always the first chunk in a valid PNG.
  if (view.byteLength < 24) return null;
  const signatureOk = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => view.getUint8(i) === b);
  if (!signatureOk) return null;
  const isIHDR = view.getUint32(12, false) === 0x49484452; // "IHDR"
  if (!isIHDR) return null;
  return { width: readUint32BE(view, 16), height: readUint32BE(view, 20) };
}

function detectGif(view) {
  if (view.byteLength < 10) return null;
  const sig = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2));
  if (sig !== 'GIF') return null;
  return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
}

function detectJpeg(view) {
  if (view.byteLength < 4 || view.getUint16(0, false) !== 0xffd8) return null;
  let offset = 2;
  while (offset + 4 <= view.byteLength) {
    if (view.getUint8(offset) !== 0xff) return null; // not a marker where one was expected — malformed
    const marker = view.getUint8(offset + 1);
    // Standalone markers (no length/payload) — skip past just the marker itself.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2;
      continue;
    }
    const length = readUint16BE(view, offset + 2);
    const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSOF) {
      if (offset + 9 > view.byteLength) return null;
      return { height: readUint16BE(view, offset + 5), width: readUint16BE(view, offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

function detectWebp(view) {
  if (view.byteLength < 30) return null;
  const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  const webp = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
  if (riff !== 'RIFF' || webp !== 'WEBP') return null;
  const chunkId = String.fromCharCode(view.getUint8(12), view.getUint8(13), view.getUint8(14), view.getUint8(15));
  const data = 20; // chunk payload starts after the 8-byte RIFF header + 4-byte FourCC + 4-byte chunk size

  if (chunkId === 'VP8 ') {
    // Lossy: 3-byte frame tag + 3-byte start code (0x9d 0x01 0x2a), then two
    // little-endian uint16s whose low 14 bits are width/height.
    if (data + 10 > view.byteLength) return null;
    if (view.getUint8(data + 3) !== 0x9d || view.getUint8(data + 4) !== 0x01 || view.getUint8(data + 5) !== 0x2a) {
      return null;
    }
    const w = view.getUint16(data + 6, true) & 0x3fff;
    const h = view.getUint16(data + 8, true) & 0x3fff;
    return { width: w, height: h };
  }
  if (chunkId === 'VP8L') {
    // Lossless: 1-byte signature (0x2f), then 4 bytes packing 14-bit width-1
    // and 14-bit height-1, little-endian across the whole 32 bits.
    if (data + 5 > view.byteLength || view.getUint8(data) !== 0x2f) return null;
    const bits = view.getUint32(data + 1, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunkId === 'VP8X') {
    // Extended: 1 byte flags + 3 reserved, then 24-bit (canvas width - 1)
    // and 24-bit (canvas height - 1), both little-endian.
    if (data + 10 > view.byteLength) return null;
    const w = view.getUint8(data + 4) | (view.getUint8(data + 5) << 8) | (view.getUint8(data + 6) << 16);
    const h = view.getUint8(data + 7) | (view.getUint8(data + 8) << 8) | (view.getUint8(data + 9) << 16);
    return { width: w + 1, height: h + 1 };
  }
  return null;
}

/**
 * Best-effort width/height straight from the file header. Returns `null`
 * (not an error) for a format this doesn't parse — AVIF is in the upload
 * allow-list but not handled here: its dimensions live in a nested ISOBMFF
 * box structure (meta/iprp/ipco/ispe) that's real parsing work of its own,
 * and shipping it untested against real AVIF fixtures felt worse than a
 * post with no width/height recorded. A post uploads fine either way; it
 * just won't get an aspect-ratio-aware `<img>` for that one format yet.
 */
export function detectDimensions(bytes, contentType) {
  const view = new DataView(bytes.buffer || bytes, bytes.byteOffset || 0, bytes.byteLength);
  try {
    if (contentType === 'image/png') return detectPng(view);
    if (contentType === 'image/jpeg') return detectJpeg(view);
    if (contentType === 'image/gif') return detectGif(view);
    if (contentType === 'image/webp') return detectWebp(view);
    return null;
  } catch {
    return null; // truncated/malformed header — upload still proceeds, just without dimensions
  }
}
