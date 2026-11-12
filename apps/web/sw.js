// Offline support: network first (so updates arrive immediately), falling
// back to the cached copy when the iPad is offline. Files are always checked
// with the server (`no-cache`): the host lets browsers keep them for a few
// minutes, and a page put together from two versions does not start.
const CACHE = 'bedrock-v24';
const SHELL = [
  './', 'index.html', 'style.css', 'manifest.webmanifest', 'icons/icon.svg',
  'src/main.js', 'src/input.js', 'src/storage.js', 'src/files.js', 'src/cloud.js', 'src/save-worker.js', 'src/minimap.js', 'src/handwriting.js', 'src/recognizer-worker.js', 'src/recognizer-view.js', 'src/models.js', 'src/links.js', 'src/word-menu.js', 'src/selection-view.js', 'src/images.js', 'src/collect.js', 'src/share-words.js', 'src/host.js', 'src/boot-check.js', 'train/', 'train/setup.js', 'train/train.css', 'train/train.js', 'train/prompts.js', 'train/handwriting/', 'train/scribble/', 'dict/en.txt.gz',
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
    (e.request.mode === 'navigate' ? fetch(e.request) : fetch(e.request, { cache: 'no-cache' }))
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
