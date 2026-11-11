// Edge Function "avisa-accio": envia una notificació als aparells (Web Push) de qui té una acció nova (també una consulta que li fan),
// de qui li torna una acció, o de qui rep la resposta a la seva consulta. L'app la crida en segon pla just després de crear una acció
// (motiu "nova"), quan la feina d'un operari torna al tècnic o a la seguidora (motiu "torna") i quan es contesta una consulta (motiu
// "resposta": va a qui l'havia feta, amb l'acció on treballava); la crida porta la sessió de l'usuari ("Verify JWT" activat).
// Cada acció té la seva notificació (etiqueta «accio-ID»): així el mòbil compta quantes n'hi ha per mirar, i una de nova de la mateixa
// acció substitueix l'anterior.
//  1. Comprova la sessió i llegeix l'acció amb els permisos de qui crida (RLS): si no la pot veure, no s'envia res.
//  2. Amb la clau de servei (que només viu dins Supabase, mai a l'app) busca els aparells registrats (taula push_subscripcions) dels
//     destinataris —el responsable i el gestor de l'acció— i hi envia el missatge xifrat (RFC 8291) i signat (VAPID, RFC 8292).
//     Qui crida no rep l'avís a l'aparell des d'on ha fet la crida; si s'ha encarregat l'acció a si mateix, sí que li arriba als altres aparells.
//     Els aparells que ja no existeixen (el servei de push torna 404 o 410) s'esborren de la taula.
// Secrets necessaris (Edge Functions → Secrets):
//   VAPID_KEYS      el contingut sencer del fitxer vapid.json: {"publicKey":{…},"privateKey":{…}} (la pública és la que porta l'app)
//   VAPID_CONTACTE  opcional: un correu de l'empresa en forma mailto:… (els serveis de push el demanen per si han d'avisar-vos)
// SUPABASE_URL, SUPABASE_ANON_KEY i SUPABASE_SERVICE_ROLE_KEY ja hi són sempre.
// Cos de la petició: { accio_id: 123, motiu: "nova" | "torna" | "resposta", dispositiu: "<endpoint de l'aparell que crida>" }, o { motiu: "prova" }
// (una notificació de prova a tots els aparells de qui crida, en activar els avisos). Resposta: { destinataris, aparells, enviats, esborrats, errors }.

import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (cos: unknown, status = 200) => new Response(JSON.stringify(cos), { status, headers: { ...cors, "Content-Type": "application/json" } });

// els noms dels tipus d'acció (els mateixos que a l'app)
const NOM_TIPUS: Record<string, string> = {
  obrir: "Obrir incidència", assignar_seguidora: "Assignar seguidora", visibilitat_client: "Informació a disposició del client",
  diagnosticar: "Anar a veure què passa", planificar: "Planificar", consultar: "Consulta", demanar_preu: "Demanar preu",
  autoritzar_actuacio: "Autoritzar actuació (sense pressupost)", pressupost: "Elaborar pressupost", demanar_instruccions: "Demanar instruccions al client",
  decisio_client: "Decisió del client sobre el pressupost", programar: "Programar feina", assignar: "Assignar feina", executar: "Executar feina",
  demanar_material: "Demanar material", registrar_resultat: "Registrar resultat", albarans: "Convertir fulls de treball en albarans",
  conclusio: "Documentar conclusió", tancar: "Tancar incidència", reobrir: "Reobrir incidència",
};
const nomTipus = (t: string) => NOM_TIPUS[t] || t;
const nomCurt = (t: { nom?: string; cognoms?: string } | null | undefined) => t ? (t.nom || "") + (t.cognoms && t.cognoms.trim() ? " " + t.cognoms.trim()[0].toUpperCase() + "." : "") : "";

