/* Bottone della call, chat e accesso in tempo reale per la pagina della diretta (Cloudflare Worker + Durable Object).
   GET  /ws       WebSocket: manda subito lo stato del bottone e gli ultimi messaggi della chat, poi ogni cambio, a tutti insieme.
                  Lo spettatore scrive in chat mandando { t: "msg", testo } sullo stesso WebSocket (?d= codice del dispositivo):
                  il nome è quello dato all'accesso. Il pannello si collega con ?p=1 e manda { t: "admin", chiave } per ricevere
                  anche le email, l'elenco di chi è entrato e le statistiche ({ t: "stats" }).
   POST /accesso  { nome, email, dev } per entrare nella diretta: controlla l'email (scritta bene, niente refusi dei domini più
                  usati, niente caselle usa e getta o indirizzi finti, dominio che riceve posta) e salva nome ed email.
   GET  /stato    stato attuale in JSON.
   POST /stato    { chiave, stato } salva e avvisa tutti: lo chiama api/live.js del sito quando si preme Mostra o Nascondi.
   POST /chat     { chiave, azione, id } moderazione dal pannello: cancella, banna, sblocca, bannati, chiudi, apri, svuota;
                  "sorgente" fa rileggere subito sorgente.json a tutte le pagine aperte (dopo averlo cambiato);
                  "sagoma-su" / "sagoma-giu" fanno salire o rientrare Andrea cartonato nella pagina della diretta;
                  "togli-accesso" (id = codice del dispositivo) toglie un accesso di prova dall'elenco.
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

/* Controllo email. Refusi dei domini più usati (si propone quello giusto), caselle usa e getta, indirizzi palesemente finti,
   e il dominio deve avere i server di posta (record MX, chiesto al DNS di Cloudflare). Se il DNS non risponde non si blocca nessuno. */
const REFUSI = {
  "gmial.com": "gmail.com", "gmal.com": "gmail.com", "gmai.com": "gmail.com", "gamil.com": "gmail.com", "gnail.com": "gmail.com",
  "gmaill.com": "gmail.com", "gmail.co": "gmail.com", "gmail.cm": "gmail.com", "gmail.con": "gmail.com", "gmail.om": "gmail.com",
  "gmail.comm": "gmail.com", "gmail.it": "gmail.com", "gmail.cmo": "gmail.com", "gmeil.com": "gmail.com", "gimail.com": "gmail.com",
  "hotmial.com": "hotmail.com", "hotmal.com": "hotmail.com", "hotmail.co": "hotmail.com", "hotmail.con": "hotmail.com", "homail.com": "hotmail.com",
  "hotmai.it": "hotmail.it", "hotmial.it": "hotmail.it", "hotmail.ti": "hotmail.it", "homail.it": "hotmail.it", "hotmal.it": "hotmail.it",
  "outlok.com": "outlook.com", "outllok.com": "outlook.com", "outlook.co": "outlook.com", "outlook.con": "outlook.com", "outlok.it": "outlook.it",
  "yaho.com": "yahoo.com", "yahooo.com": "yahoo.com", "yahoo.co": "yahoo.com", "yahoo.con": "yahoo.com", "yahoo.ti": "yahoo.it", "yaho.it": "yahoo.it",
  "libero.ti": "libero.it", "liber.it": "libero.it", "lbero.it": "libero.it", "libro.it": "libero.it", "libero.com": "libero.it", "libeo.it": "libero.it",
  "icloud.co": "icloud.com", "iclod.com": "icloud.com", "icoud.com": "icloud.com", "icloud.con": "icloud.com", "icluod.com": "icloud.com",
  "virgilio.ti": "virgilio.it", "virgiio.it": "virgilio.it", "virgilo.it": "virgilio.it", "tiscali.ti": "tiscali.it", "tiscal.it": "tiscali.it",
  "alice.ti": "alice.it", "live.ti": "live.it", "live.con": "live.com", "msn.con": "msn.com", "me.con": "me.com"
};
const USA_E_GETTA = new Set(("mailinator.com yopmail.com yopmail.fr yopmail.net 10minutemail.com 10minutemail.net guerrillamail.com guerrillamail.net " +
  "guerrillamail.org guerrillamailblock.com sharklasers.com grr.la pokemail.net spam4.me temp-mail.org temp-mail.io tempmail.com tempmail.net " +
  "tempmailo.com tempmail.plus tempr.email trashmail.com trashmail.de trashmail.net getnada.com nada.email maildrop.cc dispostable.com " +
  "fakeinbox.com mohmal.com emailondeck.com throwawaymail.com mintemail.com mailnesia.com mailcatch.com spamgourmet.com mytemp.email " +
  "tmpmail.org tmpmail.net tmail.ws moakt.com burnermail.io inboxkitten.com mail.tm mailpoof.com emailfake.com fakemail.net luxusmail.org " +
  "dropmail.me 10mail.org mvrht.net cuvox.de armyspy.com dayrep.com einrot.com fleckens.hu gustr.com jourrapide.com rhyta.com superrito.com " +
  "teleworm.us crazymailing.com mailforspam.com spambox.us trbvm.com emltmp.com minuteinbox.com fexbox.org byom.de tempinbox.com " +
  "discard.email harakirimail.com mailsac.com getairmail.com linshiyouxiang.net owlymail.com vomoto.com wegwerfmail.de wegwerfemail.de " +
  "emailtemporanea.net emailtemporanea.com mailtemporanea.it tempail.com tempmailaddress.com temporary-mail.net").split(" "));
