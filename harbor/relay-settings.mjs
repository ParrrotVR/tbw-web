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
// The key is kept on this device so it survives reloads; iPad Safari wipes session
// storage whenever it reloads a tab to free memory. Older versions kept it per session.
function savedKey() {
  let key = '';
  try { key = localStorage.getItem('harbor:relay-key') || ''; } catch {}
  if (!key) try {
    key = sessionStorage.getItem('harbor:relay-key') || '';
    if (key) { localStorage.setItem('harbor:relay-key', key); sessionStorage.removeItem('harbor:relay-key'); }
  } catch {}
  return key;
}
export function forgetKey() {
  try { localStorage.removeItem('harbor:relay-key'); } catch {}
  try { sessionStorage.removeItem('harbor:relay-key'); } catch {}
}
// For one visit Harbor can switch to the backup server (when the main one is offline)
// without changing what is saved.
export const DEFAULT_SERVER = 'https://harbor-relay.onrender.com';
let sessionRelay = null;
export function useRelayForSession(relay) { sessionRelay = relay; }
export function getRelay() {
  if (sessionRelay) return sessionRelay;
  try {
    const saved = JSON.parse(localStorage.getItem('harbor:relay') || '{}');
    // Nothing set up yet: use Harbor's own public server, no key needed when it runs in public mode.
    if (!saved.address) return { mode: 'harbor', address: DEFAULT_SERVER, key: savedKey(), isDefault: true };
    const mode = saved.mode === 'harbor' ? 'harbor' : 'wisp';
    return { mode, address: saved.address ? normalizeRelay(mode, saved.address) : '', key: savedKey() };
  } catch { return { mode: 'wisp', address: '', key: '' }; }
}
export function saveRelay(mode, address, key = '') {
  const next = { mode: mode === 'harbor' ? 'harbor' : 'wisp', address: normalizeRelay(mode, address) };
  localStorage.setItem('harbor:relay', JSON.stringify(next));
  if (key) localStorage.setItem('harbor:relay-key', key); else forgetKey();
  return getRelay();
}
// The backup server is used when the main one does not answer (e.g. your PC is off).
export function getBackupRelay() {
  try {
    const saved = JSON.parse(localStorage.getItem('harbor:relay-backup') || 'null');
    if (!saved?.address) return null;
    const mode = saved.mode === 'harbor' ? 'harbor' : 'wisp';
    return { mode, address: normalizeRelay(mode, saved.address), key: String(saved.key || '') };
  } catch { return null; }
}
export function saveBackupRelay(relay) {
  try {
    if (relay?.address) localStorage.setItem('harbor:relay-backup', JSON.stringify({ mode: relay.mode, address: relay.address, key: relay.key || '' }));
    else localStorage.removeItem('harbor:relay-backup');
  } catch {}
}
// One-tap setup link made by the Harbor Server launcher:
//   …/index.svg#harbor-server=<base64url of {"a":"https://pc.tailnet.ts.net","k":"key"}>
// The part after # never leaves the device. It is removed from every address bar Harbor
// can reach as soon as it is read, and the server it replaces becomes the backup.
export let setupLinkResult = null;
(function readSetupLink() {
  const windows = [];
  try { for (let w = window; windows.length < 6; w = w.parent) { windows.push(w); if (w === w.parent) break; } } catch {}
  for (const w of windows) {
    let hash = '';
    try { hash = w.location.hash; } catch { continue; }
    const match = /[#&]harbor-server=([A-Za-z0-9_-]+)/.exec(hash);
    if (!match) continue;
    try { w.history.replaceState(w.history.state, '', w.location.pathname + w.location.search); } catch {}
    if (setupLinkResult) continue;
    try {
      const text = atob(match[1].replace(/-/g, '+').replace(/_/g, '/'));
      const data = JSON.parse(new TextDecoder().decode(Uint8Array.from(text, c => c.charCodeAt(0))));
      const address = normalizeRelay('harbor', data.a);
      const previous = getRelay();
      if (previous.address && previous.address !== address) saveBackupRelay(previous);
      saveRelay('harbor', address, String(data.k || ''));
      setupLinkResult = { address, backup: getBackupRelay()?.address || '' };
    } catch (error) { setupLinkResult = { error: 'That setup link is not valid: ' + (error.message || error) }; }
  }
})();
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