// ---- webpush: inici ---- (xifratge RFC 8291 / RFC 8188 i signatura VAPID RFC 8292, només amb WebCrypto)
const enc = new TextEncoder();
const b64uCodifica = (b: ArrayBuffer | Uint8Array) => { const u = b instanceof Uint8Array ? b : new Uint8Array(b); let s = ""; for (const x of u) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const b64uDescodifica = (s: string) => { s = s.replace(/-/g, "+").replace(/_/g, "/"); s += "=".repeat((4 - s.length % 4) % 4); const b = atob(s); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
const concat = (...parts: Uint8Array[]) => { const n = parts.reduce((s, p) => s + p.length, 0); const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const buf = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

// HKDF (extracció + expansió) amb SHA-256: la mida demanada en bytes
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, mida: number): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", buf(ikm), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: buf(salt), info: buf(info) }, k, mida * 8));
}

// Xifra el missatge per a un navegador (p256dh i auth són les claus que dona la subscripció). Torna el cos sencer (aes128gcm).
// Les opcions «salt» i «claus» només serveixen per a les proves amb els vectors de l'RFC 8291.
async function xifraWebPush(text: string, p256dh: string, auth: string, opts: { salt?: Uint8Array; claus?: CryptoKeyPair } = {}): Promise<Uint8Array> {
  const uaPublic = b64uDescodifica(p256dh);                      // 65 bytes: la clau pública del navegador
  const authSecret = b64uDescodifica(auth);                      // 16 bytes
  const uaKey = await crypto.subtle.importKey("raw", buf(uaPublic), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const claus = opts.claus || await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", claus.publicKey));
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, claus.privateKey, 256));
  const salt = opts.salt || crypto.getRandomValues(new Uint8Array(16));
  const ikm = await hkdf(authSecret, ecdhSecret, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", buf(cek), "AES-GCM", false, ["encrypt"]);
  const clar = concat(enc.encode(text), new Uint8Array([2]));   // 0x02: delimitador de l'últim (i únic) registre
  const xifrat = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: buf(nonce) }, aes, buf(clar)));
  const rs = 4096, capcalera = new Uint8Array(21); capcalera.set(salt, 0);
  capcalera[16] = (rs >>> 24) & 255; capcalera[17] = (rs >>> 16) & 255; capcalera[18] = (rs >>> 8) & 255; capcalera[19] = rs & 255; capcalera[20] = asPublic.length;
  return concat(capcalera, asPublic, xifrat);
}

type ClausVapid = { publicKey: JsonWebKey; privateKey: JsonWebKey };
// la clau pública VAPID en el format que fa servir el navegador (65 bytes, base64url): és la que porta l'app
const clauPublicaVapid = (c: ClausVapid) => b64uCodifica(concat(new Uint8Array([4]), b64uDescodifica(String(c.publicKey.x)), b64uDescodifica(String(c.publicKey.y))));

// la capçalera Authorization (VAPID): un JWT ES256 per al servei de push (audiència = l'origen de l'endpoint), vàlid 12 hores
async function capcaleraVapid(c: ClausVapid, endpoint: string, contacte: string): Promise<string> {
  const priv = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: c.privateKey.x, y: c.privateKey.y, d: c.privateKey.d }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const cap = b64uCodifica(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const cos = b64uCodifica(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: contacte })));
  const signatura = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, priv, buf(enc.encode(cap + "." + cos)));   // WebCrypto ja dona r‖s (64 bytes), com vol JWS
  return `vapid t=${cap}.${cos}.${b64uCodifica(signatura)}, k=${clauPublicaVapid(c)}`;
}

