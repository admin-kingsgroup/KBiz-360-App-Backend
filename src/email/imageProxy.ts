import crypto from 'crypto';
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

const isPrivateIp = (ip: string): boolean => {
  const low = ip.toLowerCase();
  if (low.includes(':')) {
    if (low.startsWith('::ffff:')) return isPrivateIp(low.slice(7)); // v4-mapped
    return low === '::1' || low === '::' || low.startsWith('fe80') || low.startsWith('fc') || low.startsWith('fd');
  }
  const p = low.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true; // unparseable → refuse
  return p[0] === 0 || p[0] === 10 || p[0] === 127 || (p[0] === 100 && p[1] >= 64 && p[1] <= 127)
    || (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168);
};

const MAX_BYTES = 15 * 1024 * 1024;
const TIMEOUT_MS = 12_000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export async function proxyEmailImage(req: Request, res: Response): Promise<void> {
  const u = typeof req.query.u === 'string' ? req.query.u : '';
  const s = typeof req.query.s === 'string' ? req.query.s : '';
  if (!u || !s || !validSig(u, s)) { res.status(403).json({ error: 'Bad signature' }); return; }

  let current = u;
  for (let hop = 0; hop < 4; hop++) {
    let parsed: URL;
    try { parsed = new URL(current); } catch { res.status(400).json({ error: 'Bad URL' }); return; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') { res.status(400).json({ error: 'Bad scheme' }); return; }
    try {
      const addrs = await lookup(parsed.hostname, { all: true });
      if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) { res.status(403).json({ error: 'Refused host' }); return; }
    } catch { res.status(502).json({ error: 'DNS failed' }); return; }

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const upstream = await fetch(current, {
        redirect: 'manual',
        signal: ctl.signal,
        headers: { 'User-Agent': UA, Accept: 'image/*,*/*;q=0.8' },
      });
      if ([301, 302, 303, 307, 308].includes(upstream.status)) {
        const loc = upstream.headers.get('location');
        if (!loc) { res.status(502).json({ error: 'Bad redirect' }); return; }
        current = new URL(loc, current).toString();
        continue; // re-validate the next hop
      }
      if (!upstream.ok || !upstream.body) { res.status(502).json({ error: `Upstream ${upstream.status}` }); return; }
      const type = upstream.headers.get('content-type') ?? 'image/png';
      if (!/^image\//i.test(type) && !/octet-stream/i.test(type)) { res.status(415).json({ error: 'Not an image' }); return; }
      if (Number(upstream.headers.get('content-length') ?? 0) > MAX_BYTES) { res.status(413).json({ error: 'Too large' }); return; }

      res.setHeader('Content-Type', type);
      res.setHeader('Cache-Control', 'private, max-age=604800, immutable');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      // helmet() stamps Cross-Origin-Resource-Policy: same-origin on every response — the exact
      // header this proxy exists to escape. The proxy's whole job is being embedded cross-origin.
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

      const reader = upstream.body.getReader();
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BYTES) { res.destroy(); return; } // lied about (or omitted) content-length
        if (!res.write(Buffer.from(value))) await new Promise((r) => res.once('drain', r));
      }
      res.end();
    } catch {
      if (!res.headersSent) res.status(502).json({ error: 'Fetch failed' });
      else try { res.destroy(); } catch { /* already gone */ }
    } finally {
      clearTimeout(timer);
    }
    return;
  }
  res.status(502).json({ error: 'Too many redirects' });
}
