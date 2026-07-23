import { rewriteRemoteImages, signImageUrl } from '../imageProxy';

describe('email image proxy rewrite', () => {
  it('rewrites remote img srcs to signed proxy paths', () => {
    const html = '<p>hi</p><img src="https://claude.ai/images/email/logo.png" alt="Claude">';
    const out = rewriteRemoteImages(html);
    const sig = signImageUrl('https://claude.ai/images/email/logo.png');
    expect(out).toContain(`src="/api/email/img?u=${encodeURIComponent('https://claude.ai/images/email/logo.png')}&s=${sig}"`);
    expect(out).not.toContain('src="https://claude.ai');
  });

  it('handles single quotes and http URLs', () => {
    const out = rewriteRemoteImages("<img src='http://cdn.x.com/a.png'>");
    expect(out).toContain("src='/api/email/img?u=http%3A%2F%2Fcdn.x.com%2Fa.png&s=");
  });

  it('leaves data: and cid: srcs untouched', () => {
    const html = '<img src="data:image/png;base64,AAA"><img src="cid:tk-sig-logo">';
    expect(rewriteRemoteImages(html)).toBe(html);
  });

  it('strips srcset so the proxied src wins', () => {
    const out = rewriteRemoteImages('<img srcset="https://x.com/a.png 2x" src="https://x.com/a.png">');
    expect(out).not.toContain('srcset');
    expect(out).toContain('/api/email/img?u=');
  });

  it('signature is stable and url-bound', () => {
    expect(signImageUrl('https://a.com/1.png')).toBe(signImageUrl('https://a.com/1.png'));
    expect(signImageUrl('https://a.com/1.png')).not.toBe(signImageUrl('https://a.com/2.png'));
  });
});
