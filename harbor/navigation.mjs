export const SEARCH_ENGINES = {
  google: { name: 'Google', url: 'https://www.google.com/search?q=' },
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
  ddglite: { name: 'DuckDuckGo Lite', url: 'https://html.duckduckgo.com/html/?q=' },
  bing: { name: 'Bing', url: 'https://www.bing.com/search?q=' },
};
export function resolveInput(input, engine = 'google') {
  const text = String(input).trim();
  if (!text) return null;
  if (/^[a-z][\da-z+.-]*:\/\//i.test(text) || /^(?:javascript|data|file|about|blob):/i.test(text)) {
    const url = new URL(text);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP or HTTPS address.');
    return url.href;
  }
  if (!/\s/.test(text) && /^(?:localhost(?::\d+)?|\[[\da-f:]+\](?::\d+)?|[^/?#]+\.[^/?#]+)(?:[/?#].*)?$/i.test(text)) {
    const local = /^(?:localhost|127\.0\.0\.1)(?::|\/|$)/.test(text);
    const url = new URL((local ? 'http://' : 'https://') + text);
    if (url.username || url.password) throw new Error('Embedded credentials are not supported.');
    return url.href;
  }
  return (SEARCH_ENGINES[engine] || SEARCH_ENGINES.google).url + encodeURIComponent(text);
}
export function pageLabel(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'New tab'; }
}
export function decodeProxyPath(pathname) {
  if (!/^\/~\/sj\/[^/]+\/[^/]+\//.test(pathname)) return null;
  try {
    const url = new URL(decodeURIComponent(pathname.split('/').slice(5).join('/')));
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
