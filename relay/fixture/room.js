const $ = selector => document.querySelector(selector);
const today = () => new Date().toISOString().slice(0, 10);
let puzzle;
try { puzzle = JSON.parse(localStorage.getItem('harbor-fixture:puzzle') || 'null'); } catch {}
if (!puzzle || puzzle.day !== today() || !Array.isArray(puzzle.guesses)) puzzle = { day: today(), guesses: [] };
function target(day) { return [...day].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 7) % 20 + 1; }
function renderPuzzle() {
  $('#day').textContent = 'UTC puzzle · ' + puzzle.day;
  $('#guesses').replaceChildren(...puzzle.guesses.map(guess => { const chip = document.createElement('span'); chip.className = 'guess' + (guess === target(puzzle.day) ? ' win' : ''); chip.textContent = guess; return chip; }));
  $('#saved-marker').textContent = `${puzzle.guesses.length} guess(es) restored for this UTC day. Reload to check retention.`;
}
$('#guess-form').addEventListener('submit', event => {
  event.preventDefault(); const guess = Number($('#guess').value);
  if (!Number.isInteger(guess) || guess < 1 || guess > 20) return;
  if (puzzle.day !== today()) puzzle = { day: today(), guesses: [] };
  puzzle.guesses.push(guess);
  try { localStorage.setItem('harbor-fixture:puzzle', JSON.stringify(puzzle)); renderPuzzle(); $('#guess-feedback').textContent = guess === target(puzzle.day) ? 'You found it. Saved for today.' : guess < target(puzzle.day) ? 'Go higher. Your guess is saved.' : 'Go lower. Your guess is saved.'; }
  catch { $('#guess-feedback').textContent = 'Storage unavailable: this guess could not be saved.'; }
});
function tick() { $('#clock').textContent = new Date().toISOString().slice(11, 19) + ' UTC'; }
tick(); setInterval(tick, 1000); renderPuzzle();

async function session() { const result = await (await fetch('/api/session')).json(); $('#user').textContent = result.user ? `Signed in as ${result.user.name}` : 'No test session yet.'; return result.user; }
async function login(name) {
  const response = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
  if (!response.ok) throw new Error('Test login failed');
  return await session();
}
$('#login-form').addEventListener('submit', async event => { event.preventDefault(); try { await login($('#nickname').value); } catch (error) { $('#user').textContent = error.message; } });
session().catch(error => { $('#user').textContent = error.message; });

