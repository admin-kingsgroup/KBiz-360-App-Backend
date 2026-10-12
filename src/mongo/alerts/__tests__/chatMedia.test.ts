import { canonicalMime, checkChatMedia, imageSize, mediaFilename } from '../chatMedia';

// Pure — the rules a service-posted file must pass before it is stored and served from our origin.

const PNG = (w: number, h: number): Buffer => {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
};
// SOI, an APP0 segment, then SOF0 with height 1600 / width 900.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x06, 0x40, 0x03, 0x84, 0x03, 0, 0, 0, 0, 0, 0]);
const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom', 'latin1'), Buffer.alloc(8)]);
const PDF = Buffer.from('%PDF-1.7\n', 'latin1');
const HTML = Buffer.from('<html><script>alert(1)</script>', 'latin1');

describe('checkChatMedia', () => {
  it('accepts each kind in the formats the ticket recorders and pickers produce', () => {
    expect(checkChatMedia('image', 'image/png', PNG(10, 10))).toEqual({ ok: true, kind: 'image', mime: 'image/png', ext: 'png' });
    expect(checkChatMedia('image', 'image/jpg', JPEG)).toEqual({ ok: true, kind: 'image', mime: 'image/jpeg', ext: 'jpg' });
    expect(checkChatMedia('voice', 'audio/webm;codecs=opus', WEBM)).toEqual({ ok: true, kind: 'voice', mime: 'audio/webm', ext: 'webm' });
    expect(checkChatMedia('voice', 'audio/x-m4a', MP4)).toEqual({ ok: true, kind: 'voice', mime: 'audio/mp4', ext: 'm4a' });
    expect(checkChatMedia('video', 'video/webm', WEBM)).toEqual({ ok: true, kind: 'video', mime: 'video/webm', ext: 'webm' });
    expect(checkChatMedia('video', 'video/mp4', MP4)).toEqual({ ok: true, kind: 'video', mime: 'video/mp4', ext: 'mp4' });
    expect(checkChatMedia('document', 'application/pdf', PDF)).toEqual({ ok: true, kind: 'document', mime: 'application/pdf', ext: 'pdf' });
  });

  it('a voice note the browser labelled video/webm is stored and served as audio', () => {
    expect(checkChatMedia('voice', 'video/webm', WEBM)).toEqual({ ok: true, kind: 'voice', mime: 'audio/webm', ext: 'webm' });
  });

  it('refuses a type that is not on the list for that kind', () => {
    expect(checkChatMedia('image', 'image/svg+xml', Buffer.from('<svg/>')).ok).toBe(false);
    expect(checkChatMedia('image', 'text/html', HTML).ok).toBe(false);
    expect(checkChatMedia('video', 'audio/webm', WEBM).ok).toBe(false);
    expect(checkChatMedia('document', 'image/png', PNG(1, 1)).ok).toBe(false);
    expect(checkChatMedia('image', '', PNG(1, 1)).ok).toBe(false);
  });

  it('refuses bytes that are not what the type claims (an HTML page labelled image/png)', () => {
    expect(checkChatMedia('image', 'image/png', HTML)).toEqual({ ok: false, error: 'The file is not a valid image/png' });
    expect(checkChatMedia('document', 'application/pdf', HTML).ok).toBe(false);
    expect(checkChatMedia('video', 'video/mp4', WEBM).ok).toBe(false);
  });
});

describe('mediaFilename', () => {
  it('keeps a readable name but the extension is always the verified one', () => {
    expect(mediaFilename('screenshot 1.png', 'png')).toBe('screenshot_1.png');
    expect(mediaFilename('evil.html', 'png')).toBe('evil.png');
    expect(mediaFilename('voice-note-2026.webm', 'webm')).toBe('voice-note-2026.webm');
    expect(mediaFilename('', 'pdf')).toBe('file.pdf');
  });

  it('a long name cannot push the extension past the storage layer\'s 120-char cut', () => {
    const out = mediaFilename(`${'a'.repeat(300)}.html`, 'jpg');
    expect(out.endsWith('.jpg')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(120);
  });
});

describe('imageSize', () => {
  it('reads PNG and JPEG dimensions', () => {
    expect(imageSize(PNG(1440, 2960))).toEqual({ width: 1440, height: 2960 });
    expect(imageSize(JPEG)).toEqual({ width: 900, height: 1600 });
  });
  it('null for anything else or a truncated header', () => {
    expect(imageSize(PDF)).toBeNull();
    expect(imageSize(Buffer.from([0x89, 0x50]))).toBeNull();
  });
});

it('canonicalMime folds parameters and aliases', () => {
  expect(canonicalMime(' Audio/WebM; codecs=opus ')).toBe('audio/webm');
  expect(canonicalMime('image/pjpeg')).toBe('image/jpeg');
  expect(canonicalMime(undefined)).toBe('');
});
