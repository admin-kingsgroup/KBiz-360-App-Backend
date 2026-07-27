import crypto from 'crypto';
import http from 'http';
import https from 'https';
import type { IncomingMessage } from 'http';
import { lookup } from 'dns/promises';
import type { Request, Response } from 'express';
import { config } from '../config';

// Signed pass-through proxy for remote images inside email bodies — the same mechanism Outlook
// and Gmail use. WHY IT MUST EXIST: senders increasingly serve their images with
// `Cross-Origin-Resource-Policy: same-origin` (claude.ai does), which makes every browser —
// including our WebView — refuse to render the image inside any other origin. No client setting
// can bypass that; the only correct fix is to fetch the bytes server-side (response headers mean
// nothing to a non-browser HTTP client) and re-serve them from OUR origin.
//
// Security model: getMessage rewrites <img src> to /api/email/img?u=<url>&s=<hmac>. Only URLs the
// server itself extracted from a user's mailbox ever get signed, and the route verifies the HMAC,
// so this is not an open proxy. DNS is still checked against private ranges on every hop so a
// crafted email can't turn the server into an internal-network scanner (SSRF).

const key = crypto.createHash('sha256').update(`kb360-email-img:${config.msEmail.tokenKey}`).digest();

export function signImageUrl(url: string): string {
  return crypto.createHmac('sha256', key).update(url).digest('hex').slice(0, 32);
}

const validSig = (url: string, sig: string): boolean => {
  const want = signImageUrl(url);
  return sig.length === want.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig));
};

// Rewrite every remote <img src="http(s)://…"> to the signed proxy path. data:/cid: URIs are left
// alone (cid: is inlined earlier; data: needs no network). srcset is stripped so the browser uses
// the (proxied) src instead of picking an unproxied candidate.
export function rewriteRemoteImages(html: string): string {
  return html
    .replace(/\ssrcset\s*=\s*("[^"]*"|'[^']*')/gi, ' ')
    .replace(/(<img\b[^>]*?\bsrc\s*=\s*)(["'])(https?:\/\/[^"']+)\2/gi, (_m, pre: string, q: string, url: string) =>
      `${pre}${q}/api/email/img?u=${encodeURIComponent(url)}&s=${signImageUrl(url)}${q}`);
}

// True for any address the proxy must never connect to: loopback, private, link-local (incl. the
// 169.254.169.254 cloud metadata endpoint), CGNAT, multicast, reserved/broadcast, and their IPv6
// equivalents. Anything unparseable is refused. Exported for testing.
export const isPrivateIp = (ip: string): boolean => {
  const low = ip.toLowerCase();
  if (low.includes(':')) {
    if (low.startsWith('::ffff:')) return isPrivateIp(low.slice(7)); // v4-mapped
    return low === '::1' || low === '::' || low.startsWith('fe80') || low.startsWith('fc')
      || low.startsWith('fd') || low.startsWith('ff'); // ff.. = IPv6 multicast
  }
  const p = low.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true; // unparseable → refuse
  return p[0] === 0 || p[0] === 10 || p[0] === 127 || (p[0] === 100 && p[1] >= 64 && p[1] <= 127)
    || (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31)
    || (p[0] === 192 && p[1] === 168) || p[0] >= 224; // 224-239 multicast, 240-255 reserved/broadcast
};

const MAX_BYTES = 15 * 1024 * 1024;
const TIMEOUT_MS = 12_000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Marker error so the caller can map a blocked/refused destination to HTTP 403.
class RefusedHostError extends Error {}

// A DNS lookup that RESOLVES, refuses if ANY resolved address is private/reserved, and returns a
// vetted address — so the socket connects to EXACTLY the IP we validated. Because the validation and
// the connection use the SAME resolution, there is no window for DNS rebinding (the TOCTOU the old
// pre-check + fetch() had, where fetch re-resolved the hostname independently).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pinnedLookup = (hostname: string, options: any, cb: any): void => {
  const wantAll = typeof options === 'object' && options !== null && options.all === true;
  lookup(hostname, { all: true })
    .then((addrs) => {
      if (!addrs.length) { cb(new RefusedHostError('DNS empty')); return; }
      if (addrs.some((a) => isPrivateIp(a.address))) { cb(new RefusedHostError('private address')); return; }
      if (wantAll) cb(null, addrs);
      else cb(null, addrs[0].address, addrs[0].family);
    })
    .catch(() => cb(new Error('DNS failed')));
};

// Open a GET to one URL, pinning the connection to a validated public IP (SNI/Host stay the hostname).
function openHop(urlStr: string): Promise<IncomingMessage> {
  const parsed = new URL(urlStr);
  const mod = parsed.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = mod.request(
      urlStr,
      {
        method: 'GET',
        lookup: pinnedLookup,
        timeout: TIMEOUT_MS,
        headers: { 'User-Agent': UA, Accept: 'image/*,*/*;q=0.8' },
        servername: parsed.protocol === 'https:' ? parsed.hostname : undefined,
      },
      resolve,
    );
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', reject);
    request.end();
  });
}

export async function proxyEmailImage(req: Request, res: Response): Promise<void> {
  const u = typeof req.query.u === 'string' ? req.query.u : '';
  const s = typeof req.query.s === 'string' ? req.query.s : '';
  if (!u || !s || !validSig(u, s)) { res.status(403).json({ error: 'Bad signature' }); return; }

  let current = u;
  for (let hop = 0; hop < 4; hop++) {
    let parsed: URL;
    try { parsed = new URL(current); } catch { res.status(400).json({ error: 'Bad URL' }); return; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') { res.status(400).json({ error: 'Bad scheme' }); return; }

    let upstream: IncomingMessage;
    try {
      upstream = await openHop(current); // pinnedLookup validates + pins the IP on connect
    } catch (e) {
      if (e instanceof RefusedHostError) res.status(403).json({ error: 'Refused host' });
      else if ((e as Error).message === 'DNS failed') res.status(502).json({ error: 'DNS failed' });
      else res.status(502).json({ error: 'Fetch failed' });
      return;
    }

    const status = upstream.statusCode ?? 0;
    if ([301, 302, 303, 307, 308].includes(status)) {
      const loc = upstream.headers.location;
      upstream.resume(); // drain the redirect body
      if (!loc) { res.status(502).json({ error: 'Bad redirect' }); return; }
      current = new URL(loc, current).toString();
      continue; // next hop is re-validated by pinnedLookup
    }
    if (status < 200 || status >= 300) { upstream.resume(); res.status(502).json({ error: `Upstream ${status}` }); return; }

    const type = String(upstream.headers['content-type'] ?? 'image/png');
    if (!/^image\//i.test(type) && !/octet-stream/i.test(type)) { upstream.resume(); res.status(415).json({ error: 'Not an image' }); return; }
    if (Number(upstream.headers['content-length'] ?? 0) > MAX_BYTES) { upstream.resume(); res.status(413).json({ error: 'Too large' }); return; }

    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'private, max-age=604800, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // helmet() stamps Cross-Origin-Resource-Policy: same-origin on every response — the exact header
    // this proxy exists to escape. The proxy's whole job is being embedded cross-origin.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

    let total = 0;
    upstream.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BYTES) { upstream.destroy(); res.destroy(); return; } // lied about content-length
      if (!res.write(chunk)) { upstream.pause(); res.once('drain', () => upstream.resume()); }
    });
    upstream.on('end', () => res.end());
    upstream.on('error', () => { if (!res.headersSent) res.status(502).json({ error: 'Fetch failed' }); else res.destroy(); });
    return;
  }
  res.status(502).json({ error: 'Too many redirects' });
}
