import { createHash, timingSafeEqual } from 'node:crypto';
function originValue(value) {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) throw new Error('Use an HTTPS origin in Harbor origin settings.');
  return url.origin;
}
export function relayAccess(env = process.env) {
  const publicOrigin = env.HARBOR_PUBLIC_ORIGIN || env.RENDER_EXTERNAL_URL;
  const canonical = publicOrigin ? originValue(publicOrigin) : null;
  const clients = new Set((env.HARBOR_CLIENT_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean).map(originValue));
  const key = env.HARBOR_ACCESS_KEY || '';
  if (clients.size && key.length < 24) throw new Error('Set HARBOR_ACCESS_KEY to at least 24 characters before allowing external clients.');
  const expected = createHash('sha256').update(key).digest();
  const originAllowed = (origin, req) => typeof origin === 'string' && (origin === (canonical || (req.socket.encrypted ? 'https://' : 'http://') + req.headers.host) || clients.has(origin));
  function keyAllowed(value) {
    if (!key) return true;
    if (typeof value !== 'string' || value.length > 2048) return false;
    return timingSafeEqual(createHash('sha256').update(value).digest(), expected);
  }
  function middleware(req, res, next) {
    if (!(req.path.startsWith('/api/') || req.path === '/http/')) return next();
    const origin = req.headers.origin;
    if (origin) {
      if (!originAllowed(origin, req)) return res.status(403).type('text').send('Browser origin is not allowed');
      res.set({ 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Harbor-Request, X-Harbor-Key', 'Access-Control-Expose-Headers': 'X-Harbor-Stream', 'Access-Control-Max-Age': '600' });
      res.vary('Origin');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    if (req.path === '/api/health' && req.method === 'GET' && !origin) return next();
    if (!keyAllowed(req.headers['x-harbor-key'])) return res.status(401).type('text').send('Harbor access key required');
    next();
  }
  function upgradeAllowed(req) {
    if (!originAllowed(req.headers.origin, req)) return false;
    let supplied = '';
    const protocol = String(req.headers['sec-websocket-protocol'] || '').split(',').map(value => value.trim()).find(value => value.startsWith('harbor-key.'));
    if (protocol) { try { supplied = Buffer.from(protocol.slice('harbor-key.'.length), 'base64url').toString('utf8'); } catch { return false; } }
    return keyAllowed(supplied);
  }
  return { middleware, originAllowed, upgradeAllowed };
}