const FINTI_DOMINI = new Set(("example.com example.org example.net example.it test.com test.it prova.it prova.com asd.com asd.it fake.com fake.it " +
  "domain.com dominio.it dominio.com sito.it xxx.com aaa.com aaa.it abc.com abc.it nomail.com noemail.com nessuno.it boh.it qwerty.com " +
  "email.test mail.test localhost").split(" "));
const FINTI_UTENTE = /^(test|tests|testing|prova|prove|asd|asdf|asdasd|asdfgh|asdfghjkl|qwe|qwerty|qwertyuiop|fake|nomail|noemail|nessuno|niente|boh|abc|abc123|abcd|null|none|nobody|tuaemail|tuamail|xxx+|a+|x+)$/;

async function riceve(dominio) {
  try {
    const r = await fetch("https://cloudflare-dns.com/dns-query?type=MX&name=" + encodeURIComponent(dominio),
      { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(3000) });
    const j = await r.json();
    if (j.Status === 3) return false;                       // il dominio non esiste
    return (j.Answer || []).some(a => a.type === 15 && !/^0\s+\.?$/.test(String(a.data).trim()));   // "0 ." = dichiara di non ricevere
  } catch (e) { return true; }
}

async function controllaEmail(raw) {
  const email = String(raw || "").trim().toLowerCase();
  const m = email.match(/^([a-z0-9._%+-]{1,64})@([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24})$/);
  if (!m || email.length > 254 || /\.\.|^\.|\.@|@-|-\.|\.-/.test(email)) return { errore: "Questa email non è scritta bene: controllala." };
  const [, utente, dominio] = m;
  if (REFUSI[dominio]) return { errore: `Forse volevi scrivere ${utente}@${REFUSI[dominio]}?`, suggerita: `${utente}@${REFUSI[dominio]}` };
  if (USA_E_GETTA.has(dominio) || FINTI_DOMINI.has(dominio) || FINTI_UTENTE.test(utente) || /^(.)\1{2,}$/.test(utente) || /^(asd|qwe|zxc|abc)+$/.test(utente))
    return { errore: "Usa la tua email vera, quella con cui ti sei iscritto." };
  if (!(await riceve(dominio))) return { errore: `Il dominio ${dominio} non riceve email: controlla l'indirizzo.` };
  return { ok: true, email };
}

