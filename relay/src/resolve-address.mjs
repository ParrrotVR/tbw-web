import { lookup, resolve6 } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';

// Cloudflare's published IPv6 ranges. Its edge serves every Cloudflare-hosted name on
// every one of its addresses, so an IPv6-only Cloudflare name can be reached over IPv4
// by dialing any Cloudflare IPv4 edge address with the right TLS name and Host header.
// Turnstile (Cloudflare's human check) uses such names, e.g. brunhild.challenges.cloudflare.com.
const cloudflareV6 = ['2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32'].map(range => ipaddr.parseCIDR(range));
let cloudflareEdge;

// Resolves a destination for the relay to dial. IPv4 first (what the relay's host is
// sure to support); names that only have IPv6 fall back as described above.
export async function resolveAddress(hostname) {
  try { return await lookup(hostname, { family: 4 }); }
  catch (error) {
    if (!['ENOTFOUND', 'ENODATA'].includes(error.code)) throw error;
    let v6;
    // The system resolver hides IPv6 answers on hosts without IPv6, so ask DNS directly.
    try { v6 = { address: (await resolve6(hostname))[0], family: 6 }; } catch { throw error; }
    if (!v6.address) throw error;
    const parsed = ipaddr.parse(v6.address);
    if (parsed.kind() === 'ipv6' && cloudflareV6.some(range => parsed.match(range))) {
      cloudflareEdge ??= lookup('challenges.cloudflare.com', { family: 4 }).catch(failure => { cloudflareEdge = null; throw failure; });
      return { address: (await cloudflareEdge).address, family: 4 };
    }
    return v6;
  }
}
