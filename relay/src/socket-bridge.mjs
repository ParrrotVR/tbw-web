import { WebSocket, WebSocketServer } from 'ws';
import { lookup } from 'node:dns/promises';
import { socketCertificateAuthorities } from './tls-chain.mjs';

// A browser-native WebSocket on the local side; Node handles the target TLS and
// handshake. No game payloads, cookies or URL query strings are logged.
export function createSocketBridge({ fixturePort, isAllowedDestination, diagnostics }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024, perMessageDeflate: false });
  const upstreams = new Set();
  const certificateAuthorities = socketCertificateAuthorities();
  const envelope = (kind, payload) => Buffer.concat([Buffer.from([kind]), Buffer.from(payload)]);
  function accept(req, socket, head) {
    wss.handleUpgrade(req, socket, head, client => {
      let upstream;
      let configured = false;
      let record;
      const sendControl = value => { if (client.readyState === WebSocket.OPEN) client.send(envelope(0, JSON.stringify(value))); };
      const timer = setTimeout(() => client.close(1008, 'Connection setup timed out'), 10000);
      const cleanup = () => { clearTimeout(timer); if (upstream && upstream.readyState !== WebSocket.CLOSED) upstream.terminate(); };
      client.on('error', cleanup);
      client.on('close', cleanup);
      client.on('message', async (data, binary) => {
        if (!configured) {
          configured = true;
          try {
            if (binary || data.length > 16384) throw new Error('Invalid connection setup');
            const config = JSON.parse(data.toString());
            const url = new URL(config.url);
            if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password) throw new Error('Unsupported socket address');
            const port = Number(url.port || (url.protocol === 'wss:' ? 443 : 80));
            const { address } = await lookup(url.hostname, { family: 4 });
            if (!isAllowedDestination(url.hostname, port, address, fixturePort)) throw new Error('Destination outside browser scope');
            const protocols = config.protocols ?? [];
            if (!Array.isArray(protocols) || protocols.length > 16 || protocols.some(p => typeof p !== 'string' || !/^[!#$%&'*+\-.^_`|~\da-z]+$/i.test(p))) throw new Error('Invalid subprotocol');
            const forwarded = {};
            for (const [name, value] of config.headers || []) {
              if (typeof value === 'string' && /^(origin|cookie|user-agent|accept-language)$/i.test(name)) forwarded[name.toLowerCase()] = value;
            }
            // Some game servers (digdig.io) silently stall clients whose upgrade
            // request does not look like a browser's. Declare the keys in Chrome's
            // order; ws fills its own handshake keys in place, keeping this order.
            const headers = {
              Host: url.host, Connection: 'Upgrade', Pragma: 'no-cache', 'Cache-Control': 'no-cache',
              'User-Agent': forwarded['user-agent'], Upgrade: 'websocket', Origin: forwarded.origin,
              'Sec-WebSocket-Version': '13', 'Accept-Encoding': 'gzip, deflate, br, zstd',
              'Accept-Language': forwarded['accept-language'] || 'en-US,en;q=0.9', Cookie: forwarded.cookie,
              'Sec-WebSocket-Key': '', 'Sec-WebSocket-Extensions': '',
            };
            for (const name of Object.keys(headers)) if (headers[name] === undefined) delete headers[name];
            record = { host: url.hostname, startedAt: new Date().toISOString(), state: 'connecting', sentFrames: 0, receivedFrames: 0 };
            diagnostics.sockets.push(record); diagnostics.sockets = diagnostics.sockets.slice(-60);
            upstream = new WebSocket(url, protocols, {
              headers, perMessageDeflate: true, handshakeTimeout: 12000,
              maxPayload: 16 * 1024 * 1024,
              ca: certificateAuthorities, rejectUnauthorized: true,
              lookup(_name, options, callback) { callback(null, options?.all ? [{ address, family: 4 }] : address, 4); },
            });
            upstreams.add(upstream);
            upstream.on('open', () => {
              clearTimeout(timer);
              if (client.readyState !== WebSocket.OPEN) return upstream.terminate();
              record.state = 'open';
              sendControl({ type: 'open', protocol: upstream.protocol, extensions: upstream.extensions });
            });
            upstream.on('message', (payload, isBinary) => {
              if (client.readyState !== WebSocket.OPEN) return;
              if (client.bufferedAmount > 8 * 1024 * 1024) return client.close(1013, 'Client is too slow');
              record.receivedFrames++;
              client.send(envelope(isBinary ? 2 : 1, payload));
            });
            upstream.on('close', (code) => {
              clearTimeout(timer); upstreams.delete(upstream);
              record.state = 'closed'; record.closeCode = code;
              sendControl({ type: 'close', code, reason: 'Remote connection closed' });
              client.close(1000);
            });
            upstream.on('error', error => {
              record.state = 'error';
              record.error = String(error.message).replace(/[a-z]+:\/\/\S+/gi, '[destination]').slice(0, 240);
              sendControl({ type: 'error', message: record.error });
              client.close(1011, 'Remote connection failed');
            });
          } catch (error) {
            clearTimeout(timer); sendControl({ type: 'error', message: error.message }); client.close(1008, 'Connection refused');
          }
          return;
        }
        if (!upstream || upstream.readyState !== WebSocket.OPEN || !binary || !data.length) return;
        if (upstream.bufferedAmount > 8 * 1024 * 1024) return client.close(1013, 'Remote connection is too slow');
        if (data[0] === 1 || data[0] === 2) {
          record.sentFrames++; upstream.send(data.subarray(1), { binary: data[0] === 2 });
        } else if (data[0] === 0) {
          try {
            const control = JSON.parse(data.subarray(1).toString());
            if (control.type === 'close') upstream.close(control.code === 1000 || (control.code >= 3000 && control.code <= 4999) ? control.code : 1000);
          } catch {}
        }
      });
    });
  }
  function close() { for (const remote of upstreams) remote.terminate(); for (const client of wss.clients) client.terminate(); wss.close(); }
  return { accept, close };
}
