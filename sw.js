/* ModelDuel Lab — self-updating service worker.

   No version number to bump. The app opens instantly from the cache, then the
   page sends "check": every shell file is re-fetched, the cache is refreshed,
   and if index.html came back different every open window is sent "updated"
   so it can show its "new version ready" bar. To deploy, just push. */
'use strict';

const CACHE_PREFIX = 'modelduel-';     // unique to THIS app — see activate
const CACHE = 'modelduel-shell';       // fixed name; never changes between deploys
const INDEX = './index.html';
const SCOPE_PATH = new URL('./', self.location).pathname;   // e.g. /modelduellab/
const SHELL = [
  INDEX,
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './icon.svg'
];

function sameBytes(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a), y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/* Fetch one file past the HTTP cache and store it. Resolves true only when a
   copy was already cached and the new one differs. Errors and non-200
   responses leave the cache alone, so a 404/503 can never replace the app. */
function refresh(url) {
  return fetch(url, { cache: 'no-cache' }).then((res) => {
    if (!res || !res.ok) return false;
    return caches.open(CACHE).then((c) =>
      c.match(url).then((old) =>
        Promise.all([old ? old.arrayBuffer() : null, res.clone().arrayBuffer()]).then((b) => {
          const changed = !!b[0] && !sameBytes(b[0], b[1]);
          return c.put(url, res).then(() => changed);
        })
      )
    );
  }).catch(() => false);
}

function refreshShell() {
  return Promise.all(SHELL.map(refresh)).then((changed) => changed[SHELL.indexOf(INDEX)]);
}

/* install: precache, then take over at once. Safe because the cache name is
   stable — a new worker never strands an open page on a deleted cache. */
self.addEventListener('install', (e) => {
  e.waitUntil(refreshShell().then(() => self.skipWaiting()));
});

/* activate: delete only THIS app's other caches (the old dated ones). Cache
   Storage is shared by the whole origin — on <user>.github.io that is every
   project page — so never delete caches without our prefix. */
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((k) =>
        (k.indexOf(CACHE_PREFIX) === 0 && k !== CACHE) ? caches.delete(k) : null))
    ).then(() => self.clients.claim())
  );
});

/* fetch:
   - the app page → the cached app, instantly; network only if nothing is cached
   - same-origin  → cache first, then network, and cache what comes back
   - cross-origin → left alone (Open-Meteo, MET worker are the page's business)
   - ./data/      → left alone (daily capture files, always from the network)
   Freshness is handled by the "check" message, not here. */
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;
  // Daily capture files change on the server every day: never serve or store
  // them from this cache (the page merges them into its own log).
  if (url.pathname.indexOf('/data/') !== -1) return;

  // The app page is requested three ways: as a navigation, as "./" (the
  // manifest's start_url — browsers fetch it without navigating when checking
  // the app is installable) and as index.html. All three get the cached page.
  const isAppPage = req.mode === 'navigate' || url.pathname === SCOPE_PATH || url.pathname === SCOPE_PATH + 'index.html';
  if (isAppPage) {
    e.respondWith(
      caches.match(INDEX).then((hit) => {
        if (hit) return hit;
        return fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(INDEX, copy));
          }
          return res;
        });
      }).catch(() => Response.error())
    );
    return;
  }

  e.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      });
    }).catch(() => Response.error())   // offline and not cached: a plain network error, not an unhandled rejection
  );
});

self.addEventListener('message', (e) => {
  /* "check" from a page: refresh the shell and, if index.html changed, tell
     every open window so each can offer a reload. */
  if (e.data === 'check') {
    e.waitUntil(
      refreshShell().then((changed) => {
        if (!changed) return;
        return self.clients.matchAll({ type: 'window' }).then((list) => {
          list.forEach((c) => c.postMessage('updated'));
        });
      })
    );
    return;
  }
  /* Pages loaded before this worker existed show the OLD update bar, whose
     button sends SKIP_WAITING and then waits for a controller change that has
     already happened. Reload that page for it so the button still works. */
  if (e.data && e.data.type === 'SKIP_WAITING' && e.source && e.source.navigate) {
    e.waitUntil(e.source.navigate(e.source.url).catch(() => {}));
  }
});
