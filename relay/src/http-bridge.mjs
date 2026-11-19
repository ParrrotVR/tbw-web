import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { resolveAddress } from './resolve-address.mjs';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { pipeline, Readable } from 'node:stream';
import { Impit } from 'impit';
import { socketCertificateAuthorities } from './tls-chain.mjs';

const hopHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length']);
const impitMethods = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);
// Cloudflare and similar services score the TLS/HTTP2 fingerprint of the
// connection that reaches them, and challenge Node's own TLS on sight. HTTPS
// therefore goes through impit, which presents the matching browser's handshake.
export function browserProfile(userAgent = '') {
  // Every iPhone and iPad browser (Safari, Chrome "CriOS", Firefox "FxiOS", Edge "EdgiOS")
  // runs Safari's engine and network stack, so all of them must look like Safari. Giving
  // them Chrome's network signature made Cloudflare checks loop on iPad Chrome and Firefox.
  if (/iPad|iPhone|iPod/.test(userAgent)) return 'ios18';
  // iPads usually present a Mac identity, and Firefox/Chrome on iPad may omit "Version/".
  // Safari's engine always reports AppleWebKit/60x; Chrome-family browsers report 537.36.
  if (/Macintosh/.test(userAgent) && /AppleWebKit\/60\d/.test(userAgent) && !/Chrome\/|Chromium|Edg/.test(userAgent)) return 'ios18';
  if (/Firefox\//.test(userAgent)) return 'firefox144';
  return 'chrome151';
}
export function createHttpBridge({ fixturePort, isAllowedDestination, diagnostics = {}, originAllowed, impersonate = process.env.HARBOR_IMPERSONATE !== '0' }) {
  // Request summaries for /api/diagnostics: host, path without query, status,
  // timing and Cloudflare mitigation. No headers, cookies or bodies are kept.
  const log = diagnostics.http = { inFlight: 0, total: 0, recent: [], problems: [] };
  function track(url, method, res) {
    const entry = { at: new Date().toISOString(), method, host: url.host, path: url.pathname.slice(0, 120), status: 0, via: '', headersMs: 0, totalMs: 0 };
    const started = Date.now();
    log.inFlight++; log.total++;
    log.recent.push(entry); if (log.recent.length > 300) log.recent.shift();
    res.once('close', () => {
      log.inFlight--; entry.totalMs = Date.now() - started;
      if (!res.writableFinished && !entry.error) entry.error = 'closed early';
      if (entry.status >= 400 || entry.error || entry.cf || entry.totalMs > 15000) { log.problems.push(entry); if (log.problems.length > 150) log.problems.shift(); }
    });
    const record = (status, via, cf) => { Object.assign(entry, { status, via, headersMs: Date.now() - started }); if (cf) entry.cf = cf; };
    record.fail = (via, message) => Object.assign(entry, { via, error: String(message).replace(/[a-z]+:\/\/\S+/gi, '[destination]').slice(0, 160) });
    return record;
  }
  const options = { keepAlive: true, maxSockets: 24, maxTotalSockets: 96, maxFreeSockets: 8, timeout: 30000 };
  const httpAgent = new http.Agent(options);
  const httpsAgent = new https.Agent({ ...options, ca: socketCertificateAuthorities(), rejectUnauthorized: true });
  const requests = new Set();
  const dns = new Map();
  async function resolve(hostname) {
    const cached = dns.get(hostname);
    if (cached && cached.expires > Date.now()) return cached.promise;
    const entry = { expires: Date.now() + 30000, promise: resolveAddress(hostname) };
    dns.set(hostname, entry);
    if (dns.size > 256) dns.delete(dns.keys().next().value);
    try { return await entry.promise; } catch (error) { if (dns.get(hostname) === entry) dns.delete(hostname); throw error; }
  }

  // impit resolves names itself, so it connects through this loopback CONNECT
  // tunnel. The tunnel repeats the destination check and dials the checked
  // address; TLS passes through untouched, keeping impit's fingerprint.
  const tunnelToken = randomBytes(18).toString('base64url');
  const tunnels = new Set();
  const tunnel = http.createServer((_req, res) => res.writeHead(405).end());
  tunnel.on('connect', async (req, client, head) => {
    tunnels.add(client); client.once('close', () => tunnels.delete(client)); client.on('error', () => {});
    try {
      if (req.headers['proxy-authorization'] !== 'Basic ' + Buffer.from('harbor:' + tunnelToken).toString('base64')) throw new Error('Unauthorized');
      const { hostname, port } = new URL('https://' + req.url);
      const { address } = await resolve(hostname);
      if (!isAllowedDestination(hostname, Number(port || 443), address, fixturePort)) throw new Error('Destination outside browser scope');
      const remote = net.connect(Number(port || 443), address);
      tunnels.add(remote); remote.once('close', () => tunnels.delete(remote));
      remote.once('connect', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) remote.write(head); client.pipe(remote).pipe(client); });
      remote.on('error', () => client.destroy()); client.once('close', () => remote.destroy());
    } catch { client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); }
  });
  let tunnelReady;
  const impits = new Map();
  async function impitFor(profile) {
    tunnelReady ??= new Promise(done => tunnel.listen(0, '127.0.0.1', done));
    await tunnelReady;
    if (!impits.has(profile)) impits.set(profile, new Impit({ browser: profile, followRedirects: false, timeout: null, proxyUrl: `http://harbor:${tunnelToken}@127.0.0.1:${tunnel.address().port}` }));
    return impits.get(profile);
  }
  if (impersonate) impitFor('chrome151').catch(() => {});

  function sendHead(res, status, statusText, rawHeaders) {
    const metadata = Buffer.from(JSON.stringify({ status, statusText, headers: rawHeaders }));
    const size = Buffer.alloc(4); size.writeUInt32BE(metadata.length);
    res.status(200).set({ 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Harbor-Stream': '1' });
    res.write(size); res.write(metadata);
  }

  async function impitRequest(req, res, url, config, headers, record) {
    // Scramjet supplies the browser's sec-fetch/client-hint headers. Blank out
    // impit's navigation defaults the page request did not actually carry.
    const navigate = headers['sec-fetch-mode'] === 'navigate';
    const outgoing = [];
    for (const [name, value] of Object.entries(headers)) for (const item of [].concat(value)) outgoing.push([name, item]);
    for (const name of ['sec-fetch-user', 'upgrade-insecure-requests', 'priority']) if (headers[name] === undefined && !navigate) outgoing.push([name, '']);
    if (headers['accept-language'] === undefined) outgoing.push(['accept-language', 'en-US,en;q=0.9']);
    const body = ['GET', 'HEAD'].includes(config.method) ? undefined : Buffer.concat(await Array.fromAsync(req));
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once('aborted', abort);
    res.once('close', () => { if (!res.writableFinished) abort(); });
    const timer = setTimeout(abort, 30000);
    let response;
    try { response = await (await impitFor(browserProfile(headers['user-agent']))).fetch(url.href, { method: config.method, headers: outgoing, body, redirect: 'manual', signal: controller.signal }); }
    finally { clearTimeout(timer); }
    record(response.status, 'browser-tls', response.headers.get('cf-mitigated'));
    if (process.env.HARBOR_DEBUG) console.log('Remote', response.status, config.method, url.host + url.pathname, '(browser TLS)');
    // impit has already decoded the body; its length and encoding no longer apply.
    const rawHeaders = [];
    for (const [name, value] of response.headers) if (!hopHeaders.has(name) && name !== 'content-encoding' && name !== 'set-cookie') rawHeaders.push([name, value]);
    for (const cookie of response.headers.getSetCookie()) rawHeaders.push(['set-cookie', cookie]);
    sendHead(res, response.status, response.statusText || '', rawHeaders);
    if (config.method === 'HEAD' || [204, 205, 304].includes(response.status) || !response.body) { response.body?.cancel().catch(() => {}); res.end(); return; }
    pipeline(Readable.fromWeb(response.body), res, () => {});
  }

  function nodeRequest(req, res, url, config, headers, address, record) {
    headers['accept-encoding'] = 'gzip, deflate, br';
    const client = url.protocol === 'https:' ? https : http;
    const remote = client.request(url, {
      // Node's default 16 KB response-header limit rejects big sites such as YouTube.
      method: config.method, headers, agent: url.protocol === 'https:' ? httpsAgent : httpAgent, maxHeaderSize: 256 * 1024,
      lookup(_name, options, callback) { const family = net.isIP(address); callback(null, options?.all ? [{ address, family }] : address, family); },
    });
    requests.add(remote);
    remote.once('close', () => requests.delete(remote));
    req.once('aborted', () => remote.destroy());
    res.once('close', () => { if (!res.writableFinished) remote.destroy(); });
    remote.setTimeout(30000, () => remote.destroy(new Error('Remote request timed out')));
    remote.once('error', error => {
      record.fail('node-tls', error.code || error.message);
      if (res.headersSent) return res.destroy(error);
      if (!res.destroyed) res.status(502).type('text').send('Remote request failed: ' + String(error.code || 'NETWORK_ERROR'));
    });
    remote.once('response', response => {
      record(response.statusCode, 'node-tls', response.headers['cf-mitigated']);
      if (process.env.HARBOR_DEBUG) console.log('Remote', response.statusCode, config.method, url.host + url.pathname, process.env.HARBOR_DEBUG === 'headers' ? config.headers.map(([name]) => name).join(',') : '');
      const encoding = String(response.headers['content-encoding'] || '').trim().toLowerCase();
      const decoders = { gzip: createGunzip, deflate: createInflate, br: createBrotliDecompress };
      const bodyAllowed = config.method !== 'HEAD' && ![204, 205, 304].includes(response.statusCode);
      const decoder = bodyAllowed && decoders[encoding] ? decoders[encoding]() : null;
      const responseExcluded = new Set(hopHeaders);
      for (const token of String(response.headers.connection || '').split(',')) responseExcluded.add(token.trim().toLowerCase());
      if (decoder) responseExcluded.add('content-encoding');
      const rawHeaders = [];
      for (let i = 0; i < response.rawHeaders.length; i += 2) if (!responseExcluded.has(response.rawHeaders[i].toLowerCase())) rawHeaders.push([response.rawHeaders[i], response.rawHeaders[i + 1]]);
      sendHead(res, response.statusCode, response.statusMessage || '', rawHeaders);
      if (!bodyAllowed) { response.resume(); res.end(); return; }
      // Backpressure and decompression run outside the browser's rendering
      // thread. Headers arrive before the rest of a large image or download.
      pipeline(...(decoder ? [response, decoder, res] : [response, res]), () => {});
    });
    if (config.method === 'GET' || config.method === 'HEAD') { req.resume(); remote.end(); }
    else req.pipe(remote);
    return remote;
  }

  async function handle(req, res) {
    const origin = `${req.socket.encrypted ? 'https:' : 'http:'}//${req.headers.host}`;
    if (!(originAllowed ? originAllowed(req.headers.origin, req) : req.headers.origin === origin)) return res.status(403).type('text').send('Matching browser origin required');
    let remote;
    try {
      const encoded = req.headers['x-harbor-request'];
      if (typeof encoded !== 'string' || encoded.length > 14000) throw new Error('Invalid request metadata');
      const config = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      const url = new URL(config.url);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Unsupported destination');
      if (!/^[A-Z]+$/.test(config.method) || ['CONNECT', 'TRACE', 'TRACK'].includes(config.method)) throw new Error('Unsupported method');
      const { address } = await resolve(url.hostname);
      const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
      if (!isAllowedDestination(url.hostname, port, address, fixturePort)) throw new Error('Destination outside browser scope');
      if (res.destroyed) return;
      if (!Array.isArray(config.headers) || config.headers.length > 120) throw new Error('Invalid request headers');
      const headers = Object.create(null);
      const excluded = new Set(hopHeaders);
      for (const [name, value] of config.headers) if (String(name).toLowerCase() === 'connection') for (const token of String(value).split(',')) excluded.add(token.trim().toLowerCase());
      for (const [name, value] of config.headers) {
        http.validateHeaderName(name); http.validateHeaderValue(name, value);
        const lower = name.toLowerCase();
        if (excluded.has(lower) || lower.startsWith('proxy-')) continue;
        if (headers[lower] === undefined) headers[lower] = value;
        else headers[lower] = [].concat(headers[lower], value);
      }
      const record = track(url, config.method, res);
      if (impersonate && url.protocol === 'https:' && impitMethods.has(config.method)) {
        try { return await impitRequest(req, res, url, config, headers, record); }
        catch (error) {
          record.fail('browser-tls', error.code || error.message);
          if (res.headersSent || res.destroyed) return res.destroy();
          // A certificate chain or protocol impit rejects can still load over
          // Node's verified path; bodies of other methods were already consumed.
          if (error.name === 'AbortError') return res.status(504).type('text').send('Remote request timed out');
          if (!['GET', 'HEAD'].includes(config.method)) return res.status(502).type('text').send('Remote request failed: ' + String(error.code || error.message || 'NETWORK_ERROR').slice(0, 120));
          if (process.env.HARBOR_DEBUG) console.log('Browser TLS failed, using Node TLS:', url.host, String(error.message).slice(0, 160));
        }
      }
      remote = nodeRequest(req, res, url, config, headers, address, record);
    } catch (error) {
      remote?.destroy();
      if (!res.headersSent && !res.destroyed) res.status(400).type('text').send(String(error.message).slice(0, 180));
    }
  }
  function close() {
    for (const request of requests) request.destroy();
    for (const socket of tunnels) socket.destroy();
    if (tunnel.listening) tunnel.close();
    httpAgent.destroy(); httpsAgent.destroy();
  }
  return { handle, close };
}
