"use strict";
importScripts("harbor/stream-bridge.js", "harbor/vendor/controller.sw.js", "harbor/worker-routes.js");
importScripts("split-config.js");
const CONFIG = self.TBWSplitConfig;
const SCOPE = self.registration.scope;
const PREFIX = "tbw-split:" + new URL(SCOPE).pathname + ":";
const CACHE = PREFIX + CONFIG.revision;
const PART_CACHE = "tbw-split-parts:tbw-web:v1";
const partKey = part => new URL("/__tbw_parts/tbw-web/" + part.sha256 + ".part", self.location.origin).href;
let legacyPartStores;
async function cachedPart(cache, key, part) {
  const stored = await cache.match(key);
  if (stored) return { response: stored, cache, key };
  if (!legacyPartStores) legacyPartStores = caches.keys().then(names => names.filter(name =>
    name.startsWith("tbw-split:") && name.endsWith(":parts") && /\/tbw-web(?:@|\/)/.test(name)).reverse());
  for (const name of await legacyPartStores) {
    const oldScope = name.slice("tbw-split:".length, -":parts".length);
    const oldCache = await caches.open(name);
    const oldKey = new URL(oldScope + "__tbw_parts/" + part.sha256 + ".part", self.location.origin).href;
    const response = await oldCache.match(oldKey);
    if (response) return { response, cache: oldCache, key: oldKey };
  }
  return null;
}
const local = path => new URL(path, SCOPE).href;
const networkFetch = self.fetch.bind(self);
function htmlPage(response, headOnly) {
  const headers = new Headers(response.headers);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.delete("Content-Encoding");
  headers.delete("Content-Length");
  return new Response(headOnly ? null : response.body, { status: response.status, statusText: response.statusText, headers });
}

let manifestPromise, downloading = false, activeParts = 0;
const waitingParts = [];

