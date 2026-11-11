// Edge Function "pregunta-bd": contesta preguntes en llenguatge natural sobre la base de dades.
//  1. Demana a Gemini una consulta SQL (només SELECT) a partir de l'esquema (esquema_ia) i d'un glossari del negoci.
//  2. L'executa amb consulta_ia(), amb la sessió de qui pregunta (RLS, només oficina, només lectura, 500 files com a molt).
//     Si falla, deixa que Gemini la corregeixi un cop amb el missatge d'error.
//  3. Demana a Gemini que redacti la resposta en català a partir de les files.
// Secrets necessaris (Edge Functions → Secrets): GEMINI_API_KEY (i GEMINI_MODEL, opcional; per defecte gemini-2.5-flash).
// SUPABASE_URL i SUPABASE_ANON_KEY ja hi són sempre. Cal "Verify JWT" activat: la crida porta la sessió de l'usuari.
// Cos de la petició: { pregunta: "…", historial: [{ pregunta, sql, resposta }] (les darreres, opcional) }.
// Resposta: { resposta, sql, explicacio, files: [...], n, aclariment }.

import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Què vol dir cada cosa (el que l'esquema no diu). S'hi afegeix l'esquema real, tret de la base de dades a cada arrencada.
const GLOSSARI = `
L'empresa és Outdoor Engineering Solutions, SL (Sant Cugat del Vallès): manteniment de jardins, piscines i aigües grises per a comunitats de propietaris, particulars i empreses.
Totes les taules tenen "actiu" (false = donat de baixa: EXCLOU-LOS sempre, llevat que es demanin expressament) i "creat_el".

QUI I ON
- clients: el client que paga. nom, poblacio (seu del client), tipus (particular|comunitat|empresa|administracio_publica), administrador_id → administradors (administrador de finques), gestor_id → contactes, dia_facturacio (dia del mes en què se li fa la factura), forma_pagament (domiciliacio|transferencia), termini_pagament_dies i dia_pagament (quan paga).
- llocs: la finca on hi ha el jardí o la piscina: client_id, nom, adreca, poblacio (ON ÉS el jardí; si pregunten per llocs o jardins d'una població, és aquesta), contacte_id (contacte a peu de finca).
  Quan preguntin per "clients de X", mira clients.poblacio i també els llocs (llocs.poblacio) del client; digues-ho a la resposta.
- contactes: persones (del client o de l'administrador): client_id o administrador_id, nom, carrec, telefon, email.
- administradors: administradors de finques.

INSTAL·LACIONS
- jardins: lloc_id, nom, agrupacio_id, equip_id → equips (l'equip de treballadors que el porta). Superfícies en m²: m2_gespa, m2_arbusts, m2_prat, m2_arbusts_prat (m² totals del jardí = coalesce(m2_gespa,0)+coalesce(m2_arbusts,0)+coalesce(m2_prat,0)+coalesce(m2_arbusts_prat,0)). nhg/nha/nhp necessitat hídrica (1-10), hrg/hra/hrp homogeneïtat del reg (%).
- piscines: lloc_id, nom, agrupacio_id, llargada, amplada, profunditat (m; volum m³ ≈ llargada×amplada×profunditat), tractament (clor|sal|brom), climatitzada, interior, num_veins, treballador_id (qui la porta).
- piscina_bombes/piscina_filtres/piscina_cloradors enllacen cada piscina amb els aparells dels catàlegs bombes, filtres, cloradors_salins; jardi_programadors amb programadors (de reg).
- comptadors: comptadors d'aigua, cadascun d'un lloc (lloc_id) i diu què cobreix (cobreix_jardi, cobreix_piscina, cobreix_aigues_grises); data_alta, lectura_inicial, data_baixa. Un comptador pot cobrir jardí i piscina alhora: el consum no es pot separar (si demanen "dels jardins", agafa els comptadors amb cobreix_jardi i digues que poden incloure la piscina).
- lectures: lectures de comptador: comptador_id, data, index_comptador (m³ acumulats). Les lectures són ESCASSES (una cada mes o dos, en dates qualssevol): el consum d'un mes NO es pot calcular restant lectures del mateix mes (sovint no n'hi ha cap i sortiria 0).
- CONSUM D'AIGUA: fes servir SEMPRE la funció consum_llocs(any) → columnes: lloc_id, lloc, client, poblacio, comptador_id, numero_serie, cobreix ('jardí', 'piscina', 'jardí + piscina'…), mes (1-12), m3. Dona el consum de cada comptador repartit per mesos (cada tram entre dues lectures es reparteix pels dies que cauen a cada mes), igual que la gràfica del programa. És una ESTIMACIÓ: a la resposta digues que el consum mensual és aproximat (repartit pels dies entre lectures). Si consum_llocs no existís, fes el mateix amb consum_mensual(comptador_id, any) → (mes, m3) per a cada comptador, unint comptadors i llocs. Exemples:
  · consum de juliol de 2026 per lloc: select lloc, client, round(sum(m3),1) as consum_m3 from consum_llocs(2026) where mes = 7 group by lloc, client order by consum_m3 desc
  · qui consumeix més aigua aquest any: select lloc, client, round(sum(m3),1) as consum_m3 from consum_llocs(extract(year from current_date)::int) where mes <= extract(month from current_date) group by lloc, client order by consum_m3 desc limit 10
  · consum total dels jardins al juliol: … from consum_llocs(2026) where mes = 7 and cobreix like '%jardí%'
  · un període de més d'un any: uneix consum_llocs(2025) i consum_llocs(2026) amb union all i filtra per mes.
  La funció consum_mensual(comptador_id, any) → (mes, m3) fa el mateix per a un sol comptador. Només per a preguntes sobre les lectures en si (quan es va llegir, quin índex) consulta la taula lectures.
- ESCENARIS (expectativa, previsió) DE CONSUM: per a cada comptador el programa calcula la previsió mensual de consum en m³ a partir del jardí (m², necessitats hídriques, pluja) i la piscina (evaporació, neteges, dutxes) en tres escenaris: "baix" (escenari baix: any plujós, estalvi), "alt" (any sec) i "tòrrid" (alt × factor). Fes servir la funció escenaris_llocs() → lloc_id, lloc, client, poblacio, comptador_id, numero_serie, cobreix, mes (1-12), baix, alt, torrid (m³ previstos aquell mes). No depèn de l'any. Si parlen d'"expectativa", "previsió" o "escenari" de consum, és això.
  Comparar consum real amb un escenari: uneix consum_llocs(any) i escenaris_llocs() per comptador_id i mes. Per a un acumulat "fins ara", compta els mesos sencers ja passats (mes < mes actual) i digues-ho. Exemple ("quants m³ portem de més als jardins respecte de l'escenari baix"):
  with real as (select comptador_id, lloc, client, sum(m3) as m3 from consum_llocs(extract(year from current_date)::int) where mes < extract(month from current_date) and cobreix like '%jardí%' group by 1,2,3),
       prev as (select comptador_id, sum(baix) as baix from escenaris_llocs() where mes < extract(month from current_date) group by 1)
  select r.lloc, r.client, round(r.m3,1) as consum_m3, round(p.baix,1) as escenari_baix_m3, round(r.m3 - p.baix,1) as diferencia_m3 from real r join prev p using (comptador_id) order by diferencia_m3 desc
  (i per al total, suma les columnes). Mai contestis que "no hi ha dades d'escenari": es calculen sempre.

CONTRACTES I FACTURACIÓ (a clients)
- agrupacions: contracte de manteniment recurrent d'un client: client_id, nom, concepte_factura, preu (quota MENSUAL, base sense IVA), data_inici, data_fi (null = en marxa), inclou_jardi/inclou_piscina/inclou_aigues_grises, facturat_fins. Els llocs d'una agrupació són els dels jardins i piscines que tenen aquest agrupacio_id (jardins.agrupacio_id, piscines.agrupacio_id → lloc_id).
- agrupacions_estat: vista igual que agrupacions amb "estat": futur (sense data d'inici) | actual (en marxa) | finalitzat.
- factures: factures a clients. estat: esborrany (sense número) | emesa (pendent de cobrar) | cobrada | anul_lada. numero_complet, data_factura, data_venciment (quan s'ha de cobrar), data_cobrament, client_id, agrupacio_id (si és recurrent), periode_inici/periode_fi, concepte, base_imponible (sense IVA), quota_iva, total (amb IVA), origen (recurrent|manual).
  "Vençuda i no cobrada" / "impagada" = estat = 'emesa' AND data_venciment < current_date. "Pendent de cobrar" = estat = 'emesa'. Imports de factures: fes servir total (amb IVA) i digues-ho; base_imponible si demanen sense IVA.
- factura_linies: línies (descripcio, quantitat, preu_unitari, dte %, base).
- albarans: albarans (feines i material servits, pendents de passar a factura): client_id, lloc_id, data, numero_complet, estat (obert = pendent de facturar | facturat = ja passat a factura | anul_lat = ELIMINAT: no s'ha de facturar; digues-ne «eliminat», i compta'l només si es demana), factura_id. Import d'un albarà = sum(base) de les seves albara_linies actives (base = quantitat×preu_unitari amb dte).
- pressupostos_tasca (feines puntuals) i pressupostos_agrupacio (contractes de manteniment): numero, data, client_id, lloc_id, estat (esborrany|enviat|acceptat|rebutjat), base_imponible (tasca) o preu_jardi/preu_piscina/preu_aigues_grises (agrupació, mensuals).

PROVEÏDORS
- proveidors: nom, poblacio, forma_pagament, termini_dies, dia_pagament, subcontractista, percentatge_venda.
- factures_proveidor: factures rebudes: proveidor_id, numero, data_factura, data_venciment, total, pagada (true/false), data_pagament, compte_despesa_id → comptes_despesa (codi, nom), estat (revisar|ok), dubtosa. "Pendent de pagar" = pagada = false; "vençuda" = pagada = false AND data_venciment < current_date.
- factura_proveidor_linies: línies amb destí (desti_tipus lloc|stock|grup, lloc_id) i albara_id si se n'ha fet albarà.
- productes: catàleg: referencia, nom, preu_cost, pvp.

FEINA
- treballadors: nom, cognoms, rol (admin|oficina|tecnic|operari; els operaris són els de camp, que fan la feina a les comunitats; els tècnics supervisen i fan el seguiment), equip_id → equips, data_alta, data_baixa. Nom complet = nom || ' ' || cognoms.
- absencies: dies de vacances o baixa per treballador (tipus vacances|baixa, dia). festius: festius de l'empresa.
- tasques_piscina: cada visita de manteniment d'una piscina: piscina_id, data, hora, treballador_id, mesures de l'aigua (clor_lliure_1, clor_combinat_1, ph_1, isocianuric, alcalinitat, duresa, temperatura, salinitat), comprovacions (…_ok) i feines fetes (netejafons, raspallat, neteja_filtre…) com a booleans, observacions.
- incidencies: incidències d'un lloc: numero, lloc_id, titol, seguidora_id → treballadors (qui la segueix), estat (oberta|tancada), data_obertura, data_tancament, motiu_tancament.
- incidencia_accions: les accions de cada incidència: incidencia_id, tipus, carril (client|operari|seguidora|tecnic|subcontractista|proveidor), titol, responsable_treballador_id, estat (pendent|en_curs|finalitzada), inici (data a partir de la qual es pot fer; si és futura, està programada), venciment (termini), finalitzada_el, es_peticio. Fora de termini = estat <> 'finalitzada' AND venciment < now().
- incidencia_reports: avisos de problemes rebuts (lloc_id, data_hora, descripcio, estat pendent|incidencia|observacio|descartat).
- fulls_treball: fulls de treball (la feina feta en un lloc, amb les jornades i el material): numero, nom, lloc_id, encarregat_id → treballadors (QUI HA FET LA FEINA), incidencia_id (si ve d'una incidència), estat (en_curs = OBERT: l'operari encara no l'ha tancat | finalitzat = acabat, falta passar-lo a albarà | albara = passat a albarà | anul_lat = ELIMINAT: no es passarà a albarà; digues-ne «eliminat», i compta'l només si es demana), finalitzat, albara_id. (termini, inici i demanat_per ja no es fan servir: no en parlis)
  full_treball_jornades: dies treballats (full_id, data, hora_inici, hora_fi, persones, feina): hores = extract(epoch from (hora_fi - hora_inici))/3600 × persones. full_treball_material: material de magatzem usat (nom, quantitat, data).
- informes_lloc: informes escrits d'un lloc (titol, data, tema).
- empresa: dades de l'empresa (preu_hora = preu de l'hora de feina).
`;

function promptSql(esquema: string, historial: { pregunta: string; sql?: string; resposta?: string }[], pregunta: string, errorAnterior?: string, sqlAnterior?: string): string {
  const avui = new Date().toLocaleDateString("ca-ES", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" });
  const hist = historial.slice(-6).map((x) => `- Pregunta: ${x.pregunta}${x.sql ? `\n  SQL: ${x.sql}` : ""}${x.resposta ? `\n  Resposta: ${String(x.resposta).slice(0, 300)}` : ""}`).join("\n");
  return `Ets l'ajudant de dades d'una empresa de manteniment de jardins i piscines. Converteixes preguntes en català en UNA consulta SQL per a PostgreSQL (Supabase).

ESQUEMA (taula: columna tipus, …):
${esquema}

GLOSSARI I REGLES DEL NEGOCI:
${GLOSSARI}

REGLES DE LA CONSULTA:
- Només SELECT (pot començar amb WITH). Una sola instrucció, sense punt i coma final, sense comentaris. Mai INSERT/UPDATE/DELETE ni funcions que escriguin.
- Exclou els registres amb actiu = false, llevat que es demanin expressament.
- Mostra NOMS, no identificadors: client, lloc, treballador, proveïdor… amb els JOIN que calguin. Posa àlies de columna curts en català (en minúscules, sense accents, amb guions baixos: client, lloc, poblacio, total_eur, m2_totals, consum_m3…).
- Text: compara sense distingir majúscules i de forma parcial (ILIKE '%…%'); els noms de població poden anar amb o sense accent o article (Barberà / Barbera / Barberà del Vallès): fes servir un tros segur ('%barber%').
- Dates: avui és ${avui} (current_date). "Aquest any" = l'any actual; "aquest mes" = el mes actual. Mostra les dates en format DD/MM/AAAA amb to_char.
- Imports: arrodoneix a 2 decimals. Si una pregunta és ambigua sobre amb IVA o sense, mostra les dues columnes o digues què has triat a l'explicació.
- Ordena de manera útil (el més gran primer quan demanen "més"; per nom quan és una llista) i posa LIMIT 200 si no es demana una quantitat (si demanen "els 5", LIMIT 5).
- Si la pregunta no té a veure amb aquestes dades, o no es pot contestar amb l'esquema, no inventis: torna sql null i explica-ho a "aclariment". Si és ambigua de debò, fes la consulta més raonable i digues a "explicacio" què has suposat (no preguntis si no cal).
${hist ? `\nCONVERSA ANTERIOR (per si la pregunta en depèn):\n${hist}\n` : ""}
${errorAnterior ? `\nLA CONSULTA ANTERIOR HA FALLAT. Corregeix-la.\nSQL anterior: ${sqlAnterior}\nError de PostgreSQL: ${errorAnterior}\n` : ""}
PREGUNTA: ${pregunta}

Torna NOMÉS un objecte JSON: {"sql": "…" | null, "explicacio": "una frase sobre com ho calcules i què has suposat", "aclariment": null | "si no es pot contestar, per què o què caldria saber"}`;
}

function promptResposta(pregunta: string, sql: string, explicacio: string, files: unknown[], n: number): string {
  const mostra = files.slice(0, 60);
  return `Ets l'ajudant de dades d'una empresa de manteniment de jardins i piscines. Un usuari ha preguntat: "${pregunta}".
S'ha executat aquesta consulta: ${sql}
(${explicacio})
Resultat: ${n} fil${n === 1 ? "a" : "es"}${n > mostra.length ? ` (aquí les ${mostra.length} primeres)` : ""}:
${JSON.stringify(mostra)}

Redacta la resposta en català, breu i directa, en text pla (sense Markdown ni taules: la taula ja la veu l'usuari a sota).
- Si són poques files (fins a 8), anomena-les a la resposta; si són més, dona el nombre, els 3 o 4 primers i, si té sentit, el total o la suma.
- Diners amb el format 1.234,56 € i dates DD/MM/AAAA. No inventis res que no sigui al resultat. Si no hi ha cap fila, digues-ho clarament.
- Si el càlcul té una suposició important (amb IVA, només actius, població del client o del lloc…), esmenta-la en mitja frase.`;
}

async function gemini(key: string, model: string, text: string, json: boolean): Promise<string> {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text }] }], generationConfig: json ? { response_mime_type: "application/json", temperature: 0 } : { temperature: 0.2 } }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error("Gemini: " + (j.error?.message || r.status));
  return j.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text || "").join("") || "";
}

