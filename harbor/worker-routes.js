"use strict";
(() => {
  const scope = self.registration.scope;
  const prefix = new URL('harbor/route/', scope).pathname;
  const pending = new Set();
  const reconnecting = new Map();
  self.addEventListener('message', event => { if (event.data?.$controller$init) for (const check of [...pending]) check(); });
  async function connected(event) {
    if ($scramjetController.shouldRoute(event)) return;
    const pathname = new URL(event.request.url).pathname;
    const id = pathname.slice(prefix.length).split('/')[0];
    const routePrefix = prefix + id + '/';
    if (!reconnecting.has(routePrefix)) {
      const task = new Promise((resolve, reject) => {
        const check = () => { if ($scramjetController.shouldRoute(event)) { clearTimeout(timer); pending.delete(check); resolve(); } };
        const timer = setTimeout(() => { pending.delete(check); reject(new Error('The browser tab disconnected. Return to Browser and open the address again.')); }, 10000);
        pending.add(check); check();
      });
      const notify = self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
        for (const client of clients) if (client.url.startsWith(scope)) client.postMessage({ $harbor$revive: { pathname } });
      });
      reconnecting.set(routePrefix, Promise.all([task, notify]).finally(() => reconnecting.delete(routePrefix)));
    }
    await reconnecting.get(routePrefix);
  }
  globalThis.HarborRoutes = {
    matches(event) { const url = new URL(event.request.url); return url.origin === self.location.origin && url.pathname.startsWith(prefix); },
    async route(event) {
      try {
        await connected(event);
        const response = await $scramjetController.route(event);
        if (event.request.mode !== 'navigate' && !['iframe', 'document'].includes(event.request.destination)) return response;
        const headers = new Headers(response.headers);
        for (const name of ['Cross-Origin-Opener-Policy', 'Cross-Origin-Embedder-Policy', 'Document-Isolation-Policy']) headers.delete(name);
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
      } catch (error) {
        return new Response(error.message, { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
      }
    }
  };
})();