function relativePath(path) {
  if (typeof path !== "string" || !path || path.startsWith("/") ||
      path.split("/").some(piece => !piece || piece === "." || piece === "..") || /[?#\\]/.test(path))
    throw new Error("Invalid split asset path.");
  const url = new URL(path, SCOPE);
  if (!url.href.startsWith(SCOPE)) throw new Error("Split asset escaped the game folder.");
  return url.href;
}

async function manifest() {
  if (!manifestPromise) manifestPromise = (async () => {
    const cache = await caches.open(CACHE);
    let response = await cache.match(local("split-manifest.json"));
    const downloaded = !response;
    if (!response) {
      response = await networkFetch(local("split-manifest.json"), { cache: "no-store" });
      if (!response.ok) throw new Error("The split asset manifest could not be downloaded.");
    }
    const copy = downloaded ? response.clone() : null;
    let value;
    try { value = await response.json(); }
    catch (error) {
      await cache.delete(local("split-manifest.json"));
      throw new Error("The split asset manifest is incomplete. Finish uploading, then reload.");
    }
    if (value.version !== 1 || value.revision !== CONFIG.revision || !Array.isArray(value.assets))
    {
      await cache.delete(local("split-manifest.json"));
      throw new Error("The split asset manifest belongs to a different game version.");
    }
    const routes = new Map();
    for (const asset of value.assets) {
      const url = relativePath(asset.url);
      if (routes.has(url) || !Number.isSafeInteger(asset.bytes) || asset.bytes < 1 ||
          !Array.isArray(asset.parts) || !asset.parts.length) throw new Error("Invalid split asset entry.");
      let total = 0;
      for (const part of asset.parts) {
        relativePath(part.url);
        if (!Number.isSafeInteger(part.bytes) || part.bytes < 1 || part.bytes > 16 * 1024 * 1024 ||
            !/^[a-f0-9]{64}$/.test(part.sha256)) throw new Error("Invalid split part entry.");
        total += part.bytes;
      }
      if (total !== asset.bytes) throw new Error("Split part sizes do not match the asset.");
      routes.set(url, asset);
    }
    if (copy) await cache.put(local("split-manifest.json"), copy);
    return { value, routes };
  })().catch(error => { manifestPromise = null; throw error; });
  return manifestPromise;
}

async function partSlot(signal, bytes) {
  if (activeParts >= 2) await new Promise((resolve, reject) => {
    const waiter = { resolve, reject, signal, bytes, abort: null };
    waiter.abort = () => {
      const index = waitingParts.indexOf(waiter);
      if (index >= 0) waitingParts.splice(index, 1);
      reject(new DOMException("Download cancelled", "AbortError"));
    };
    if (signal.aborted) { waiter.abort(); return; }
    signal.addEventListener("abort", waiter.abort, { once: true });
    waitingParts.push(waiter);
    waitingParts.sort((a, b) => a.bytes - b.bytes);
  });
  else activeParts++;
  if (signal.aborted) { releasePart(); throw new DOMException("Download cancelled", "AbortError"); }
}

function releasePart() {
  const waiter = waitingParts.shift();
  if (waiter) {
    waiter.signal.removeEventListener("abort", waiter.abort);
    waiter.resolve(); // Transfer this slot without increasing activeParts.
  } else activeParts--;
}

async function sha256(bytes) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join("");
}

async function readPart(part, signal, strictStorage, activity) {
  if (activity) activity("queued", 0);
  await partSlot(signal, part.bytes);
  try {
    const cache = await caches.open(PART_CACHE);
    const key = partKey(part);
    const stored = await cachedPart(cache, key, part);
    if (stored) {
      const bytes = new Uint8Array(await stored.response.arrayBuffer());
      if (bytes.byteLength === part.bytes && await sha256(bytes) === part.sha256) {
        if (activity) activity("cached", part.bytes);
        return bytes;
      }
      await stored.cache.delete(stored.key);
    }
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (signal.aborted) throw new DOMException("Download cancelled", "AbortError");
      const controller = new AbortController();
      let idleTimer, timedOut = false;
      const cancel = () => controller.abort();
      const timeout = () => { timedOut = true; controller.abort(); };
      const resetIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(timeout, 45000); };
      const totalTimer = setTimeout(timeout, 240000);
      signal.addEventListener("abort", cancel, { once: true });
      resetIdle();
      if (activity) activity(attempt ? "retrying" : "downloading", 0);
      try {
        const url = new URL(part.url, new URL(CONFIG.assetBase || "./", SCOPE));
        if (url.protocol !== "https:" && url.origin !== self.location.origin)
          throw new Error("The asset host must use HTTPS.");
        const response = await networkFetch(url.href, {
          signal: controller.signal, credentials: "omit", mode: "cors",
          cache: attempt ? "reload" : "default"
        });
        if (!response.ok) throw new Error("Part request failed (HTTP " + response.status + "): " + part.url);
        resetIdle();
        let wire;
        if (response.body && response.body.getReader) {
          wire = new Uint8Array(part.bytes + 8);
          const reader = response.body.getReader();
          let received = 0;
          try {
            while (true) {
              const result = await reader.read();
              if (result.done) break;
              resetIdle();
              if (received + result.value.byteLength > wire.byteLength)
                throw new Error("The part is larger than expected: " + part.url);
              wire.set(result.value, received);
              received += result.value.byteLength;
              if (activity) activity("downloading", received);
            }
            if (received !== wire.byteLength) throw new Error("The part download is incomplete: " + part.url);
          } catch (error) {
            await reader.cancel().catch(() => {});
            throw error;
          } finally { reader.releaseLock(); }
        } else wire = new Uint8Array(await response.arrayBuffer());
        clearTimeout(idleTimer);
        clearTimeout(totalTimer);
        if (wire.byteLength !== part.bytes + 8 ||
            [84, 66, 87, 80, 65, 82, 84, 49].some((byte, index) => wire[index] !== byte))
          throw new Error("Invalid split part: " + part.url);
        const bytes = wire.subarray(8);
        if (await sha256(bytes) !== part.sha256) throw new Error("Split part checksum failed: " + part.url);
        if (signal.aborted) throw new DOMException("Download cancelled", "AbortError");
        if (activity) activity("verified", part.bytes);
        try {
          await cache.put(key, new Response(bytes, { headers: { "Content-Type": "application/octet-stream" } }));
        } catch (error) { if (strictStorage) throw error; }
        return bytes;
      } catch (error) {
        if (signal.aborted || error.name === "QuotaExceededError") throw error;
        lastError = timedOut
          ? new Error("Part download timed out: " + part.url)
          : new Error((error.name === "AbortError" ? "The browser interrupted the part download" : error.message) + ": " + part.url);
      } finally {
        clearTimeout(idleTimer);
        clearTimeout(totalTimer);
        signal.removeEventListener("abort", cancel);
      }
    }
    throw lastError;
  } finally { releasePart(); }
}