/* una sola stanza per la diretta: tiene stato, chat, accessi, bannati e tutte le connessioni aperte (in pausa quando non succede niente) */
export class Stanza extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS chat (id TEXT PRIMARY KEY, ora INTEGER, nome TEXT, testo TEXT, ip TEXT, dev TEXT, via INTEGER DEFAULT 0);
      CREATE INDEX IF NOT EXISTS chat_ora ON chat (ora);
      CREATE TABLE IF NOT EXISTS ban (id TEXT PRIMARY KEY, ora INTEGER, nome TEXT, ip TEXT, dev TEXT);
      CREATE TABLE IF NOT EXISTS nomi (chi TEXT PRIMARY KEY, nome TEXT);
      CREATE TABLE IF NOT EXISTS accessi (dev TEXT PRIMARY KEY, nome TEXT, email TEXT, ip TEXT, ora INTEGER)`);
    this.ultimi = new Map();
    this.ingressi = new Map();
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
  /* solo ai pannelli entrati con la chiave: email e statistiche non arrivano mai agli spettatori */
  agliAdmin(obj) {
    const msg = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets("pannello")) { if ((ws.deserializeAttachment() || {}).admin) try { ws.send(msg); } catch (e) {} }
  }
  /* dopo un ban o uno sblocco ognuno riceve lo stato giusto: chi è bannato non vede più il campo per scrivere */
  avvisaBan() {
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() || {};
      try { ws.send(JSON.stringify({ t: "ban", v: this.bannato(a.ip, a.dev) })); } catch (e) {}
    }
  }
  spettatori() { return this.ctx.getWebSockets().length - this.ctx.getWebSockets("pannello").length; }
  async stats() {
    const uno = q => this.sql.exec(q).toArray()[0];
    return {
      t: "stats",
      entrati: uno("SELECT COUNT(*) AS n FROM accessi").n,
      email: uno("SELECT COUNT(DISTINCT email) AS n FROM accessi").n,
      collegati: this.spettatori(),
      picco: (await this.ctx.storage.get("picco")) || 0,
      messaggi: uno("SELECT COUNT(*) AS n FROM chat").n,
      cancellati: uno("SELECT COUNT(*) AS n FROM chat WHERE via = 1").n,
      scrittori: uno("SELECT COUNT(DISTINCT dev) AS n FROM chat").n,
      bannati: uno("SELECT COUNT(*) AS n FROM ban").n
    };
  }
  async fetch(req) {
    const u = new URL(req.url);
    const stato = (await this.ctx.storage.get("stato")) || null;
    if (u.pathname === "/ws") {
      const [client, server] = Object.values(new WebSocketPair());
      const ip = rete(req.headers.get("cf-connecting-ip")), dev = (u.searchParams.get("d") || "").replace(/[^\w-]/g, "").slice(0, 40);
      const pannello = u.searchParams.has("p");
      this.ctx.acceptWebSocket(server, pannello ? ["pannello"] : []);
      server.serializeAttachment({ ip, dev, p: pannello });
      if (stato) server.send(JSON.stringify(stato));
      server.send(JSON.stringify({ t: "storia", m: this.recenti(), ban: this.bannato(ip, dev), chiusa: !!(await this.ctx.storage.get("chiusa")), sagoma: !!(await this.ctx.storage.get("sagoma")) }));
      if (!pannello) {
        const n = this.spettatori(), picco = (await this.ctx.storage.get("picco")) || 0;
        if (n > picco) await this.ctx.storage.put("picco", n);
      }
      return new Response(null, { status: 101, webSocket: client });
    }
    if (u.pathname === "/accesso") return this.accesso(await req.json());
    if (u.pathname === "/chat") return this.modera(await req.json());
    if (req.method === "POST") {
      const nuovo = await req.json();
      await this.ctx.storage.put("stato", nuovo);
      this.manda(nuovo);
      return json({ ok: true, stato: nuovo, connessi: this.spettatori() });
    }
    return json(stato);
  }
  /* accesso alla diretta (nome ed email già controllati dal Worker): al massimo 8 accessi ogni 10 minuti dalla stessa connessione */
  accesso({ nome, email, dev, ip }) {
    const ora = Date.now(), prima = (this.ingressi.get(ip) || []).filter(t => ora - t < 600000);
    if (prima.length >= 8) return json({ error: "Troppi accessi da questa connessione: riprova tra qualche minuto." }, 429);
    this.ingressi.set(ip, [...prima, ora]);
    if (this.ingressi.size > 5000) this.ingressi.clear();
    this.sql.exec(`INSERT INTO accessi (dev, nome, email, ip, ora) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(dev) DO UPDATE SET nome = excluded.nome, email = excluded.email, ip = excluded.ip, ora = excluded.ora`, dev, nome, email, ip, ora);
    this.agliAdmin({ t: "accesso", a: { dev, nome, email, ora } });
    return json({ ok: true, nome, email });
  }
  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > 4000) return;
    let d;
    try { d = JSON.parse(raw); } catch (e) { return; }
    if (!d) return;
    const a = ws.deserializeAttachment() || {};
    /* pannello: con la chiave riceve email dei messaggi, elenco di chi è entrato e statistiche */
    if (d.t === "admin" && a.p) {
      if (!(await keyOk(d.chiave))) return ws.send(JSON.stringify({ t: "admin", ok: false }));
      a.admin = true; ws.serializeAttachment(a);
      const email = Object.fromEntries(this.sql.exec(`SELECT c.id, a.email FROM chat c JOIN accessi a ON a.dev = c.dev
        WHERE c.via = 0 ORDER BY c.ora DESC LIMIT ?`, STORIA).toArray().map(r => [r.id, r.email]));
      const accessi = this.sql.exec("SELECT dev, nome, email, ora FROM accessi ORDER BY ora DESC").toArray();
      ws.send(JSON.stringify({ t: "admin", ok: true, email, accessi }));
      return ws.send(JSON.stringify(await this.stats()));
    }
    if (d.t === "stats" && a.admin) return ws.send(JSON.stringify(await this.stats()));
    if (d.t !== "msg") return;
    const errore = (t, campo) => ws.send(JSON.stringify({ t: "errore", testo: t, campo }));
    if (this.bannato(a.ip, a.dev)) return ws.send(JSON.stringify({ t: "ban", v: true }));
    if (await this.ctx.storage.get("chiusa")) return ws.send(JSON.stringify({ t: "chiusa", v: true }));
    /* il nome è quello dato all'accesso con l'email: per scrivere con un altro nome serve un'altra email vera */
    const acc = this.sql.exec("SELECT nome, email FROM accessi WHERE dev = ?", a.dev || "").toArray()[0];
    if (!acc) return errore("Per scrivere in chat entra con nome ed email.", "accesso");
    const t = testo(d.testo, 300);
    if (!t) return;
    if (/https?:\/\/|www\./i.test(t)) return errore("In chat non si possono mettere link.");
    /* un messaggio ogni 3 secondi per finestra, per dispositivo e per IP: più finestre o l'incognito non fanno scrivere più veloce */
    const ora = Date.now(), dev = a.dev ? "dev:" + a.dev : "", ip = a.ip ? "ip:" + a.ip : "";
    if (ora - (a.ultimo || 0) < PAUSA || [dev, ip].some(k => k && ora - (this.ultimi.get(k) || 0) < PAUSA))
      return errore("Aspetta qualche secondo tra un messaggio e l'altro.");
    for (const k of [dev, ip]) if (k) this.ultimi.set(k, ora);
    a.ultimo = ora; ws.serializeAttachment(a);
    if (this.ultimi.size > 5000) this.ultimi.clear();
    const m = { id: crypto.randomUUID().replace(/-/g, "").slice(0, 12), ora, nome: acc.nome, testo: t };
    this.sql.exec("INSERT INTO chat (id, ora, nome, testo, ip, dev) VALUES (?, ?, ?, ?, ?, ?)", m.id, ora, acc.nome, t, a.ip || "", a.dev || "");
    this.manda({ t: "chat", m });
    this.agliAdmin({ t: "email", id: m.id, email: acc.email });
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
    /* Andrea cartonato: sale dall'angolo del video di tutti (sagoma-su) o rientra (sagoma-giu) */
    if (azione === "sagoma-su" || azione === "sagoma-giu") {
      const v = azione === "sagoma-su";
      await this.ctx.storage.put("sagoma", v);
      this.manda({ t: "sagoma", v });
      return json({ ok: true, sagoma: v });
    }
    /* dopo aver pubblicato un sorgente.json nuovo (piano B): tutte le pagine aperte lo rileggono subito */
    if (azione === "sorgente") {
      this.manda({ t: "sorgente" });
      return json({ ok: true });
    }
    if (azione === "togli-accesso") {
      this.sql.exec("DELETE FROM accessi WHERE dev = ?", id);
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
    if (path === "/accesso" && req.method === "POST") {
      let body;
      try { body = await req.json(); } catch (e) { return json({ error: "json non valido" }, 400); }
      const nome = testo(body.nome, 40), dev = String(body.dev || "").replace(/[^\w-]/g, "").slice(0, 40);
      if ([...nome.replace(/[^\p{L}]/gu, "")].length < 2) return json({ error: "Scrivi il tuo nome.", campo: "nome" }, 400);
      if (RISERVATI.test(nome)) return json({ error: "Questo nome non si può usare: scegline un altro.", campo: "nome" }, 400);
      const e = await controllaEmail(body.email);
      if (!e.ok) return json({ error: e.errore, campo: "email", suggerita: e.suggerita }, 400);
      if (!dev) return json({ error: "Ricarica la pagina e riprova." }, 400);
      return stanza.fetch(new Request(req.url, { method: "POST", body: JSON.stringify({ nome, email: e.email, dev, ip: rete(req.headers.get("cf-connecting-ip")) }) }));
    }
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
