/* Harbor UI. Third-party feature support is recorded, never inferred from load. */
const $ = selector => document.querySelector(selector);
const frameElement = $('#site-frame');
const state = { controller: null, frame: null, health: null, checks: [], fixture: null, currentUrl: '', timeout: null, connections: [] };
let observations = [];
try { observations = JSON.parse(localStorage.getItem('harbor:observations') || '[]'); if (!Array.isArray(observations)) observations = []; } catch {}
function notice(message) { $('#notice').textContent = message; $('#notice').hidden = !message; }
function setEngine(text, error = false) { $('#engine-status').textContent = text; $('#engine-dot').classList.toggle('error', error); }
function view(name) {
  $('#browser-view').hidden = name !== 'browser'; $('#checks-view').hidden = name !== 'checks';
  document.querySelectorAll('.tab').forEach(tab => tab.classList.toggle('active', tab.dataset.view === name));
}
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => view(button.dataset.view)));
function bounded(promise, ms, label) { return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(label)), ms))]); }

async function boot() {
  try {
    state.health = await (await fetch('/api/health')).json();
    if (!window.isSecureContext || !('serviceWorker' in navigator)) throw new Error('Safari needs trusted HTTPS to run this proxy. HTTP works only on this computer’s loopback address. See README.md.');
    const suffix = harborStreamBridge.mode === 'buffered' ? '?buffered=1' : '';
    await navigator.serviceWorker.register('/sw.js' + suffix, { scope: '/' });
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await bounded(new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true })), 12000, 'The service worker did not take control. Reload once.');
    const alternateTransport = new URLSearchParams(location.search).get('transport') === 'epoxy';
    const BaseTransport = alternateTransport ? EpoxyTransport.default : LibcurlTransport.LibcurlClient;
    class HarborTransport extends BaseTransport {
      connect(url, protocols, headers, onopen, onmessage, onclose, onerror) {
        const record = { host: url.hostname, startedAt: new Date().toISOString(), state: 'connecting', sentFrames: 0, receivedFrames: 0 };
        state.connections.push(record); state.connections = state.connections.slice(-30);
        const [send, close] = super.connect(url, protocols, headers,
          (protocol, extensions) => { record.state = 'open'; onopen(protocol, extensions); },
          data => { record.receivedFrames++; onmessage(data); },
          (code, reason) => { record.state = 'closed'; record.closeCode = code; onclose(code, reason); },
          error => { record.state = 'error'; record.error = String(error).replace(/[a-z]+:\/\/\S+/gi, '[destination]').slice(0, 400); onerror(error); });
        return [data => { record.sentFrames++; send(data); }, close];
      }
      async init() {
        await super.init();
        if (!this.session?.fetch) return;
        const request = this.session.fetch.bind(this.session);
        // Plain HTTP test servers need HTTP/1.1; h2c upgrade collides with their
        // WebSocket upgrade listener. HTTPS keeps normal HTTP/2 negotiation.
        this.session.fetch = (url, options) => request(url, { ...options, ...(url.startsWith('http:') ? { _libcurl_http_version: 1.1 } : {}) });
      }
    }
    const transport = new HarborTransport({ wisp: `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/wisp/` });
    state.transportName = alternateTransport ? 'Epoxy 3.0.2' : 'libcurl 2.0.6';
    state.controller = new $scramjetController.Controller({ serviceworker: navigator.serviceWorker.controller, transport });
    await bounded(state.controller.wait(), 20000, 'The proxy engine did not finish starting.');
    state.frame = state.controller.createFrame(frameElement);
    setEngine(`Engine ready · ${alternateTransport ? 'Epoxy · ' : ''}${harborStreamBridge.mode === 'buffered' ? 'buffered compatibility mode' : 'streaming mode'}`);
    window.harbor.ready = true;
    const target = new URLSearchParams(location.search).get('target');
    if (target) await launch(target);
  } catch (error) { setEngine('Engine needs attention', true); notice(error.message); window.harbor.bootError = error.message; }
}
function normalize(input) {
  const text = input.trim();
  const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(text) ? text : 'https://' + text);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Enter an HTTP or HTTPS website address without embedded credentials.');
  return url.href;
}
async function launch(input) {
  view('browser');
  try {
    if (!state.frame) throw new Error('The engine is still starting or needs attention.');
    const url = normalize(input);
    clearTimeout(state.timeout);
    state.currentUrl = url; $('#address').value = url; $('#result-site').value = new URL(url).hostname;
    $('#session-label').textContent = new URL(url).hostname; $('#empty').hidden = true; frameElement.hidden = false;
    $('#loading').hidden = false; notice('');
    state.frame.go(url);
    state.timeout = setTimeout(() => { $('#loading').hidden = true; notice('This target is taking a while. Inspect the page and record what happens; loading alone does not verify gameplay.'); }, 22000);
  } catch (error) { notice(error.message); }
}
$('#address-form').addEventListener('submit', event => { event.preventDefault(); launch($('#address').value); });
document.querySelectorAll('[data-target]').forEach(button => button.addEventListener('click', () => launch(button.dataset.target)));
$('#open-fixture').addEventListener('click', () => state.health ? launch(state.health.fixtureOrigin) : notice('The local server is not ready.'));
$('#run-proxy-checks').addEventListener('click', () => state.health ? launch(state.health.fixtureOrigin + '/?autorun=1') : notice('The local server is not ready.'));
$('#back').addEventListener('click', () => state.frame?.back());
$('#reload').addEventListener('click', () => state.frame?.reload());
$('#expand').addEventListener('click', () => { const expanded = $('#viewport').classList.toggle('expanded'); $('#expand').textContent = expanded ? 'Collapse ↙' : 'Expand ↗'; });
$('#dismiss-loading').addEventListener('click', () => { $('#loading').hidden = true; });
frameElement.addEventListener('load', () => { clearTimeout(state.timeout); $('#loading').hidden = true; });

