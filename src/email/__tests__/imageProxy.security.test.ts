import { isPrivateIp, signImageUrl, rewriteRemoteImages } from '../imageProxy';

// The proxy must refuse to connect to any internal/reserved destination — especially the cloud
// metadata endpoint (169.254.169.254) that would expose EC2 IAM credentials.
describe('isPrivateIp (SSRF blocklist)', () => {
  const refused = [
    '127.0.0.1', '127.1.2.3', // loopback
    '0.0.0.0',
    '10.0.0.5', '10.255.255.255', // private A
    '172.16.0.1', '172.31.255.255', // private B
    '192.168.1.1', // private C
    '100.64.0.1', '100.127.0.1', // CGNAT
    '169.254.169.254', // ← EC2/GCP/Azure metadata (IMDSv1 & IMDSv2)
    '169.254.0.1', // link-local
    '224.0.0.1', '239.255.255.255', // multicast
    '240.0.0.1', '255.255.255.255', // reserved / broadcast
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', // IPv6 loopback/link-local/ULA/multicast
    '::ffff:169.254.169.254', // v4-mapped metadata
    'not-an-ip', '999.999.999.999', // unparseable → refuse
  ];
  for (const ip of refused) {
    it(`refuses ${ip}`, () => expect(isPrivateIp(ip)).toBe(true));
  }

  const allowed = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111'];
  for (const ip of allowed) {
    it(`allows public ${ip}`, () => expect(isPrivateIp(ip)).toBe(false));
  }
});

describe('image proxy signing', () => {
  it('produces a stable 32-char HMAC for a URL', () => {
    const sig = signImageUrl('https://cdn.example.com/a.png');
    expect(sig).toHaveLength(32);
    expect(signImageUrl('https://cdn.example.com/a.png')).toBe(sig); // deterministic
    expect(signImageUrl('https://cdn.example.com/b.png')).not.toBe(sig);
  });

  it('only rewrites remote <img> src to signed proxy paths (data:/cid: left alone)', () => {
    const html = '<img src="http://cdn.example.com/x.png"><img src="cid:logo"><img src="data:image/png;base64,AA">';
    const out = rewriteRemoteImages(html);
    expect(out).toContain('/api/email/img?u=');
    expect(out).toContain('cid:logo'); // untouched
    expect(out).toContain('data:image/png;base64,AA'); // untouched
  });
});
