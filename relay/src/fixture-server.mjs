import http from 'node:http';
import { randomBytes } from 'node:crypto';
import express from 'express';
import { WebSocketServer } from 'ws';
import { gzipSync, brotliCompressSync, deflateSync } from 'node:zlib';

export function createFixture(directory) {
  const app = express();
  const sessions = new Map();
  const rooms = new Map();
  const cacheCounts = {};
  app.disable('x-powered-by');
  app.use(express.json({ limit: '4kb' }));
  app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  function userFor(req) {
    const token = /(?:^|;\s*)harbor_session=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1];
    return sessions.get(token) || null;
  }
  app.get('/api/time', (_req, res) => res.json({ now: Date.now() }));
  app.get('/api/cache-counts', (_req, res) => res.json(cacheCounts));
  app.get('/cache/:name', (req, res) => {
    const name = req.params.name; cacheCounts[name] = (cacheCounts[name] || 0) + 1;
    res.set('Cache-Control', name === 'private.js' ? 'private, max-age=300' : 'public, max-age=300');
    if (name === 'session.js') res.set('Set-Cookie', 'cache-probe=present; Path=/');
    res.type('application/javascript').send('globalThis.harborFixtureAsset = true;');
  });
  app.get('/stream/slow.bin', (_req, res) => {
    res.type('application/octet-stream'); res.write(Buffer.from([1, 2]));
    const timer = setTimeout(() => res.end(Buffer.from([3, 4])), 1000);
    res.on('close', () => clearTimeout(timer));
  });
  app.get('/stream/fast.txt', (_req, res) => res.type('text').send('fast response'));
  app.get('/stream/delayed-headers', (_req, res) => {
    const timer = setTimeout(() => res.type('text').send('request survives worker update'), 800);
    res.on('close', () => clearTimeout(timer));
  });
  app.get('/stream/compressed', (req, res) => {
    const encoders = { gzip: gzipSync, br: brotliCompressSync, deflate: deflateSync };
    const encoding = req.query.encoding;
    if (!encoders[encoding]) return res.sendStatus(400);
    res.set('Content-Encoding', encoding).type('text').send(encoders[encoding](Buffer.from('streamed compressed content '.repeat(1000))));
  });
  app.get('/image-bench', (_req, res) => res.type('html').send(`<!doctype html><title>Image benchmark</title><div id="images"></div><script>
    const start = performance.now(); let loaded = 0, failed = 0;
    const finish = () => { if (loaded + failed === 48) window.imageResult = { loaded, failed, elapsedMs: performance.now() - start }; };
    for (let i = 0; i < 48; i++) { const image = new Image(64, 64); image.onload = () => { loaded++; finish(); }; image.onerror = () => { failed++; finish(); }; image.src = '/image-bench/' + i + '.svg'; document.querySelector('#images').append(image); }
  </script>`));
  const benchmarkImage = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">' + Array.from({ length: 750 }, (_, i) => `<rect x="${i % 256}" y="${i * 7 % 256}" width="16" height="16" fill="rgb(${i % 255},${i * 13 % 255},${i * 19 % 255})"/>`).join('') + '</svg>');
  app.get('/image-bench/:image', (_req, res) => res.set('Cache-Control', 'public, max-age=300').type('svg').send(benchmarkImage));
  app.get('/_next/image', (_req, res) => { cacheCounts['optimized-image'] = (cacheCounts['optimized-image'] || 0) + 1; res.set('Cache-Control', 'public, max-age=300').type('svg').send(benchmarkImage); });
  app.get('/api/session', (req, res) => res.json({ user: userFor(req) }));
  app.post('/api/login', (req, res) => {
    const name = String(req.body?.name || '').trim().slice(0, 24);
    if (!name) return res.status(400).json({ error: 'Enter a test nickname.' });
    const token = randomBytes(24).toString('hex');
    sessions.set(token, { name });
    res.set('Set-Cookie', `harbor_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`);
    res.json({ user: { name } });
  });
  app.post('/api/post-redirect', (req, res) => res.redirect(307, '/api/post-received'));
  app.post('/api/post-received', (req, res) => res.json({ method: req.method, body: req.body }));
  app.get('/api/post-received', (_req, res) => res.status(405).json({ error: 'POST was changed to GET' }));
  app.use(express.static(directory));
  const server = http.createServer(app);
  server.on('clientError', (error, socket) => { if (process.env.HARBOR_DEBUG) console.error('Fixture HTTP parser:', error.message); socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  const roomName = value => /^[a-z0-9-]{1,24}$/.test(value || '') ? value : 'first-room';
  function broadcast(room) {
    const members = rooms.get(room);
    if (!members) return;
    const payload = JSON.stringify({ type: 'state', players: [...members.values()].map(p => ({ id: p.id, x: p.x, y: p.y, color: p.color })) });
    for (const ws of members.keys()) if (ws.readyState === 1) ws.send(payload);
  }
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://fixture.test');
    if (url.pathname !== '/room') return socket.destroy();
    wss.handleUpgrade(req, socket, head, ws => {
      const room = roomName(url.searchParams.get('room'));
      const id = randomBytes(5).toString('hex');
      if (!rooms.has(room)) rooms.set(room, new Map());
      const player = { id, x: 40 + Math.random() * 240, y: 50 + Math.random() * 100, color: ['#70e1c6', '#ffbc72', '#bdadff'][rooms.get(room).size % 3] };
      rooms.get(room).set(ws, player);
      ws.send(JSON.stringify({ type: 'hello', id, user: userFor(req) }));
      broadcast(room);
      ws.on('message', (bytes, binary) => {
        if (binary) { ws.send(bytes, { binary: true }); return; }
        let message;
        try { message = JSON.parse(bytes.toString()); } catch { return; }
        if (message.type === 'ping') return ws.send(JSON.stringify({ type: 'pong', at: message.at }));
        if (message.type === 'move' && Number.isFinite(message.x) && Number.isFinite(message.y)) {
          player.x = Math.max(8, Math.min(312, message.x));
          player.y = Math.max(8, Math.min(192, message.y));
          broadcast(room);
        }
      });
      ws.on('close', () => {
        rooms.get(room)?.delete(ws);
        if (!rooms.get(room)?.size) rooms.delete(room);
        else broadcast(room);
      });
    });
  });
  return { server, async close() { for (const ws of wss.clients) ws.terminate(); for (const socket of sockets) socket.destroy(); wss.close(); await new Promise(resolve => server.close(resolve)); } };
}
