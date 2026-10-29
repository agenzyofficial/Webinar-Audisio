/* Bottone della call e chat in tempo reale per la pagina della diretta (Cloudflare Worker + Durable Object).
   GET  /ws     WebSocket: manda subito lo stato del bottone e gli ultimi messaggi della chat, poi ogni cambio, a tutti insieme.
                Lo spettatore scrive in chat mandando { t: "msg", nome, testo } sullo stesso WebSocket (?d= codice del dispositivo).
   GET  /stato  stato attuale in JSON.
   POST /stato  { chiave, stato } salva e avvisa tutti: lo chiama api/live.js del sito quando si preme Mostra o Nascondi.
   POST /chat   { chiave, azione, id } moderazione dal pannello: cancella, banna, sblocca, bannati, chiudi, apri, svuota;
                "sorgente" fa rileggere subito sorgente.json a tutte le pagine aperte (dopo averlo cambiato).
   Il ban blocca la scrittura per IP (per IPv6 la rete /64) e per codice del dispositivo: chi è bannato vede la chat ma non scrive.
   La chiave non sta nel codice: c'è solo la sua impronta SHA-256, la stessa di api/live.js. */
import { DurableObject } from "cloudflare:workers";

const KEY_HASH = "715ccff2b0480e44fc5ea32554e0ca1dbe045526383a3ac3924ded669215d2a5";
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET, POST, OPTIONS" };
const STORIA = 100, PAUSA = 3000;
const RISERVATI = /admin|moderat|staff|andrea\s*audisio|team\s*audisio/i;

const json = (obj, code = 200) => new Response(JSON.stringify(obj), {
  status: code, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS }
});

async function keyOk(k) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(k || "")));
  const h = [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
  const a = new TextEncoder().encode(h), b = new TextEncoder().encode(KEY_HASH);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

/* stesso controllo di api/live.js: il bottone si accende solo con un link https */
function pulisci(st) {
  const c = (st && st.cta) || {};
  const url = String(c.url || "").trim();
  const ok = /^https:\/\/\S+$/.test(url);
  const t = Date.parse(st && st.aggiornato);
  return {
    cta: { on: !!c.on && ok, url: ok ? url : "", testo: String(c.testo || "").trim().slice(0, 120) },
    aggiornato: new Date(Number.isNaN(t) ? Date.now() : t).toISOString()
  };
}

/* testo di chat: niente caratteri di controllo o invisibili, spazi compattati, lunghezza massima in caratteri veri */
const testo = (s, n) => [...String(s || "").replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g, " ")
  .replace(/\s+/g, " ").trim()].slice(0, n).join("").trim();

/* IPv4 intero; IPv6 ridotto alla rete /64, perché lo stesso telefono cambia spesso l'ultima parte */
function rete(ip) {
  ip = String(ip || "").trim().toLowerCase();
  if (!ip.includes(":")) return ip;
  const [a, b = ""] = ip.split("::"), sx = a ? a.split(":") : [], dx = b ? b.split(":") : [];
  const g = ip.includes("::") ? [...sx, ...Array(Math.max(0, 8 - sx.length - dx.length)).fill("0"), ...dx] : sx;
  return g.slice(0, 4).map(x => (parseInt(x, 16) || 0).toString(16)).join(":") + "::/64";
}