let socket = null;
let pingTimer;
let roomState = { id: null, players: [], binaryEcho: false, latency: null, user: null };
const canvas = $('#field'); const context = canvas.getContext('2d');
function draw() {
  context.clearRect(0, 0, 640, 400); context.strokeStyle = '#28423a'; context.lineWidth = 1;
  for (let x = 0; x <= 640; x += 40) { context.beginPath(); context.moveTo(x, 0); context.lineTo(x, 400); context.stroke(); }
  for (let y = 0; y <= 400; y += 40) { context.beginPath(); context.moveTo(0, y); context.lineTo(640, y); context.stroke(); }
  if (!roomState.players.length) { context.fillStyle = '#8ba99c'; context.font = '19px system-ui'; context.textAlign = 'center'; context.fillText('Join a room, then tap to move.', 320, 205); }
  for (const player of roomState.players) {
    context.beginPath(); context.fillStyle = player.color; context.arc(player.x * 2, player.y * 2, 14, 0, Math.PI * 2); context.fill();
    if (player.id === roomState.id) { context.strokeStyle = '#ecfff6'; context.lineWidth = 2; context.stroke(); }
    context.fillStyle = '#d1eee1'; context.font = '14px system-ui'; context.textAlign = 'center'; context.fillText(player.id === roomState.id ? 'you' : 'peer', player.x * 2, player.y * 2 + 32);
  }
}
draw();
function move(x, y) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'move', x, y })); }
canvas.addEventListener('pointerdown', event => { const rect = canvas.getBoundingClientRect(); move((event.clientX - rect.left) / rect.width * 320, (event.clientY - rect.top) / rect.height * 200); });
function join(room = $('#room').value) {
  clearInterval(pingTimer); socket?.close();
  roomState = { id: null, players: [], binaryEcho: false, latency: null, user: null };
  $('#connection').textContent = 'Connecting…';
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/room?room=${encodeURIComponent(room)}`);
  socket.binaryType = 'arraybuffer';
  const current = socket;
  socket.onopen = () => {
    if (socket !== current) return;
    $('#connection').textContent = 'Live connection';
    const ping = () => { if (current.readyState === WebSocket.OPEN) current.send(JSON.stringify({ type: 'ping', at: performance.now() })); };
    ping(); pingTimer = setInterval(ping, 2000);
    current.send(new Uint8Array([72, 65, 82, 66, 79, 82]));
  };
  socket.onmessage = event => {
    if (socket !== current) return;
    if (typeof event.data !== 'string') {
      const bytes = new Uint8Array(event.data); roomState.binaryEcho = String.fromCharCode(...bytes) === 'HARBOR';
      $('#binary').textContent = roomState.binaryEcho ? 'Binary echo passed' : 'Binary echo mismatch'; return;
    }
    const message = JSON.parse(event.data);
    if (message.type === 'hello') { roomState.id = message.id; roomState.user = message.user; }
    if (message.type === 'state') { roomState.players = message.players; $('#players').textContent = `${message.players.length} player${message.players.length === 1 ? '' : 's'}`; draw(); }
    if (message.type === 'pong') { roomState.latency = Math.round(performance.now() - message.at); $('#latency').textContent = `${roomState.latency} ms round trip`; }
  };
  socket.onclose = () => { if (socket !== current) return; clearInterval(pingTimer); $('#connection').textContent = 'Disconnected · rejoin room'; };
  socket.onerror = () => { if (socket === current) $('#connection').textContent = 'Connection failed'; };
}
$('#join').addEventListener('click', () => join());

async function database(value) {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('harbor-fixture', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('saves');
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  try {
    if (value !== undefined) await new Promise((resolve, reject) => { const tx = db.transaction('saves', 'readwrite'); tx.objectStore('saves').put(value, 'marker'); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
    return await new Promise((resolve, reject) => { const request = db.transaction('saves').objectStore('saves').get('marker'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  } finally { db.close(); }
}
async function probe() {
  $('#probe').disabled = true;
  const checks = []; const list = $('#results'); list.replaceChildren();
  const check = async (name, task) => {
    let result; try { result = { name, ok: true, detail: await task() }; } catch (error) { result = { name, ok: false, detail: String(error.message) }; }
    checks.push(result); const row = document.createElement('div'); row.className = 'result' + (result.ok ? '' : ' fail');
    const label = document.createElement('span'); label.textContent = name; const detail = document.createElement('span'); detail.textContent = `${result.ok ? 'PASS' : 'FAIL'} · ${result.detail}`; row.append(label, detail); list.append(row);
  };
  await check('Local storage', () => { localStorage.setItem('harbor-fixture:marker', 'remember-me'); if (localStorage.getItem('harbor-fixture:marker') !== 'remember-me') throw new Error('Read mismatch'); return 'Marker written and read'; });
  await check('IndexedDB', async () => { if (await database('database-remembers') !== 'database-remembers') throw new Error('Read mismatch'); return 'Transaction committed and read'; });
  await check('UTC clock', async () => { const start = Date.now(); const result = await (await fetch('/api/time')).json(); const offset = Math.round(result.now - (start + Date.now()) / 2); if (Math.abs(offset) > 10000) throw new Error(`Offset ≈ ${offset} ms`); return `Server offset ≈ ${offset} ms`; });
  await check('Cookie-backed test sign-in', async () => { const user = await login('harbor-tester'); if (user?.name !== 'harbor-tester') throw new Error('Session cookie was not returned'); return 'HttpOnly cookie accepted by server'; });
  await check('POST across 307 redirect', async () => { const result = await (await fetch('/api/post-redirect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ marker: 'preserve-post' }) })).json(); if (result.method !== 'POST' || result.body?.marker !== 'preserve-post') throw new Error('Method or payload changed'); return 'Method and JSON body preserved'; });
  const report = { checks, at: new Date().toISOString(), origin: location.origin };
  parent.postMessage({ type: 'harbor:fixture', report }, '*');
  $('#probe').disabled = false; window.lab.lastReport = report; return report;
}
$('#probe').addEventListener('click', probe);
window.lab = { probe, database, login, session, join, move, get state() { return roomState; }, get puzzle() { return puzzle; } };
if (new URLSearchParams(location.search).get('autorun') === '1') probe();