// envia un missatge a un aparell; torna l'estat HTTP del servei de push (201 = acceptat; 404/410 = l'aparell ja no hi és)
async function enviaPush(sub: { endpoint: string; p256dh: string; auth: string }, missatge: string, claus: ClausVapid, contacte: string): Promise<number> {
  const cos = await xifraWebPush(missatge, sub.p256dh, sub.auth);
  const r = await fetch(sub.endpoint, {
    method: "POST",
    headers: { Authorization: await capcaleraVapid(claus, sub.endpoint, contacte), "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: String(24 * 3600), Urgency: "high" },
    body: buf(cos),
  });
  try { await r.arrayBuffer(); } catch (_) { /* el cos no interessa */ }
  return r.status;
}
// ---- webpush: fi ----

// envia el missatge als aparells registrats d'uns treballadors (clau de servei: només aquí) i esborra els aparells que ja no existeixen
// a qui s'avisa: el responsable i el gestor de l'acció. Qui crida, només si l'acció nova és seva (se l'ha encarregada a si mateix: li arriba
// als altres aparells); mai quan és el gestor d'una petició que acaba de fer, ni quan la feina li torna perquè l'ha acabada ell mateix.
function destinatarisDe(a: { responsable_treballador_id: number | null; gestor_id: number | null }, jo: number, motiu: string): number[] {
  const out = new Set<number>();
  const resp = Number(a.responsable_treballador_id) || 0, gestor = Number(a.gestor_id) || 0;
  if (resp && (motiu === "nova" || resp !== jo)) out.add(resp);
  if (gestor && gestor !== jo) out.add(gestor);
  return [...out];
}

async function enviaAls(destinataris: number[], titol: string, text: string, accioId: number | null, excloure: string | null = null, prova = false, motiu = "nova") {
  const clausTxt = Deno.env.get("VAPID_KEYS");
  if (!clausTxt) return { error: "Falta el secret VAPID_KEYS (el contingut de vapid.json)", status: 500 };
  let claus: ClausVapid;
  try { claus = JSON.parse(clausTxt) as ClausVapid; } catch (_) { return { error: "El secret VAPID_KEYS no és un JSON vàlid: hi va el contingut sencer de vapid.json", status: 500 }; }
  if (!claus?.privateKey?.d || !claus?.publicKey?.x) return { error: "El secret VAPID_KEYS no té el format esperat ({publicKey:{x,y}, privateKey:{x,y,d}})", status: 500 };
  const contacte = Deno.env.get("VAPID_CONTACTE") || "mailto:info@outdoor.barcelona";
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data: totes, error: es } = await admin.from("push_subscripcions").select("id, treballador_id, endpoint, p256dh, auth, pagina").in("treballador_id", destinataris);
  if (es) throw es;
  const subs = (totes || []).filter((s: { endpoint: string }) => !excloure || s.endpoint !== excloure);   // l'aparell des d'on s'ha fet, no
  let enviats = 0; const morts: number[] = []; const errors: string[] = [];
  await Promise.all((subs || []).map(async (s: { id: number; endpoint: string; p256dh: string; auth: string; pagina: string }) => {
    const url = `${s.pagina === "gestio" ? "gestio" : "index"}.html${accioId ? "#accio=" + accioId : "#accions"}`;   // per si el navegador no recorda quina pàgina fa servir
    try {
      const estat = await enviaPush(s, JSON.stringify({ titol, text, url, tag: accioId ? "accio-" + accioId : "gestio-prova", accio_id: accioId, motiu, prova }), claus, contacte);
      if (estat === 201 || estat === 200 || estat === 202) enviats++;
      else if (estat === 404 || estat === 410) morts.push(s.id);
      else errors.push(`${new URL(s.endpoint).host}: ${estat}${estat === 403 || estat === 401 ? " (les claus VAPID de l'app i del secret no coincideixen?)" : ""}`);
    } catch (e) { errors.push(String((e as Error)?.message || e)); }
  }));
  if (morts.length) await admin.from("push_subscripcions").delete().in("id", morts);
  return { destinataris: destinataris.length, aparells: (subs || []).length, enviats, esborrats: morts.length, errors };
}

