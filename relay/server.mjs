import { relayAccess } from './src/relay-access.mjs';
import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';
import { lookup } from 'node:dns/promises';
import { spawn } from 'node:child_process';
import express from 'express';
import ipaddr from 'ipaddr.js';
import { server as wisp, logging } from '@mercuryworkshop/wisp-js/server';
import { createFixture } from './src/fixture-server.mjs';
import { createSocketBridge } from './src/socket-bridge.mjs';
import { decodeProxyPath } from './public/navigation.mjs';
import { createHttpBridge } from './src/http-bridge.mjs';
import { buildId } from './src/build-id.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { version } = require('./package.json');
const build = buildId();
const wispEntry = require.resolve('@mercuryworkshop/wisp-js/server');
const netPath = path.resolve(path.dirname(wispEntry), '../src/server/net.mjs');
// The CJS entry resolves under dist; use the package's pinned ESM socket adapter.
const { NodeTCPSocket } = await import(pathToFileURL(netPath).href);

export function isAllowedDestination(hostname, port, address, fixturePort) {
  if (hostname === '127.0.0.1' && port === fixturePort && address === '127.0.0.1') return true;
  // Public internet addresses only. Games often run on high ports (8080, 2096, 9000…),
  // so any port from 1024 up is allowed alongside 80 and 443.
  return (port === 80 || port === 443 || (port >= 1024 && port <= 65535)) && ipaddr.isValid(address) && ipaddr.process(address).range() === 'unicast';
}

