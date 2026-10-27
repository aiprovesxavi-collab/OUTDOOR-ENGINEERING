// Service worker de l'app (index.html) i de l'oficina (gestio.html). Cada pàgina en té el seu registre, amb un abast diferent
// («./» per a l'app i «./gestio.html» per a l'oficina), i per tant la seva pròpia subscripció d'avisos: en tocar una notificació
// s'obre sempre la pàgina que l'ha rebuda, encara que en el mateix navegador també s'hagi obert l'altra.
// Fa la pàgina instal·lable, en guarda una còpia per si s'obre sense xarxa (les dades sempre necessiten connexió)
// i rep els avisos (Web Push) d'accions noves, també amb la pàgina tancada.
const VERSIO = 4, CACHE = 'gestio-outdoor-v' + VERSIO;
const OFICINA = /\/gestio\.html$/.test(self.registration.scope);   // aquest registre és el de l'oficina; si no, el de l'app
const PAGINA = self.registration.scope;                              // la pàgina que s'obre: l'arrel (app) o gestio.html (oficina)
const esMeva = url => { let p = ''; try { p = new URL(url).pathname; } catch (x) { return false; } return OFICINA ? /\/gestio(\.html)?$/.test(p) : /\/(index(\.html)?)?$/.test(p); };

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(Promise.all([self.clients.claim(), caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))])));
self.addEventListener('fetch', e => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(
    fetch(e.request).then(r => { const c = r.clone(); caches.open(CACHE).then(k => k.put(e.request, c)).catch(() => {}); return r; })
      .catch(() => caches.match(e.request))
  );
});

// La pàgina pregunta quina versió hi ha (per saber si el navegador ja té aquest fitxer o encara un d'antic)
self.addEventListener('message', e => {
  const d = e.data || {};
  if (d.tipus === 'versio') { const resposta = { tipus: 'versio', versio: VERSIO, oficina: OFICINA }; const port = e.ports && e.ports[0]; if (port) port.postMessage(resposta); else if (e.source) e.source.postMessage(resposta); }
});

// Un avís (enviat per l'Edge Function «avisa-accio»): es mostra la notificació i s'avisa la pàgina, si és oberta, perquè es posi al dia.
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { text: e.data ? e.data.text() : '' }; }
  const mostra = self.registration.showNotification(d.titol || 'Acció nova', {
    body: d.text || '', icon: 'icona-192.png', badge: 'icona-192.png', tag: (d.tag || 'gestio-accions') + (OFICINA ? '-oficina' : ''), renotify: true, vibrate: [180, 90, 180],
    data: { accio_id: d.accio_id || null, prova: !!d.prova },
  });
  const avisa = self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => cs.filter(c => esMeva(c.url)).forEach(c => c.postMessage({ tipus: 'push', accio_id: d.accio_id || null })));
  e.waitUntil(Promise.all([mostra, avisa]));
});

// En tocar la notificació: es porta al davant la pàgina d'aquest registre (o s'obre) i s'hi obre l'acció.
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const d = e.notification.data || {};
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async cs => {
    const oberta = cs.find(c => esMeva(c.url));
    if (oberta) { try { if ('focus' in oberta) await oberta.focus(); } catch (x) {} oberta.postMessage({ tipus: 'obre', accio_id: d.accio_id || null, prova: !!d.prova }); return; }
    return self.clients.openWindow(PAGINA + (d.accio_id && !d.prova ? '#accio=' + d.accio_id : ''));
  }));
});
