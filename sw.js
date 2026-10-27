// Service worker de l'app (index.html) i de l'oficina (gestio.html). Cada pàgina en té el seu registre, amb un abast diferent
// («./» per a l'app i «./gestio.html» per a l'oficina), i per tant la seva pròpia subscripció d'avisos: en tocar una notificació
// s'obre sempre la pàgina que l'ha rebuda, encara que en el mateix navegador també s'hagi obert l'altra.
// Fa la pàgina instal·lable, en guarda una còpia per si s'obre sense xarxa (les dades sempre necessiten connexió)
// i rep els avisos (Web Push) d'accions noves, també amb la pàgina tancada.
const VERSIO = 5, CACHE = 'gestio-outdoor-v' + VERSIO;
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

// pregunta a una pàgina oberta si pot fer sonar ella mateixa la melodia (és a la vista, amb els avisos activats i el so desbloquejat)
const potSonar = c => new Promise(res => {
  try { const mc = new MessageChannel(); const tanca = v => { try { mc.port1.close(); } catch (x) {} res(v); }; const t = setTimeout(() => tanca(false), 400); mc.port1.onmessage = ev => { clearTimeout(t); tanca(!!(ev.data && ev.data.sona)); }; c.postMessage({ tipus: 'pots-sonar' }, [mc.port2]); }
  catch (x) { res(false); }
});
// Un avís (enviat per l'Edge Function «avisa-accio»): es mostra la notificació i s'avisa la pàgina, si és oberta, perquè es posi al dia.
// Si la pàgina és a la vista i pot sonar, la notificació surt en silenci i sona la melodia de la pàgina (no dos sons alhora);
// amb la pàgina tancada o amagada, sona el so de notificacions del sistema (el web no el pot triar).
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { text: e.data ? e.data.text() : '' }; }
  e.waitUntil((async () => {
    const meves = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).filter(c => esMeva(c.url));
    const visibles = meves.filter(c => c.visibilityState === 'visible');
    const silenci = visibles.length ? (await Promise.all(visibles.map(potSonar))).some(Boolean) : false;
    const opcions = { body: d.text || '', icon: 'icona-192.png', badge: 'icona-192.png', tag: (d.tag || 'gestio-accions') + (OFICINA ? '-oficina' : ''), renotify: true, data: { accio_id: d.accio_id || null, prova: !!d.prova } };
    if (silenci) opcions.silent = true; else opcions.vibrate = [180, 90, 180];   // (silent i vibrate no poden anar junts)
    await self.registration.showNotification(d.titol || 'Acció nova', opcions);
    meves.forEach(c => c.postMessage({ tipus: 'push', accio_id: d.accio_id || null, prova: !!d.prova }));
  })());
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