type Accio = { id: number; incidencia_id: number; tipus: string; titol: string | null; descripcio: string | null; estat: string; actiu: boolean; es_peticio: boolean; responsable_treballador_id: number | null; gestor_id: number | null; creat_per: number | null; finalitzada_per: number | null; resultat: string | null };

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const auth = req.headers.get("Authorization") || "";
    if (!auth.startsWith("Bearer ")) return json({ error: "Cal haver entrat" }, 401);
    const cos = await req.json().catch(() => ({}));
    const accioId = Number(cos?.accio_id); const motiu = ["torna", "resposta", "prova"].includes(cos?.motiu) ? String(cos.motiu) : "nova";
    const dispositiu = typeof cos?.dispositiu === "string" && cos.dispositiu ? String(cos.dispositiu) : null;
    if (!accioId && motiu !== "prova") return json({ error: "Falta accio_id" }, 400);

    // 1. qui crida, i l'acció tal com la pot veure (RLS)
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
    const { data: u, error: eu } = await sb.auth.getUser();
    if (eu || !u?.user) return json({ error: "Sessió no vàlida" }, 401);
    const email = String(u.user.email || "").toLowerCase();
    const { data: trebs } = await sb.from("treballadors").select("id, nom, cognoms, email_acces").eq("actiu", true);
    const jo = (trebs || []).find((t: { email_acces?: string | null }) => String(t.email_acces || "").toLowerCase() === email);
    if (!jo) return json({ error: "Sense fitxa de treballador" }, 403);
    const treb = (id: number | null) => (trebs || []).find((t: { id: number }) => t.id === Number(id)) || null;
    if (motiu === "prova") {   // una notificació de prova als aparells de qui crida
      const r = await enviaAls([jo.id], "Prova d’avís", "Així t’avisarem quan tinguis una acció nova.", null, null, true);
      return json(r, "status" in r ? r.status : 200);
    }
    const { data: a, error: ea } = await sb.from("incidencia_accions").select("id, incidencia_id, tipus, titol, descripcio, estat, actiu, es_peticio, responsable_treballador_id, gestor_id, creat_per, finalitzada_per, resultat").eq("id", accioId).maybeSingle();
    if (ea) throw ea;
    const accio = a as Accio | null;
    if (!accio || !accio.actiu) return json({ error: "Acció no trobada" }, 404);
    if (accio.estat === "finalitzada") return json({ destinataris: 0, aparells: 0, enviats: 0, esborrats: 0, errors: [], motiu: "acció finalitzada" });
    const { data: inc } = await sb.from("incidencies").select("id, numero, titol, lloc_id, estat").eq("id", accio.incidencia_id).maybeSingle();
    if (!inc || inc.estat !== "oberta") return json({ destinataris: 0, aparells: 0, enviats: 0, esborrats: 0, errors: [], motiu: "incidència no oberta" });
    const { data: lloc } = inc.lloc_id ? await sb.from("llocs").select("id, nom").eq("id", inc.lloc_id).maybeSingle() : { data: null };

    // 2. els destinataris: el responsable i el gestor de l'acció (vegeu destinatarisDe)
    const destinataris = destinatarisDe(accio, jo.id, motiu);
    if (!destinataris.length) return json({ destinataris: 0, aparells: 0, enviats: 0, esborrats: 0, errors: [] });

    // 3. el missatge
    const on = `${inc.numero || ""}${lloc?.nom ? " · " + lloc.nom : ""}`;
    const titolAccio = accio.titol && accio.titol !== nomTipus(accio.tipus) ? ` · ${accio.titol}` : "";
    let titol = "Acció nova", text = `${nomTipus(accio.tipus)}${titolAccio} (${on})`;
    if (motiu === "nova" && accio.tipus === "consultar") {   // una consulta que et fan: qui pregunta i què
      titol = `Consulta de ${nomCurt(treb(accio.creat_per)) || "algú"}`;
      text = `${String(accio.descripcio || "").slice(0, 160)} (${on})`;
    }
    if (motiu === "resposta") {   // la resposta a la teva consulta: l'última consulta contestada d'aquesta acció
      const { data: cs } = await sb.from("incidencia_accions").select("id, resultat, responsable_treballador_id, finalitzada_per, finalitzada_el").eq("origen_accio_id", accio.id).eq("tipus", "consultar").eq("estat", "finalitzada").eq("actiu", true).order("finalitzada_el", { ascending: false }).limit(1);
      const c = (cs || [])[0];
      titol = `Resposta de ${nomCurt(treb(c?.finalitzada_per || c?.responsable_treballador_id)) || nomCurt(jo)}`;
      text = `${c?.resultat ? String(c.resultat).slice(0, 160) : "Ja et poden contestar la consulta"} (${on})`;
    }
    if (motiu === "torna") {
      // la feina que ha acabat l'operari: l'última acció filla finalitzada
      const { data: filles } = await sb.from("incidencia_accions").select("id, tipus, titol, resultat, responsable_treballador_id, finalitzada_per, finalitzada_el").eq("origen_accio_id", accio.id).eq("estat", "finalitzada").eq("actiu", true).order("finalitzada_el", { ascending: false }).limit(1);
      const f = (filles || [])[0];
      titol = "Et torna una acció";
      if (f) {
        const qui = nomCurt(treb(f.finalitzada_per || f.responsable_treballador_id)) || nomCurt(jo);
        const feina = f.titol && f.titol !== nomTipus(f.tipus) ? f.titol : nomTipus(f.tipus);
        text = `${qui} ha acabat «${feina}»${f.resultat ? ": " + String(f.resultat).slice(0, 160) : ""} (${on})`;
      } else text = `Torna «${nomTipus(accio.tipus)}${titolAccio}» (${on})`;
    }

    // 4. els aparells dels destinataris (clau de servei: només aquí) i l'enviament
    const r = await enviaAls(destinataris, titol, text, accio.id, dispositiu, false, motiu);
    return json(r, "status" in r ? r.status : 200);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 400);
  }
});
