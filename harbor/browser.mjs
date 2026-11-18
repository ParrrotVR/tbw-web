import { getRelay, relayFetch, portalBase, relayProtocols } from './relay-settings.mjs';
import { SEARCH_ENGINES, resolveInput, pageLabel } from './navigation.mjs';
import { AssetCache } from './asset-cache.mjs';
import { connectSocket } from './socket-client.mjs';
import { browserPlugin } from './browser-plugin.mjs';
import { NativeHttpTransport } from './http-client.mjs';
import { isFilteredHost, filteredResponse } from './content-filter.mjs';
import { iconSVG, fillSiteIcon } from './brand.mjs';

const $ = selector => document.querySelector(selector);
const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const write = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} };
const settings = { search: 'bing', appearance: 'harbor', restoreTabs: true, reduceAds: true, ...read('harbor:settings', {}) };
if (!settings.themeV2) { if (settings.appearance === 'light') settings.appearance = 'harbor'; settings.themeV2 = true; }
if (!['harbor', 'light', 'dark', 'system'].includes(settings.appearance)) settings.appearance = 'harbor';
if (!settings.searchV2) { if (settings.search === 'google') settings.search = 'duckduckgo'; settings.searchV2 = true; }
// DuckDuckGo stalls requests from the Harbor server's cloud network; move off it once.
if (!settings.searchV3) { if (['duckduckgo', 'ddglite'].includes(settings.search)) settings.search = 'bing'; settings.searchV3 = true; }
if (!SEARCH_ENGINES[settings.search]) settings.search = 'bing';
let bookmarks = read('harbor:bookmarks', [
  { title: 'MCdle', url: 'https://www.mcdle.net/en_gb' },
  { title: 'Krillion', url: 'https://playdaily.org/krillion' },
  { title: 'digdig.io', url: 'https://digdig.io/' },
]);
if (!Array.isArray(bookmarks)) bookmarks = [];
let visited = read('harbor:history', []); if (!Array.isArray(visited)) visited = [];
const assets = new AssetCache();
const state = { tabs: [], activeId: null, controller: null, health: null, connections: [], checks: [], fixture: null, transport: null, currentUrl: '', frame: null, cache: assets, filteredRequests: 0 };
const closedTabs = [];
let enginePromise, toastTimer, saveTimer, dragId;
function reconnectWorker() {
  const controller = state.controller;
  if (!controller || !navigator.serviceWorker.controller) return;
  controller.serviceWorkerController = navigator.serviceWorker.controller;
  controller.setupMessagePort();
}
navigator.serviceWorker?.addEventListener('controllerchange', () => {
  if (state.controller && state.controller.serviceWorkerController !== navigator.serviceWorker.controller) {
    // A replacement worker is a new software version, rather than an idle
    // revival. Recreate the shell and restore saved tabs together so scripts
    // cannot mix two versions' live RPC channels.
    location.reload();
    return;
  }
  reconnectWorker();
});
navigator.serviceWorker?.addEventListener('message', event => {
  if (event.source !== navigator.serviceWorker.controller) return;
  // Harbor reconnects on controller changes and on an awaited route request.
  // The upstream delayed broadcast can otherwise close an already reattached
  // port while a navigation is using it.
  if (event.data?.$controller$swrevive) { event.stopImmediatePropagation(); return; }
  const pathname = event.data?.$harbor$revive?.pathname;
  if (typeof pathname === 'string' && state.controller && pathname.startsWith(state.controller.prefix)) reconnectWorker();
});
const active = () => state.tabs.find(tab => tab.id === state.activeId);
const icon = name => { const element = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); const use = document.createElementNS(element.namespaceURI, 'use'); use.setAttribute('href', new URL('icons.svg#', portalBase).href + '' + name); element.append(use); return element; };
function notice(message) { clearTimeout(toastTimer); $('#notice').textContent = message; $('#notice').hidden = !message; if (message) toastTimer = setTimeout(() => { $('#notice').hidden = true; }, 6000); }
function bounded(promise, ms, message) { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]).finally(() => clearTimeout(timer)); }
function loadScript(url) { return new Promise((resolve, reject) => { const script = document.createElement('script'); script.src = url; script.onload = resolve; script.onerror = () => reject(new Error('A browser component could not load. Restart Harbor and reload.')); document.head.append(script); }); }
function saveSession() { clearTimeout(saveTimer); saveTimer = setTimeout(() => write('harbor:tabs', { active: state.tabs.findIndex(tab => tab.id === state.activeId), tabs: state.tabs.map(tab => ({ url: tab.url, title: tab.title })) }), 150); }
function setAppearance() { const value = settings.appearance === 'system' ? (matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light') : settings.appearance; document.documentElement.dataset.theme = value; document.querySelector('meta[name=theme-color]')?.setAttribute('content', { harbor: '#0e2738', light: '#f5f3ee', dark: '#121416' }[value]); }
function setPreferences() {
  $('#address').placeholder = `Search ${SEARCH_ENGINES[settings.search].name} or enter an address`;
  $('#home-query').placeholder = `Search ${SEARCH_ENGINES[settings.search].name} or enter an address`;
  $('#search-engine-name').textContent = SEARCH_ENGINES[settings.search].name;
  $('#search-engine').value = settings.search; $('#appearance').value = settings.appearance; $('#restore-tabs').checked = settings.restoreTabs;
  $('#reduce-ads').checked = settings.reduceAds;
  setAppearance(); write('harbor:settings', settings);
}
function remember(tab) {
  if (!tab.url) return;
  const last = visited.at(-1);
  if (last?.url === tab.url) { last.title = tab.title; last.at = Date.now(); }
  else visited.push({ title: tab.title, url: tab.url, at: Date.now() });
  visited = visited.slice(-250); write('harbor:history', visited);
}
function renderTabs() {
  for (const tab of state.tabs) {
    if (!tab.tabElement) {
      const element = document.createElement('div'); element.className = 'browser-tab'; element.role = 'tab'; element.tabIndex = 0; element.draggable = true; element.dataset.tabId = tab.id;
      const favicon = document.createElement('span'); favicon.className = 'tab-favicon';
      const title = document.createElement('span'); title.className = 'tab-title';
      const close = document.createElement('button'); close.className = 'close-tab'; close.type = 'button'; close.setAttribute('aria-label', 'Close tab'); close.append(icon('close')); close.addEventListener('click', event => { event.stopPropagation(); closeTab(tab.id); });
      element.append(favicon, title, close); element.addEventListener('click', () => activateTab(tab.id));
      element.addEventListener('keydown', event => { if (event.target !== element) return; if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activateTab(tab.id); } });
      element.addEventListener('auxclick', event => { if (event.button === 1) { event.preventDefault(); closeTab(tab.id); } });
      element.addEventListener('dragstart', event => { dragId = tab.id; event.dataTransfer.setData('text/plain', tab.id); });
      element.addEventListener('dragover', event => event.preventDefault());
      element.addEventListener('drop', event => { event.preventDefault(); const index = state.tabs.findIndex(item => item.id === dragId); const destination = state.tabs.indexOf(tab); if (index < 0 || destination < 0) return; const [moved] = state.tabs.splice(index, 1); state.tabs.splice(destination, 0, moved); renderTabs(); saveSession(); });
      tab.tabElement = element;
    }
    tab.tabElement.setAttribute('aria-selected', String(tab.id === state.activeId));
    tab.tabElement.classList.toggle('loading', tab.loading);
    tab.tabElement.title = tab.title;
    const favicon = tab.tabElement.querySelector('.tab-favicon'); favicon.classList.toggle('harbor', !tab.url); if (tab.url) fillSiteIcon(favicon, tab.url, pageLabel(tab.url).slice(0, 1).toUpperCase()); else if (!favicon.querySelector('svg')) { favicon.dataset.iconSrc = ''; favicon.classList.remove('has-img'); favicon.innerHTML = iconSVG(); }
    tab.tabElement.querySelector('.tab-title').textContent = tab.title;
    if ($('#tabs').children[state.tabs.indexOf(tab)] !== tab.tabElement) $('#tabs').insertBefore(tab.tabElement, $('#tabs').children[state.tabs.indexOf(tab)] || null);
  }
}
function renderActive() {
  const tab = active(); if (!tab) return;
  state.frame = tab.frame; state.currentUrl = tab.url || '';
  const home = !tab.url;
  $('#newtab').hidden = !home; $('#frames').hidden = home; $('#loading-error').hidden = !tab.error;
  if (tab.error) $('#error-detail').textContent = tab.error;
  for (const item of state.tabs) if (item.iframe) { item.iframe.hidden = item !== tab || home; item.iframe.id = item === tab ? 'site-frame' : `site-frame-${item.id}`; }
  if (document.activeElement !== $('#address')) $('#address').value = tab.url || '';
  $('#back').disabled = tab.historyIndex <= 0; $('#forward').disabled = tab.historyIndex >= tab.history.length - 1;
  $('#reload').replaceChildren(icon(tab.loading ? 'close' : 'reload')); $('#reload').setAttribute('aria-label', tab.loading ? 'Stop loading' : 'Reload');
  $('#progress').hidden = !tab.loading;
  $('#bookmark').classList.toggle('saved', bookmarks.some(bookmark => bookmark.url === tab.url));
  $('#address-icon').setAttribute('href', new URL('icons.svg#', portalBase).href + '' + (home ? 'search' : 'globe'));
  document.title = `${tab.title} — Harbor`;
  renderTabs();
}
function pushHistory(tab, url) {
  if (tab.history[tab.historyIndex] === url) return;
  tab.history.splice(tab.historyIndex + 1); tab.history.push(url); tab.historyIndex = tab.history.length - 1;
}
function onNavigation(tab, url, kind) {
  if (tab.closed || !/^https?:/.test(url)) return;
  if (tab.pendingNavigation) {
    tab.history[tab.historyIndex] = url;
    if (kind === 'commit') tab.pendingNavigation = false;
  } else if (url !== tab.url) pushHistory(tab, url);
  tab.url = url; tab.error = null;
  if (kind === 'commit') { tab.loading = false; tab.loaded = true; }
  if (tab.title === 'New tab' || tab.title === pageLabel(tab.previousUrl || '')) tab.title = pageLabel(url);
  if (tab.id === state.activeId) renderActive(); else renderTabs();
  remember(tab); saveSession();
}
function ensureFrame(tab) {
  if (tab.frame || !state.controller) return tab.frame;
  const iframe = document.createElement('iframe'); iframe.className = 'site-frame'; iframe.title = 'Website'; iframe.allow = 'fullscreen; autoplay; gamepad; clipboard-write'; iframe.hidden = tab.id !== state.activeId;
  tab.iframe = iframe;
  tab.frame = state.controller.createFrame(iframe, { plugins: [browserPlugin(tab, {
    navigation: onNavigation,
    title(item, title) { const next = title?.trim().slice(0, 160); if (next && next !== item.title) { item.title = next; if (item === active()) document.title = `${item.title} — Harbor`; renderTabs(); remember(item); saveSession(); } },
    newTab, ensureFrame, keydown,
  })] });
  iframe.addEventListener('load', () => {
    if (tab.closed || !tab.url) return;
    try { if (iframe.contentDocument?.URL === 'about:blank') return; } catch {}
    tab.loading = false; tab.loaded = true;
    if (tab === active()) renderActive(); else renderTabs();
  });
  $('#frames').append(iframe); renderActive(); return tab.frame;
}
function newTab(url = null, activate = true) {
  if (state.tabs.length >= 5) { notice('Close a tab before opening another.'); return active(); }
  const tab = { id: crypto.randomUUID(), title: url ? pageLabel(url) : 'New tab', url: null, previousUrl: null, frame: null, iframe: null, loading: false, loaded: false, closed: false, error: null, observers: [], history: [null], historyIndex: 0 };
  state.tabs.push(tab);
  if (activate || !state.activeId) activateTab(tab.id);
  if (url) navigate(url, tab).catch(error => fail(tab, error));
  renderTabs(); saveSession(); return tab;
}
function activateTab(id) {
  const tab = state.tabs.find(item => item.id === id); if (!tab) return;
  if (!tab.url) $('#home-query').value = '';
  state.activeId = id; hideSuggestions(); renderActive();
  tab.tabElement?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  if (tab.url && !tab.loaded && !tab.loading) navigate(tab.url, tab, { history: false }).catch(error => fail(tab, error));
  saveSession();
}
function closeTab(id) {
  const index = state.tabs.findIndex(tab => tab.id === id); if (index < 0) return;
  const tab = state.tabs[index]; closedTabs.push({ url: tab.url, title: tab.title }); if (closedTabs.length > 20) closedTabs.shift();
  tab.closed = true; tab.observers.forEach(observer => observer.disconnect());
  if (tab.iframe) { tab.iframe.src = 'about:blank'; tab.iframe.remove(); }
  if (state.controller && tab.frame) state.controller.frames = state.controller.frames.filter(frame => frame !== tab.frame);
  tab.tabElement?.remove(); state.tabs.splice(index, 1);
  if (!state.tabs.length) newTab(); else if (state.activeId === id) activateTab(state.tabs[Math.min(index, state.tabs.length - 1)].id);
  renderTabs(); saveSession();
}
function reopenTab() { const item = closedTabs.pop(); if (item) newTab(item.url); else notice('No closed tabs to reopen.'); }
function fail(tab, error) { tab.error = error.message || String(error); tab.loading = false; if (tab === active()) renderActive(); else renderTabs(); }
async function navigate(input, tab = active(), options = {}) {
  const url = resolveInput(input, settings.search); if (!url || !tab || tab.closed) return;
  tab.previousUrl = tab.url;
  if (options.history !== false) pushHistory(tab, url);
  tab.url = url; tab.title = pageLabel(url); tab.loading = true; tab.error = null; tab.pendingNavigation = true;
  renderActive(); saveSession(); hideSuggestions();
  await ensureEngine(); if (tab.closed) return;
  ensureFrame(tab).go(url);
  if (tab === active()) $('#address').blur();
}
function goHome() {
  const tab = active(); if (!tab) return;
  $('#home-query').value = '';
  pushHistory(tab, null); tab.url = null; tab.title = 'New tab'; tab.loading = false; tab.error = null; tab.loaded = false; tab.pendingNavigation = false;
  if (tab.iframe) tab.iframe.src = 'about:blank'; renderActive(); saveSession(); $('#home-query').focus();
}
function goHistory(direction) {
  const tab = active(); const index = tab.historyIndex + direction;
  if (index < 0 || index >= tab.history.length) return;
  tab.historyIndex = index; const url = tab.history[index];
  if (!url) { tab.url = null; tab.title = 'New tab'; tab.loading = false; if (tab.iframe) tab.iframe.src = 'about:blank'; renderActive(); saveSession(); }
  else navigate(url, tab, { history: false }).catch(error => fail(tab, error));
}
function keydown(event) {
  const command = event.ctrlKey || event.metaKey;
  if (command && event.key.toLowerCase() === 'l') { event.preventDefault(); $('#address').focus(); $('#address').select(); }
  else if (command && event.key.toLowerCase() === 't') { event.preventDefault(); if (event.shiftKey) reopenTab(); else { newTab(); $('#address').focus(); } }
  else if (command && event.key.toLowerCase() === 'w') { event.preventDefault(); closeTab(state.activeId); }
  else if (command && event.key.toLowerCase() === 'r') { event.preventDefault(); if (active()?.url) navigate(active().url, active(), { history: false }); }
  else if (event.altKey && event.key === 'ArrowLeft') { event.preventDefault(); goHistory(-1); }
  else if (event.altKey && event.key === 'ArrowRight') { event.preventDefault(); goHistory(1); }
  else if (event.key === 'Escape') { hideSuggestions(); closeMenu(); }
}
document.addEventListener('keydown', keydown);

async function ensureEngine() {
  if (enginePromise) return enginePromise;
  enginePromise = (async () => {
    const relay = getRelay();
    if (!relay.address) {
      window.dispatchEvent(new Event('harbor:connect-needed'));
      throw new Error('Add a Wisp address or connect a Harbor server to browse. Your games are ready.');
    }
    if (!isSecureContext || !navigator.serviceWorker) throw new Error('Open the SVG link directly in Safari over HTTPS.');
    if (relay.mode === 'harbor') {
      const response = await bounded(relayFetch('/api/health'), 90000, 'The Harbor server did not answer. It may need more time to wake up.');
      if (!response.ok) throw new Error('The Harbor connection was rejected. Check its address and access key.');
      state.health = await response.json();
      if (state.health.name !== 'Harbor' || !state.health.nativeHttp) throw new Error('This server does not provide the Harbor HTTP relay.');
    } else state.health = { name: 'Wisp', nativeHttp: false, version: 'Wisp' };
    if (!window.$scramjet) await loadScript(new URL('vendor/scramjet.js', portalBase).href);
    if (!window.$scramjetController) await loadScript(new URL('vendor/controller.api.js', portalBase).href);
    if (relay.mode === 'wisp' && !window.EpoxyTransport) await loadScript(new URL('vendor/epoxy.js', portalBase).href);
    const workerURL = new URL('../sw.js', portalBase);
    const registration = await bounded(navigator.serviceWorker.register(workerURL.href, { scope: new URL('../', portalBase).pathname, updateViaCache: 'none' }), 30000, 'The browser worker did not register.');
    await bounded(navigator.serviceWorker.ready, 15000, 'The browser worker is not ready.');
    if (!navigator.serviceWorker.controller) await bounded(new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true })), 12000, 'Reload the SVG to attach the browser worker.');
    const Base = relay.mode === 'wisp' ? EpoxyTransport.default : NativeHttpTransport;
    class HarborTransport extends Base {
      connect(url, protocols, headers, onopen, onmessage, onclose, onerror) {
        if (relay.mode === 'wisp') return super.connect(url, protocols, headers, onopen, onmessage, onclose, onerror);
        const record = { host: url.hostname, startedAt: new Date().toISOString(), state: 'connecting', sentFrames: 0, receivedFrames: 0, path: 'Harbor relay' };
        state.connections.push(record); state.connections = state.connections.slice(-30);
        return connectSocket(url, protocols, headers, onopen, onmessage, onclose, onerror, record);
      }
      async request(...args) {
        if (settings.reduceAds && isFilteredHost(args[0].hostname)) { state.filteredRequests++; return filteredResponse(); }
        // CrazyGames blocks its game pages unless they're opened from its own player, and
        // the engine can drop the player's Referer on the way. Restore it when it's missing.
        if (args[0].hostname.endsWith('.game-files.crazygames.com') && Array.isArray(args[3])) {
          const referer = args[3].find(([name]) => String(name).toLowerCase() === 'referer');
          let fromCrazyGames = false;
          try { fromCrazyGames = !!referer && /(^|\.)crazygames\.com$/.test(new URL(referer[1]).hostname); } catch {}
          if (!fromCrazyGames) args[3] = [...args[3].filter(([name]) => String(name).toLowerCase() !== 'referer'), ['Referer', 'https://games.crazygames.com/']];
        }
        return assets.request(super.request.bind(this), ...args);
      }
    }
    state.transportName = relay.mode === 'wisp' ? 'Wisp' : 'Harbor';
    state.transport = new HarborTransport({ wisp: relay.address, wisp_ws_protocols: relayProtocols(relay.key) });
    state.controller = new $scramjetController.Controller({
      serviceworker: navigator.serviceWorker.controller || registration.active,
      transport: state.transport,
      config: { prefix: new URL('route/', portalBase).pathname, scramjetPath: new URL('vendor/scramjet.js', portalBase).href, injectPath: new URL('vendor/controller.inject.js', portalBase).href, wasmPath: new URL('vendor/scramjet.wasm', portalBase).href },
      scramjetConfig: { flags: { syncxhr: false, sourcemaps: false, captureErrors: false, rewriterLogs: false, debugTrampolines: false } },
    });
    await bounded(state.controller.wait(), 25000, 'The browser engine did not finish starting.');
    $('#engine-status').textContent = 'Browser connected'; window.harbor.ready = true;
    return state.controller;
  })().catch(error => { enginePromise = null; $('#engine-status').textContent = 'Browser connection needed'; window.harbor.bootError = error.message; throw error; });
  return enginePromise;
}

