const CACHE = 'inquisitor-v24';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './style.css',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './InquisitorSplash.jpg',
  './InquisitorSplash1.jpg',
  './ringin.wav',
  './ringout.wav',
  './Windows XP Hardware Fail.wav'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c =>
      Promise.all(ASSETS.map(url => fetch(url, { cache: 'reload' }).then(res => c.put(url, res))))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network first, cache as the offline fallback. Cache-first used to keep showing the old
// version of the app after a deploy until the page was loaded a second time; now every
// online load gets what GitHub Pages is serving, and the cache only answers when the
// network fails or takes longer than NETWORK_TIMEOUT_MS (so a weak venue Wi-Fi can't
// leave the operator staring at a blank screen).
const NETWORK_TIMEOUT_MS = 3000;

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(networkFirst(req));
});

function networkFirst(req) {
  const network = fetch(req, { cache: 'no-cache' }).then(res => {
    if (res.status === 200) {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
    }
    return res;
  });

  const fallback = () =>
    caches.match(req, { ignoreSearch: true })
      .then(hit => hit || (req.mode === 'navigate' ? caches.match('./index.html') : undefined));

  const timeout = new Promise(resolve => setTimeout(resolve, NETWORK_TIMEOUT_MS));

  return Promise.race([network.catch(() => null), timeout]).then(res =>
    res || fallback().then(hit => hit || network)
  );
}