async function splitResponse(request, asset, finish, clientId) {
  let first = 0, last = asset.bytes - 1, status = 200;
  const range = request.headers.get("Range");
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match && (match[1] || match[2])) {
      first = match[1] ? Number(match[1]) : Math.max(0, asset.bytes - Number(match[2]));
      last = match[1] && match[2] ? Math.min(Number(match[2]), last) : last;
    } else first = asset.bytes;
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first > last || first >= asset.bytes)
      { finish(); return new Response(null, { status: 416, headers: { "Content-Range": "bytes */" + asset.bytes } }); }
    status = 206;
  }
  const headers = new Headers({
    "Content-Type": "application/octet-stream", "Content-Length": String(last - first + 1),
    "Accept-Ranges": "bytes", "Cache-Control": "no-cache", "X-TBW-Split": CONFIG.revision
  });
  if (status === 206) headers.set("Content-Range", "bytes " + first + "-" + last + "/" + asset.bytes);
  if (request.method === "HEAD") { finish(); return new Response(null, { status, headers }); }
  const controller = new AbortController();
  let cancelled = false, complete = false, lastActivity = 0;
  const notify = async data => {
    if (!clientId) return;
    const client = await self.clients.get(clientId).catch(() => null);
    if (client) client.postMessage(data);
  };
  const activity = (phase, bytes) => {
    const now = Date.now();
    if (phase === "downloading" && bytes && now - lastActivity < 500) return;
    lastActivity = now;
    void notify({ type: "TBW_SPLIT_ACTIVITY", url: asset.url, phase, bytes }).catch(() => {});
  };
  let index = 0, offset = 0, nextPart = null;
  while (offset + asset.parts[index].bytes <= first) offset += asset.parts[index++].bytes;
  const body = new ReadableStream({
    async pull(stream) {
      if (cancelled || complete) return;
      try {
        const part = asset.parts[index++];
        const currentPart = nextPart || readPart(part, controller.signal, false, activity);
        nextPart = null;
        if (asset.bytes > 16 * 1024 * 1024 && index < asset.parts.length && offset + part.bytes <= last) {
          nextPart = readPart(asset.parts[index], controller.signal, false, activity);
          nextPart.catch(() => {});
        }
        const bytes = await currentPart;
        if (cancelled) return;
        stream.enqueue(bytes.subarray(Math.max(0, first - offset), Math.min(part.bytes, last - offset + 1)));
        offset += part.bytes;
        if (offset > last) {
          complete = true;
          stream.close();
          finish();
        }
      } catch (error) {
        if (cancelled) { finish(); return; }
        complete = true;
        controller.abort();
        stream.error(error);
        finish();
        await notify({ type: "TBW_SPLIT_ERROR", error: asset.url + ": " + error.message }).catch(() => {});
      }
    },
    cancel() { cancelled = true; controller.abort(); finish(); }
  }, { highWaterMark: 1 });
  return new Response(body, { status, headers });
}

self.addEventListener("install", event => event.waitUntil((async () => {
  await manifest();
  const cache = await caches.open(CACHE);
  await cache.addAll(CONFIG.shell.map(relativePath));
  await self.skipWaiting();
})()));

