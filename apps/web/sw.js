// Offline support: network first (so updates arrive immediately), falling
// back to the cached copy when the iPad is offline. Files are always checked
// with the server (`no-cache`): the host lets browsers keep them for a few
// minutes, and a page put together from two versions does not start.
//
// Offline (openspec/specs/web-app-delivery): the recogniser's library comes
// from the CDN at an exact version, so it never changes and is kept in its
// own cache, served from there first. Only Bedrock's own caches are cleared
// on an update: Transformers.js keeps the downloaded handwriting models in
// `transformers-cache`, and they must survive updates to work offline.
const CACHE = 'bedrock-v34';
const LIBS = 'bedrock-libs-v1';
const KEEP = [CACHE, LIBS];
// Transformers.js at an exact version (x.y.z), as recognizer-worker.js loads it.
const PINNED = /^https:\/\/cdn\.jsdelivr\.net\/npm\/@huggingface\/transformers@\d+\.\d+\.\d+(?:[/?#]|$)/;
const SHELL = [
  './', 'index.html', 'style.css', 'manifest.webmanifest', 'icons/icon.svg',
  'src/main.js', 'src/input.js', 'src/storage.js', 'src/files.js', 'src/cloud.js', 'src/save-worker.js', 'src/minimap.js', 'src/layout.js', 'src/handwriting.js', 'src/recognizer-worker.js', 'src/recognizer-view.js', 'src/models.js', 'src/links.js', 'src/word-menu.js', 'src/selection-view.js', 'src/swatch-picker.js', 'src/images.js', 'src/collect.js', 'src/share-words.js', 'src/consent.js', 'src/host.js', 'src/errors.js', 'src/report-panel.js', 'src/error-report.js', 'src/perf.js', 'src/library.js', 'src/sidecar.js', 'src/zip-read.js', 'src/assets.js', 'src/keep-in-view.js', 'src/link-picker.js', 'train/', 'train/setup.js', 'train/train.css', 'train/train.js', 'train/prompts.js', 'train/handwriting/', 'train/scribble/', 'welcome/', 'welcome/welcome.js', 'terms/',
  'pkg/bedrock_web.js', 'pkg/bedrock_web_bg.wasm',
  // Not the spelling dictionary or PDF import: they are downloaded only when
  // used (spelling on, a PDF opened), and the first use keeps them for
  // offline like any other file.
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('bedrock-') && !KEEP.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** A file that never changes: from the cache, else fetched once and kept. */
async function pinned(request) {
  const cache = await caches.open(LIBS);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  // Only a full, readable answer is kept (never an opaque one).
  if (res.ok && (res.type === 'cors' || res.type === 'basic')) await cache.put(request, res.clone());
  return res;
}

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  if (new URL(e.request.url).origin !== location.origin) {
    if (PINNED.test(e.request.url)) e.respondWith(pinned(e.request));
    return;
  }
  e.respondWith(
    // The page too: a page the browser kept with newer scripts does not
    // start (a new main.js looks for buttons the old page lacks). A request
    // made from a navigation keeps its manual redirects, so a redirect is
    // still handed back to the browser to follow.
    fetch(new Request(e.request, { cache: 'no-cache' }))
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => {
        if (r) return r;
        // Only a page falls back to the app. A missing file stays missing
        // (as it would without a service worker): Transformers.js, for one,
        // must not read the page as a model file.
        return e.request.mode === 'navigate' ? caches.match('index.html') : Response.error();
      })),
  );
});
