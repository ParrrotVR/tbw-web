export const portalBase = new URL('./', import.meta.url);
export function normalizeRelay(mode, value) {
  const url = new URL(String(value).trim());
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.hash) throw new Error('Use a connection address without embedded credentials or a fragment.');
  if (mode === 'wisp') {
    if (url.protocol !== 'wss:' && !(local && url.protocol === 'ws:')) throw new Error('Use a secure wss:// Wisp address.');
    return url.href;
  }
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('Use an HTTPS Harbor server address.');
  if (url.pathname !== '/' || url.search) throw new Error('Use the server root address, without a page path.');
  return url.origin;
}
export function getRelay() {
  try {
    const saved = JSON.parse(localStorage.getItem('harbor:relay') || '{}');
    const mode = saved.mode === 'harbor' ? 'harbor' : 'wisp';
    return { mode, address: saved.address ? normalizeRelay(mode, saved.address) : '', key: sessionStorage.getItem('harbor:relay-key') || '' };
  } catch { return { mode: 'wisp', address: '', key: '' }; }
}
export function saveRelay(mode, address, key = '') {
  const next = { mode: mode === 'harbor' ? 'harbor' : 'wisp', address: normalizeRelay(mode, address) };
  localStorage.setItem('harbor:relay', JSON.stringify(next));
  if (key) sessionStorage.setItem('harbor:relay-key', key); else sessionStorage.removeItem('harbor:relay-key');
  return getRelay();
}
export async function relayFetch(path, options = {}, override) {
  const relay = override || getRelay();
  if (relay.mode !== 'harbor' || !relay.address) throw new Error('Connect a Harbor server first.');
  const headers = new Headers(options.headers);
  if (relay.key) headers.set('X-Harbor-Key', relay.key);
  return fetch(new URL(path, relay.address), { ...options, headers, credentials: 'omit', cache: 'no-store' });
}
export function relayProtocols(key) {
  if (!key) return [];
  const encoded = btoa(Array.from(new TextEncoder().encode(key), byte => String.fromCharCode(byte)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return ['harbor', 'harbor-key.' + encoded];
}
