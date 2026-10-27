// Service worker de l'app: fa la pàgina instal·lable, guarda una còpia de la pantalla per si s'obre sense xarxa
// (les dades sempre necessiten connexió) i rep els avisos (Web Push) d'accions noves, també amb l'app tancada.
const CACHE = 'gestio-outdoor-v2';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(Promise.all([self.clients.claim(), caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))])));
self.addEventListener('fetch', e => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(
    fetch(e.request).then(r => { const c = r.clone(); caches.open(CACHE).then(k => k.put(e.request, c)); return r; })
      .catch(() => caches.match(e.request))
  );
});

// Un avís (enviat per l'Edge Function «avisa-accio»): es mostra la notificació i s'avisa la pàgina, si és oberta, perquè es posi al dia.
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { text: e.data ? e.data.text() : '' }; }
  const mostra = self.registration.showNotification(d.titol || 'Acció nova', {
    body: d.text || '', icon: 'icona-192.png', badge: 'icona-192.png', tag: d.tag || 'gestio-accions', renotify: true, vibrate: [180, 90, 180], data: { url: d.url || './', accio_id: d.accio_id || null },
  });
  const avisa = self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => cs.forEach(c => c.postMessage({ tipus: 'push', accio_id: d.accio_id || null })));
  e.waitUntil(Promise.all([mostra, avisa]));
});

// En tocar la notificació: s'obre l'app (o es porta al davant la que ja és oberta) a «Les meves accions».
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './', self.location.href).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    const oberta = cs.find(c => c.url.split('#')[0] === url.split('#')[0]) || cs[0];
    if (oberta) { oberta.postMessage({ tipus: 'obre' }); return 'focus' in oberta ? oberta.focus() : null; }
    return self.clients.openWindow(url);
  }));
});
