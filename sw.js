// Service worker de l'app: fa la pàgina instal·lable, guarda una còpia de la pantalla per si s'obre sense xarxa
// (les dades sempre necessiten connexió) i rep els avisos (Web Push) d'accions noves, també amb l'app tancada.
const VERSIO = 3, CACHE = 'gestio-outdoor-v' + VERSIO, DARRERA = 'darrera-pagina';   // DARRERA: quina pàgina (app o oficina) fa servir aquest navegador
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(Promise.all([self.clients.claim(), caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))])));
self.addEventListener('fetch', e => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(
    fetch(e.request).then(r => {
      const c = r.clone();
      caches.open(CACHE).then(k => { k.put(e.request, c); if (/\/(index\.html|gestio\.html)?$/.test(new URL(e.request.url).pathname)) k.put(DARRERA, new Response(e.request.url.split('#')[0])); });
      return r;
    }).catch(() => caches.match(e.request))
  );
});

// La pàgina pregunta quina versió hi ha (per saber si el navegador ja té aquest fitxer o encara un d'antic)
self.addEventListener('message', e => {
  const d = e.data || {};
  if (d.tipus === 'versio') { const port = e.ports && e.ports[0]; if (port) port.postMessage({ tipus: 'versio', versio: VERSIO }); else if (e.source) e.source.postMessage({ tipus: 'versio', versio: VERSIO }); }
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

// En tocar la notificació: s'obre l'acció a la pàgina que fa servir aquest navegador (l'app o l'oficina), o es porta al davant la que ja és oberta.
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const d = e.notification.data || {};
  const ancora = d.accio_id ? '#accio=' + d.accio_id : '#accions';
  e.waitUntil((async () => {
    let pagina = null;
    try { const r = await caches.match(DARRERA); if (r) pagina = (await r.text()).split('#')[0]; } catch (x) {}
    const ambMarca = !!(pagina && pagina.startsWith(self.registration.scope));
    if (!ambMarca) pagina = new URL(d.url || './', self.location.href).href.split('#')[0];
    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const cami = u => { try { return new URL(u).pathname; } catch (x) { return u; } };
    const oberta = cs.find(c => cami(c.url) === cami(pagina)) || (!ambMarca ? cs[0] : null);
    if (oberta) { if ('focus' in oberta) { try { await oberta.focus(); } catch (x) {} } oberta.postMessage({ tipus: 'obre', accio_id: d.accio_id || null }); return; }
    await self.clients.openWindow(pagina + ancora);
  })());
});