let esquemaCache: { text: string; quan: number } | null = null;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const auth = req.headers.get("Authorization") || "";
    if (!auth.startsWith("Bearer ")) return new Response(JSON.stringify({ error: "Cal haver entrat" }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });
    const body = await req.json();
    const pregunta = String(body?.pregunta || "").trim().slice(0, 1000);
    if (!pregunta) throw new Error("Escriu una pregunta");
    const historial = Array.isArray(body?.historial) ? body.historial.filter((x: unknown) => x && typeof x === "object").slice(-6) : [];

    // client amb la sessió de qui pregunta: les funcions de la base de dades apliquen els seus permisos
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
    const { data: u, error: eu } = await sb.auth.getUser();
    if (eu || !u?.user) return new Response(JSON.stringify({ error: "Sessió no vàlida" }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });
    // només l'oficina (admin o oficina, treballador actiu): abans de gastar cap crida a Gemini
    const { data: rol, error: er0 } = await sb.rpc("rol_actual");
    if (er0 || !["admin", "oficina"].includes(String(rol))) return new Response(JSON.stringify({ error: "Només l’oficina pot fer preguntes a la IA" }), { status: 403, headers: { ...cors, "Content-Type": "application/json" } });

    if (!esquemaCache || Date.now() - esquemaCache.quan > 10 * 60 * 1000) {
      const { data, error } = await sb.rpc("esquema_ia");
      if (error) throw new Error(error.message);
      esquemaCache = { text: String(data || ""), quan: Date.now() };
    }

    const key = Deno.env.get("GEMINI_API_KEY");
    if (!key) throw new Error("Falta el secret GEMINI_API_KEY");
    const model = Deno.env.get("GEMINI_MODEL") || "gemini-2.5-flash";

    // 1) la consulta
    let pla = JSON.parse(await gemini(key, model, promptSql(esquemaCache.text, historial, pregunta), true));
    if (!pla?.sql) {
      return new Response(JSON.stringify({ resposta: pla?.aclariment || "No ho puc contestar amb les dades que tinc.", sql: null, explicacio: pla?.explicacio || "", files: [], n: 0, aclariment: pla?.aclariment || null }), { headers: { ...cors, "Content-Type": "application/json" } });
    }
    // 2) executar-la (si falla, un intent de correcció amb l'error)
    let sql = String(pla.sql), files: unknown[] = [];
    let { data: res, error: er } = await sb.rpc("consulta_ia", { p_sql: sql });
    if (er) {
      pla = JSON.parse(await gemini(key, model, promptSql(esquemaCache.text, historial, pregunta, er.message, sql), true));
      if (!pla?.sql) throw new Error("No he sabut fer la consulta: " + er.message);
      sql = String(pla.sql);
      const segon = await sb.rpc("consulta_ia", { p_sql: sql });
      if (segon.error) throw new Error("La consulta ha fallat: " + segon.error.message);
      res = segon.data;
    }
    files = Array.isArray(res) ? res : [];
    // 3) la resposta redactada
    let resposta = "";
    try { resposta = (await gemini(key, model, promptResposta(pregunta, sql, String(pla.explicacio || ""), files, files.length), false)).trim(); }
    catch (_e) { resposta = files.length ? `${files.length} resultat${files.length === 1 ? "" : "s"} (mira la taula).` : "Cap resultat."; }

    return new Response(JSON.stringify({ resposta, sql, explicacio: pla.explicacio || "", files, n: files.length, aclariment: null }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error)?.message || e) }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