function renderBookmarks() {
  $('#bookmarks').replaceChildren();
  for (const item of bookmarks.slice(0, 18)) {
    const button = document.createElement('button'); button.className = 'bookmark-item'; button.title = item.url;
    const mark = document.createElement('span'); mark.className = 'mini-icon'; fillSiteIcon(mark, item.url, item.title.slice(0, 1).toUpperCase());
    const label = document.createElement('span'); label.textContent = item.title; button.append(mark, label);
    button.addEventListener('click', event => { if (event.ctrlKey || event.metaKey) newTab(item.url, false); else launch(item.url); });
    button.addEventListener('contextmenu', event => { event.preventDefault(); bookmarks = bookmarks.filter(bookmark => bookmark !== item); write('harbor:bookmarks', bookmarks); renderBookmarks(); renderActive(); notice('Shortcut removed.'); });
    $('#bookmarks').append(button);
  }
}
function toggleBookmark() {
  const tab = active(); if (!tab.url) return openBookmarkDialog();
  const index = bookmarks.findIndex(item => item.url === tab.url);
  if (index >= 0) { bookmarks.splice(index, 1); notice('Bookmark removed.'); }
  else { bookmarks.push({ title: tab.title, url: tab.url }); notice('Bookmark saved.'); }
  write('harbor:bookmarks', bookmarks); renderBookmarks(); renderActive();
}
function openBookmarkDialog() { $('#bookmark-name').value = ''; $('#bookmark-url').value = ''; $('#bookmark-dialog').showModal(); }
function openSettings() { closeMenu(); setPreferences(); $('#cache-info').textContent = `${assets.stats.hits} cached requests reused this session`; $('#settings-dialog').showModal(); }
function openHistory() {
  closeMenu(); $('#history-list').replaceChildren();
  if (!visited.length) { const text = document.createElement('p'); text.className = 'setting-note'; text.textContent = 'Your recently visited pages will appear here.'; $('#history-list').append(text); }
  for (const item of visited.slice(-80).reverse()) {
    const button = document.createElement('button'); button.className = 'history-entry'; const details = document.createElement('div');
    const title = document.createElement('strong'); title.textContent = item.title; const url = document.createElement('small'); url.textContent = item.url; details.append(title, url);
    const time = document.createElement('time'); time.textContent = new Date(item.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    button.append(icon('globe'), details, time); button.addEventListener('click', () => { $('#history-dialog').close(); launch(item.url); }); $('#history-list').append(button);
  }
  $('#history-dialog').showModal();
}
function closeMenu() { $('#browser-menu').hidden = true; $('#menu-button').setAttribute('aria-expanded', 'false'); }
let suggestionIndex = -1; let suggestions = [];
function hideSuggestions() { $('#suggestions').hidden = true; suggestionIndex = -1; }
function showSuggestions() {
  const query = $('#address').value.trim(); const list = $('#suggestions'); list.replaceChildren(); suggestionIndex = -1;
  if (!query) { hideSuggestions(); return; }
  let url; try { url = resolveInput(query, settings.search); } catch { hideSuggestions(); return; }
  suggestions = [{ title: url.includes('q=' + encodeURIComponent(query)) ? `${query} — Search ${SEARCH_ENGINES[settings.search].name}` : query, url, search: true }];
  const seen = new Set([url]);
  for (const item of [...bookmarks, ...visited.slice().reverse()]) { if (seen.has(item.url) || !`${item.title} ${item.url}`.toLowerCase().includes(query.toLowerCase())) continue; seen.add(item.url); suggestions.push(item); if (suggestions.length >= 6) break; }
  for (const item of suggestions) {
    const button = document.createElement('button'); button.className = 'suggestion'; button.role = 'option';
    const title = document.createElement('span'); title.className = 'suggestion-title'; title.textContent = item.title;
    const url = document.createElement('small'); url.textContent = item.search ? '' : item.url;
    button.append(icon(item.search ? 'search' : 'history'), title, url);
    button.addEventListener('mousedown', event => event.preventDefault()); button.addEventListener('click', () => launch(item.url)); list.append(button);
  }
  list.hidden = false;
}
$('#address').addEventListener('input', showSuggestions);
$('#address').addEventListener('focus', () => $('#address').select());
$('#address').addEventListener('blur', () => setTimeout(hideSuggestions, 120));
$('#address').addEventListener('keydown', event => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { if ($('#suggestions').hidden) showSuggestions(); event.preventDefault(); suggestionIndex = (suggestionIndex + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length; [...$('#suggestions').children].forEach((row, index) => row.classList.toggle('selected', index === suggestionIndex)); }
});
function launch(input) { return navigate(input).catch(error => { fail(active(), error); notice(error.message); }); }
$('#address-form').addEventListener('submit', event => { event.preventDefault(); launch(suggestionIndex >= 0 && !$('#suggestions').hidden ? suggestions[suggestionIndex].url : $('#address').value); });
$('#home-search').addEventListener('submit', event => { event.preventDefault(); launch($('#home-query').value); });
document.querySelectorAll('[data-target]').forEach(button => button.addEventListener('click', event => { if (event.ctrlKey || event.metaKey) newTab(button.dataset.target, false); else launch(button.dataset.target); }));
$('#new-tab').addEventListener('click', () => { newTab(); $('#address').focus(); });
$('#back').addEventListener('click', () => goHistory(-1)); $('#forward').addEventListener('click', () => goHistory(1));
$('#reload').addEventListener('click', () => { const tab = active(); if (tab.loading) { tab.iframe?.contentWindow?.stop(); tab.loading = false; renderActive(); } else if (tab.url) navigate(tab.url, tab, { history: false }); });
for (const id of ['home', 'brand-home']) $('#' + id).addEventListener('click', goHome);
$('#bookmark').addEventListener('click', toggleBookmark); $('#add-shortcut').addEventListener('click', openBookmarkDialog);
$('#bookmark-form').addEventListener('submit', event => { event.preventDefault(); try { const url = new URL($('#bookmark-url').value); if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Use a website address.'); bookmarks.push({ title: $('#bookmark-name').value.trim(), url: url.href }); write('harbor:bookmarks', bookmarks); renderBookmarks(); $('#bookmark-dialog').close(); } catch (error) { notice(error.message); } });
for (const id of ['customize', 'search-engine-name', 'menu-settings', 'rail-settings']) $('#' + id).addEventListener('click', openSettings);
for (const id of ['show-history', 'menu-history']) $('#' + id).addEventListener('click', openHistory);
$('#clear-history').addEventListener('click', () => { visited = []; write('harbor:history', visited); $('#history-dialog').close(); openHistory(); });
$('#search-engine').addEventListener('change', event => { settings.search = event.target.value; setPreferences(); });
$('#appearance').addEventListener('change', event => { settings.appearance = event.target.value; setPreferences(); });
$('#restore-tabs').addEventListener('change', event => { settings.restoreTabs = event.target.checked; setPreferences(); });
$('#reduce-ads').addEventListener('change', event => { settings.reduceAds = event.target.checked; setPreferences(); });
$('#clear-cache').addEventListener('click', async () => { await assets.clear(); $('#cache-info').textContent = 'Saved website files cleared'; notice('File cache cleared. Your saves and cookies are unchanged.'); });
$('#menu-button').addEventListener('click', () => { const menu = $('#browser-menu'); menu.hidden = !menu.hidden; $('#menu-button').setAttribute('aria-expanded', String(!menu.hidden)); });
document.addEventListener('pointerdown', event => { if (!event.target.closest('#browser-menu,#menu-button')) closeMenu(); });
$('#menu-new-tab').addEventListener('click', () => { closeMenu(); newTab(); $('#address').focus(); });
$('#reopen-tab').addEventListener('click', () => { closeMenu(); reopenTab(); });
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => $('#' + button.dataset.close).close()));
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } }));
$('#retry-page').addEventListener('click', () => active()?.url ? launch(active().url) : goHome());

