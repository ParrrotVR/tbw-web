// Harbor developer tools: a panel under the page with the open site's console messages
// and errors, every request Harbor made for it, its live connections and page details.
// "Copy report" puts all of it on the clipboard as plain text to share.
import { getRelay } from './relay-settings.mjs';

const ROUTE = /(?:https?:\/\/[^\s/"')]+)?\/[^\s"')]*?harbor\/route\/[^/\s"')]+\/[^/\s"')]+\/([^\s?"')]+)(?:\?(?:\$|%24)[^\s"'):]*)?/g;
// Engine addresses look like …/harbor/route/<id>/<id>/https%3A%2F%2Fsite…; show the real one.
export function realURL(text) {
  return String(text).replace(ROUTE, (whole, encoded) => { try { return decodeURIComponent(encoded); } catch { return whole; } });
}
const time = at => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function createDevtools({ state, $, active, notice }) {
  const logs = [], network = [], frames = new Map();
  let pane = 'console', open = false, queued = false, errorsOnly = false;
  const hub = {
    captureConsole: false,
    log(entry) {
      const tab = entry.win ? state.tabs.find(item => item.iframe && item.iframe.contentWindow === entry.win) : state.tabs.find(item => item.iframe && item.iframe === entry.frame);
      logs.push({ level: entry.level, text: realURL(entry.text).slice(0, 4000), page: realURL(entry.page), tabId: tab ? tab.id : null, inner: !entry.top, at: Date.now() });
      if (logs.length > 500) logs.splice(0, logs.length - 500);
      if (entry.level === 'error') badge();
      refresh();
    },
  };
  // Every page and frame the engine opens reports itself here, including frames inside
  // closed shadow roots (Cloudflare Turnstile) that Harbor cannot see from outside.
  hub.frame = ({ page, win, top }) => {
    const tab = state.tabs.find(item => item.iframe && item.iframe.contentWindow === win); if (!tab) return;
    if (top) frames.set(tab.id, []);
    else { const list = frames.get(tab.id) || []; list.push(realURL(page)); frames.set(tab.id, list.slice(-40)); }
    refresh();
  };
  window.harborDevtools = hub;

  function note(level, text, tab = active()) { hub.log({ level, text, page: tab?.url || 'Harbor', frame: tab?.iframe, top: true }); }
  function request(url, method) {
    const entry = { method, url: url.href, status: '…', ms: 0, at: Date.now(), started: performance.now(), tabId: active()?.id ?? null };
    network.push(entry); if (network.length > 400) network.splice(0, network.length - 400);
    refresh();
    return {
      done(status) { entry.status = status; entry.ms = Math.round(performance.now() - entry.started); refresh(); },
      fail(error) { entry.status = 'failed'; entry.error = String(error?.message || error).slice(0, 300); entry.ms = Math.round(performance.now() - entry.started); refresh(); },
      blocked() { entry.status = 'blocked'; refresh(); },
    };
  }
  function badge() {
    const button = $('#devtools-button');
    if (button && !open) button.classList.add('has-errors');
  }
  function refresh() {
    if (!open || queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; render(); });
  }
  const forTab = item => item.tabId === null || item.tabId === active()?.id;

  function row(className, cells) {
    const element = document.createElement('div'); element.className = 'dev-row ' + className;
    for (const [cls, text] of cells) { const cell = document.createElement('span'); cell.className = cls; cell.textContent = text; element.append(cell); }
    return element;
  }
  function empty(text) { const element = document.createElement('p'); element.className = 'dev-empty'; element.textContent = text; return element; }

  function consoleRows() {
    const list = logs.filter(forTab).filter(item => !errorsOnly || item.level === 'error' || item.level === 'warn');
    if (!list.length) return [empty(hub.captureConsole ? 'No messages yet. Reload the page to see messages from the start.' : 'No errors yet.')];
    return list.slice(-300).map(item => row('level-' + item.level, [['dev-time', time(item.at)], ['dev-level', item.level], ['dev-text', item.text + (item.inner ? `\n↳ in frame ${item.page}` : '')]]));
  }
  function networkRows() {
    const list = network.filter(forTab).filter(item => !errorsOnly || item.status === 'failed' || item.status === 'blocked' || item.status >= 400);
    if (!list.length) return [empty('No requests yet.')];
    return list.slice(-300).reverse().map(item => row(item.status === 'failed' || item.status >= 400 ? 'level-error' : item.status === 'blocked' ? 'level-warn' : '', [
      ['dev-status', String(item.status)], ['dev-method', item.method], ['dev-text', (item.url.length > 200 ? item.url.slice(0, 200) + '…' : item.url) + (item.error ? `\n${item.error}` : '')], ['dev-time', item.ms ? item.ms + ' ms' : ''],
    ]));
  }
  function socketRows() {
    const list = state.connections.slice().reverse();
    if (!list.length) return [empty('No live connections yet. Games use these for multiplayer.')];
    return list.map(item => row(item.state === 'error' ? 'level-error' : '', [
      ['dev-status', item.state], ['dev-text', `${item.url || item.host}${item.error ? `\n${item.error}` : ''}${item.closeCode ? `\nclosed with code ${item.closeCode}` : ''}`],
      ['dev-time', `${item.sentFrames} sent · ${item.receivedFrames} received`],
    ]));
  }
  function frameList(win, depth = 0, out = []) {
    if (depth > 4) return out;
    try {
      for (let i = 0; i < win.frames.length && out.length < 40; i++) {
        let url = ''; try { url = realURL(win.frames[i].location.href); } catch { url = '(cross-origin frame)'; }
        out.push('  '.repeat(depth) + url);
        frameList(win.frames[i], depth + 1, out);
      }
    } catch {}
    return out;
  }
  function pageInfo() {
    const tab = active(); const relay = getRelay();
    let title = tab?.title || '';
    const seen = (tab && frames.get(tab.id)) || [];
    const listed = tab?.iframe ? frameList(tab.iframe.contentWindow) : [];
    const all = [...new Set([...seen, ...listed.map(item => item.trim())])];
    return [
      ['Address', tab?.url || 'New tab'], ['Title', title], ['Status', tab?.error ? 'Error: ' + tab.error : tab?.loading ? 'Loading' : 'Loaded'],
      ['Frames inside', all.length ? all.join('\n') : 'none'],
      ['Connection', `${relay.mode === 'harbor' ? 'Harbor server' : 'Wisp'} ${relay.address || '(not set)'}${relay.key ? ' · key saved' : ''}${state.relayInUse?.backup ? ` · BACKUP (main ${state.relayInUse.main} unavailable: ${state.relayInUse.reason})` : ''}`],
      ['Engine', $('#engine-status')?.textContent || ''], ['Browser', navigator.userAgent],
      ['Screen', `${innerWidth}×${innerHeight} @${devicePixelRatio}x`],
      ['Harbor build', String(new URL('./', import.meta.url).pathname.match(/@([0-9a-f]{7})/)?.[1] || 'local')],
    ];
  }
  function pageRows() { return pageInfo().map(([name, value]) => row('', [['dev-key', name], ['dev-text', value]])); }

  function render() {
    const host = $('#dev-pane'); if (!host) return;
    const stick = host.scrollTop + host.clientHeight >= host.scrollHeight - 30;
    host.replaceChildren(...({ console: consoleRows, network: networkRows, sockets: socketRows, page: pageRows }[pane])());
    for (const button of document.querySelectorAll('.devtools-tabs button')) button.setAttribute('aria-selected', String(button.dataset.pane === pane));
    const errors = logs.filter(forTab).filter(item => item.level === 'error').length;
    $('#dev-error-count').textContent = errors ? String(errors) : '';
    $('#dev-network-count').textContent = String(network.filter(forTab).length || '');
    if (pane === 'console' && stick) host.scrollTop = host.scrollHeight;
  }
  function report() {
    const lines = ['Harbor developer report · ' + new Date().toString(), ''];
    for (const [name, value] of pageInfo()) lines.push(`${name}: ${value}`);
    lines.push('', '== Console ==');
    for (const item of logs.filter(forTab).slice(-150)) lines.push(`${time(item.at)} [${item.level}] ${item.text}${item.inner ? ` (frame ${item.page})` : ''}`);
    lines.push('', '== Network (failures, then latest) ==');
    const tabNetwork = network.filter(forTab);
    for (const item of tabNetwork.filter(entry => entry.status === 'failed' || entry.status >= 400).slice(-60)) lines.push(`${item.status} ${item.method} ${item.url}${item.error ? ' · ' + item.error : ''}`);
    lines.push('--');
    for (const item of tabNetwork.slice(-60)) lines.push(`${item.status} ${item.method} ${item.ms}ms ${item.url}`);
    lines.push('', '== Connections ==');
    for (const item of state.connections) lines.push(`${item.state} ${item.url || item.host} sent=${item.sentFrames} received=${item.receivedFrames}${item.closeCode ? ' code=' + item.closeCode : ''}${item.error ? ' ' + item.error : ''}`);
    return lines.join('\n');
  }
  async function copyReport() {
    const text = report();
    try { await navigator.clipboard.writeText(text); notice('Developer report copied.'); return; } catch {}
    const area = document.createElement('textarea'); area.value = text; area.setAttribute('readonly', ''); area.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
    document.body.append(area); area.select(); area.setSelectionRange(0, text.length);
    try { document.execCommand('copy'); notice('Developer report copied.'); } catch { notice('Copy blocked by the browser.'); }
    area.remove();
  }
  function toggle(force) {
    open = force ?? !open;
    $('#devtools').hidden = !open;
    $('#devtools-button').setAttribute('aria-pressed', String(open));
    $('#devtools-button').classList.remove('has-errors');
    if (open && !hub.captureConsole) { hub.captureConsole = true; note('info', 'Console capture is on. Reload the page to see its messages from the start.'); }
    if (open) render();
  }
  $('#devtools-button').addEventListener('click', () => toggle());
  $('#menu-devtools').addEventListener('click', () => { $('#browser-menu').hidden = true; toggle(true); });
  $('#dev-close').addEventListener('click', () => toggle(false));
  $('#dev-clear').addEventListener('click', () => { logs.length = 0; network.length = 0; render(); });
  $('#dev-copy').addEventListener('click', copyReport);
  $('#dev-errors-only').addEventListener('change', event => { errorsOnly = event.target.checked; render(); });
  for (const button of document.querySelectorAll('.devtools-tabs button')) button.addEventListener('click', () => { pane = button.dataset.pane; render(); });
  document.addEventListener('keydown', event => {
    if (event.key === 'F12' || ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'i')) { event.preventDefault(); toggle(); }
  });
  return { note, request, refresh, toggle };
}
