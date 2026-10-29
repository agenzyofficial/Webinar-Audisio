/* Bottone della call in tempo reale per la pagina della diretta (Cloudflare Worker + Durable Object).
   GET  /ws     WebSocket: manda subito lo stato attuale e poi ogni cambio, a tutti insieme.
   GET  /stato  stato attuale in JSON.
   POST /stato  { chiave, stato } salva e avvisa tutti: lo chiama api/live.js del sito quando si preme Mostra o Nascondi.
   La chiave non sta nel codice: c'è solo la sua impronta SHA-256, la stessa di api/live.js. */
import { DurableObject } from "cloudflare:workers";

const KEY_HASH = "715ccff2b0480e44fc5ea32554e0ca1dbe045526383a3ac3924ded669215d2a5";
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET, POST, OPTIONS" };

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

/* una sola stanza per la diretta: tiene lo stato e tutte le connessioni aperte (in pausa quando non succede niente) */
export class Stanza extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }
  async fetch(req) {
    const stato = (await this.ctx.storage.get("stato")) || null;
    if (new URL(req.url).pathname === "/ws") {
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server);
      if (stato) server.send(JSON.stringify(stato));
      return new Response(null, { status: 101, webSocket: client });
    }
    if (req.method === "POST") {
      const nuovo = await req.json();
      await this.ctx.storage.put("stato", nuovo);
      const msg = JSON.stringify(nuovo), aperti = this.ctx.getWebSockets();
      for (const ws of aperti) { try { ws.send(msg); } catch (e) {} }
      return json({ ok: true, stato: nuovo, connessi: aperti.length });
    }
    return json(stato);
  }
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
    if (path === "/stato" && req.method === "POST") {
      let body;
      try { body = await req.json(); } catch (e) { return json({ error: "json non valido" }, 400); }
      if (!(await keyOk(body.chiave))) return json({ error: "chiave sbagliata" }, 401);
      return stanza.fetch(new Request(req.url, { method: "POST", body: JSON.stringify(pulisci(body.stato)) }));
    }
    return json({ error: "non trovato" }, 404);
  }
};
