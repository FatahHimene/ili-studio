// The visitor's real IP address. Sites on yela.uk go through Cloudflare's proxy, so the request
// reaches us from a Cloudflare address; Cloudflare then gives the visitor's IP in CF-Connecting-IP.
// That header is only trusted when the request really comes from Cloudflare (it could be faked otherwise).
import net from 'node:net';

const V4 = ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20',
  '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22'];
const V6 = ['2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32'];

const v4num = (ip) => ip.split('.').reduce((n, p) => n * 256 + Number(p), 0);
const v4ranges = V4.map((c) => { const [ip, bits] = c.split('/'); const size = 2 ** (32 - Number(bits)); const start = v4num(ip); return [start, start + size]; });
function v6big(ip) {
  const [head, tail = ''] = ip.split('::');
  const h = head ? head.split(':') : []; const t = tail ? tail.split(':') : [];
  const parts = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  return parts.reduce((n, p) => (n << 16n) + BigInt(parseInt(p || '0', 16)), 0n);
}
const v6ranges = V6.map((c) => { const [ip, bits] = c.split('/'); const shift = BigInt(128 - Number(bits)); return [v6big(ip) >> shift, shift]; });

export function isCloudflare(ip) {
  ip = String(ip || '').replace(/^::ffff:/, '');
  if (net.isIPv4(ip)) { const n = v4num(ip); return v4ranges.some(([a, b]) => n >= a && n < b); }
  if (net.isIPv6(ip)) { const n = v6big(ip); return v6ranges.some(([prefix, shift]) => n >> shift === prefix); }
  return false;
}

export function clientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (cf && isCloudflare(req.ip) && net.isIP(String(cf).trim())) return String(cf).trim();
  return req.ip;
}
