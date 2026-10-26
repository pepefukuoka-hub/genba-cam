// 一度開いたあとは、電波がなくても画面を開けるようにする(自分のファイルだけを保存)
const CACHE = 'genba-v3';
const FILES = ['./', 'index.html', 'app.js', 'style.css', 'vendor/qrcode.min.js', 'vendor/jsQR.js', 'manifest.webmanifest', 'icon-180.png', 'icon-512.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(fetch(e.request).then((r) => { const c = r.clone(); caches.open(CACHE).then((ch) => ch.put(e.request, c)); return r; }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
