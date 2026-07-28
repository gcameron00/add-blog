import { describe, expect, it } from 'vitest';
import { detectDimensions, sanitizeFilename, sha256Hex } from './media-parse.js';

// Real, minimal files generated with ImageMagick (`magick -size WxH xc:color out.ext`)
// — not hand-built byte arrays — so the parsers below are checked against
// actual encoder output, not against my own assumptions about the format.
const FIXTURES = {
  png: {
    base64:
      'iVBORw0KGgoAAAANSUhEUgAAAAwAAAAHAQMAAAAGfD5nAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURf8AAP///0EdNBEAAAABYktHRAH/Ai3eAAAAB3RJTUUH6gccESQgBIauWgAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wNy0yOFQxNzozNjozMiswMDowMP7sXxMAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDctMjhUMTc6MzY6MzIrMDA6MDCPseevAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTA3LTI4VDE3OjM2OjMyKzAwOjAw2KTGcAAAAAtJREFUCNdjYMACAAAVAAEyHTlgAAAAAElFTkSuQmCC',
    width: 12,
    height: 7,
  },
  jpg: {
    base64:
      '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAAKABQDAREAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFgEBAQEAAAAAAAAAAAAAAAAAAAYJ/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8Anu1TQ4AAAAD/2Q==',
    width: 20,
    height: 10,
  },
  gif: {
    base64: 'R0lGODlhEAAJAPAAAACAAAAAACH5BAAAAAAALAAAAAAQAAkAAAIKhI+py+0Po5yUFQA7',
    width: 16,
    height: 9,
  },
  webp: {
    base64: 'UklGRjgAAABXRUJQVlA4ICwAAACQAQCdASoIAAUAAgA0JaACdLoAA5gA/vjdX/+Rx/+Rx/+Rx/8jj9SMMXMgAA==',
    width: 8,
    height: 5,
  },
};

function bytesFor(name) {
  const binary = atob(FIXTURES[name].base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

describe('detectDimensions', () => {
  it('reads PNG dimensions from the IHDR chunk', () => {
    expect(detectDimensions(bytesFor('png'), 'image/png')).toEqual({ width: 12, height: 7 });
  });

  it('reads JPEG dimensions from the SOF0 segment', () => {
    expect(detectDimensions(bytesFor('jpg'), 'image/jpeg')).toEqual({ width: 20, height: 10 });
  });

  it('reads GIF dimensions from the logical screen descriptor', () => {
    expect(detectDimensions(bytesFor('gif'), 'image/gif')).toEqual({ width: 16, height: 9 });
  });

  it('reads WebP dimensions (VP8/VP8L/VP8X, whichever ImageMagick chose)', () => {
    expect(detectDimensions(bytesFor('webp'), 'image/webp')).toEqual({ width: 8, height: 5 });
  });

  it('returns null for a format it does not parse (e.g. AVIF), not an error', () => {
    expect(detectDimensions(bytesFor('png'), 'image/avif')).toBeNull();
  });

  it('returns null instead of throwing on truncated/garbage bytes', () => {
    expect(detectDimensions(new Uint8Array([1, 2, 3]), 'image/png')).toBeNull();
    expect(detectDimensions(new Uint8Array([1, 2, 3]), 'image/jpeg')).toBeNull();
    expect(detectDimensions(new Uint8Array(0), 'image/gif')).toBeNull();
  });
});

describe('sanitizeFilename', () => {
  it('lowercases and strips a path down to the basename', () => {
    expect(sanitizeFilename('C:\\Users\\me\\My Photo.PNG')).toBe('my-photo.png');
    expect(sanitizeFilename('/home/me/../../etc/passwd.jpg')).toBe('passwd.jpg');
  });

  it('collapses unsafe characters and repeated dashes', () => {
    expect(sanitizeFilename('weird!! name??.jpg')).toBe('weird-name.jpg');
  });

  it('falls back to a default for an empty or fully-unsafe name', () => {
    expect(sanitizeFilename('')).toBe('upload');
    expect(sanitizeFilename('???')).toBe('upload');
  });

  it('caps length', () => {
    expect(sanitizeFilename('a'.repeat(500) + '.jpg').length).toBeLessThanOrEqual(120);
  });
});

describe('sha256Hex', () => {
  it('matches a known SHA-256 vector', async () => {
    const bytes = new TextEncoder().encode('abc');
    expect(await sha256Hex(bytes)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('is deterministic for the same bytes', async () => {
    const bytes = bytesFor('png');
    expect(await sha256Hex(bytes)).toBe(await sha256Hex(bytes));
  });
});