/* una sola stanza per la diretta: tiene stato, chat, bannati e tutte le connessioni aperte (in pausa quando non succede niente) */
export class Stanza extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS chat (id TEXT PRIMARY KEY, ora INTEGER, nome TEXT, testo TEXT, ip TEXT, dev TEXT, via INTEGER DEFAULT 0);
      CREATE INDEX IF NOT EXISTS chat_ora ON chat (ora);
      CREATE TABLE IF NOT EXISTS ban (id TEXT PRIMARY KEY, ora INTEGER, nome TEXT, ip TEXT, dev TEXT);
      CREATE TABLE IF NOT EXISTS nomi (chi TEXT PRIMARY KEY, nome TEXT)`);
    this.ultimi = new Map();
  }
  recenti() {
    return this.sql.exec("SELECT id, ora, nome, testo FROM chat WHERE via = 0 ORDER BY ora DESC LIMIT ?", STORIA).toArray().reverse();
  }
  bannato(ip, dev) {
    if (!ip && !dev) return false;
    return this.sql.exec("SELECT 1 FROM ban WHERE (ip <> '' AND ip = ?) OR (dev <> '' AND dev = ?) LIMIT 1", ip || "", dev || "").toArray().length > 0;
  }
  manda(obj) {
    const msg = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) { try { ws.send(msg); } catch (e) {} }
  }
  /* dopo un ban o uno sblocco ognuno riceve lo stato giusto: chi è bannato non vede più il campo per scrivere */
  avvisaBan() {
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() || {};
      try { ws.send(JSON.stringify({ t: "ban", v: this.bannato(a.ip, a.dev) })); } catch (e) {}
    }
  }
  async fetch(req) {
    const u = new URL(req.url);
    const stato = (await this.ctx.storage.get("stato")) || null;
    if (u.pathname === "/ws") {
      const [client, server] = Object.values(new WebSocketPair());
      const ip = rete(req.headers.get("cf-connecting-ip")), dev = (u.searchParams.get("d") || "").replace(/[^\w-]/g, "").slice(0, 40);
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ ip, dev, p: u.searchParams.has("p") });
      if (stato) server.send(JSON.stringify(stato));
      server.send(JSON.stringify({ t: "storia", m: this.recenti(), ban: this.bannato(ip, dev), chiusa: !!(await this.ctx.storage.get("chiusa")) }));
      return new Response(null, { status: 101, webSocket: client });
    }
    if (u.pathname === "/chat") return this.modera(await req.json());
    if (req.method === "POST") {
      const nuovo = await req.json();
      await this.ctx.storage.put("stato", nuovo);
      this.manda(nuovo);
      const connessi = this.ctx.getWebSockets().filter(ws => !(ws.deserializeAttachment() || {}).p).length;
      return json({ ok: true, stato: nuovo, connessi });
    }
    return json(stato);
  }
  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > 4000) return;
    let d;
    try { d = JSON.parse(raw); } catch (e) { return; }
    if (!d || d.t !== "msg") return;
    const a = ws.deserializeAttachment() || {};
    const errore = (t, campo) => ws.send(JSON.stringify({ t: "errore", testo: t, campo }));
    if (this.bannato(a.ip, a.dev)) return ws.send(JSON.stringify({ t: "ban", v: true }));
    if (await this.ctx.storage.get("chiusa")) return ws.send(JSON.stringify({ t: "chiusa", v: true }));
    const nome = testo(d.nome, 30), t = testo(d.testo, 300);
    if (!nome) return errore("Scrivi il tuo nome.", "nome");
    if (RISERVATI.test(nome)) return errore("Questo nome non si può usare: scegline un altro.", "nome");
    if (!t) return;
    if (/https?:\/\/|www\./i.test(t)) return errore("In chat non si possono mettere link.");
    /* un messaggio ogni 3 secondi per finestra, per dispositivo e per IP: più finestre o l'incognito non fanno scrivere più veloce */
    const ora = Date.now(), dev = a.dev ? "dev:" + a.dev : "", ip = a.ip ? "ip:" + a.ip : "";
    if (ora - (a.ultimo || 0) < PAUSA || [dev, ip].some(k => k && ora - (this.ultimi.get(k) || 0) < PAUSA))
      return errore("Aspetta qualche secondo tra un messaggio e l'altro.");
    /* un nome solo per dispositivo e per IP: chi apre altre finestre non può scrivere con nomi diversi */
    const legato = this.sql.exec("SELECT nome FROM nomi WHERE chi IN (?, ?) ORDER BY (chi = ?) DESC LIMIT 1", dev, ip, dev).toArray()[0];
    if (legato && legato.nome.toLowerCase() !== nome.toLowerCase())
      return ws.send(JSON.stringify({ t: "errore", testo: "Da questa connessione scrivi già come " + legato.nome + ": il nome resta quello.", campo: "nome", nome: legato.nome }));
    const firma = legato ? legato.nome : nome;
    for (const k of [dev, ip]) if (k) { this.ultimi.set(k, ora); this.sql.exec("INSERT OR IGNORE INTO nomi (chi, nome) VALUES (?, ?)", k, firma); }
    a.ultimo = ora; ws.serializeAttachment(a);
    if (this.ultimi.size > 5000) this.ultimi.clear();
    const m = { id: crypto.randomUUID().replace(/-/g, "").slice(0, 12), ora, nome: firma, testo: t };
    this.sql.exec("INSERT INTO chat (id, ora, nome, testo, ip, dev) VALUES (?, ?, ?, ?, ?, ?)", m.id, ora, firma, t, a.ip || "", a.dev || "");
    this.manda({ t: "chat", m });
  }
  async modera({ azione, id } = {}) {
    id = String(id || "");
    if (azione === "cancella") {
      this.sql.exec("UPDATE chat SET via = 1 WHERE id = ?", id);
      this.manda({ t: "cancella", ids: [id] });
      return json({ ok: true });
    }
    if (azione === "banna") {
      const r = this.sql.exec("SELECT nome, ip, dev FROM chat WHERE id = ?", id).toArray()[0];
      if (!r) return json({ error: "messaggio non trovato" }, 404);
      if (!this.bannato(r.ip, r.dev))
        this.sql.exec("INSERT INTO ban (id, ora, nome, ip, dev) VALUES (?, ?, ?, ?, ?)", crypto.randomUUID().slice(0, 8), Date.now(), r.nome, r.ip, r.dev);
      /* spariscono tutti i suoi messaggi: per dispositivo, o per IP se il dispositivo non c'è */
      const ids = this.sql.exec("SELECT id FROM chat WHERE via = 0 AND (id = ? OR (? <> '' AND dev = ?) OR (? = '' AND ? <> '' AND ip = ?))",
        id, r.dev, r.dev, r.dev, r.ip, r.ip).toArray().map(x => x.id);
      for (const x of ids) this.sql.exec("UPDATE chat SET via = 1 WHERE id = ?", x);
      this.manda({ t: "cancella", ids });
      this.avvisaBan();
      return json({ ok: true, cancellati: ids.length, bannati: this.bannati() });
    }
    if (azione === "sblocca") {
      this.sql.exec("DELETE FROM ban WHERE id = ?", id);
      this.avvisaBan();
      return json({ ok: true, bannati: this.bannati() });
    }
    if (azione === "bannati") return json({ ok: true, bannati: this.bannati(), chiusa: !!(await this.ctx.storage.get("chiusa")) });
    if (azione === "chiudi" || azione === "apri") {
      await this.ctx.storage.put("chiusa", azione === "chiudi");
      this.manda({ t: "chiusa", v: azione === "chiudi" });
      return json({ ok: true, chiusa: azione === "chiudi" });
    }
    /* dopo aver pubblicato un sorgente.json nuovo (piano B): tutte le pagine aperte lo rileggono subito */
    if (azione === "sorgente") {
      this.manda({ t: "sorgente" });
      return json({ ok: true });
    }
    if (azione === "svuota") {
      this.sql.exec("DELETE FROM chat; DELETE FROM nomi");
      this.manda({ t: "svuota" });
      return json({ ok: true });
    }
    return json({ error: "azione sconosciuta" }, 400);
  }
  bannati() { return this.sql.exec("SELECT id, ora, nome, ip FROM ban ORDER BY ora DESC").toArray(); }
  webSocketClose(ws, code) { try { ws.close(code === 1005 || code === 1006 ? 1000 : code); } catch (e) {} }
  webSocketError(ws) { try { ws.close(1011); } catch (e) {} }
}

export default {
  async fetch(req, env) {
    const path = new URL(req.url).pathname;
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const stanza = env.STANZA.get(env.STANZA.idFromName("diretta"));
    if (path === "/ws") {
      if (req.headers.get("upgrade") !== "websocket") return json({ error: "serve un WebSocket" }, 426);
      return stanza.fetch(req);
    }
    if (path === "/stato" && req.method === "GET") return stanza.fetch(req);
    if ((path === "/stato" || path === "/chat") && req.method === "POST") {
      let body;
      try { body = await req.json(); } catch (e) { return json({ error: "json non valido" }, 400); }
      if (!(await keyOk(body.chiave))) return json({ error: "chiave sbagliata" }, 401);
      const dentro = path === "/stato" ? pulisci(body.stato) : { azione: body.azione, id: body.id };
      return stanza.fetch(new Request(req.url, { method: "POST", body: JSON.stringify(dentro) }));
    }
    return json({ error: "non trovato" }, 404);
  }
};
