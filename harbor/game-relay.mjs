import { getRelay } from './relay-settings.mjs';
import { NativeHttpTransport } from './http-client.mjs';

const destinations = new Map([
  ['boomlings.com', 'b'], ['www.boomlings.com', 'b'],
  ['robtopgames.org', 'r'], ['www.robtopgames.org', 'r'],
  ['audio.ngfiles.com', 'n'], ['geometrydashfiles.b-cdn.net', 'c'],
]);
const workers = new Set([
  'gd-proxy.webdashers.workers.dev', 'webdashers.webdashersdevelopement.workers.dev',
  'fallbackgdproxy.webdashers.workers.dev', 'fallback2.webdashers.workers.dev',
]);
const queryProxies = new Set(['api.sngdu.com', 'api.ixl.college']);
const queryDestinations = new Map([
  ['b', 'www.boomlings.com'], ['r', 'www.robtopgames.org'],
  ['n', 'audio.ngfiles.com'], ['c', 'geometrydashfiles.b-cdn.net'],
]);
const genericProxies = new Set(['proxy.corsfix.com', 'corsproxy.io', 'api.allorigins.win']);
const forwardedHeaders = new Set(['accept', 'accept-language', 'content-type', 'range', 'if-range']);

export function geometryDashDestination(input) {
  let value = String(input);
  for (let depth = 0; depth < 8; depth++) {
    if (/^(?:gd-proxy\.webdashers|webdashers\.webdashersdevelopement|fallbackgdproxy\.webdashers|fallback2\.webdashers)\.workers\.dev\//i.test(value)) {
      value = 'https://' + value;
    }
    const url = new URL(value, 'https://www.boomlings.com');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) {
      throw new Error('Unsupported Geometry Dash destination.');
    }
    if (url.pathname === '/__proxy' && url.searchParams.has('url')) {
      value = url.searchParams.get('url');
      continue;
    }
    if (queryProxies.has(url.hostname)) {
      let target;
      for (const [key, host] of queryDestinations) {
        if (!url.searchParams.has(key)) continue;
        target = 'https://' + host + '/' + url.searchParams.get(key).replace(/^\/+/, '');
        break;
      }
      if (!target) throw new Error('The Geometry Dash proxy address has no supported destination.');
      value = target;
      continue;
    }
    if (workers.has(url.hostname)) {
      value = url.pathname === '/audio-proxy' && url.searchParams.has('url')
        ? url.searchParams.get('url')
        : 'https://www.boomlings.com/database' + url.pathname + url.search;
      continue;
    }
    if (genericProxies.has(url.hostname)) {
      value = url.searchParams.get('url') || url.search.slice(1);
      if (!/^https?:/i.test(value)) {
        try { value = decodeURIComponent(value); } catch {}
      }
      continue;
    }
    if (!destinations.has(url.hostname)) throw new Error('This address is outside Geometry Dash’s game services.');
    if (url.hostname === 'boomlings.com') url.hostname = 'www.boomlings.com';
    url.protocol = 'https:';
    url.hash = '';
    return url;
  }
  throw new Error('The Geometry Dash address contains too many nested proxies.');
}

export function createGameRelay(onProblem) {
  const transport = new NativeHttpTransport();
  return async function request(input, options = {}) {
    try {
      const relay = getRelay();
      if (relay.mode !== 'harbor' || !relay.address) {
        const error = new Error('Connect your Harbor server in Connection to search creators and download levels or music.');
        error.needsConnection = true;
        throw error;
      }
      let url = geometryDashDestination(input);
      let method = String(options.method || 'GET').toUpperCase();
      if (!['GET', 'HEAD', 'POST'].includes(method)) throw new Error('Unsupported Geometry Dash request method.');
      let body = ['GET', 'HEAD'].includes(method) ? null : options.body;
      const headers = new Headers();
      for (const [name, value] of new Headers(options.headers)) {
        if (forwardedHeaders.has(name)) headers.set(name, value);
      }
      // Geometry Dash's game API rejects browser User-Agent strings.
      headers.set('User-Agent', '');
      for (let redirects = 0; redirects <= 5; redirects++) {
        options.signal?.throwIfAborted();
        const result = await transport.request(url, method, body, [...headers], options.signal);
        const responseHeaders = new Headers(result.headers);
        const location = responseHeaders.get('location');
        if ([301, 302, 303, 307, 308].includes(result.status) && location) {
          await result.body.cancel();
          if (redirects === 5) throw new Error('The Geometry Dash service redirected too many times.');
          url = geometryDashDestination(new URL(location, url).href);
          if (result.status === 303 && method !== 'HEAD' || [301, 302].includes(result.status) && method === 'POST') {
            method = 'GET'; body = null; headers.delete('content-type');
          }
          continue;
        }
        // The relay decodes compressed responses before sending their bodies.
        responseHeaders.delete('content-encoding');
        responseHeaders.delete('content-length');
        responseHeaders.delete('set-cookie');
        const noBody = method === 'HEAD' || [204, 205, 304].includes(result.status);
        if (noBody) await result.body.cancel();
        if (result.status >= 400) {
          if (!noBody) await result.body.cancel();
          throw new Error('Geometry Dash rejected the online request (HTTP ' + result.status + ').');
        }
        onProblem?.('', false);
        return new Response(noBody ? null : result.body, {
          status: result.status, statusText: result.statusText || '', headers: responseHeaders,
        });
      }
    } catch (error) {
      if (error.name === 'AbortError' || options.signal?.aborted) throw error;
      const needsConnection = error.needsConnection || /access key|matching browser origin|unauthorized/i.test(error.message || '');
      onProblem?.(error.message || 'The game could not reach your Harbor server.', needsConnection);
      throw error;
    }
  };
}
