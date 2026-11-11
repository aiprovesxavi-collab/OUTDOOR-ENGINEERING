// Edge Function "llegeix-factura": llegeix un PDF de factura de proveïdor desat al bucket
// "documents" i torna les dades en JSON, fent servir Gemini.
// Secrets necessaris (Edge Functions → Secrets): GEMINI_API_KEY (i GEMINI_MODEL, opcional).
// Cos de la petició: { path, comptes: ["6001001 — PLANTES", …], persones: ["XA — Xavier Amat", …], llocs: ["M1", "AG D7 2", …] }.
// Torna també les línies de la factura amb l'anotació manuscrita de destinació de cada una (M1, STOCK, OFICINA…).
// SEGURETAT (versió de novembre de 2026): només hi pot cridar l'oficina (admin o oficina), amb la seva sessió. El PDF es llegeix amb
// els permisos de qui crida (les regles del Storage) i només de la carpeta proveidors/. No fa servir la clau de servei.
// SUPABASE_URL i SUPABASE_ANON_KEY ja hi són sempre.

import { createClient } from "npm:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding/base64";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// El prompt es munta a cada crida: l'aplicació hi envia la llista de comptes de despesa i la de persones
// que poden donar la conformitat, perquè la lectura de l'anotació manuscrita sigui més fiable.
function prompt(comptes: string[], persones: string[], llocs: string[]): string {
  return `Ets un assistent comptable. Llegeix aquesta factura d'un proveïdor i torna NOMÉS un objecte JSON amb aquests camps
(posa null als que no trobis; les dates en format AAAA-MM-DD; els imports com a números amb punt decimal, sense símbol):
{
  "proveidor_nom": "nom o raó social de qui emet la factura",
  "proveidor_nif": "NIF/CIF de qui emet la factura (no el del destinatari)",
  "numero": "número de la factura",
  "data_factura": "data d'emissió",
  "data_venciment": "data de venciment o de càrrec, si hi és",
  "base_imponible": 0,
  "iva_percent": 21,
  "quota_iva": 0,
  "total": 0,
  "concepte": "resum molt breu (una línia) del que es factura",
  "conformitat": "l'anotació MANUSCRITA de conformitat, si n'hi ha, transcrita tal qual (exemple: 'CXA · 6001001 · 21/04/2026')",
  "conforme_inicials": "les inicials de qui dona la conformitat: les lletres que van després de la C (a l'exemple, 'XA')",
  "compte_despesa": "el compte comptable de 7 xifres de l'anotació (a l'exemple, '6001001')",
  "conforme_data": "la data de l'anotació, en AAAA-MM-DD (a l'exemple, 2026-04-21)",
  "confianca": "alta | mitjana | baixa",
  "linies": [
    { "ordre": 1, "descripcio": "descripció de l'article tal com surt a la factura", "quantitat": 11, "preu_unitari": 3.45, "import": 37.95, "iva_percent": 10, "desti": "M1" }
  ]
}
Sobre les línies: una entrada per cada línia d'article de la factura, en el mateix ordre (si no n'hi ha, una llista buida).
"quantitat" és el nombre d'unitats; "preu_unitari" el preu unitari; "import" l'import net de la línia (amb el descompte aplicat, si n'hi ha);
"iva_percent" el tipus d'IVA de la línia si es pot saber (si la factura en té un de sol, el mateix a totes).
"desti" és l'anotació MANUSCRITA que hi ha al costat de la línia (normalment a la dreta de la descripció): diu on va el material.
Pot ser el codi curt d'un lloc o jardí (M1, D7, VC, JO, R31…) o bé STOCK, GRUP o OFICINA. Transcriu-la tal qual, en majúscules.
Si una clau, parèntesi o línia agrupa diverses línies amb una sola anotació, posa la mateixa anotació a totes. Si una línia no en té, null.
No confonguis l'anotació manuscrita amb el text imprès de la factura, i no inventis cap destinació.
El destinatari de la factura és Outdoor Engineering Solutions, SL (NIF B66725086): no el confonguis amb el proveïdor.

Sobre l'anotació de conformitat: l'escriu a mà el destinatari (Outdoor) quan aprova la factura, normalment a la part de baix
del full, i té la forma "C" + inicials + compte de 7 xifres + data, sovint separats per punts o guions. La C vol dir "conforme",
les inicials són de la persona que l'aprova, el compte és el compte de despesa on es comptabilitza i la data és la de l'aprovació.
No forma part del text imprès pel proveïdor. Si no hi ha cap anotació manuscrita d'aquest tipus, posa null als quatre camps
(conformitat, conforme_inicials, compte_despesa i conforme_data). No inventis mai el compte: si el número escrit no es llegeix bé, posa null.
${persones.length ? `Persones que poden donar la conformitat (inicials — nom): ${persones.join('; ')}.` : ''}
${comptes.length ? `Comptes de despesa que existeixen (codi — nom), per ajudar-te a llegir bé els dígits manuscrits: ${comptes.join('; ')}. Si el que hi ha escrit no coincideix amb cap, torna igualment el que llegeixis.` : ''}
${llocs.length ? `Llocs (jardins i piscines) que existeixen, per ajudar-te a llegir bé els codis manuscrits de destinació: ${llocs.join('; ')}. Si el que hi ha escrit no coincideix amb cap, torna igualment el que llegeixis.` : ''}`;
}

const resposta = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    // 1. qui crida: ha d'haver entrat i ha de ser de l'oficina (admin o oficina, treballador actiu)
    const auth = req.headers.get("Authorization") || "";
    if (!auth.startsWith("Bearer ")) return resposta({ error: "Cal haver entrat" }, 401);
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
    const { data: u, error: eu } = await sb.auth.getUser();
    if (eu || !u?.user) return resposta({ error: "Sessió no vàlida" }, 401);
    const { data: rol, error: er } = await sb.rpc("rol_actual");
    if (er || !["admin", "oficina"].includes(String(rol))) return resposta({ error: "Només l’oficina pot llegir factures de proveïdor" }, 403);

    // 2. què vol llegir: només un PDF de la carpeta de les factures de proveïdor
    const { path, comptes, persones, llocs } = await req.json();
    if (typeof path !== "string" || !/^proveidors\/[\w.\-\/]+$/.test(path) || path.includes("..")) return resposta({ error: "Camí del PDF no vàlid" }, 400);
    const llista = (v: unknown) => Array.isArray(v) ? v.filter((x) => typeof x === "string").map((x) => x.slice(0, 120)).slice(0, 300) : [];

    // 3. el fitxer, amb els permisos de qui crida (si no el pot veure a l'app, aquí tampoc)
    const { data: file, error } = await sb.storage.from("documents").download(path);
    if (error) throw new Error("No s'ha pogut llegir el fitxer: " + error.message);
    const b64 = encodeBase64(new Uint8Array(await file.arrayBuffer()));

    const key = Deno.env.get("GEMINI_API_KEY");
    if (!key) throw new Error("Falta el secret GEMINI_API_KEY");
    const model = Deno.env.get("GEMINI_MODEL") || "gemini-2.5-flash";
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ inline_data: { mime_type: "application/pdf", data: b64 } }, { text: prompt(llista(comptes), llista(persones), llista(llocs)) }] }],
        generationConfig: { response_mime_type: "application/json", temperature: 0 },
      }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error("Gemini: " + (j.error?.message || r.status));
    const text = j.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    const dades = JSON.parse(text);
    return resposta(dades);
  } catch (e) {
    return resposta({ error: String((e as Error)?.message || e) }, 400);
  }
});