function renderChecks() {
  $('#checks-list').replaceChildren();
  for (const check of state.checks) { const row = document.createElement('div'); row.className = 'check-row' + (check.ok ? '' : ' warn'); const name = document.createElement('span'); name.textContent = check.name; const detail = document.createElement('span'); detail.textContent = `${check.ok ? '✓' : '○'} ${check.detail}`; row.append(name, detail); $('#checks-list').append(row); }
}
async function runChecks() {
  await ensureEngine(); state.checks = []; $('#run-checks').disabled = true;
  const check = async (name, task) => { try { state.checks.push({ name, ok: true, detail: await task() }); } catch (error) { state.checks.push({ name, ok: false, detail: error.message }); } renderChecks(); };
  await check('Secure connection', () => { if (!isSecureContext) throw new Error('Trusted HTTPS required'); return 'Available'; });
  await check('Browser service', () => { if (!navigator.serviceWorker.controller) throw new Error('Not ready'); return 'Active'; });
  await check('Local save', () => { localStorage.setItem('harbor:probe', 'ok'); if (localStorage.getItem('harbor:probe') !== 'ok') throw new Error('Read mismatch'); localStorage.removeItem('harbor:probe'); return 'Write/read passed'; });
  await check('IndexedDB', () => new Promise((resolve, reject) => { const request = indexedDB.open('harbor-probe', 1); request.onupgradeneeded = () => request.result.createObjectStore('probe'); request.onerror = () => reject(request.error); request.onsuccess = () => { const db = request.result; const tx = db.transaction('probe', 'readwrite'); tx.objectStore('probe').put('ok', 'marker'); tx.oncomplete = () => { db.close(); resolve('Transaction passed'); }; tx.onerror = () => reject(tx.error); }; }));
  await check('Clock', async () => { const start = Date.now(); const result = await (await relayFetch('/api/time')).json(); return `${Intl.DateTimeFormat().resolvedOptions().timeZone} · offset ≈ ${Math.round(result.now - (start + Date.now()) / 2)} ms`; });
  await check('Website file cache', () => `${assets.stats.hits} hits · ${assets.stats.writes} files saved`);
  $('#run-checks').disabled = false; return state.checks;
}
async function openDiagnostics() {
  closeMenu(); $('#connection-summary').textContent = `${state.transportName || 'Starting'} for web requests; native relay for WebSockets. ${harborStreamBridge.mode} responses.`;
  $('#socket-list').replaceChildren();
  for (const item of state.connections.slice(-10).reverse()) { const row = document.createElement('div'); row.className = 'socket-row'; row.textContent = `${item.host} · ${item.state} · ${item.sentFrames} sent / ${item.receivedFrames} received${item.error ? ' · ' + item.error : ''}`; $('#socket-list').append(row); }
  $('#diagnostics-dialog').showModal();
}
$('#menu-diagnostics').addEventListener('click', openDiagnostics);
$('#run-checks').addEventListener('click', () => runChecks().catch(error => notice(error.message)));
$('#run-proxy-checks').addEventListener('click', async () => { await ensureEngine(); $('#diagnostics-dialog').close(); newTab(state.health.fixtureOrigin + '/?autorun=1'); });
window.addEventListener('message', event => {
  const tab = state.tabs.find(item => item.iframe?.contentWindow === event.source);
  if (!tab || event.data?.type !== 'harbor:fixture' || !tab.url || new URL(tab.url).origin !== state.health?.fixtureOrigin) return;
  const report = event.data.report;
  if (!Array.isArray(report?.checks) || report.checks.length > 20 || report.checks.some(check => typeof check.name !== 'string' || typeof check.ok !== 'boolean' || typeof check.detail !== 'string')) return;
  state.fixture = report;
});
$('#export').addEventListener('click', async () => {
  try {
    const relay = await (await relayFetch('/api/diagnostics')).json();
    const report = { generatedAt: new Date().toISOString(), version: '0.3.0', engine: { ...state.health, transport: state.transportName }, connections: state.connections, cache: assets.stats, filteredRequests: state.filteredRequests, foundations: state.checks, fixture: state.fixture, relay, userAgent: navigator.userAgent };
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = 'harbor-report.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { notice(error.message); }
});

window.harbor = { ready: false, state, settings, launch, newTab, closeTab, activateTab, reopenTab, runChecks, normalize: resolveInput, ensureEngine };
setPreferences(); renderBookmarks();
$('#date-label').textContent = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date());
const saved = settings.restoreTabs ? read('harbor:tabs', null) : null;
if (saved?.tabs?.length && Array.isArray(saved.tabs)) {
  for (const item of saved.tabs.slice(0, 5)) {
    const tab = newTab(null, false);
    if (typeof item.url === 'string' && /^https?:\/\//.test(item.url)) { tab.url = item.url; tab.title = item.title || pageLabel(item.url); tab.history.push(item.url); tab.historyIndex = 1; }
  }
  state.activeId = state.tabs[Math.max(0, Math.min(saved.active || 0, state.tabs.length - 1))].id;
} else newTab();
renderActive();
if (getRelay().address) {
ensureEngine().then(() => {
  const target = new URLSearchParams(location.search).get('target');
  if (target) launch(target); else if (active()?.url) navigate(active().url, active(), { history: false });
}).catch(error => notice(error.message));
} else $('#engine-status').textContent = 'Connect a browser relay · Games are ready';
window.addEventListener('pagehide', () => { clearTimeout(saveTimer); write('harbor:tabs', { active: state.tabs.findIndex(tab => tab.id === state.activeId), tabs: state.tabs.map(tab => ({ url: tab.url, title: tab.title })) }); });