self.addEventListener("activate", event => event.waitUntil((async () => {
  for (const name of await caches.keys())
    if (name.startsWith(PREFIX) && name !== CACHE && !name.endsWith(":parts")) await caches.delete(name);
  await self.clients.claim();
})()));

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (HarborRoutes.matches(event)) { event.respondWith(HarborRoutes.route(event)); return; }
  if (!["GET", "HEAD"].includes(event.request.method) || url.origin !== self.location.origin || !url.href.startsWith(SCOPE)) return;
  let completeResponse;
  let finishedResponse = false;
  const completion = new Promise(resolve => { completeResponse = resolve; });
  const lifetimeTimer = setTimeout(() => finish(), 10 * 60 * 1000);
  function finish() {
    if (finishedResponse) return;
    finishedResponse = true;
    clearTimeout(lifetimeTimer);
    completeResponse();
  }
  event.waitUntil(completion);
  event.respondWith((async () => {
    const metadata = await manifest();
    const asset = metadata.routes.get(url.origin + url.pathname);
    if (asset) return splitResponse(event.request, asset, finish, event.clientId);
    finish();
    const cache = await caches.open(CACHE);
    if (["index.html", "harbor/browser.html", "harbor/games/geometry-dash.html"].some(name => url.pathname === new URL(local(name)).pathname)) {
      const key = url.origin + url.pathname;
      const stored = await cache.match(key);
      const page = stored || await networkFetch(event.request);
      if (page.ok && !stored) event.waitUntil(cache.put(key, page.clone()).catch(() => {}));
      return page.ok ? htmlPage(page, event.request.method === "HEAD") : page;
    }
    if (event.request.mode === "navigate") {
      try { return await networkFetch(event.request); }
      catch (error) {
        const page = await cache.match(local("index.html"));
        if (page) return htmlPage(page, false);
        throw error;
      }
    }
    if (event.request.method === "HEAD") return networkFetch(event.request);
    const stored = await cache.match(event.request);
    if (stored) return stored;
    const response = await networkFetch(event.request);
    if (response.ok && !/\/(?:sw|split-config)\.js$/.test(url.pathname))
      event.waitUntil(cache.put(event.request, response.clone()).catch(() => {}));
    return response;
  })().catch(error => { finish(); throw error; }));
});

self.addEventListener("message", event => {
  if (!event.data) return;
  const port = event.ports && event.ports[0];
  const send = data => { if (port) port.postMessage(data); };
  if (event.data.type === "TBW_SPLIT_CLAIM") {
    event.waitUntil((async () => {
      await self.clients.claim();
      await manifest();
      send({ revision: CONFIG.revision });
    })().catch(error => send({ error: error.message })));
    return;
  }
  if (event.data.type === "TBW_SPLIT_READY") {
    event.waitUntil(manifest().then(() => send({ revision: CONFIG.revision })).catch(error => send({ error: error.message })));
    return;
  }
  if (event.data.type !== "CACHE_ALL") return;
  if (downloading) { send({ error: "An offline download is already running." }); return; }
  downloading = true;
  event.waitUntil((async () => {
    try {
      const metadata = await manifest();
      const cache = await caches.open(CACHE);
      const response = await cache.match(local("offline-manifest.json"));
      const offline = await response.json();
      if (offline.revision !== CONFIG.revision) throw new Error("Reload the updated game before downloading.");
      const total = offline.files.reduce((sum, file) => sum + file.bytes, 0);
      let done = 0;
      for (const file of offline.files) {
        const url = relativePath(file.url);
        const asset = metadata.routes.get(url);
        if (asset) {
          for (const part of asset.parts) {
            await readPart(part, new AbortController().signal, true);
            done += part.bytes;
            send({ done, total });
          }
        } else {
          if (!(await cache.match(url))) {
            const result = await networkFetch(url);
            if (!result.ok) throw new Error("Download failed: " + file.url);
            await cache.put(url, result);
          }
          done += file.bytes;
          send({ done, total });
        }
      }
      send({ complete: true, done, total });
    } catch (error) {
      send({ error: error.name === "QuotaExceededError" ? "Not enough browser storage. Downloaded parts are kept so you can resume." : error.message });
    } finally { downloading = false; }
  })());
});
