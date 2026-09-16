// Service worker mínim: fa la pàgina instal·lable i guarda una còpia de la pantalla
// per si s'obre sense xarxa (les dades sempre necessiten connexió).
const CACHE = 'gestio-outdoor-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(
    fetch(e.request).then(r => { const c = r.clone(); caches.open(CACHE).then(k => k.put(e.request, c)); return r; })
      .catch(() => caches.match(e.request))
  );
});
