import { createHash, timingSafeEqual } from 'node:crypto';
function originValue(value) {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) throw new Error('Use an HTTPS origin in Harbor origin settings.');
  return url.origin;
}
// Per-device request budget for public mode (token bucket refilled every minute).
function limiter(perMinute) {
  const buckets = new Map();
  return id => {
    const now = Date.now();
    let bucket = buckets.get(id);
    if (!bucket) { bucket = { tokens: perMinute, at: now }; buckets.set(id, bucket); if (buckets.size > 5000) buckets.delete(buckets.keys().next().value); }
    bucket.tokens = Math.min(perMinute, bucket.tokens + (now - bucket.at) / 60000 * perMinute); bucket.at = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1; return true;
  };
}
export function relayAccess(env = process.env) {
  // Public mode (HARBOR_PUBLIC=1): anyone can browse without a key, within per-device
  // limits. Requests carrying the access key skip the limits.
  const open = ['1', 'true', 'yes'].includes(String(env.HARBOR_PUBLIC || '').toLowerCase());
  const httpBudget = limiter(Number(env.HARBOR_PUBLIC_REQUESTS_PER_MINUTE || 300));
  const socketBudget = limiter(Number(env.HARBOR_PUBLIC_SOCKETS_PER_MINUTE || 60));
  // Render and similar hosts put the visitor's address first in X-Forwarded-For.
  const behindProxy = !!(env.RENDER || env.HARBOR_TRUST_PROXY);
  const clientId = req => (behindProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || 'unknown';
  const publicOrigin = env.HARBOR_PUBLIC_ORIGIN || env.RENDER_EXTERNAL_URL;
  const canonical = publicOrigin ? originValue(publicOrigin) : null;
  const clients = new Set((env.HARBOR_CLIENT_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean).map(originValue));
  const key = env.HARBOR_ACCESS_KEY || '';
  if (clients.size && key.length < 24 && !open) throw new Error('Set HARBOR_ACCESS_KEY to at least 24 characters before allowing external clients.');
  const expected = createHash('sha256').update(key).digest();
  const originAllowed = (origin, req) => typeof origin === 'string' && (origin === (canonical || (req.socket.encrypted ? 'https://' : 'http://') + req.headers.host) || clients.has(origin));
  function keyMatches(value) {
    if (!key || typeof value !== 'string' || value.length > 2048) return false;
    return timingSafeEqual(createHash('sha256').update(value).digest(), expected);
  }
  function keyAllowed(value) { return !key || keyMatches(value); }
  function middleware(req, res, next) {
    if (!(req.path.startsWith('/api/') || req.path === '/http/')) return next();
    const origin = req.headers.origin;
    if (origin) {
      if (!originAllowed(origin, req)) return res.status(403).type('text').send('Browser origin is not allowed');
      res.set({ 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Harbor-Request, X-Harbor-Key', 'Access-Control-Expose-Headers': 'X-Harbor-Stream', 'Access-Control-Max-Age': '600' });
      res.vary('Origin');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    if ((req.path === '/api/health' || req.path === '/api/egress') && req.method === 'GET' && !origin) return next();
    if (keyAllowed(req.headers['x-harbor-key'])) return next();
    if (!open) return res.status(401).type('text').send('Harbor access key required');
    if (req.path === '/http/' && !httpBudget(clientId(req))) return res.status(429).type('text').send('Too many requests from this device. Wait a minute and try again.');
    next();
  }
  function upgradeAllowed(req) {
    if (!originAllowed(req.headers.origin, req)) return false;
    let supplied = '';
    const protocol = String(req.headers['sec-websocket-protocol'] || '').split(',').map(value => value.trim()).find(value => value.startsWith('harbor-key.'));
    if (protocol) { try { supplied = Buffer.from(protocol.slice('harbor-key.'.length), 'base64url').toString('utf8'); } catch { return false; } }
    if (keyAllowed(supplied)) return true;
    return open && socketBudget(clientId(req));
  }
  return { middleware, originAllowed, upgradeAllowed, open };
}