function renderChecks() {
  const list = $('#checks-list'); list.replaceChildren();
  for (const check of state.checks) {
    const row = document.createElement('div'); row.className = 'check-row' + (check.ok ? '' : ' warn');
    const name = document.createElement('span'); name.textContent = check.name;
    const result = document.createElement('span'); result.textContent = (check.ok ? '✓ ' : '○ ') + check.detail;
    row.append(name, result); list.append(row);
  }
}
async function runChecks() {
  $('#run-checks').disabled = true; state.checks = [];
  async function check(name, task) { try { const detail = await task(); state.checks.push({ name, ok: true, detail }); } catch (error) { state.checks.push({ name, ok: false, detail: error.message }); } renderChecks(); }
  await check('Secure context', () => { if (!isSecureContext) throw new Error('Trusted HTTPS required on iPad'); return 'Available'; });
  await check('Service worker', () => { if (!navigator.serviceWorker?.controller) throw new Error('Not controlling this page'); return 'Active'; });
  await check('Local save', () => { const key = 'harbor:probe'; const value = crypto.randomUUID(); localStorage.setItem(key, value); if (localStorage.getItem(key) !== value) throw new Error('Read did not match'); localStorage.removeItem(key); return 'Write/read passed'; });
  await check('IndexedDB', () => new Promise((resolve, reject) => { const request = indexedDB.open('harbor-probe', 1); request.onupgradeneeded = () => request.result.createObjectStore('probe'); request.onerror = () => reject(request.error); request.onsuccess = () => { const db = request.result; const transaction = db.transaction('probe', 'readwrite'); transaction.objectStore('probe').put('ok', 'marker'); transaction.oncomplete = () => { db.close(); resolve('Transaction passed'); }; transaction.onerror = () => reject(transaction.error); }; }));
  await check('Storage persistence', async () => { if (!navigator.storage?.persisted) throw new Error('API unavailable'); const persistent = await navigator.storage.persisted(); if (!persistent) throw new Error('Best effort; reopening still needs testing'); return 'Persistent storage granted'; });
  await check('Clock & timezone', async () => { const start = Date.now(); const { now } = await (await fetch('/api/time')).json(); const delta = Math.round(now - (start + Date.now()) / 2); return `${Intl.DateTimeFormat().resolvedOptions().timeZone} · server offset ≈ ${delta} ms`; });
  await check('Browser features', () => `WebSocket ${'WebSocket' in window ? 'yes' : 'no'} · WebRTC ${'RTCPeerConnection' in window ? 'yes' : 'no'}`);
  $('#run-checks').disabled = false;
  return state.checks;
}
$('#run-checks').addEventListener('click', runChecks);
function renderObservations() {
  const list = $('#observations'); list.replaceChildren();
  if (!observations.length) { const empty = document.createElement('p'); empty.className = 'subtle'; empty.textContent = 'No observations yet. Start with a controlled test or a real target.'; list.append(empty); }
  for (const item of observations.slice().reverse().slice(0, 30)) {
    const row = document.createElement('article'); row.className = 'observation';
    const title = document.createElement('strong'); title.textContent = item.site;
    const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = item.outcome;
    const time = document.createElement('time'); time.textContent = new Date(item.at).toLocaleString();
    const note = document.createElement('p'); note.textContent = item.note;
    row.append(title, badge, time, note); list.append(row);
  }
  document.querySelectorAll('[data-site-status]').forEach(label => {
    const item = observations.findLast(item => item.site === label.dataset.siteStatus);
    label.textContent = item ? `↳ ${item.outcome} · observation saved` : '○ Not verified';
  });
}
function saveObservation(item) {
  observations.push(item); observations = observations.slice(-100);
  localStorage.setItem('harbor:observations', JSON.stringify(observations)); renderObservations();
}
$('#result-form').addEventListener('submit', event => {
  event.preventDefault();
  try { saveObservation({ site: $('#result-site').value.trim(), outcome: $('#result-outcome').value, note: $('#result-note').value, at: new Date().toISOString(), source: 'manual' }); $('#record-feedback').textContent = 'Saved on this browser.'; }
  catch { $('#record-feedback').textContent = 'Could not save: browser storage is unavailable.'; }
});
window.addEventListener('message', event => {
  if (event.source !== frameElement.contentWindow || event.data?.type !== 'harbor:fixture') return;
  if (!state.currentUrl || new URL(state.currentUrl).origin !== state.health?.fixtureOrigin) return;
  const report = event.data.report;
  if (!Array.isArray(report?.checks) || report.checks.length > 20 || report.checks.some(c => typeof c.name !== 'string' || typeof c.ok !== 'boolean' || typeof c.detail !== 'string')) return;
  state.fixture = report;
  const note = report.checks.map(c => `${c.ok ? 'PASS' : 'FAIL'}: ${c.name} — ${c.detail}`).join('\n');
  try { saveObservation({ site: 'Controlled test room', outcome: report.checks.every(c => c.ok) ? 'fixture checks passed' : 'fixture needs attention', note, source: 'fixture', at: new Date().toISOString() }); } catch {}
});
async function exportReport() {
  const diagnostic = await (await fetch('/api/diagnostics')).json();
  const report = { generatedAt: new Date().toISOString(), userAgent: navigator.userAgent, engine: { ...state.health, transport: state.transportName }, streamBridge: harborStreamBridge, foundations: state.checks, fixture: state.fixture, observations, relay: diagnostic, connections: state.connections, scope: 'Browser lab observations. Actual iPad, multiplayer gameplay and third-party login require their own tests.' };
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `harbor-report-${new Date().toISOString().slice(0, 10)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('#export').addEventListener('click', () => exportReport().catch(error => notice(error.message)));
window.harbor = { state, ready: false, launch, runChecks, normalize };
renderObservations(); boot();
