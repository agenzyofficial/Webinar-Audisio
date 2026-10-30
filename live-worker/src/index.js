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
                  "togli-accesso" (id = codice del dispositivo) toglie un accesso di prova dall'elenco;
                  "chiudi-diretta" (con testo) / "riapri-diretta": a diretta finita la pagina mostra solo il messaggio di saluto.
   POST /minuti   { chiave, righe } carica i minuti di una diretta passata (dalle statistiche di Cloudflare); oltre alla chiave
                  del pannello accetta il codice del secret IMPORTA, se c'è.
   Le statistiche si azzerano da sole all'inizio della diretta (INIZIO, 20:50 italiane).
   Minuto per minuto, finché c'è qualcuno collegato, si salvano le pagine vive, quante hanno il video in play e quante l'audio
   acceso (la pagina lo manda con { t: "guardo", g }) e la slide della regia; il pannello le chiede con { t: "minuti" }.
   Il ban blocca la scrittura per IP (per IPv6 la rete /64) e per codice del dispositivo: chi è bannato vede la chat ma non scrive.
   La chiave non sta nel codice: c'è solo la sua impronta SHA-256, la stessa di api/live.js. */
import { DurableObject } from "cloudflare:workers";

const KEY_HASH = "715ccff2b0480e44fc5ea32554e0ca1dbe045526383a3ac3924ded669215d2a5";
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET, POST, OPTIONS" };
const STORIA = 100, PAUSA = 3000;
const VIVA = 120000, BUCO = 30 * 60000;   // pagina viva: ping negli ultimi 2 minuti · più di 30 minuti senza nessuno = un'altra diretta
const INIZIO = Date.parse("2026-10-29T20:50:00+01:00");   // si aprono video, accesso e chat: da qui contano le statistiche
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
      CREATE TABLE IF NOT EXISTS accessi (dev TEXT PRIMARY KEY, nome TEXT, email TEXT, ip TEXT, ora INTEGER);
      CREATE TABLE IF NOT EXISTS minuti (min INTEGER PRIMARY KEY, pagine INTEGER, video INTEGER, audio INTEGER, slide INTEGER,
        momento TEXT, frase TEXT, evento TEXT, reg TEXT);
      CREATE TABLE IF NOT EXISTS eventi (ora INTEGER, cosa TEXT)`);
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
  /* pagine della diretta davvero aperte: appena collegate o con un ping negli ultimi 2 minuti (la pagina ne manda uno ogni 45 s).
     Un telefono bloccato o una pagina chiusa male restano collegati ancora per un po' senza mandare niente: così non contano. */
  vive() {
    const da = Date.now() - VIVA;
    return this.ctx.getWebSockets().map(ws => {
      const a = ws.deserializeAttachment() || {}, t = this.ctx.getWebSocketAutoResponseTimestamp(ws);
      return a.p || Math.max(a.da || 0, t ? t.getTime() : 0) < da ? null : a;
    }).filter(Boolean);
  }
  segna(cosa) { this.sql.exec("INSERT INTO eventi (ora, cosa) VALUES (?, ?)", Date.now(), cosa); }
  /* ogni minuto, finché c'è qualcuno collegato: pagine vive, video in play, audio acceso e slide della regia (se è aperta) */
  async alarm() {
    const min = Math.round(Date.now() / 60000) * 60000, vive = this.vive();
    const regia = this.ctx.getWebSockets("pannello").some(ws => (ws.deserializeAttachment() || {}).regia);
    const slide = regia ? ((await this.ctx.storage.get("slideOra")) || {}).n || null : null;
    this.sql.exec(`INSERT INTO minuti (min, pagine, video, audio, slide) VALUES (?, ?, ?, ?, ?) ON CONFLICT(min) DO UPDATE SET
      pagine = excluded.pagine, video = excluded.video, audio = excluded.audio, slide = excluded.slide`,
      min, vive.length, vive.filter(a => a.g > 0).length, vive.filter(a => a.g === 2).length, slide);
    if (this.spettatori() > 0) await this.ctx.storage.setAlarm(min + 60000);
  }
  /* le dirette salvate (minuti con meno di 30 minuti di buco tra loro) e i minuti di quella chiesta (l'ultima se non si dice),
     con gli eventi del pannello e i messaggi di chat di ogni minuto. Le pagine aperte per prova (meno di 10 minuti o meno di
     3 persone) non entrano nell'elenco, salvo quella in corso. */
  minuti(da) {
    const tutti = this.sql.exec("SELECT min, video, pagine FROM minuti ORDER BY min").toArray(), tutte = [];
    for (const r of tutti) {
      const d = tutte[tutte.length - 1];
      if (d && r.min - d.a < BUCO) { d.a = r.min; d.picco = Math.max(d.picco, r.video ?? r.pagine); d.n++; }
      else tutte.push({ da: r.min, a: r.min, picco: r.video ?? r.pagine, n: 1 });
    }
    const dirette = tutte.filter(d => (d.n >= 10 && d.picco >= 3) || Date.now() - d.a < 10 * 60000);
    const s = tutte.find(d => d.da === Number(da)) || dirette[dirette.length - 1];
    if (!s) return { t: "minuti", dirette, righe: [], eventi: [], chat: [] };
    /* persone entrate (una per dispositivo) e persone che hanno scritto: dall'inizio della diretta (INIZIO, se cade in questa,
       come le statistiche in alto del pannello) o da 15 minuti prima del primo minuto salvato (si entra prima che parta il conteggio) */
    const inizio = s.da <= INIZIO && INIZIO <= s.a ? INIZIO : s.da - 15 * 60000, uno = (q, ...p) => this.sql.exec(q, ...p).toArray()[0].n;
    return {
      t: "minuti", dirette, da: s.da, inizio, fine: s.a + 60000,
      entrati: uno("SELECT COUNT(*) AS n FROM accessi WHERE ora BETWEEN ? AND ?", inizio, s.a + 60000),
      ip: uno("SELECT COUNT(DISTINCT ip) AS n FROM accessi WHERE ora BETWEEN ? AND ?", inizio, s.a + 60000),
      scrittori: uno("SELECT COUNT(DISTINCT dev) AS n FROM chat WHERE ora BETWEEN ? AND ?", inizio, s.a + 60000),
      righe: this.sql.exec("SELECT * FROM minuti WHERE min BETWEEN ? AND ? ORDER BY min", s.da, s.a).toArray(),
      eventi: this.sql.exec("SELECT ora, cosa FROM eventi WHERE ora BETWEEN ? AND ? ORDER BY ora", s.da - 60000, s.a + 60000).toArray(),
      chat: this.sql.exec("SELECT (ora / 60000) * 60000 AS min, COUNT(*) AS n FROM chat WHERE ora BETWEEN ? AND ? GROUP BY 1",
        s.da, s.a + 60000).toArray()
    };
  }
  importa(righe) {
    let n = 0;
    for (const r of Array.isArray(righe) ? righe : []) {
      const min = Math.round(Number(r.min) / 60000) * 60000;
      if (!min) continue;
      const num = v => v === null || v === undefined || v === "" ? null : Math.max(0, Math.round(Number(v)) || 0);
      const txt = (v, k) => v ? String(v).slice(0, k) : null;
      this.sql.exec(`INSERT OR REPLACE INTO minuti (min, pagine, video, audio, slide, momento, frase, evento, reg) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        min, num(r.pagine), num(r.video), num(r.audio), num(r.slide), txt(r.momento, 300), txt(r.frase, 4000), txt(r.evento, 120), txt(r.reg, 20));
      n++;
    }
    return json({ ok: true, righe: n });
  }
  /* Le statistiche si azzerano da sole all'inizio della diretta (20:50, quando si aprono video, accesso e chat): prima contano tutto
     (le prove), dopo solo da quell'ora. Non si cancella niente. La prima volta dopo l'inizio riparte anche il picco e i pannelli
     ricevono l'elenco "Chi è entrato" già ripulito. */
  async daQuando() {
    if (Date.now() < INIZIO) return 0;
    if (!(await this.ctx.storage.get("azzeratoInizio"))) {
      await this.ctx.storage.put("azzeratoInizio", true);
      await this.ctx.storage.put("picco", this.spettatori());
      this.agliAdmin({ t: "accessi", accessi: this.sql.exec("SELECT dev, nome, email, ora FROM accessi WHERE ora >= ? ORDER BY ora DESC", INIZIO).toArray() });
    }
    return INIZIO;
  }
  /* persone, non pagine: "guardano" = pagine vive con il video in play, "attesa" = sulla pagina ma col video fermo
     (per esempio prima dell'inizio); il picco è il massimo di persone che guardavano nello stesso minuto, come nel grafico */
  async stats() {
    const da = await this.daQuando(), uno = q => this.sql.exec(q, da).toArray()[0].n, vive = this.vive();
    const guardano = vive.filter(a => a.g > 0).length;
    return {
      t: "stats",
      da, entrati: uno("SELECT COUNT(*) AS n FROM accessi WHERE ora >= ?"),
      ip: uno("SELECT COUNT(DISTINCT ip) AS n FROM accessi WHERE ora >= ?"),
      email: uno("SELECT COUNT(DISTINCT email) AS n FROM accessi WHERE ora >= ?"),
      collegati: vive.length, guardano, attesa: vive.length - guardano,
      picco: this.sql.exec("SELECT MAX(video) AS n FROM minuti WHERE min >= ?", da).toArray()[0].n || 0,
      messaggi: uno("SELECT COUNT(*) AS n FROM chat WHERE ora >= ?"),
      cancellati: uno("SELECT COUNT(*) AS n FROM chat WHERE via = 1 AND ora >= ?"),
      scrittori: uno("SELECT COUNT(DISTINCT dev) AS n FROM chat WHERE ora >= ?"),
      bannati: uno("SELECT COUNT(*) AS n FROM ban WHERE ora >= ?")
    };
  }
  async accessiDa() {
    return this.sql.exec("SELECT dev, nome, email, ora FROM accessi WHERE ora >= ? ORDER BY ora DESC", await this.daQuando()).toArray();
  }
  async fetch(req) {
    const u = new URL(req.url);
    const stato = (await this.ctx.storage.get("stato")) || null;
    if (u.pathname === "/ws") {
      const [client, server] = Object.values(new WebSocketPair());
      const ip = rete(req.headers.get("cf-connecting-ip")), dev = (u.searchParams.get("d") || "").replace(/[^\w-]/g, "").slice(0, 40);
      const pannello = u.searchParams.has("p");
      this.ctx.acceptWebSocket(server, pannello ? ["pannello"] : []);
      server.serializeAttachment({ ip, dev, p: pannello, da: Date.now() });
      if (stato) server.send(JSON.stringify(stato));
      server.send(JSON.stringify({ t: "storia", m: this.recenti(), ban: this.bannato(ip, dev), chiusa: !!(await this.ctx.storage.get("chiusa")),
        sagoma: !!(await this.ctx.storage.get("sagoma")), finita: (await this.ctx.storage.get("finita")) || { v: false } }));
      /* il primo spettatore fa partire il conteggio minuto per minuto (il picco si aggiorna lì, con le sole pagine vive) */
      if (!pannello) {
        await this.daQuando();
        if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Math.floor(Date.now() / 60000) * 60000 + 60000);
      }
      return new Response(null, { status: 101, webSocket: client });
    }
    if (u.pathname === "/accesso") return this.accesso(await req.json());
    if (u.pathname === "/chat") return this.modera(await req.json());
    if (u.pathname === "/minuti") return this.importa((await req.json()).righe);
    if (req.method === "POST") {
      const nuovo = await req.json();
      if (!!(stato && stato.cta && stato.cta.on) !== !!nuovo.cta.on) this.segna(nuovo.cta.on ? "Bottone call acceso" : "Bottone call spento");
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
      ws.send(JSON.stringify({ t: "admin", ok: true, email, accessi: await this.accessiDa() }));
      return ws.send(JSON.stringify(await this.stats()));
    }
    if (d.t === "stats" && a.admin) return ws.send(JSON.stringify(await this.stats()));
    if (d.t === "minuti" && a.admin) return ws.send(JSON.stringify(this.minuti(d.da)));
    /* la pagina della diretta dice se il video sta andando: 0 fermo, 1 in play senza audio, 2 in play con l'audio */
    if (d.t === "guardo" && !a.p) {
      const g = d.g === 1 || d.g === 2 ? d.g : 0;
      if (a.g !== g) { a.g = g; ws.serializeAttachment(a); }
      return;
    }
    /* regia slide e telecomando dell'iPhone: entrano con la chiave (?p=1), il telecomando manda avanti/indietro,
       la regia sul Mac esegue e rimanda la slide attuale; tutto solo ai collegati con la chiave */
    if (d.t === "regia" && a.p) {
      if (!(await keyOk(d.chiave))) return ws.send(JSON.stringify({ t: "regia", ok: false }));
      a.admin = true; a.regia = true; ws.serializeAttachment(a);
      return ws.send(JSON.stringify({ t: "regia", ok: true, ora: (await this.ctx.storage.get("slideOra")) || null }));
    }
    if (d.t === "slide" && a.admin) return this.agliAdmin({ t: "slide", cmd: d.cmd === "indietro" ? "indietro" : "avanti" });
    if (d.t === "slide-ora" && a.admin) {
      const ora = { n: d.n | 0, tot: d.tot | 0 };
      await this.ctx.storage.put("slideOra", ora);
      return this.agliAdmin({ t: "slide-ora", ...ora });
    }
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
  async modera({ azione, id, testo: msg } = {}) {
    id = String(id || "");
    /* fine della diretta: chi apre la pagina vede solo il saluto (senza video, chat e accesso); "riapri-diretta" la rimette com'era */
    if (azione === "chiudi-diretta" || azione === "riapri-diretta") {
      const v = azione === "chiudi-diretta", finita = { v, testo: testo(msg, 200) || "Grazie di essere stato con noi. Ci vediamo alla prossima diretta!" };
      await this.ctx.storage.put("finita", finita);
      this.segna(v ? "Pagina della diretta chiusa" : "Pagina della diretta riaperta");
      this.manda({ t: "finita", ...finita });
      return json({ ok: true, finita });
    }
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
      this.segna(azione === "chiudi" ? "Chat chiusa" : "Chat riaperta");
      this.manda({ t: "chiusa", v: azione === "chiudi" });
      return json({ ok: true, chiusa: azione === "chiudi" });
    }
    /* Andrea cartonato: sale dall'angolo del video di tutti (sagoma-su) o rientra (sagoma-giu) */
    if (azione === "sagoma-su" || azione === "sagoma-giu") {
      const v = azione === "sagoma-su";
      await this.ctx.storage.put("sagoma", v);
      this.segna(v ? "Andrea cartonato esce" : "Andrea cartonato rientra");
      this.manda({ t: "sagoma", v });
      return json({ ok: true, sagoma: v });
    }
    /* dopo aver pubblicato un sorgente.json nuovo (piano B): tutte le pagine aperte lo rileggono subito */
    if (azione === "sorgente") {
      this.segna("Cambio sorgente del video");
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
      /* dal 29/10 sera si entra con il solo nome: l'email si controlla solo se qualcuno la manda */
      let email = "";
      if (String(body.email || "").trim()) {
        const e = await controllaEmail(body.email);
        if (!e.ok) return json({ error: e.errore, campo: "email", suggerita: e.suggerita }, 400);
        email = e.email;
      }
      if (!dev) return json({ error: "Ricarica la pagina e riprova." }, 400);
      return stanza.fetch(new Request(req.url, { method: "POST", body: JSON.stringify({ nome, email, dev, ip: rete(req.headers.get("cf-connecting-ip")) }) }));
    }
    if (path === "/minuti" && req.method === "POST") {
      let body;
      try { body = await req.json(); } catch (e) { return json({ error: "json non valido" }, 400); }
      if (!(await keyOk(body.chiave)) && !(env.IMPORTA && body.chiave === env.IMPORTA)) return json({ error: "chiave sbagliata" }, 401);
      return stanza.fetch(new Request(req.url, { method: "POST", body: JSON.stringify({ righe: body.righe }) }));
    }
    if ((path === "/stato" || path === "/chat") && req.method === "POST") {
      let body;
      try { body = await req.json(); } catch (e) { return json({ error: "json non valido" }, 400); }
      if (!(await keyOk(body.chiave))) return json({ error: "chiave sbagliata" }, 401);
      const dentro = path === "/stato" ? pulisci(body.stato) : { azione: body.azione, id: body.id, testo: body.testo };
      return stanza.fetch(new Request(req.url, { method: "POST", body: JSON.stringify(dentro) }));
    }
    return json({ error: "non trovato" }, 404);
  }
};
