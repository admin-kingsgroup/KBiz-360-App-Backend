import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

// Link previews (the card WhatsApp shows under a pasted URL). The SERVER fetches the page, because
// the phone must not: it would leak every recipient's IP to whatever was linked, and mobile clients
// can't be trusted to enforce the safety rules below.
//
// This endpoint takes a URL from a user and fetches it, which is textbook SSRF territory. The rules:
//   • https/http only — no file:, gopher:, data:, ftp:
//   • the resolved IP must be public — blocks localhost, LAN, link-local and cloud metadata (169.254.169.254)
//   • no redirect following (a public URL can 302 straight to an internal one)
//   • hard timeout and a byte cap, so a slow or enormous page can't tie up the process
//   • only <head> metadata is returned — never page contents

export interface LinkPreview {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
}

const TIMEOUT_MS = 4000;
const MAX_BYTES = 512 * 1024; // plenty for <head>; the body is truncated past this

// Private/reserved ranges that must never be reachable through this endpoint.
function isPrivateIPv4(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true; // malformed ⇒ refuse
  const [a, b] = p;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast / reserved
  return false;
}
function isPrivateIPv6(ip: string): boolean {
  const s = ip.toLowerCase();
  if (s === '::1' || s === '::') return true;
  if (s.startsWith('fc') || s.startsWith('fd')) return true; // unique-local
  if (s.startsWith('fe80')) return true;                     // link-local
  if (s.startsWith('::ffff:')) return isPrivateIPv4(s.slice(7)); // IPv4-mapped
  return false;
}
const isPrivateAddress = (ip: string): boolean => (isIP(ip) === 6 ? isPrivateIPv6(ip) : isPrivateIPv4(ip));

// Decode the handful of entities that actually show up in titles/descriptions.
const decode = (s: string): string => s
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&nbsp;/g, ' ')
  .trim();

const metaOf = (html: string, prop: string): string | null => {
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, 'i'),
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (m?.[1]) return decode(m[1]).slice(0, 300);
  }
  return null;
};

/** Fetch a URL's card metadata, or null when it is unsafe/unreachable/not a web page. */
export async function fetchLinkPreview(raw: string): Promise<LinkPreview | null> {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

  // Resolve first and check every address the host answers with — a hostname that resolves to a
  // private address is the classic bypass.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  try {
    const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
    if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) return null;
  } catch { return null; }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), {
      redirect: 'manual', // a public URL redirecting to an internal one must not be followed
      signal: controller.signal,
      headers: { 'user-agent': 'KB360LinkPreview/1.0', accept: 'text/html,application/xhtml+xml' },
    });
    if (!res.ok || !res.body) return null;
    if (!(res.headers.get('content-type') ?? '').includes('html')) return null;

    // Read at most MAX_BYTES — enough for <head>, and a cap on what a hostile page can cost us.
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (size < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
      if (/<\/head>/i.test(Buffer.concat(chunks).toString('utf8'))) break; // metadata is all in
    }
    await reader.cancel().catch(() => undefined);
    const html = Buffer.concat(chunks).toString('utf8').slice(0, MAX_BYTES);

    const title = metaOf(html, 'og:title') ?? (/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] ? decode(/<title[^>]*>([^<]*)<\/title>/i.exec(html)![1]).slice(0, 300) : null);
    const image = metaOf(html, 'og:image');
    if (!title && !image) return null; // nothing worth showing a card for
    return {
      url: url.toString(),
      title,
      description: metaOf(html, 'og:description') ?? metaOf(html, 'description'),
      // Relative og:image paths are resolved against the page, else the phone can't load them.
      image: image ? new URL(image, url).toString() : null,
      siteName: metaOf(html, 'og:site_name') ?? url.hostname.replace(/^www\./, ''),
    };
  } catch {
    return null; // timeout, DNS failure, TLS error — a preview is never worth surfacing an error for
  } finally {
    clearTimeout(timer);
  }
}
