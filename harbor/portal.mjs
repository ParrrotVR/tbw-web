import './browser.mjs';
import { getRelay, saveRelay, portalBase } from './relay-settings.mjs';
import { createGameRelay } from './game-relay.mjs';
const $ = selector => document.querySelector(selector);
let gameFrame = null;
let activeGame = null;
let startingGame = false;
let closingGame = null;
let currentView = 'browser';
const gameURL = new URL('https://cdn.jsdelivr.net/gh/ParrrotVR/tbw-web@eff26e9a2c3d335135c6c62e8745aafc60051df6/index.svg');
if (location.hostname.endsWith('jsdelivr.net')) gameURL.host = location.host;
const games = {
  tbw: { title: 'Tactical Breach Wizards', url: gameURL.href, action: '#game-card-action' },
  gd: { title: 'Geometry Dash', url: new URL('games/geometry-dash.html', portalBase).href, action: '#gd-card-action' },
};
const gameRequest = createGameRelay((text, needsConnection) => {
  if (activeGame !== 'gd') return;
  const message = $('#game-message');
  message.textContent = text;
  message.hidden = !text;
  if (needsConnection) openConnection();
});
window.HarborGameNetwork = Object.freeze({
  request(source, input, options) {
    if (activeGame !== 'gd' || source !== gameFrame?.contentWindow) {
      return Promise.reject(new Error('Open Geometry Dash from the Games page to connect its online services.'));
    }
    return gameRequest(input, options);
  },
});
function updateGameCards() {
  for (const [id, game] of Object.entries(games)) {
    $(game.action).textContent = gameFrame && activeGame === id ? 'Resume game ↗' : 'Play game ↗';
  }
}
function gameWindow() {
  const queue = gameFrame ? [gameFrame.contentWindow] : [];
  for (let count = 0; queue.length && count < 6; count++) {
    const candidate = queue.shift();
    try {
      if (candidate.unityInstance?.Module || candidate.HarborGame) return candidate;
      for (let i = 0; i < Math.min(candidate.frames.length, 3); i++) queue.push(candidate.frames[i]);
    } catch {}
  }
  return null;
}
function pauseGame(pause) {
  const target = gameWindow();
  try {
    if (target?.HarborGame) { target.HarborGame.pause(pause); return; }
    const module = target?.unityInstance?.Module;
    if (pause) { module?.pauseMainLoop?.(); target?.dispatchEvent(new Event('blur')); }
    else module?.resumeMainLoop?.();
  } catch {}
}
function view(name) {
  const previousView = currentView;
  currentView = name;
  document.body.dataset.view = name;
  $('#games-view').hidden = name !== 'games';
  $('#game-view').hidden = name !== 'game';
  $('#view-browser').setAttribute('aria-current', name === 'browser' ? 'page' : 'false');
  $('#view-games').setAttribute('aria-current', name === 'games' || name === 'game' ? 'page' : 'false');
  pauseGame(name !== 'game');
  if (name === 'browser' && previousView !== 'browser') window.harbor.activateTab(window.harbor.state.activeId);
}
function releaseWebsites() {
  const state = window.harbor.state;
  for (const tab of state.tabs) {
    tab.observers.forEach(observer => observer.disconnect());
    tab.observers = [];
    tab.iframe?.remove();
    tab.iframe = null; tab.frame = null; tab.loaded = false; tab.loading = false;
  }
  if (state.controller) state.controller.frames = [];
  state.frame = null;
}
async function startGame(id) {
  if (startingGame || !games[id]) return;
  startingGame = true;
  try {
    if (closingGame) await closingGame;
    if (gameFrame && activeGame !== id) await closeGame();
    if (!gameFrame) {
      releaseWebsites();
      activeGame = id;
      gameFrame = document.createElement('iframe');
      gameFrame.title = games[id].title;
      gameFrame.allow = 'autoplay; fullscreen; gamepad; clipboard-write';
      gameFrame.allowFullscreen = true;
      gameFrame.addEventListener('load', () => pauseGame(currentView !== 'game'));
      gameFrame.src = games[id].url;
      $('#game-title').textContent = games[id].title;
      $('#game-message').hidden = true;
      $('#game-player').append(gameFrame);
      updateGameCards();
    }
    view('game');
    gameFrame.focus();
  } catch (error) {
    view(gameFrame ? 'game' : 'games');
    const message = $('#game-message');
    message.hidden = false; message.textContent = error.message || 'The game could not be opened.';
  } finally { startingGame = false; }
}
function closeGame() {
  if (closingGame) return closingGame;
  if (!gameFrame) return Promise.resolve();
  closingGame = saveAndCloseGame().finally(() => { closingGame = null; });
  return closingGame;
}
async function saveAndCloseGame() {
  const button = $('#game-close');
  button.disabled = true; button.textContent = 'Saving…';
  const message = $('#game-message'); message.hidden = true;
  try {
    const target = gameWindow();
    const module = target?.unityInstance?.Module;
    if (target?.HarborGame) {
      await target.HarborGame.save();
    } else if (module?.calledRun && module.TBWFileSystem) {
      pauseGame(true);
      const saveButton = target.document.getElementById('save-now');
      if (saveButton && !saveButton.disabled) saveButton.click();
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Saving is taking longer than expected. Keep the game open and try again.')), 20000);
        module.TBWFileSystem.syncfs(false, error => { clearTimeout(timer); if (error) reject(error); else resolve(); });
      });
    }
    gameFrame.remove(); gameFrame = null; activeGame = null;
    updateGameCards();
    document.body.classList.remove('game-expanded');
    view('games');
  } catch (error) {
    message.hidden = false; message.textContent = error.message || 'The save could not be completed. The game is still open.';
    pauseGame(currentView !== 'game');
    throw error;
  } finally { button.disabled = false; button.textContent = 'Save & close'; }
}
$('#view-browser').addEventListener('click', () => view('browser'));
$('#view-games').addEventListener('click', () => view('games'));
$('#game-library').addEventListener('click', () => view('games'));
$('#play-tbw').addEventListener('click', () => startGame('tbw'));
$('#play-gd').addEventListener('click', () => startGame('gd'));
$('#game-close').addEventListener('click', () => closeGame().catch(() => {}));
$('#game-fullscreen').addEventListener('click', async () => {
  const element = $('#game-view');
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (document.webkitFullscreenElement) document.webkitExitFullscreen();
    else if (document.body.classList.contains('game-expanded')) document.body.classList.remove('game-expanded');
    else if (element.requestFullscreen) await element.requestFullscreen();
    else if (element.webkitRequestFullscreen) element.webkitRequestFullscreen();
    else document.body.classList.add('game-expanded');
  } catch { document.body.classList.toggle('game-expanded'); }
  $('#game-fullscreen').textContent = document.fullscreenElement || document.webkitFullscreenElement || document.body.classList.contains('game-expanded') ? 'Exit fullscreen' : 'Fullscreen';
});
const dialog = $('#connection-dialog');
function connectionFields() {
  const wisp = $('#relay-mode').value === 'wisp';
  $('#relay-address-label').textContent = wisp ? 'Wisp address' : 'Harbor server address';
  $('#relay-address').placeholder = wisp ? 'wss://your-relay.example/wisp/' : 'https://your-harbor-server.example';
  $('#relay-key-label').hidden = false;
}
function openConnection() {
  const relay = getRelay();
  $('#relay-mode').value = relay.mode;
  $('#relay-address').value = relay.address;
  $('#relay-key').value = relay.key;
  $('#connection-status').textContent = relay.address ? 'Update your connection below.' : 'Add a Wisp address or your Harbor server address. Games are ready now.';
  connectionFields();
  if (!dialog.open) dialog.showModal();
}
for (const id of ['connect-browser', 'connection-button']) $('#' + id).addEventListener('click', openConnection);
window.addEventListener('harbor:connect-needed', openConnection);
$('#relay-mode').addEventListener('change', connectionFields);
$('#connection-dismiss').addEventListener('click', () => dialog.close());
$('#connection-form').addEventListener('submit', async event => {
  event.preventDefault();
  const previous = getRelay();
  const submit = $('#connection-submit'); const status = $('#connection-status');
  submit.disabled = true; status.textContent = 'Connecting…';
  try {
    saveRelay($('#relay-mode').value, $('#relay-address').value, $('#relay-key').value);
    if (window.harbor.ready) {
      await closeGame();
      location.reload();
      return;
    }
    await window.harbor.ensureEngine();
    $('#connection-dot').classList.add('connected');
    dialog.close();
    const active = window.harbor.state.tabs.find(tab => tab.id === window.harbor.state.activeId);
    if (active?.url) window.harbor.launch(active.url);
  } catch (error) {
    if (previous.address) saveRelay(previous.mode, previous.address, previous.key);
    else { localStorage.removeItem('harbor:relay'); sessionStorage.removeItem('harbor:relay-key'); }
    status.textContent = error.message || 'The connection could not be established.';
  } finally { submit.disabled = false; }
});
if (getRelay().address) $('#connection-dot').classList.add('connected');
view('browser');
