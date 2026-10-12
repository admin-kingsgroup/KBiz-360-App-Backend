// What a service may post into a group chat as MEDIA (POST /api/alerts/chat/media), and how it is
// stored. Owner, 2026-10-12: a support ticket lands in "Ticket Support" with ALL its attachments —
// screenshots, voice notes, screen recordings — so the developers see the problem in the chat.
//
// The files come from the ERP / CRM ticket stores (uploaded there by staff browsers), so the rules
// are the chat-media ones made strict: an allowlist of types the phone can show, checked against
// the file's own MAGIC BYTES, and a stored name whose extension comes from that verified type —
// never from the name the caller sent (the extension and the Content-Type decide how our origin
// serves the file; neither may be caller-controlled, see attachmentName.ts for the PDF incident).
//
// Pure — no storage, no DB — so the rules are pinned by __tests__/chatMedia.test.ts.

export type ChatMediaKind = 'image' | 'voice' | 'video' | 'document';

export const CHAT_MEDIA_MAX_BYTES = 26 * 1024 * 1024; // the ERP/CRM ticket ceiling is 25 MB

interface Format { ext: string; kinds: ChatMediaKind[]; magic: (b: Buffer) => boolean }

const at = (b: Buffer, offset: number, ascii: string): boolean =>
  b.length >= offset + ascii.length && b.subarray(offset, offset + ascii.length).toString('latin1') === ascii;
const ebml = (b: Buffer): boolean => b.length >= 4 && b.readUInt32BE(0) === 0x1a45dfa3; // WebM / Matroska
const isoBmff = (b: Buffer): boolean => at(b, 4, 'ftyp'); // MP4 / M4A / MOV

// Canonical type → what it is stored as. A voice note recorded in a browser is often labelled
// video/webm (an audio-only WebM) — so WebM is accepted as a voice note too, and served as audio.
const FORMATS: Record<string, Format> = {
  'image/png': { ext: 'png', kinds: ['image'], magic: (b) => b.length >= 8 && b.readUInt32BE(0) === 0x89504e47 },
  'image/jpeg': { ext: 'jpg', kinds: ['image'], magic: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/gif': { ext: 'gif', kinds: ['image'], magic: (b) => at(b, 0, 'GIF8') },
  'image/webp': { ext: 'webp', kinds: ['image'], magic: (b) => at(b, 0, 'RIFF') && at(b, 8, 'WEBP') },
  'audio/webm': { ext: 'webm', kinds: ['voice'], magic: ebml },
  'audio/ogg': { ext: 'ogg', kinds: ['voice'], magic: (b) => at(b, 0, 'OggS') },
  'audio/mpeg': { ext: 'mp3', kinds: ['voice'], magic: (b) => at(b, 0, 'ID3') || (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) },
  'audio/mp4': { ext: 'm4a', kinds: ['voice'], magic: isoBmff },
  'audio/wav': { ext: 'wav', kinds: ['voice'], magic: (b) => at(b, 0, 'RIFF') && at(b, 8, 'WAVE') },
  'video/webm': { ext: 'webm', kinds: ['video', 'voice'], magic: ebml },
  'video/mp4': { ext: 'mp4', kinds: ['video'], magic: isoBmff },
  'video/quicktime': { ext: 'mov', kinds: ['video'], magic: isoBmff },
  'application/pdf': { ext: 'pdf', kinds: ['document'], magic: (b) => at(b, 0, '%PDF-') },
};

// Spellings browsers and pickers use for the same thing.
const ALIASES: Record<string, string> = {
  'image/jpg': 'image/jpeg', 'image/pjpeg': 'image/jpeg', 'image/x-png': 'image/png',
  'audio/x-m4a': 'audio/mp4', 'audio/m4a': 'audio/mp4', 'audio/mp3': 'audio/mpeg',
  'audio/x-wav': 'audio/wav', 'audio/wave': 'audio/wav', 'audio/opus': 'audio/ogg',
};

/** `audio/webm;codecs=opus` → `audio/webm`; known aliases folded onto their canonical type. */
export const canonicalMime = (mime: string | null | undefined): string => {
  const m = String(mime ?? '').split(';')[0].trim().toLowerCase();
  return ALIASES[m] ?? m;
};

export type MediaCheck =
  | { ok: true; kind: ChatMediaKind; mime: string; ext: string }
  | { ok: false; error: string };

/**
 * May this file be posted as `kind`? The declared type must be on the allowlist for that kind AND
 * the bytes must be that format. Returns the type and extension to store it under — for a voice
 * note that arrived as video/webm that is audio/webm, so the phone's player is handed audio.
 */
export function checkChatMedia(kind: ChatMediaKind, mime: string | null | undefined, buffer: Buffer): MediaCheck {
  const m = canonicalMime(mime);
  const fmt = FORMATS[m];
  if (!fmt || !fmt.kinds.includes(kind)) return { ok: false, error: `A ${kind} cannot be ${m || 'an untyped file'}` };
  if (!fmt.magic(buffer)) return { ok: false, error: `The file is not a valid ${m}` };
  if (kind === 'voice' && m === 'video/webm') return { ok: true, kind, mime: 'audio/webm', ext: 'webm' };
  return { ok: true, kind, mime: m, ext: fmt.ext };
}

/**
 * The stored filename: the caller's name sanitised, its own extension dropped, capped so the
 * storage layer's 120-char safeName cut can never reach the extension, then the VERIFIED one.
 */
export const mediaFilename = (name: string | null | undefined, ext: string): string => {
  const base = String(name ?? '').replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.[a-zA-Z0-9]{1,5}$/, '').slice(0, 100);
  return `${base || 'file'}.${ext}`;
};

/**
 * Pixel size of a PNG / GIF / JPEG, or null. The chat sizes a photo tile from it — without one a
 * tall screenshot is cropped to a 4:3 box until tapped.
 */
export function imageSize(b: Buffer): { width: number; height: number } | null {
  try {
    if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && at(b, 12, 'IHDR')) {
      return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    }
    if (at(b, 0, 'GIF8') && b.length >= 10) return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
    if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
      // Walk the JPEG segments to the first start-of-frame (SOF0–SOF15, minus DHT/JPG/DAC).
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i += 1; continue; }
        const marker = b[i + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
        const len = b.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
    }
  } catch { /* a truncated header is not worth failing the post over */ }
  return null;
}
