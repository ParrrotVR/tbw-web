importScripts('/stream-bridge.js', '/controller/controller.sw.js');

const waitingRoutes = new Set();
const reconnectingRoutes = new Map();
self.addEventListener('message', event => {
  if (!event.data?.$controller$init) return;
  // The imported controller registers the route synchronously first.
  for (const check of [...waitingRoutes]) check();
});

function reconnectRoute(event) {
  if ($scramjetController.shouldRoute(event)) return Promise.resolve();
  const pathname = new URL(event.request.url).pathname;
  const prefix = pathname.split('/').slice(0, 4).join('/') + '/';
  if (reconnectingRoutes.has(prefix)) return reconnectingRoutes.get(prefix);
  const connected = new Promise((resolve, reject) => {
    const check = () => {
      if (!$scramjetController.shouldRoute(event)) return;
      clearTimeout(timer); waitingRoutes.delete(check); resolve();
    };
    const timer = setTimeout(() => {
      waitingRoutes.delete(check);
      reject(new Error('The browser tab is no longer connected. Open Harbor and try again.'));
    }, 10000);
    waitingRoutes.add(check);
    check();
  });
  // Workers can be terminated while their pages remain open. Ask the owning
  // page to reattach its transport instead of leaking this URL to Express.
  const notify = self.clients.matchAll({ type: 'window' }).then(clients => {
    for (const client of clients) client.postMessage({ $harbor$revive: { pathname } });
  });
  const reconnecting = Promise.all([connected, notify]).finally(() => reconnectingRoutes.delete(prefix));
  reconnectingRoutes.set(prefix, reconnecting);
  return reconnecting;
}

async function route(event) {
  try {
    await reconnectRoute(event);
    return await $scramjetController.route(event);
  } catch (error) {
    if (event.request.mode === 'navigate') {
      const destination = new URL(event.request.url).pathname.split('/').slice(5).join('/');
      let target = '';
      try { const url = new URL(decodeURIComponent(destination)); if (/^https?:$/.test(url.protocol) && !url.username && !url.password) target = url.href; } catch {}
      // A bookmarked internal URL has no living owner. Reopen the public
      // shell, which can create a fresh controller and retain existing saves.
      return Response.redirect(new URL('/' + (target ? '?target=' + encodeURIComponent(target) : ''), self.location.origin).href, 302);
    }
    return new Response(error.message, { status: 503, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });
  }
}
self.addEventListener('fetch', event => {
  if (new URL(event.request.url).pathname.startsWith('/~/sj/')) event.respondWith(route(event));
});
