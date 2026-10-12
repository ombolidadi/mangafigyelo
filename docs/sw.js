// Az alkalmazás vázát gyorsítótárazza, hogy gyenge hálózaton is elinduljon.
// Hálózat-először stratégia: frissítés után mindig az új változat töltődik be.
const CACHE = 'mangafigyelo-shell-v1';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest', 'icon-192.png'];

self.addEventListener('install', ev => {
  ev.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', ev => {
  ev.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', ev => {
  const url = new URL(ev.request.url);
  if (ev.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/api/')) return;
  ev.respondWith(
    fetch(ev.request)
      .then(resp => {
        if (resp.ok) caches.open(CACHE).then(c => c.put(ev.request, resp.clone()));
        return resp;
      })
      .catch(() => caches.match(ev.request).then(hit => hit || caches.match('index.html'))),
  );
});

self.addEventListener('notificationclick', ev => {
  ev.notification.close();
  ev.waitUntil(self.clients.matchAll({ type: 'window' }).then(list => (list[0] ? list[0].focus() : self.clients.openWindow('./'))));
});