export async function startLab({ port = 4173, fixturePort = 4174, host = '127.0.0.1', tls } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  const access = relayAccess();
  app.use(access.middleware);
  const diagnostics = { startedAt: new Date().toISOString(), connections: 0, destinations: [], sockets: [], errors: [] };
  const fixture = createFixture(path.join(root, 'fixture'));
  await new Promise((resolve, reject) => fixture.server.once('error', reject).listen(fixturePort, '127.0.0.1', resolve));
  fixturePort = fixture.server.address().port;
  const fixtureOrigin = `http://127.0.0.1:${fixturePort}`;
  const httpBridge = createHttpBridge({ fixturePort, isAllowedDestination, diagnostics, originAllowed: access.originAllowed });

  logging.set_level(logging.ERROR);
  Object.assign(wisp.options, {
    allow_private_ips: false, allow_loopback_ips: true, allow_udp_streams: false,
    port_whitelist: [80, 443, fixturePort], stream_limit_total: 256,
    parse_real_ip: false, dns_result_order: 'ipv4first',
  });
  class LabTCPSocket extends NodeTCPSocket {
    async send(data) {
      if (process.env.HARBOR_DEBUG && this.hostname === '127.0.0.1') console.log('Fixture request:', Buffer.from(data).toString().split('\r\n')[0]);
      return super.send(data);
    }
    async connect() {
      const { address } = await lookup(this.hostname, { family: 4 });
      if (!isAllowedDestination(this.hostname, this.port, address, fixturePort)) throw new Error('Destination outside lab scope');
      // Pin the checked address so the connect cannot resolve a different address.
      const target = { host: this.hostname, port: this.port, at: new Date().toISOString() };
      diagnostics.destinations.push(target);
      diagnostics.destinations = diagnostics.destinations.slice(-60);
      this.hostname = address;
      try { return await super.connect(); }
      catch (error) {
        diagnostics.errors.push({ host: target.host, message: String(error), at: target.at });
        diagnostics.errors = diagnostics.errors.slice(-20);
        throw error;
      }
    }
  }

  app.use((req, res, next) => {
    res.set({
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': req.path.startsWith('/api/') ? 'no-store' : 'no-cache',
    });
    next();
  });
  app.get('/api/health', (_req, res) => res.json({ ok: true, name: 'Harbor', version, build, fixtureOrigin, engine: 'Scramjet 2.0.67-alpha.2', controller: '0.0.14', transport: 'native streaming', nativeHttp: true, socketBridge: true, browserTls: process.env.HARBOR_IMPERSONATE !== '0', udp: false }));
  app.get('/api/time', (_req, res) => res.json({ now: Date.now(), iso: new Date().toISOString() }));
  app.get('/api/diagnostics', (_req, res) => res.json(diagnostics));
  // Which public addresses this server's outgoing traffic uses, over separate connections.
  // Cloudflare ties its clearance cookie to one address, so several addresses here would
  // explain endless "verify you are human" loops. Cached; no key needed; reveals nothing private.
  let egress;
  app.get('/api/egress', async (_req, res) => {
    if (!egress || Date.now() - egress.at > 300000) egress = { at: Date.now(), result: (async () => {
      const viaNode = () => new Promise(resolve => {
        const request = https.get('https://api.ipify.org?format=json', { agent: false, timeout: 8000 }, response => { let body = ''; response.on('data', chunk => body += chunk); response.on('end', () => { try { resolve(JSON.parse(body).ip); } catch { resolve('error'); } }); });
        request.on('error', () => resolve('error')); request.on('timeout', () => request.destroy());
      });
      const viaBrowserTls = async () => { try { const { Impit } = await import('impit'); const response = await new Impit({ browser: 'ios18' }).fetch('https://api.ipify.org?format=json'); return JSON.parse(await response.text()).ip; } catch { return 'error'; } };
      const addresses = await Promise.all([viaNode(), viaNode(), viaNode(), viaNode(), viaBrowserTls(), viaBrowserTls(), viaBrowserTls(), viaBrowserTls()]);
      return { checkedAt: new Date().toISOString(), addresses, distinct: [...new Set(addresses.filter(ip => ip !== 'error'))] };
    })() };
    res.json(await egress.result);
  });
  app.post('/http/', httpBridge.handle);
  const vendorCache = { setHeaders(res) { res.setHeader('Cache-Control', 'public, max-age=86400'); } };
  app.use('/scramjet', express.static(path.join(root, 'node_modules/@mercuryworkshop/scramjet/dist'), vendorCache));
  app.use('/controller', express.static(path.join(root, 'node_modules/@mercuryworkshop/scramjet-controller/dist'), vendorCache));
  app.use('/transport', express.static(path.join(root, 'node_modules/@mercuryworkshop/libcurl-transport/dist'), vendorCache));
  app.use('/epoxy', express.static(path.join(root, 'node_modules/@mercuryworkshop/epoxy-transport/dist'), vendorCache));
  app.get('/', (_req, res) => res.sendFile(path.join(root, 'public/browser.html')));
  app.use(express.static(path.join(root, 'public')));
  // Internal frame URLs have no meaning without their live browser controller.
  // A reopened URL must initialize the shell rather than display a raw 404.
  app.get(/^\/~\/sj\//, (req, res) => {
    const target = decodeProxyPath(req.path);
    res.redirect(302, target ? '/?target=' + encodeURIComponent(target) : '/');
  });
  app.use((_req, res) => res.status(404).type('text').send('Not found. Open / to initialize the proxy.'));

  const server = tls ? https.createServer(tls, app) : http.createServer(app);
  const sockets = createSocketBridge({ fixturePort, isAllowedDestination, diagnostics });
  const activeSockets = new Set();
  server.on('connection', socket => { activeSockets.add(socket); socket.on('close', () => activeSockets.delete(socket)); });
  server.on('upgrade', (req, socket, head) => {
    if (!['/wisp/', '/socket/'].includes(req.url) || !access.upgradeAllowed(req)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    if (req.url === '/socket/') return sockets.accept(req, socket, head);
    diagnostics.connections++;
    wisp.routeRequest(req, socket, head, { TCPSocket: LabTCPSocket });
  });
  try {
    await new Promise((resolve, reject) => server.once('error', reject).listen(port, host, resolve));
  } catch (error) {
    await fixture.close();
    throw error;
  }
  const origin = `${tls ? 'https' : 'http'}://${host === '0.0.0.0' ? 'localhost' : host}:${server.address().port}`;
  return {
    server, origin, fixtureOrigin,
    async close() {
      httpBridge.close();
      sockets.close();
      for (const socket of activeSockets) socket.destroy();
      await Promise.all([new Promise(resolve => server.close(resolve)), fixture.close()]);
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tls = process.env.TLS_CERT && process.env.TLS_KEY
    ? { cert: readFileSync(process.env.TLS_CERT), key: readFileSync(process.env.TLS_KEY) } : undefined;
  const lab = await startLab({ port: Number(process.env.PORT || 4173), fixturePort: Number(process.env.FIXTURE_PORT || 4174), host: process.env.HOST || '127.0.0.1', tls });
  console.log(`Harbor browser lab: ${lab.origin}`);
  console.log(`Controlled test origin: ${lab.fixtureOrigin}`);
  console.log('Press Ctrl+C to stop. iPad access requires trusted HTTPS; see README.md.');
  if (process.env.HARBOR_OPEN_BROWSER === '1' && process.platform === 'win32') {
    const opener = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', lab.origin], { windowsHide: true, stdio: 'ignore' });
    opener.on('error', () => console.log(`Open ${lab.origin} in your browser.`));
    opener.unref();
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await lab.close(); process.exit(0); });
}
