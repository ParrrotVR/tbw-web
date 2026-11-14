const CACHE_NAME = 'harbor-public-assets-v1';
const MAX_BYTES = 8 * 1024 * 1024;
const extension = /\.(?:js|mjs|css|wasm|woff2?|ttf|otf|png|jpe?g|webp|avif|gif|svg|ico)(?:$)/i;
export function cacheLifetime(headers, status = 200) {
  if (status !== 200 || headers.has('set-cookie')) return 0;
  const policy = headers.get('cache-control') || '';
  if (/(?:^|,)\s*(?:private|no-store|no-cache)(?:\s|,|=|$)/i.test(policy)) return 0;
  const maxAge = /(?:^|,)\s*max-age\s*=\s*"?(\d+)/i.exec(policy);
  if (!maxAge) return 0;
  const vary = (headers.get('vary') || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (vary.some(name => !['accept', 'accept-encoding', 'accept-language', 'origin'].includes(name))) return 0;
  const apparentAge = headers.has('date') ? Math.max(0, (Date.now() - Date.parse(headers.get('date'))) / 1000) : 0;
  const age = Math.max(Number(headers.get('age') || 0), Number.isFinite(apparentAge) ? apparentAge : 0);
  return Math.max(0, Math.min(86400, Number(maxAge[1]) - age));
}
export class AssetCache {
  stats = { hits: 0, misses: 0, writes: 0, bytes: 0 };
  pending = new Set();
  async clear() { await Promise.allSettled([...this.pending]); await caches.delete(CACHE_NAME); this.stats = { hits: 0, misses: 0, writes: 0, bytes: 0 }; }
  async request(transport, url, method, body, rawHeaders, signal) {
    const headers = new Headers(rawHeaders);
    const eligible = method === 'GET' && (extension.test(url.pathname) || /\/_next\/image$/.test(url.pathname)) && !headers.has('authorization') && !headers.has('range') && !/no-cache|no-store/i.test(headers.get('cache-control') || '') && 'caches' in globalThis;
    if (!eligible) return transport(url, method, body, rawHeaders, signal);
    let cache, key;
    try {
      const partition = [headers.get('cookie') || '', headers.get('accept') || '', headers.get('accept-language') || '', headers.get('origin') || ''].join('\n');
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(partition)))].map(n => n.toString(16).padStart(2, '0')).join('');
      key = new Request(`https://harbor-assets.invalid/${hash}/${encodeURIComponent(url.href)}`);
      cache = await caches.open(CACHE_NAME);
      const match = await cache.match(key);
      if (match && Number(match.headers.get('x-harbor-expires')) > Date.now()) {
        this.stats.hits++;
        const resultHeaders = [...match.headers].filter(([name]) => name !== 'x-harbor-expires');
        return { body: match.body, headers: resultHeaders, status: match.status, statusText: match.statusText };
      }
    } catch {}
    this.stats.misses++;
    const result = await transport(url, method, body, rawHeaders, signal);
    const responseHeaders = new Headers(result.headers);
    const lifetime = cacheLifetime(responseHeaders, result.status);
    if (!cache || !lifetime || (headers.has('cookie') && !/(?:^|,)\s*public(?:\s|,|$)/i.test(responseHeaders.get('cache-control') || '')) || Number(responseHeaders.get('content-length')) > MAX_BYTES) return result;
    const response = new Response(result.body, { status: result.status, statusText: result.statusText, headers: responseHeaders });
    const copy = response.clone();
    const task = (async () => {
      const reader = copy.body.getReader(); const chunks = []; let size = 0;
      while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > MAX_BYTES) { reader.cancel().catch(() => {}); return; } chunks.push(value); }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const storedHeaders = new Headers(responseHeaders); storedHeaders.set('x-harbor-expires', String(Date.now() + lifetime * 1000)); storedHeaders.delete('content-length');
      await cache.put(key, new Response(bytes, { status: result.status, statusText: result.statusText, headers: storedHeaders }));
      this.stats.writes++; this.stats.bytes += size;
    })().catch(() => {});
    this.pending.add(task); task.finally(() => this.pending.delete(task));
    return { ...result, body: response.body };
  }
}
