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
const publicLookupEndpoints = new Set([
  'getGJLevels21.php', 'getGJUsers20.php', 'getGJUserInfo20.php',
  'downloadGJLevel21.php', 'downloadGJLevel22.php', 'getGJSongInfo.php',
  'getGJGauntlets21.php', 'getGJMapPacks21.php', 'getGJDailyLevel.php',
]);
const publicLookupFields = new Set([
  'gameVersion', 'binaryVersion', 'gdw', 'secret', 'type', 'str', 'page', 'total',
  'diff', 'len', 'uncompleted', 'onlyCompleted', 'featured', 'original', 'twoPlayer',
  'coins', 'epic', 'star', 'noStar', 'legendary', 'mythic', 'starred', 'demonFilter',
  'song', 'customSong', 'list', 'local', 'ids', 'gauntlet', 'targetAccountID',
  'levelID', 'songID', 'inc', 'extras', 'revision', 'mode', 'count',
]);
const publicLookupRelays = [
  'https://gd-proxy.webdashers.workers.dev',
  'https://webdashers.webdashersdevelopement.workers.dev',
];

function lookupRoutes(url, method, body) {
  const routes = [{ url, body, fallback: false }];
  const match = /^\/database\/([^/]+)$/.exec(url.pathname);
  if (url.hostname !== 'www.boomlings.com' || method !== 'POST' || url.search ||
      !match || !publicLookupEndpoints.has(match[1])) return routes;
  let text;
  if (typeof body === 'string') text = body;
  else if (ArrayBuffer.isView(body)) text = new TextDecoder().decode(body);
  else if (body instanceof URLSearchParams) text = body.toString();
  else return routes;
  const publicForm = new URLSearchParams();
  for (const [name, value] of new URLSearchParams(text)) {
    if (publicLookupFields.has(name)) publicForm.append(name, value);
  }
  for (const base of publicLookupRelays) {
    routes.push({ url: new URL('/' + match[1], base), body: publicForm.toString(), fallback: true });
  }
  return routes;
}

async function inspectLookupBody(body) {
  const reader = body.getReader();
  let first;
  try { first = await reader.read(); }
  catch (error) { await reader.cancel().catch(() => {}); throw error; }
  if (!first.done && /^\s*(?:<!doctype|<html|<head|<body)/i.test(
    new TextDecoder().decode(first.value.subarray(0, 256)))) {
    await reader.cancel();
    return null;
  }
  let initial = first;
  return new ReadableStream({
    async pull(controller) {
      try {
        const chunk = initial || await reader.read();
        initial = null;
        if (chunk.done) controller.close(); else controller.enqueue(chunk.value);
      } catch (error) { controller.error(error); }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
}

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
      let routes = lookupRoutes(url, method, body);
      let routeIndex = 0;
      let invalidResponses = 0;
      onProblem?.('', false, { state: 'connecting' });
      for (let redirects = 0; redirects <= 5; redirects++) {
        options.signal?.throwIfAborted();
        const result = await transport.request(url, method, body, [...headers], options.signal);
        const responseHeaders = new Headers(result.headers);
        const location = responseHeaders.get('location');
        if ([403, 502, 503, 504].includes(result.status) && routeIndex + 1 < routes.length) {
          await result.body.cancel();
          const next = routes[++routeIndex];
          url = next.url; body = next.body;
          headers.set('content-type', 'application/x-www-form-urlencoded');
          continue;
        }
        if ([301, 302, 303, 307, 308].includes(result.status) && location) {
          await result.body.cancel();
          if (redirects === 5) throw new Error('The Geometry Dash service redirected too many times.');
          if (routes[routeIndex]?.fallback) {
            if (routeIndex + 1 >= routes.length) throw new Error('The public level relay returned an unexpected redirect.');
            const next = routes[++routeIndex];
            url = next.url; body = next.body;
            continue;
          }
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
          throw new Error('Harbor connected, but the game service rejected ' +
            (routeIndex ? 'the public level lookup' : 'the request') + ' (HTTP ' + result.status + ').');
        }
        let responseBody = noBody ? null : result.body;
        if (responseBody && routes.length > 1) {
          responseBody = await inspectLookupBody(responseBody);
          if (!responseBody) {
            invalidResponses++;
            if (routeIndex + 1 >= routes.length) throw new Error('The game service returned a blocked web page instead of level data.');
            const next = routes[++routeIndex];
            url = next.url; body = next.body;
            headers.set('content-type', 'application/x-www-form-urlencoded');
            continue;
          }
        }
        onProblem?.('', false, { state: 'connected', fallback: routeIndex > 0 });
        return new Response(responseBody, {
          status: result.status, statusText: result.statusText || '', headers: responseHeaders,
        });
      }
      throw new Error(invalidResponses ? 'The game service returned invalid level data.' : 'The game request exceeded the redirect limit.');
    } catch (error) {
      if (error.name === 'AbortError' || options.signal?.aborted) throw error;
      const needsConnection = error.needsConnection || [401, 403].includes(error.relayStatus) || /access key|matching browser origin|unauthorized/i.test(error.message || '');
      onProblem?.(error.message || 'The game could not reach your Harbor server.', needsConnection, { state: 'failed' });
      throw error;
    }
  };
}
