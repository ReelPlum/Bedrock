// Offline support: network first (so updates arrive immediately), falling
// back to the cached copy when the iPad is offline.
const CACHE = 'bedrock-v1';
const SHELL = [
  './', 'index.html', 'style.css', 'manifest.webmanifest', 'icons/icon.svg',
  'src/main.js', 'src/input.js', 'src/storage.js', 'src/files.js', 'src/cloud.js',
  'pkg/bedrock_web.js', 'pkg/bedrock_web_bg.wasm',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('index.html'))),
  );
});
