/* Stato della diretta, scritto dal pannello e letto dalla pagina della diretta.
   POST /api/live/ con { chiave, cta: { on, url, testo } } salva live/stato.json nello spazio Blob "pbm-live" (pubblico).
   La pagina della diretta legge direttamente il file pubblico: la rete lo aggiorna entro 60 secondi.
   La chiave non sta nel codice: qui c'è solo la sua impronta (SHA-256). */
const crypto = require("crypto");
const { put } = require("@vercel/blob");

const KEY_HASH = "715ccff2b0480e44fc5ea32554e0ca1dbe045526383a3ac3924ded669215d2a5";
const PATH = "live/stato.json";

function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(obj));
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const keyOk = k => {
  const h = crypto.createHash("sha256").update(String(k || "")).digest("hex");
  return h.length === KEY_HASH.length && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(KEY_HASH));
};

module.exports = async (req, res) => {
  if (req.method !== "POST") return send(res, 405, { error: "solo POST" });
  let body;
  try { body = JSON.parse(await readRaw(req)); } catch (e) { return send(res, 400, { error: "json non valido" }); }
  if (!keyOk(body.chiave)) return send(res, 401, { error: "chiave sbagliata" });

  const cta = body.cta || {};
  const url = String(cta.url || "").trim();
  if (url && !/^https:\/\/\S+$/.test(url)) return send(res, 400, { error: "il link deve iniziare con https://" });
  const stato = {
    cta: { on: !!cta.on && !!url, url, testo: String(cta.testo || "").trim().slice(0, 120) },
    aggiornato: new Date().toISOString()
  };

  try {
    const blob = await put(PATH, JSON.stringify(stato), {
      access: "public", addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 60, contentType: "application/json"
    });
    return send(res, 200, { ok: true, url: blob.url, stato });
  } catch (e) {
    return send(res, 502, { error: "salvataggio non riuscito", dettaglio: String(e && e.message || "").slice(0, 200) });
  }
};
