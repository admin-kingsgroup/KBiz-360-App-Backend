import { fetchLinkPreview } from '../chat.linkPreview';

// This endpoint fetches a URL a user supplied, which is the classic SSRF shape. These cases pin the
// guards: no non-web schemes, no private/internal addresses (cloud metadata included), and no
// following a redirect that could hop from a public URL to an internal one.
//
// DNS and fetch are stubbed so the suite never touches the network.
jest.mock('node:dns/promises', () => ({
  lookup: jest.fn(async (host: string) => {
    const map: Record<string, string> = {
      'example.com': '93.184.216.34',
      'internal.example.com': '10.0.0.5',       // public name, private answer — the classic bypass
      'metadata.example.com': '169.254.169.254', // cloud metadata
      'v6.example.com': 'fd00::1',
    };
    const address = map[host];
    if (!address) throw new Error('ENOTFOUND');
    return [{ address, family: address.includes(':') ? 6 : 4 }];
  }),
}));

const html = (head: string): string => `<!doctype html><html><head>${head}</head><body>ignored</body></html>`;
const ok = (body: string) => ({
  ok: true,
  headers: { get: () => 'text/html; charset=utf-8' },
  body: {
    getReader: () => {
      let done = false;
      return {
        read: async () => (done ? { done: true, value: undefined } : ((done = true), { done: false, value: Buffer.from(body) })),
        cancel: async () => undefined,
      };
    },
  },
});

const mockFetch = jest.fn();
beforeEach(() => {
  mockFetch.mockReset();
  (globalThis as unknown as { fetch: unknown }).fetch = mockFetch;
});

describe('link preview — what it will fetch', () => {
  it('reads Open Graph metadata from a normal public page', async () => {
    mockFetch.mockResolvedValue(ok(html(`
      <meta property="og:title" content="Quarterly report">
      <meta property="og:description" content="Numbers &amp; charts">
      <meta property="og:image" content="/img/cover.png">
      <meta property="og:site_name" content="Example">`)));

    const p = await fetchLinkPreview('https://example.com/report');

    expect(p).toMatchObject({
      title: 'Quarterly report',
      description: 'Numbers & charts',
      image: 'https://example.com/img/cover.png', // relative og:image resolved against the page
      siteName: 'Example',
    });
  });

  it('falls back to <title> when there is no og:title', async () => {
    mockFetch.mockResolvedValue(ok(html('<title>Plain page</title><meta property="og:image" content="https://example.com/a.png">')));
    expect((await fetchLinkPreview('https://example.com/x'))?.title).toBe('Plain page');
  });

  it('returns nothing for a page with no card metadata', async () => {
    mockFetch.mockResolvedValue(ok(html('<meta name="robots" content="noindex">')));
    expect(await fetchLinkPreview('https://example.com/bare')).toBeNull();
  });
});

describe('link preview — SSRF guards', () => {
  it('refuses non-web schemes', async () => {
    for (const url of ['file:///etc/passwd', 'gopher://example.com', 'data:text/html,<h1>x', 'ftp://example.com/f']) {
      expect(await fetchLinkPreview(url)).toBeNull();
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refuses a host that resolves to a private address', async () => {
    expect(await fetchLinkPreview('https://internal.example.com/admin')).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refuses cloud metadata and IPv6 unique-local', async () => {
    expect(await fetchLinkPreview('https://metadata.example.com/latest/meta-data/')).toBeNull();
    expect(await fetchLinkPreview('https://v6.example.com/')).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refuses literal loopback and LAN addresses', async () => {
    for (const url of ['http://127.0.0.1:9090/', 'http://localhost/', 'http://192.168.1.1/', 'http://169.254.169.254/']) {
      expect(await fetchLinkPreview(url)).toBeNull();
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('never follows redirects — a public URL must not hop somewhere internal', async () => {
    mockFetch.mockResolvedValue(ok(html('<title>x</title>')));
    await fetchLinkPreview('https://example.com/');
    expect(mockFetch.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
  });

  it('ignores non-HTML responses', async () => {
    mockFetch.mockResolvedValue({ ok: true, headers: { get: () => 'application/pdf' }, body: {} });
    expect(await fetchLinkPreview('https://example.com/file.pdf')).toBeNull();
  });

  it('returns null instead of throwing when the fetch fails', async () => {
    mockFetch.mockRejectedValue(new Error('timeout'));
    expect(await fetchLinkPreview('https://example.com/')).toBeNull();
  });
});
